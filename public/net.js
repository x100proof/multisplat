// Client netcode (SPEC §6): the WebSocket connection to /ws on this page's origin, reconnect with
// backoff and resume, clock sync, client-side prediction with reconciliation for the local player,
// and interpolation of remote players 100 ms in the past.
import * as Sim from '/shared/sim.js';
import { NET, TICK_MS, PW, PH, KEY, FX, cfgDiff, cfgFromDiff } from '/shared/constants.js';
import { LEVEL } from '/shared/level.js';
import { dbg, dbgv, sendReport, setWordId, setLogSink } from './debug.js';
import { isWordId } from '/shared/logid.js';

const INTERP_TICKS = NET.interpMs / TICK_MS;          // 6
const EXTRAP_TICKS = NET.extrapMs / TICK_MS;          // 6
const SNAP_KEEP = 60;                                  // ~2 s of snapshots
const PENDING_MAX = 120;
const ERR_KEEP = 180;                                  // prediction-error samples for the graph
const RESTART_MS = 40000;                              // how long to keep reconnecting to a restarting server (SPEC §18)
const LS_WORD = 'multisplat-id';                       // the log word id (SPEC §13.5), kept per browser
const lsWord = () => { try { const w = localStorage.getItem(LS_WORD); return isWordId(w) ? w : null; } catch { return null; } };

// Snapshot player array layout (server/arena.js snapshot()).
function unpack(a) {
  return { id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], face: a[5], hp: a[6], atk: a[7],
    alive: !!(a[8] & 1), onGround: !!(a[8] & 2), atkType: a[8] & 4 ? 'sweep' : 'chop', long: !!(a[8] & 8),
    iframes: a[9], stun: a[10], fx: a[11], stars: a[12] | 0, w: PW, h: PH };   // a[12]: ninja stars carried (absent before M6)
}
// Long-sword pickups lying in the arena, from a snapshot's `it` ([[id, x, y]]). A snapshot from a
// pre-M5 server has none.
// a[3] is the kind (1 = ninja stars; absent or 0 = long sword); a[4] a star pickup's amount (absent
// from an older server: n is left out and Sim.starAmount gives the old 3).
const unpackItems = it => (Array.isArray(it) ? it.filter(Array.isArray).map(a => (a[3] === 1
  ? { id: a[0], x: a[1], y: a[2], kind: 'star', ...(a[4] > 0 ? { n: a[4] } : {}) }
  : { id: a[0], x: a[1], y: a[2], kind: 'long' })) : []);
// Ninja stars in flight, from a snapshot's `st` ([[id, x, y, vx, owner]]); none from an older server.
const unpackFlying = st => new Map(Array.isArray(st) ? st.filter(Array.isArray).map(a => [a[0], { id: a[0], x: a[1], y: a[2], vx: a[3], owner: a[4] }]) : []);

// Can this page share a game with the server whose welcome is `m` (SPEC §18)? page: {rules, build}, the
// page's own ids (from its index.html). 'same': yes, and it is the same build; 'ui': yes, only files
// outside the rules (the UI) differ, so the page may reload quietly when nothing is lost; 'outdated':
// no, the game must stop and the page reload. A server without a rules hash (older than SPEC §18)
// is judged by the build id alone, as before.
export function compareVersion(page, m) {
  if (typeof m.r === 'string' && m.r) {
    if (!page.rules || m.r !== page.rules) return 'outdated';
    return m.b && page.build && m.b !== page.build ? 'ui' : 'same';
  }
  return m.b && page.build && m.b !== page.build ? 'outdated' : 'same';
}

// Rooms (SPEC §17): onRefused({what, why}) for a request the server turned down, onClosed({room, name,
// why}) when the room we looked at closed, onRoom(id) when the room whose world we see changes (the
// game then clears what it drew of the old one). onCfg(ev) when the room's settings (SPEC §17.1)
// changed: ev is the server's `cfg` event, or null when they came with a welcome or lobby message.
export function createNet({ onEvent = () => {}, onLobby = () => {}, onStatus = () => {}, onRefused = () => {}, onClosed = () => {}, onRoom = () => {}, onMadeAdmin = () => {}, onCfg = () => {} } = {}) {
  const net = {
    id: null, state: 'idle', mode: 'viewer',           // viewer (lobby) | play | queue
    token: null, kickReason: null, queuePos: 0, cap: NET.maxPlayers,
    meta: new Map(),                                   // id -> {name, color, score, deaths, away}
    // the room list, and the selected (or our own) room's detail: name, admin id, roster, queue, bots,
    // and `mine`: we are its admin (pending, before FIGHT, or as its player) (SPEC §17)
    lobby: { rooms: [], maxRooms: 10, room: null, rname: null, admin: null, players: [], queue: [], cap: NET.maxPlayers, bots: 0, botMax: NET.maxPlayers - 1, mine: false },
    me: null,                                          // the predicted local player (sim object)
    stats: { rtt: 0, rttAvg: 0, rttMax: 0, offset: 0, jitter: 0, reconnects: 0, snaps: 0, snapGapMax: 0,
      predErr: [], predErrSum: 0, predErrN: 0, snaps_: 0, extrapolating: false, corrections: 0, snapsSnapped: 0 },
    serverTick: 0,
    word: lsWord(),                                    // log word id: offered on connect, set by the welcome
    // the settings of the room we look at (SPEC §17.1): the sim constants prediction must use (the
    // server steps the room with exactly these) and the room-wide display switches (gore, blood style)
    cfg: cfgFromDiff({}),
  };
  let cfgSig = '{}';
  // Take the room's settings from a diff against ROOM_DEFAULTS (welcome, lobby or `cfg` event).
  function setCfg(diff, ev = null) {
    const cfg = cfgFromDiff(diff), sig = JSON.stringify(cfgDiff(cfg));
    if (sig === cfgSig && !ev) return;
    cfgSig = sig; net.cfg = cfg;
    dbg('life', 'room settings', { n: Object.keys(cfgDiff(cfg)).length, ...(ev && ev.reset ? { reset: true } : {}) });
    onCfg(ev);
  }
  if (net.word) setWordId(net.word);
  let ws = null, want = null, attempts = 0, retryTimer = 0, pingTimer = 0, pingId = 0;
  let dropped = false, sentToken = null, kicked = false;
  // Restarts (SPEC §18): `restarting` from the server's {t:'restart'} or its NET.restartClose until the
  // next welcome (the game stays frozen on its last frame meanwhile; reconnects are paced for
  // RESTART_MS); `halted` once a welcome said this page's rules differ from the server's: nothing is
  // sent or handled any more, and the page (game.js, net.onOutdated) reloads.
  let restarting = false, restartUntil = 0, halted = false, resumeAfterRestart = false;
  net.lostToRestart = false;                           // an `expired` resume right after a restart: the server couldn't keep the game
  let viewWant = 0;                                    // the room picked in the lobby (asked for again after a reconnect)
  let heardAt = 0;                                     // when the server last sent anything (heartbeat watchdog)
  // Inputs go out only after this socket's welcome: until then `seq` still counts the old session,
  // and the server (which restarts seq at the hello) would take those numbers and then ignore the
  // restarted ones as stale, freezing the player.
  let live = false;
  const rtts = [];
  let seq = 0, pending = [], unsent = [];
  let prevKeys = 0, localThrowCd = 0;                  // the local throw's immediate sound/animation
  let localThrows = [];   // seq numbers of our recent throws (see localTick)
  const snaps = [];                                    // [{tick, at, players: Map}]
  const taken = new Set();                             // ids of pickups we took (hidden before the snapshots catch up)
  let arrOff = null, lastSnapAt = 0, lastFxTick = 0;
  const evq = [];
  const walk = new Map();                              // per remote id, for the run animation
  let smooth = { x: 0, y: 0, n: 0 };
  let ranOut = false;

  const status = s => { net.state = s; onStatus(s); };

  function url() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + (net.word ? '?id=' + net.word : ''); }

  net.connect = function connect() {
    clearTimeout(retryTimer);
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* ignore */ } }
    status('connecting');
    kicked = false; live = false;
    const sock = ws = new WebSocket(url());
    sock.onopen = () => {
      if (sock !== ws) return;
      status('open');
      dbg('net', attempts ? 'reconnected' : 'connect', { attempts });
      if (want) hello();
      // Heartbeat (SPEC §6.4): ping twice a second from the moment the socket opens, whatever the
      // mode (lobby viewer, queue or play). The server closes a connection silent for 5 s.
      heardAt = performance.now();
      clearInterval(pingTimer);
      ping(); pingTimer = setInterval(ping, NET.pingMs);
    };
    sock.onmessage = e => { if (sock === ws && !frozen && !halted) { heardAt = performance.now(); onMessage(e.data); } };
    sock.onclose = e => { if (sock !== ws) return; if (frozen) frozen.close = e.code; else closed(e.code); };
  };

  function ping() { send({ t: 'ping', id: ++pingId, ct: performance.now() }); }

  // The socket is gone. A kick (4000-4999, except the heartbeat timeout) ends the session; anything
  // else, the heartbeat timeout included, is a network drop: reconnect with backoff and resume.
  function closed(code) {
    clearInterval(pingTimer);
    dbg('net', 'close', { code });
    ws = null;
    if (halted) return;
    // The server is restarting (SPEC §18): keep the last frame (our player, the snapshots) and
    // reconnect every ~0.7 s for RESTART_MS, resuming with our token as after a drop.
    if (code === NET.restartClose || restarting) {
      if (!restarting) { restarting = true; restartUntil = performance.now() + RESTART_MS; dbg('net', 'server restarting'); }
      if (performance.now() < restartUntil) {
        if (want) dropped = true;
        status('restarting');
        retryTimer = setTimeout(net.connect, 400 + Math.random() * 600);
        return;
      }
      restarting = false;                              // too long: carry on as after any drop
    }
    net.me = null; snaps.length = 0; arrOff = null;
    if (code === NET.timeoutClose) dbg('net', 'server closed a silent connection (heartbeat)');
    if (kicked || (code >= 4000 && code < 5000 && code !== NET.timeoutClose)) {
      // a kick ends the session: back to the lobby as a viewer, no resume
      net.token = null; want = null; net.id = null; net.mode = 'viewer';
      status('kicked');
      retryTimer = setTimeout(net.connect, 1000);
      return;
    }
    if (want) dropped = true;
    status('reconnecting');
    const delay = Math.min(8000, 500 * 2 ** attempts) * (.75 + Math.random() * .5);
    attempts++;
    net.stats.reconnects++;
    dbg('net', 'reconnect attempt', { attempt: attempts, inMs: Math.round(delay) });
    retryTimer = setTimeout(net.connect, delay);
  }

  // Watchdog: the server sends snapshots or lobby updates and answers every ping, so a socket that
  // has been quiet for longer than the server's heartbeat is dead even if no close arrived (a
  // background tab whose timers were frozen, a dead NAT mapping). Drop it and reconnect.
  function watchdog() {
    if (frozen || !ws || ws.readyState !== 1) return;
    const quiet = performance.now() - heardAt;
    if (quiet <= NET.heartbeatMs + 1000) return;
    dbg('net', 'server silent, dropping the socket', { ms: Math.round(quiet) });
    const sock = ws;
    sock.onclose = null;
    try { sock.close(); } catch { /* ignore */ }
    closed(1006);
  }
  setInterval(watchdog, 1000);
  // A background tab's timers are throttled (Chrome: about once a second, and after minutes hidden
  // once a minute; phones may freeze the page). Coming back: check the socket at once, ping, and
  // retry a pending reconnect now instead of waiting out the backoff.
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    watchdog();
    if (ws && ws.readyState === 1) ping();
    else if (net.state === 'reconnecting' || net.state === 'restarting') { attempts = 0; net.connect(); }
  });

  function send(obj) { if (!frozen && ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  // The streamed debug log (SPEC §13.5) goes out on this socket whenever it is open.
  setLogSink(str => { if (frozen || !ws || ws.readyState !== 1) return false; ws.send(str); return true; });

  // Test hook: behave like a page whose timers and event handlers are frozen for `ms` (a
  // backgrounded or suspended tab): nothing is sent, incoming messages are lost, and a close that
  // arrives meanwhile is handled only when the page wakes up.
  let frozen = null;
  net.freeze = function freeze(ms) {
    dbg('net', 'test: frozen', { ms });
    frozen = { close: null };
    setTimeout(() => {
      const f = frozen; frozen = null;
      dbg('net', 'test: thawed', { closed: f.close });
      if (f.close != null) closed(f.close); else watchdog();
    }, ms);
  };

  function hello() {
    sentToken = net.token;
    // after a drop, ask to resume only: if the grace period is over the server says `expired`
    // and we go back to the lobby rather than silently joining as someone new
    // A resume names no room (the token knows it); a fresh join names the room.
    const base = { name: want.name, color: want.color, ...(net.word ? { w: net.word } : {}) };
    if (net.token) send({ t: 'hello', ...base, token: net.token, ...(dropped ? { resume: true } : {}) });
    else send({ t: 'hello', ...base, room: want.room });
  }

  // Join room `room` (SPEC §17) with this name and colour.
  net.join = function join(name, color, room) {
    want = { name, color, room };
    dbg('life', 'join', { color, room });
    if (net.state === 'open') hello(); else if (net.state !== 'connecting') net.connect();
  };
  // Create a room ('' for the default "<name>'s room"). It does not join: this connection is its
  // admin (pending) and looks at it; FIGHT then joins it (SPEC §17). `name`: our player name, if any.
  net.create = function create(rname, name) {
    dbg('life', 'create room', { len: (rname || '').length });
    send({ t: 'create', room: rname || '', ...(name ? { name } : {}) });
  };
  // Look at room `id` from the lobby (its roster, snapshots and events), or at none (0).
  net.viewRoom = function viewRoom(id) {
    dbg('life', 'view room', { room: id || 0 });
    viewWant = id || 0;
    send({ t: 'view', room: viewWant });
  };
  // Admin only (the server checks): rename our room, hand the admin role to player `id`.
  net.rename = function rename(name) { dbg('life', 'rename room', { len: name.length }); send({ t: 'rename', name }); };
  net.makeAdmin = function makeAdmin(id) { dbg('life', 'make admin', { id }); send({ t: 'admin', id }); };
  net.isAdmin = () => !!net.lobby.mine;
  // Admin only (the server checks): change the room's settings ({key: value}) or reset them (SPEC §17.1).
  net.setCfg = function setCfgMsg(set) { dbg('life', 'room setting', { keys: Object.keys(set).join(',') }); send({ t: 'cfg', set }); };
  net.resetCfg = function resetCfg() { dbg('life', 'room settings reset'); send({ t: 'cfg', reset: true }); };
  // Forget what we drew of the room we looked at (another room, or none, is coming).
  function resetView() {
    snaps.length = 0; evq.length = 0; taken.clear(); arrOff = null; walk.clear();
  }
  // Leave the arena on purpose: the server frees the slot at once (no resume) and this connection
  // carries on as a lobby viewer.
  net.leave = function leave() {
    dbg('life', 'leave');
    send({ t: 'leave' });
    viewWant = net.lobby.room || 0;                    // the server keeps us looking at the room we left
    net.token = null; want = null; net.id = null; net.mode = 'viewer'; net.me = null; net.queuePos = 0;
    live = false; dropped = false; seq = 0; pending = []; unsent = [];
  };
  // Send a chat line (SPEC §9). Only its length is logged, never the text.
  // Ask for one AI player more (d = 1) or fewer (d = -1) (SPEC §15). The server answers with a
  // lobby message carrying the new count; nothing changes here until then.
  net.bots = function bots(d) {
    dbg('life', 'bots', { d });
    send({ t: 'bots', d: d > 0 ? 1 : -1 });
  };
  net.chat = function chat(text) {
    dbg('chat', 'sent', { len: Array.from(text).length });
    send({ t: 'chat', text });
  };
  // Test hook: drop the connection as if the network failed (the token is kept for resume).
  net.drop = function drop() { if (ws) ws.close(); };

  function onMessage(data) {
    let m;
    try { m = JSON.parse(data); } catch { dbg('error', 'bad server message'); return; }
    switch (m.t) {
      case 'snapshot': return onSnapshot(m);
      case 'event': return onEvents(m);
      case 'lobby': return onLobbyMsg(m);
      case 'pong': return onPong(m);
      case 'welcome': return onWelcome(m);
      case 'refused':                                  // a request turned down without a kick (SPEC §17)
        dbg('net', 'refused', { what: m.what, why: m.why });
        if ((m.what === 'join' || m.what === 'create') && net.id == null) { want = null; net.mode = 'viewer'; }
        return onRefused(m);
      case 'closed':                                   // the room we looked at closed
        dbg('life', 'room closed', { room: m.room, why: m.why });
        if (viewWant === m.room) viewWant = 0;
        return onClosed(m);
      case 'restart':                                  // the server is about to restart (SPEC §18)
        restarting = true; restartUntil = performance.now() + RESTART_MS;
        dbg('net', 'server restarting');
        return;
      case 'kick':
        kicked = true; net.kickReason = m.reason;
        dbg('net', 'kick', { reason: m.reason });
        sendReport('auto', 'kick: ' + m.reason);
        return;
    }
  }

  function onWelcome(m) {
    if (m.cap) net.cap = m.cap;
    if (m.b) net.serverBuild = m.b;
    if (typeof m.r === 'string') net.serverRules = m.r;
    // Versions (SPEC §18). The first welcome on every socket (the connection welcome) is checked, so
    // this runs before our resume's welcome can put us back in the game.
    const v = compareVersion({ rules: net.rules, build: net.build }, m);
    if (restarting) { restarting = false; resumeAfterRestart = !!want; }
    if (v === 'outdated') return outdated(m);
    if (v === 'ui' && net.uiStale !== m.b) { net.uiStale = m.b; dbg('net', 'ui older than the server', { page: net.build, server: m.b }); }
    if (isWordId(m.w) && m.w !== net.word) {             // the server's word id for this browser (SPEC §13.5)
      net.word = m.w;
      try { localStorage.setItem(LS_WORD, m.w); } catch { /* private mode: a new id each visit */ }
    }
    if (m.w) { setWordId(net.word); if (net.onWord) net.onWord(net.word); }
    if (m.expired) {                                    // our resume came too late: the slot is gone
      dbg('net', 'resume refused: grace period over');
      sendReport('auto', 'resume expired');
      net.token = null; want = null; net.id = null; net.mode = 'viewer'; net.me = null; net.queuePos = 0;
      dropped = false; attempts = 0; live = false; seq = 0; pending = []; unsent = [];
      net.kickReason = 'expired';
      net.lostToRestart = resumeAfterRestart; resumeAfterRestart = false;
      status('expired');
      status('open');
      return;
    }
    if (m.id == null) {                                 // connection welcome (before hello)
      net.serverTick = m.tick;
      if (viewWant && !want) send({ t: 'view', room: viewWant });   // a new socket looks at nothing until told
      return;
    }
    const wasDrop = dropped;
    dropped = false; attempts = 0; resumeAfterRestart = false; net.lostToRestart = false;
    if (sentToken && !m.resumed) { dbg('net', 'resume refused'); sendReport('auto', 'resume refused'); }
    if (sentToken && m.resumed) dbg('net', 'resume accepted', { id: m.id });
    net.id = m.id; net.token = m.token; net.mode = m.state; net.queuePos = m.queuePos;
    net.kickReason = null;
    want.name = m.name.replace(/#\d+$/, '');
    seq = 0; pending = []; unsent = []; localThrows = []; net.me = null; live = true;
    for (const p of m.players) net.meta.set(p.id, { ...p });
    for (const q of m.queue) if (!net.meta.has(q.id)) net.meta.set(q.id, { ...q, score: 0, deaths: 0 });
    net.meta.set(m.id, { ...(net.meta.get(m.id) || { score: 0, deaths: 0 }), id: m.id, name: m.name, color: m.color });
    onLobbyMsg({ ...net.lobby, room: m.room, rname: m.rname, admin: m.admin, players: m.players, queue: m.queue, cap: m.cap, mine: m.admin === m.id, cfg: m.cfg });
    dbg('life', m.state === 'play' ? 'in arena' : 'queued', { id: m.id, queuePos: m.queuePos, resumed: m.resumed });
    if (wasDrop) sendReport('auto', 'reconnected after drop');
    status('open');
  }

  // This page can't play with the server any more (SPEC §18): its rules differ. Stop for good: the slot
  // we may hold (a resume hello may already be on its way) is given up with `leave`, nothing more is
  // sent or handled, and net.onOutdated({playing}) lets the game show why and reload. `playing`:
  // there was a game to lose (we were in a room's arena or queue); a viewer has nothing to lose.
  function outdated(m) {
    const playing = net.id != null || !!want;
    dbg('net', 'outdated: the server runs other rules', { page: net.rules, server: m.r ?? null, build: m.b ?? null, playing });
    if (net.token || net.id != null) send({ t: 'leave' });
    halted = true;
    clearTimeout(retryTimer); clearInterval(pingTimer);
    want = null; net.token = null; net.id = null; net.mode = 'viewer'; live = false; pending = []; unsent = [];
    status('outdated');
    if (net.onOutdated) net.onOutdated({ playing, server: m.r ?? m.b ?? null });
  }
  net.halted = () => halted;
  net.restarting = () => restarting;              // the server said it is restarting and no welcome has come since

  function onLobbyMsg(m) {
    // bots / botMax (SPEC §15) come with every lobby message; a welcome's roster leaves them as they were
    // rooms (SPEC §17): the list, and the room we look at (null: none, the plain list)
    const room = m.room ?? null;
    if (room !== net.lobby.room) { resetView(); dbg('life', 'room view', { from: net.lobby.room, to: room }); onRoom(room); }
    net.lobby = { rooms: Array.isArray(m.rooms) ? m.rooms : net.lobby.rooms, maxRooms: m.maxRooms || net.lobby.maxRooms,
      room, rname: m.rname ?? null, admin: m.admin ?? null, mine: !!m.mine,
      players: m.players || [], queue: m.queue || [], cap: m.cap || net.cap,
      bots: Number.isInteger(m.bots) ? m.bots : net.lobby.bots, botMax: Number.isInteger(m.botMax) ? m.botMax : net.lobby.botMax };
    // the room's settings come with every lobby message (none from an older server: the defaults)
    setCfg(room ? m.cfg : null);
    if (net.lobby.mine && net.id == null && room) viewWant = room;   // our new room (create), looked at after a reconnect too
    for (const p of net.lobby.players) net.meta.set(p.id, { ...(net.meta.get(p.id) || {}), ...p });
    if (net.id != null && net.mode === 'queue') {
      const i = net.lobby.queue.findIndex(q => q.id === net.id);
      if (i >= 0 && i + 1 !== net.queuePos) { net.queuePos = i + 1; dbg('life', 'queue position', { pos: net.queuePos }); }
    }
    onLobby(net.lobby);
  }

  function onPong(m) {
    const now = performance.now(), rtt = now - m.ct;
    if (!(rtt >= 0 && rtt < 30000)) return;
    rtts.push(rtt); if (rtts.length > 30) rtts.shift();
    const s = net.stats;
    s.rtt = rtt; s.rttAvg = rtts.reduce((a, b) => a + b, 0) / rtts.length; s.rttMax = Math.max(...rtts);
    // estimated server tick now = pong tick + fraction + one-way time
    const off = m.tick + m.tf + rtt / 2 / TICK_MS - now / TICK_MS;
    s.offset = s.offset && rtts.length > 1 ? s.offset + (off - s.offset) * .2 : off;
    dbg('sync', 'rtt', { rtt: Math.round(rtt), offTicks: Math.round(off * 10) / 10 });
  }

  // ---------- events ----------
  function onEvents(m) {
    for (const e of m.ev) {
      if (e.type === 'join') {
        net.meta.set(e.id, { ...(net.meta.get(e.id) || { score: 0, deaths: 0 }), id: e.id, name: e.name, color: e.color, away: false, bot: !!e.bot });
        if (e.id === net.id) { net.mode = 'play'; net.queuePos = 0; dbg('life', 'promoted', { id: e.id }); }
      } else if (e.type === 'leave') {
        const mm = net.meta.get(e.id); if (mm) mm.gone = true;
      } else if (e.type === 'rename') {   // a freed name passed to its "#2" holder (SPEC §9)
        const mm = net.meta.get(e.id); if (mm) mm.name = e.name;
        for (const p of [...net.lobby.players, ...net.lobby.queue]) if (p.id === e.id) p.name = e.name;
        if (e.id === net.id) dbg('life', 'renamed', { id: e.id });
        onLobby(net.lobby);
      } else if (e.type === 'admin') {    // the admin role moved (SPEC §17): a transfer or the old admin gone for good
        net.lobby.admin = e.id; net.lobby.mine = e.id != null && e.id === net.id;
        if (e.id === net.id) dbg('life', 'made admin', { why: e.why });
        onLobby(net.lobby);
        if (e.id != null && e.id === net.id) onMadeAdmin(e);   // tell them, in the lobby or in game
      } else if (e.type === 'cfg') {      // the admin changed the room's settings (SPEC §17.1)
        setCfg(e.cfg, e);
      } else if (e.type === 'room') {     // the admin renamed the room
        net.lobby.rname = e.name;
        for (const r of net.lobby.rooms) if (r.id === e.id) r.name = e.name;
        onLobby(net.lobby);
      } else if (e.type === 'score') {
        const mm = net.meta.get(e.id); if (mm) { mm.score = e.score; mm.deaths = e.deaths; }
      }
      if (e.type === 'chat') dbg('chat', 'received', { id: e.id, len: Array.from(e.text || '').length });
      if (e.type === 'spawn' && e.id === net.id) dbg('life', 'spawn', { x: Math.round(e.x), y: Math.round(e.y) });
      if (e.type === 'kill' && e.victim === net.id) {
        dbg('life', 'death', { killer: e.killer, move: e.move });
        if (e.held) dbg('life', 'long sword lost', { cause: 'death', move: e.move });
        if (e.stars) dbg('life', 'stars lost', { n: e.stars, cause: 'death' });
      }
      if (e.type === 'pickup' && e.id === net.id) {
        if (!e.left) taken.add(e.item);            // a star pickup with stars left over stays
        if (e.kind === 'star') dbg('life', 'stars gained', { item: e.item, gain: e.gain, now: e.stars, x: e.x, y: e.y, ...(e.left ? { left: e.left } : {}) });
        else dbg('life', 'long sword taken', { item: e.item, x: e.x, y: e.y });
      }
      if (e.type === 'throw' && e.id === net.id) dbg('life', 'star thrown', { star: e.star, left: e.stars });
      // effects about me play at once; the rest when the interpolated view reaches their tick
      const mine = e.victim === net.id || e.attacker === net.id || ((e.type === 'spawn' || e.type === 'pickup' || e.type === 'throw') && e.id === net.id) || !('x' in e);
      evq.push({ e, due: mine ? -Infinity : e.tick });
    }
  }
  // Events whose time has come on the render timeline.
  net.dueEvents = function dueEvents(now = performance.now()) {
    const R = net.renderTick(now), out = [];
    while (evq.length && (evq[0].due <= R || evq.length > 200 || snaps.length === 0)) out.push(evq.shift().e);
    // keep order but release "mine" events stuck behind a later one
    for (let i = 0; i < evq.length; i++) if (evq[i].due === -Infinity) { out.push(evq[i].e); evq.splice(i--, 1); }
    return out;
  };

  // ---------- snapshots: reconciliation + interpolation buffer ----------
  function onSnapshot(m) {
    const now = performance.now(), s = net.stats;
    const players = new Map();
    for (const a of m.p) players.set(a[0], unpack(a));
    if (snaps.length && m.tick <= snaps[snaps.length - 1].tick) return;
    snaps.push({ tick: m.tick, at: now, players, items: unpackItems(m.it), flying: unpackFlying(m.st) });
    const ids = new Set(); for (const s2 of snaps) for (const i of s2.items) ids.add(i.id);
    for (const i of taken) if (!ids.has(i)) taken.delete(i);
    if (snaps.length > SNAP_KEEP) snaps.shift();
    net.serverTick = m.tick;
    s.snaps++;
    // arrival clock: tracks the early envelope of (tick - local time), so late snapshots are jitter
    const sample = m.tick - now / TICK_MS;
    if (arrOff === null || sample > arrOff + 30 || sample < arrOff - 30) arrOff = sample;
    else {
      const late = (arrOff - sample) * TICK_MS;
      s.jitter = s.jitter * .95 + Math.abs(late) * .05;
      arrOff += (sample - arrOff) * (sample > arrOff ? .25 : .01);
    }
    if (lastSnapAt) {
      const gap = now - lastSnapAt;
      if (gap > 100) dbg('sync', 'snapshot gap', { ms: Math.round(gap) });
      s.snapGapMax = Math.max(s.snapGapMax * .999, gap);
    }
    lastSnapAt = now;
    dbgv('verbose', 'snapshot', { tick: m.tick, seq: m.seq, n: m.p.length });
    if (m.me) reconcile(m); else net.me = null;
  }

  // SPEC §6.2: reset to the server's state for our player, replay the inputs it hasn't processed.
  function reconcile(m) {
    const before = net.me;
    const me = m.me;
    pending = pending.filter(p => p.seq > m.seq);
    localThrows = localThrows.filter(t => t > m.seq);   // throws up to m.seq are already in me.stars
    const world = { tick: m.tick, rng: 1, players: obstacles(m.tick, me) };
    for (const p of pending) Sim.predictStep(world, me.id, p.keys, { cfg: net.cfg, level: LEVEL });
    net.me = me;
    if (!before || !before.alive || !me.alive) { smooth = { x: 0, y: 0, n: 0 }; return; }
    const ex = before.x + smooth.x * smooth.n / NET.smoothFrames - me.x;
    const ey = before.y + smooth.y * smooth.n / NET.smoothFrames - me.y;
    const rawErr = Math.hypot(before.x - me.x, before.y - me.y);
    recordErr(rawErr);
    if (rawErr === 0) return;
    net.stats.corrections++;
    if (rawErr < NET.smoothUnits) { smooth = { x: ex, y: ey, n: NET.smoothFrames }; dbgv('verbose', 'correction', { err: rawErr }); }
    else { smooth = { x: 0, y: 0, n: 0 }; net.stats.snapsSnapped++; dbg('sync', 'snap correction', { err: Math.round(rawErr * 100) / 100, seq: m.seq }); }
  }
  function recordErr(e) {
    const s = net.stats;
    s.predErr.push(e); if (s.predErr.length > ERR_KEEP) s.predErr.shift();
    s.predErrSum += e * e; s.predErrN++;
  }
  net.predErrRms = () => Math.sqrt(net.stats.predErrSum / Math.max(1, net.stats.predErrN));
  net.resetPredErr = () => { net.stats.predErrSum = 0; net.stats.predErrN = 0; net.stats.predErr.length = 0; };

  // Other living players as fixed obstacles for prediction: their newest snapshot positions.
  function obstacles(tick, me) {
    const last = snaps[snaps.length - 1];
    const list = [me];
    if (last) for (const p of last.players.values()) if (p.id !== me.id && p.alive)
      list.push({ ...p, px: p.x, py: p.y, keys: 0, standOn: null, hitSet: [] });
    return list.sort((a, b) => a.id - b.id);
  }

  // ---------- local ticks ----------
  // Called once per 60 Hz client tick with this tick's key mask.
  net.localTick = function localTick(keys) {
    if (smooth.n > 0) smooth.n--;
    if (net.mode !== 'play' || !live || !ws || ws.readyState !== 1) { prevKeys = keys; return; }
    seq++;
    unsent.push(keys);
    if (net.me) {
      pending.push({ seq, keys });
      if (pending.length > PENDING_MAX) pending.shift();
      const world = { tick: 0, rng: 1, players: obstacles(0, net.me) };
      Sim.predictStep(world, net.me.id, keys, { cfg: net.cfg, level: LEVEL });
      // A throw is not predicted (no star, no count change: both come from the server), but its
      // sound and arm flick play at once: the FX bit is set when the press would be accepted.
      localThrowCd = Math.max(0, localThrowCd - 1);
      const me = net.me;
      // The server's own cooldown and star count reach us late (they are a snapshot old), so they
      // must not gate the sound: a quick second or third throw would stay silent. We count our own
      // cooldown, and take off the stars of our throws the server has not processed yet (seq > the
      // snapshot's m.seq; reconcile drops the rest, which me.stars already counts).
      if ((keys & KEY.THROW) && !(prevKeys & KEY.THROW) && me.alive && (me.stars | 0) - localThrows.length > 0 && me.stun <= 0 && localThrowCd <= 0) {
        me.fx |= FX.THROW; localThrowCd = net.cfg.throwCd; localThrows.push(seq);
      }
    }
    prevKeys = keys;
  };
  // Send this frame's inputs, at most 3 ticks per message.
  net.flush = function flush() {
    while (unsent.length) {
      const batch = unsent.splice(0, NET.maxInputBatch);
      const first = seq - unsent.length - batch.length + 1;
      send({ t: 'input', seq: first, keys: batch.length === 1 ? batch[0] : batch });
    }
  };

  // ---------- the render view ----------
  net.renderTick = (now = performance.now()) => (arrOff === null ? net.serverTick : now / TICK_MS + arrOff - INTERP_TICKS);
  net.serverTickNow = (now = performance.now()) => now / TICK_MS + net.stats.offset;

  // Players to draw: remotes interpolated at the render tick, our own predicted player (smoothed).
  // Also returns the remote fx flags whose snapshots the timeline passed since the last call.
  net.view = function view(now = performance.now()) {
    const players = [], fx = [];
    const R = net.renderTick(now);
    if (snaps.length) {
      let i = snaps.length - 1;
      while (i > 0 && snaps[i].tick > R) i--;
      const a = snaps[i], b = snaps[i + 1];
      let k = 0, ext = 0;
      if (b) k = Math.max(0, Math.min(1, (R - a.tick) / (b.tick - a.tick)));
      else if (R > a.tick) {
        ext = Math.min(R - a.tick, EXTRAP_TICKS);
        if (R - a.tick > EXTRAP_TICKS && !ranOut) { ranOut = true; net.stats.extrapolating = true; dbg('sync', 'extrapolation ran out', { behindTicks: Math.round(R - a.tick) }); }
      }
      if (b || R <= a.tick) { ranOut = false; net.stats.extrapolating = false; }
      for (const pa of a.players.values()) {
        if (pa.id === net.id && net.me) continue;
        const pb = b && b.players.get(pa.id);
        const p = { ...pa, keys: 0, standOn: null };
        if (pb && pa.alive && pb.alive && Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y) < 48) {
          p.x = pa.x + (pb.x - pa.x) * k; p.y = pa.y + (pb.y - pa.y) * k;
          p.vx = pa.vx + (pb.vx - pa.vx) * k; p.vy = pa.vy + (pb.vy - pa.vy) * k;
          if (k > .5) Object.assign(p, { face: pb.face, atk: pb.atk, atkType: pb.atkType, onGround: pb.onGround, iframes: pb.iframes, stun: pb.stun, hp: pb.hp, long: pb.long });
        } else if (ext && pa.alive) { p.x += pa.vx * ext; p.y += pa.vy * ext; }
        const w = walk.get(p.id) || { x: p.x, walk: 0 };
        w.walk += Math.min(4, Math.abs(p.x - w.x)); w.x = p.x; walk.set(p.id, w);
        p.walk = w.walk;
        players.push(p);
      }
      for (const s of snaps) if (s.tick > lastFxTick && s.tick <= R) {
        for (const p of s.players.values()) if (p.fx && p.id !== net.id) fx.push({ id: p.id, fx: p.fx, standOn: null });
        lastFxTick = s.tick;
      }
    }
    if (net.me) {
      const f = smooth.n / NET.smoothFrames;
      players.push({ ...net.me, x: net.me.x + smooth.x * f, y: net.me.y + smooth.y * f });
    }
    players.sort((a, b) => a.id - b.id);
    // pickups as of the render tick, minus any we took ourselves (released at once, not interpolated)
    const at = snaps.length ? snaps[Math.max(0, snaps.findLastIndex(s => s.tick <= R))] : null;
    const items = at ? at.items.filter(i => !taken.has(i.id)) : [];
    // ninja stars in flight, interpolated like remote players (between the snapshots around the
    // render tick; a star missing from the later one ended in between and shows until the midpoint)
    const stars = [];
    if (snaps.length) {
      let i = snaps.length - 1;
      while (i > 0 && snaps[i].tick > R) i--;
      const a = snaps[i], b = snaps[i + 1];
      const k = b ? Math.max(0, Math.min(1, (R - a.tick) / (b.tick - a.tick))) : 0;
      const ext = b ? 0 : Math.max(0, Math.min(R - a.tick, EXTRAP_TICKS));
      for (const fa of (a.flying || new Map()).values()) {
        const fb = b && b.flying && b.flying.get(fa.id);
        if (fb) stars.push({ ...fa, x: fa.x + (fb.x - fa.x) * k, y: fa.y + (fb.y - fa.y) * k });
        else if (!b) stars.push({ ...fa, x: fa.x + fa.vx * ext });
        else if (k < .5) stars.push({ ...fa, x: fa.x + fa.vx * (R - a.tick) });
      }
    }
    return { tick: Math.floor(R), players, fx, items, stars };
  };

  net.snapshots = snaps;
  net.pending = () => pending.length;
  return net;
}
