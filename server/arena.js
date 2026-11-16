// The authoritative arena: one shared world, the 60 Hz tick loop, the protocol (SPEC §6.1), the
// lobby, the 12 slots and the FIFO spectator queue, resume tokens, idle kicks and lag-compensated
// slashes. It knows nothing about sockets: a connection is any object with send(string) and
// close(code, reason), so unit tests can drive it with fakes and call tick() by hand.
// AI players (SPEC §15) are records with `bot: true` and no connection; server/ai.js drives them.
import { randomBytes } from 'node:crypto';
import * as Sim from '../shared/sim.js';
import { DEFAULTS, NET, TICK_MS, COLORS, KEY, KEY_MASK, cleanName, cleanChat, CHAT, BOT } from '../shared/constants.js';
import { newBrain, botKeys, navOf } from './ai.js';

export const PROTOCOL = 1;
const SNAP_DIV = Math.round(60 / NET.snapshotHz);   // a snapshot every 2nd tick
const MAX_QUEUED_INPUTS = 12;                       // ~200 ms of buffered inputs per player
const STARVE_ZERO_TICKS = 8;                        // repeat the last input this long, then use 0
const DRAIN_WINDOW = 30;                            // ticks over which a standing input backlog is measured
const PRESS_BITS = KEY.JUMP | KEY.SLASH | KEY.THROW; // edge-triggered keys a skipped input must not lose
const LOBBY_MIN_MS = 500;                           // lobby broadcasts are coalesced to 2/s
const PING_RATE = 10;                               // non-input messages per second
const FLOOD_KICK_DROPS = 90;                        // dropped messages within FLOOD_WINDOW_MS → kick
const FLOOD_WINDOW_MS = 3000;

// Close codes sent with a kick (the client treats 4000-4999 as "don't resume", except
// NET.timeoutClose, the heartbeat timeout, which is not a kick: the client reconnects and resumes).
export const KICK = Object.freeze({
  idle: 4001, malformed: 4002, unknown: 4003, flood: 4004, protocol: 4005, 'bad hello': 4006,
  replaced: 4007, shutdown: 4008,
});

const r2 = v => Math.round(v * 100) / 100;

export class Arena {
  constructor({ cfg = DEFAULTS, level = Sim.LEVEL, now = () => performance.now(), log = () => {}, event = () => {},
    maxPlayers = NET.maxPlayers, graceMs = NET.graceMs, idleMs = NET.idleMs, heartbeatMs = NET.heartbeatMs,
    maxPerIp = Infinity, seed, build = '' } = {}) {
    this.build = build;   // the server's build id, sent in every welcome (SPEC §10)
    this.cfg = cfg; this.level = level; this.now = now; this.log = log; this.event = event; this.maxPerIp = maxPerIp;
    this.maxPlayers = maxPlayers; this.graceMs = graceMs; this.idleMs = idleMs;
    this.heartbeatMs = heartbeatMs;   // 0 or Infinity: no heartbeat (never used by the server itself)
    this.state = Sim.createWorld({ seed: seed ?? (randomBytes(4).readUInt32BE() % 2147483646) + 1 });
    this.hist = Sim.createHistory();
    this.conns = new Set();
    this.recs = new Map();        // player id -> record (active, queued or waiting for a resume)
    this.tokens = new Map();      // resume token -> record (never logged or stored)
    this.queue = [];              // queued records, FIFO
    this.bots = [];               // bot records in the order they were added (SPEC §15)
    this.botBucket = { tokens: BOT.globalBurst, at: now() };   // arena-wide bot add/remove budget
    navOf(level, cfg);            // build the bots' route table now, not on the first + press
    this.nextId = 1; this.nextConn = 1;
    this.lobbyDirty = false; this.lobbyAt = -Infinity;
    this.tickStats = { n: 0, sum: 0, max: 0, overruns: 0, recent: [] };
    this.startedAt = now();
  }

  // ---------- connections ----------
  // conn: { send(str), close(code, reason), ip }. Returns the connection record.
  connect(transport) {
    const conn = { ...transport, id: this.nextConn++, rec: null, rtt: 0, connectedAt: this.now(),
      bucket: NET.inputRate, pingBucket: PING_RATE, bucketAt: this.now(), drops: [], dropCount: 0,
      inCount: 0, inRate: 0, rateAt: this.now(), heardAt: this.now(), closed: false };
    this.conns.add(conn);
    this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, tick: this.state.tick, cap: this.maxPlayers, colors: COLORS });
    this.send(conn, this.lobbyMsg());
    return conn;
  }

  send(conn, msg) {
    if (conn.closed) return;
    try { conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  kick(conn, reason) {
    if (conn.closed) return;
    this.log(`kick conn=${conn.id} ip=${conn.ip} reason=${reason}`);
    this.event('kick', conn.id, { reason, player: conn.rec ? conn.rec.id : null });
    this.send(conn, { t: 'kick', reason });
    const rec = conn.rec;
    // A kick ends the player's session: no resume. (Except 'replaced': the record lives on.)
    if (rec && reason !== 'replaced') this.release(rec, 'kick');
    conn.rec = null;
    this.disconnect(conn);
    try { conn.close(KICK[reason] || 4000, reason); } catch { /* already closed */ }
  }

  // Heartbeat (SPEC §6.4): nothing heard from this connection for heartbeatMs. It is closed with
  // NET.timeoutClose, which is not a kick: its player follows the normal dropped-player path (the
  // record is kept for graceMs for a resume, then released).
  timeout(conn) {
    if (conn.closed) return;
    const silentMs = Math.round(this.now() - conn.heardAt);
    this.log(`timeout conn=${conn.id} ip=${conn.ip} silent=${silentMs}ms`);
    this.event('timeout', conn.id, { player: conn.rec ? conn.rec.id : null, silentMs });
    this.disconnect(conn);
    try { conn.close(NET.timeoutClose, 'timeout'); } catch { /* already closed */ }
  }

  // The socket closed (or was kicked). A player keeps its slot for graceMs.
  disconnect(conn) {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    const rec = conn.rec;
    if (rec && rec.conn === conn) {
      rec.conn = null; rec.discAt = this.now(); rec.inputs.length = 0;
      this.log(`drop conn=${conn.id} id=${rec.id}`);
      this.event('drop', conn.id, { player: rec.id });
      this.lobbyDirty = true;
    }
  }

  // ---------- messages ----------
  onMessage(conn, data) {
    if (conn.closed) return;
    conn.heardAt = this.now();          // any message counts for the heartbeat
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch { return this.kick(conn, 'malformed'); }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return this.kick(conn, 'malformed');
    if (!this.allow(conn, m.t)) return;
    switch (m.t) {
      case 'input': return this.onInput(conn, m);
      case 'ping': return this.onPing(conn, m);
      case 'hello': return this.onHello(conn, m);
      case 'leave': return this.onLeave(conn);
      case 'chat': return this.onChat(conn, m);
      case 'bots': return this.onBots(conn, m);
      default: return this.kick(conn, 'unknown');
    }
  }

  // Chat (SPEC §9). Only a player in the arena or the queue may chat; a viewer's message is ignored.
  // Per-player token bucket kept on the record (so a reconnect does not refill it): burst 3, one
  // more every 1.5 s. A message over the limit is dropped and counts toward the flood kick. The
  // text is relayed as an event to every connection and is never logged: only its length is.
  onChat(conn, m) {
    if (typeof m.text !== 'string') return this.kick(conn, 'malformed');
    const rec = conn.rec;
    if (!rec) return;
    const now = this.now();
    const c = rec.chat || (rec.chat = { tokens: CHAT.burst, at: now });
    c.tokens = Math.min(CHAT.burst, c.tokens + (now - c.at) / CHAT.refillMs);
    c.at = now;
    if (c.tokens < 1) return this.dropped(conn);
    const text = cleanChat(m.text);
    if (!text) return;
    c.tokens -= 1;
    this.event('chat', conn.id, { player: rec.id, len: Array.from(text).length });
    this.broadcastEvents([{ type: 'chat', id: rec.id, text }]);
  }

  // Drop a rate-limited message: it counts toward the flood kick like allow()'s drops.
  dropped(conn) {
    const now = this.now();
    conn.dropCount++;
    conn.drops.push(now);
    while (conn.drops.length && conn.drops[0] < now - FLOOD_WINDOW_MS) conn.drops.shift();
    if (conn.drops.length === 1 || conn.dropCount % 50 === 0) this.event('ratelimit', conn.id, { dropped: conn.dropCount });
    if (conn.drops.length >= FLOOD_KICK_DROPS) this.kick(conn, 'flood');
  }

  // AI players (SPEC §15): {t:'bots', d: 1|-1} adds or removes one, {t:'bots', n} asks for n in all.
  // Any connection may send it (lobby viewers too). Anything else in d/n is a `malformed` kick. Each
  // connection has a bucket (BOT.burst, one more every BOT.refillMs; an empty bucket drops the message
  // and counts toward the flood kick) and the arena has one more, charged per bot actually added or
  // removed (BOT.globalBurst, one every BOT.globalRefillMs), so many connections together still can't
  // put more than a few spawns a second on the tick loop. The sender gets the lobby at once; everyone
  // else with the next (coalesced) lobby broadcast.
  onBots(conn, m) {
    const hasD = m.d !== undefined, hasN = m.n !== undefined;
    if (hasD === hasN || (hasD && m.d !== 1 && m.d !== -1) || (hasN && (!Number.isInteger(m.n) || m.n < 0 || m.n > this.maxBots())))
      return this.kick(conn, 'malformed');
    const now = this.now();
    const c = conn.botBucket || (conn.botBucket = { tokens: BOT.burst, at: now });
    c.tokens = Math.min(BOT.burst, c.tokens + (now - c.at) / BOT.refillMs); c.at = now;
    if (c.tokens < 1) return this.dropped(conn);
    c.tokens -= 1;
    const want = hasN ? m.n : this.bots.length + m.d;
    const g = this.botBucket;
    g.tokens = Math.min(BOT.globalBurst, g.tokens + (now - g.at) / BOT.globalRefillMs); g.at = now;
    let changed = 0;
    while (g.tokens >= 1 && want > this.bots.length && this.addBot(conn)) { g.tokens -= 1; changed++; }
    while (g.tokens >= 1 && want < this.bots.length) { this.removeBot(conn); g.tokens -= 1; changed++; }
    this.event('bots', conn.id, { want, n: this.bots.length, changed });
    this.send(conn, this.lobbyMsg());
  }

  maxBots() { return Math.max(0, this.maxPlayers - 1); }

  // Add a bot in a free slot. Refused (false) at maxBots or with no free slot: bots never evict and
  // never queue. Name "AI n" with the lowest free n (then the usual #2 de-duplication); the reserved
  // colour BOT.color, which no human can pick, so freeColor() leaves it alone.
  addBot(conn = null) {
    if (this.bots.length >= this.maxBots() || this.activeCount() >= this.maxPlayers) return false;
    const used = new Set(this.bots.map(r => r.botNo));
    let no = 1; while (used.has(no)) no++;
    const id = this.nextId++;
    const rec = {
      id, name: this.uniqueName(`${BOT.name} ${no}`), color: BOT.color, token: null, bot: true, botNo: no,
      brain: newBrain(this.state.rng ^ (id * 7919)),   // seeded from the sim's seed, without consuming it
      conn: null, ip: null, state: 'queue', inputs: [], lastSeq: -1, maxSeq: -1, lastKeys: 0, starve: 0, carry: 0, minQ: Infinity, qTicks: 0,
      lastActive: this.now(), discAt: null, fx: 0, joinedAt: this.now(),
    };
    this.recs.set(id, rec);
    this.bots.push(rec);
    const saved = this.pendingEvents;
    this.pendingEvents = [];
    this.activate(rec, false, conn);
    this.broadcastEvents([this.joinEvent(rec), ...this.pendingEvents]);
    this.pendingEvents = saved;
    this.lobbyDirty = true;
    return true;
  }

  // Remove the most recently added bot (its slot goes to the first queued human, as any leave does).
  removeBot(conn = null) {
    const rec = this.bots.pop();
    if (!rec) return false;
    this.release(rec, 'bot removed', conn);
    return true;
  }

  // Token buckets: 90 input messages/s, 10 other messages/s. Excess is dropped; sustained excess
  // (90 drops within 3 s) is a kick.
  allow(conn, type) {
    const now = this.now(), dt = (now - conn.bucketAt) / 1000;
    conn.bucketAt = now;
    conn.bucket = Math.min(NET.inputRate, conn.bucket + dt * NET.inputRate);
    conn.pingBucket = Math.min(PING_RATE, conn.pingBucket + dt * PING_RATE);
    const key = type === 'input' ? 'bucket' : 'pingBucket';
    if (conn[key] >= 1) { conn[key] -= 1; return true; }
    this.dropped(conn);
    return false;
  }

  // The player chose to leave: the slot (or queue place) is released at once, with no resume, and
  // the connection stays open as a lobby viewer. A recently hit leaver still counts as a kill.
  onLeave(conn) {
    const rec = conn.rec;
    if (!rec) return;   // already a viewer: nothing to do
    this.release(rec, 'left');
    conn.rec = null;
  }

  onPing(conn, m) {
    if (m.id !== undefined && !Number.isInteger(m.id)) return this.kick(conn, 'malformed');
    if (m.ct !== undefined && !Number.isFinite(m.ct)) return this.kick(conn, 'malformed');
    // tf: how far into the current tick the server is (0..1), for the client's clock sync
    this.send(conn, { t: 'pong', id: m.id ?? 0, ct: m.ct ?? 0, tick: this.state.tick,
      tf: r2(Math.min(1, Math.max(0, (this.now() - this.lastTickAt) / TICK_MS))) });
  }

  onHello(conn, m) {
    if (conn.rec) return this.kick(conn, 'protocol');
    const name = cleanName(m.name);
    const color = m.color;
    // Only the 12 human colours: BOT.color (= COLORS.length, SPEC §15) and anything past it is refused.
    if (!name || !Number.isInteger(color) || color < 0 || color >= COLORS.length) return this.kick(conn, 'bad hello');
    if (m.token !== undefined && (typeof m.token !== 'string' || !/^[0-9a-f]{32}$/.test(m.token))) return this.kick(conn, 'bad hello');

    // resume: the token is valid while the record exists (connected or within the grace period)
    const old = m.token && this.tokens.get(m.token);
    if (old) {
      if (old.conn) { const prev = old.conn; prev.rec = null; this.kick(prev, 'replaced'); }
      old.conn = conn; old.ip = conn.ip; old.discAt = null; old.lastActive = this.now(); old.inputs.length = 0; this.resetInputs(old);
      conn.rec = old;
      this.log(`resume conn=${conn.id} id=${old.id}`);
      this.event('resume', conn.id, { player: old.id });
      // A queued player who was away while a slot freed up was skipped by promote(): retry now.
      if (old.state === 'queue') this.promote();
      this.welcome(conn, old, true);
      this.lobbyDirty = true;
      return;
    }
    if (m.token) this.event('resume-refused', conn.id, {});
    // An automatic reconnect asks to resume only: with the token gone (the grace period ran out),
    // it is told so and stays a lobby viewer instead of silently joining as a new player.
    if (m.token && m.resume === true) {
      this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, tick: this.state.tick, cap: this.maxPlayers, resumed: false, expired: true });
      return;
    }

    // Records outlive their sockets for graceMs, so without this one address could churn
    // connect + hello + close and hold every slot and queue place. Past maxPerIp records, the
    // oldest disconnected one from that address is released.
    const mine = [...this.recs.values()].filter(r => r.ip === conn.ip);
    if (mine.length >= this.maxPerIp) {
      const away = mine.filter(r => !r.conn).sort((a, b) => a.discAt - b.discAt)[0];
      if (away) this.release(away, 'replaced');
    }

    const rec = {
      id: this.nextId++, name: this.uniqueName(name), color, token: randomBytes(16).toString('hex'),
      conn, ip: conn.ip, state: 'queue', inputs: [], lastSeq: -1, maxSeq: -1, lastKeys: 0, starve: 0, carry: 0, minQ: Infinity, qTicks: 0,
      lastActive: this.now(), discAt: null, fx: 0, joinedAt: this.now(),
    };
    conn.rec = rec;
    this.recs.set(rec.id, rec);
    this.tokens.set(rec.token, rec);
    if (this.activeCount() < this.maxPlayers) this.activate(rec, false);
    else { this.queue.push(rec); this.log(`queue conn=${conn.id} id=${rec.id} pos=${this.queue.length}`); this.event('queue', conn.id, { player: rec.id, pos: this.queue.length }); }
    this.welcome(conn, rec, false);
    if (rec.state === 'play') this.broadcastEvents([this.joinEvent(rec)]);
    this.lobbyDirty = true;
  }

  welcome(conn, rec, resumed) {
    this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, id: rec.id, token: rec.token, resumed, state: rec.state,
      name: rec.name, color: rec.color, tick: this.state.tick, queuePos: this.queuePos(rec),
      players: this.roster(), queue: this.queueList(), cap: this.maxPlayers });
  }

  onInput(conn, m) {
    const rec = conn.rec;
    const batch = Array.isArray(m.keys) ? m.keys : [m.keys];
    if (!Number.isInteger(m.seq) || m.seq < 0 || m.seq > 2 ** 31 || batch.length < 1 || batch.length > NET.maxInputBatch ||
        !batch.every(k => Number.isInteger(k) && k >= 0 && k <= KEY_MASK)) return this.kick(conn, 'malformed');
    conn.inCount++;
    if (!rec || rec.state !== 'play') return;     // spectators' and viewers' inputs are ignored
    batch.forEach((keys, i) => {
      const seq = m.seq + i;
      if (seq <= rec.maxSeq) return;              // duplicate or stale
      rec.maxSeq = seq;
      rec.inputs.push({ seq, keys });
    });
    if (rec.inputs.length > MAX_QUEUED_INPUTS) rec.inputs.splice(0, rec.inputs.length - MAX_QUEUED_INPUTS);
  }

  // ---------- roster ----------
  activeCount() { let n = 0; for (const r of this.recs.values()) if (r.state === 'play') n++; return n; }

  uniqueName(name) {
    const taken = new Set([...this.recs.values()].map(r => r.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name}#${i}`.toLowerCase())) return `${name}#${i}`;
  }

  // `gone` was released, freeing its name (SPEC §9): the holder of the lowest-numbered variant of
  // it ("Sean#2" when "Sean" goes; same case-insensitive comparison as uniqueName) takes the bare
  // name. Nobody else is renumbered, and a freed "Sean#2" is not passed on. `#` is outside the name
  // allowlist, so only uniqueName ever puts one in a name. Returns the `rename` event, or null.
  reclaimName(gone) {
    const freed = gone.name.toLowerCase();
    let best = null, bestN = Infinity;
    for (const r of this.recs.values()) {
      const m = /^(.*)#(\d+)$/.exec(r.name);
      if (m && m[1].toLowerCase() === freed && +m[2] < bestN) { best = r; bestN = +m[2]; }
    }
    if (!best) return null;
    const from = best.name;
    best.name = from.slice(0, from.lastIndexOf('#'));
    this.log(`rename id=${best.id} from=${from} to=${best.name}`);
    this.event('rename', best.conn ? best.conn.id : null, { player: best.id, from, to: best.name });
    return { type: 'rename', tick: this.state.tick, id: best.id, name: best.name };
  }

  // Forget input sequencing: a new session (resume) restarts its seq from 1.
  resetInputs(rec) {
    rec.lastSeq = -1; rec.maxSeq = -1; rec.starve = 0; rec.carry = 0; rec.minQ = Infinity; rec.qTicks = 0;
  }

  // by: the connection that asked for a bot (for the logs only)
  activate(rec, promoted, by = null) {
    if (!rec.bot) rec.color = this.freeColor(rec);
    rec.state = 'play'; rec.lastActive = this.now(); rec.inputs.length = 0;
    const evs = Sim.addPlayer(this.state, rec.id, { cfg: this.cfg, level: this.level });
    const cid = rec.conn ? rec.conn.id : by ? by.id : null;
    this.log(`${promoted ? 'promote' : rec.bot ? 'bot-add' : 'join'} conn=${cid ?? '-'} id=${rec.id} name=${rec.name}`);
    this.event(promoted ? 'promote' : rec.bot ? 'bot-add' : 'join', cid, { player: rec.id });
    this.pendingEvents.push(...evs.map(e => ({ ...e })));
  }

  joinEvent(rec) { return { type: 'join', tick: this.state.tick, id: rec.id, name: rec.name, color: rec.color, ...(rec.bot ? { bot: true } : {}) }; }

  // The player is gone for good: free its slot, invalidate its token, promote from the queue.
  release(rec, reason, by = null) {
    if (!this.recs.has(rec.id)) return;
    this.recs.delete(rec.id);
    if (rec.token) this.tokens.delete(rec.token);
    if (rec.bot) { const bi = this.bots.indexOf(rec); if (bi >= 0) this.bots.splice(bi, 1); }
    const qi = this.queue.indexOf(rec);
    if (qi >= 0) this.queue.splice(qi, 1);
    const evs = [];
    if (rec.state === 'play') {
      const p = Sim.getPlayer(this.state, rec.id);
      // a player who leaves while recently hit is a kill for the hitter (SPEC §5 credit rule)
      if (p && p.alive && p.lastHitBy != null && this.state.tick - p.lastHitTick <= this.cfg.creditTicks)
        evs.push(...this.withScores(Sim.killPlayer(this.state, rec.id, 'leave', this.cfg)));
      Sim.removePlayer(this.state, rec.id);
      evs.push({ type: 'leave', tick: this.state.tick, id: rec.id, reason });
    }
    this.log(`leave id=${rec.id} reason=${reason}`);
    this.event('leave', rec.conn ? rec.conn.id : by ? by.id : null, { player: rec.id, reason });
    rec.state = 'gone';
    const rn = this.reclaimName(rec);
    if (rn) evs.push(rn);
    if (evs.length) this.broadcastEvents(evs);
    this.promote();
    this.lobbyDirty = true;
  }

  // No two fighters share a colour (SPEC §9): a player entering the arena keeps the colour it asked
  // for if no other fighter has it, otherwise takes the next free one. Queued players don't hold one.
  freeColor(rec) {
    const used = new Set();
    for (const r of this.recs.values()) if (r !== rec && r.state === 'play') used.add(r.color);
    for (let k = 0; k < COLORS.length; k++) { const c = (rec.color + k) % COLORS.length; if (!used.has(c)) return c; }
    return rec.color;   // more fighters than colours (only with a raised maxPlayers)
  }

  promote() {
    while (this.activeCount() < this.maxPlayers) {
      const i = this.queue.findIndex(r => r.conn);
      if (i < 0) return;
      const [rec] = this.queue.splice(i, 1);
      const saved = this.pendingEvents;
      this.pendingEvents = [];
      this.activate(rec, true);
      this.broadcastEvents([this.joinEvent(rec), ...this.pendingEvents]);
      this.pendingEvents = saved;
    }
  }

  queuePos(rec) { const i = this.queue.indexOf(rec); return i < 0 ? 0 : i + 1; }
  roster() {
    return [...this.recs.values()].filter(r => r.state === 'play').map(r => {
      const p = Sim.getPlayer(this.state, r.id);
      return { id: r.id, name: r.name, color: r.color, score: p ? p.score : 0, deaths: p ? p.deaths : 0, away: !r.conn && !r.bot, ...(r.bot ? { bot: true } : {}) };
    });
  }
  queueList() { return this.queue.map(r => ({ id: r.id, name: r.name, color: r.color, away: !r.conn })); }
  lobbyMsg() { return { t: 'lobby', players: this.roster(), queue: this.queueList(), cap: this.maxPlayers, bots: this.bots.length, botMax: this.maxBots() }; }

  // Add a 'score' event for the killer and the victim after each kill.
  withScores(evs) {
    const out = [];
    for (const e of evs) {
      out.push(e);
      if (e.type !== 'kill') continue;
      for (const id of [e.killer, e.victim]) {
        const p = id != null && Sim.getPlayer(this.state, id);
        if (p) out.push({ type: 'score', tick: e.tick, id, score: p.score, deaths: p.deaths });
      }
      this.lobbyDirty = true;
    }
    return out;
  }

  broadcastEvents(evs) {
    if (!evs.length) return;
    const msg = JSON.stringify({ t: 'event', tick: this.state.tick, ev: evs });
    for (const c of this.conns) this.send(c, msg);
  }

  // ---------- the tick ----------
  pendingEvents = [];
  lastTickAt = 0;

  tick() {
    const t0 = this.now();
    this.lastTickAt = t0;
    const now = t0;
    // heartbeat: close connections that have gone silent (playing, queued or lobby viewers)
    if (this.heartbeatMs > 0 && this.heartbeatMs < Infinity)
      for (const c of [...this.conns]) if (now - c.heardAt >= this.heartbeatMs) this.timeout(c);
    // grace expiry and idle kicks
    for (const rec of [...this.recs.values()]) {
      if (!rec.conn && rec.discAt != null && now - rec.discAt >= this.graceMs) this.release(rec, 'timeout');
      else if (rec.conn && rec.state === 'play' && now - rec.lastActive >= this.idleMs) this.kick(rec.conn, 'idle');
    }
    // one input per player per tick; a missing input repeats the last one for a few ticks. A bot's
    // keys come from its brain, which sees the others as they were brain.delay ticks ago (SPEC §15).
    const inputs = new Map();
    for (const rec of this.recs.values()) {
      if (rec.state !== 'play') continue;
      let keys = 0;
      if (rec.bot) {
        const seen = new Map();
        for (const o of Sim.positionsAt(this.hist, this.state.tick - rec.brain.delay) || []) seen.set(o.id, o);
        keys = botKeys(rec.brain, Sim.getPlayer(this.state, rec.id), this.state, seen, { cfg: this.cfg, level: this.level });
      } else if (rec.conn && rec.inputs.length) {
        const inp = rec.inputs.shift();
        keys = inp.keys | rec.carry; rec.carry = 0;
        rec.lastSeq = inp.seq; rec.starve = 0;
        if (inp.keys !== 0) rec.lastActive = now;
      } else if (rec.conn && ++rec.starve <= STARVE_ZERO_TICKS) keys = rec.lastKeys;
      rec.lastKeys = keys;
      if (rec.conn) this.drainBacklog(rec);
      inputs.set(rec.id, keys);
    }
    const st = this.state;
    const rewind = a => {
      const rec = this.recs.get(a.id);
      if (rec && rec.bot) return null;              // a bot sees the present: no lag compensation
      const ms = Math.min(NET.rewindCapMs, NET.interpMs + (rec && rec.conn ? rec.conn.rtt : 0) / 2);
      return Sim.positionsAt(this.hist, st.tick - ms / TICK_MS);
    };
    const evs = [...this.pendingEvents, ...Sim.step(st, inputs, { cfg: this.cfg, level: this.level, rewind })];
    this.pendingEvents = [];
    Sim.recordHistory(this.hist, st);
    for (const p of st.players) { const rec = this.recs.get(p.id); if (rec) rec.fx |= p.fx; }
    this.broadcastEvents(this.withScores(evs));
    if (st.tick % SNAP_DIV === 0) this.snapshot();
    if (this.lobbyDirty && now - this.lobbyAt >= LOBBY_MIN_MS) {
      this.lobbyDirty = false; this.lobbyAt = now;
      const msg = JSON.stringify(this.lobbyMsg());
      for (const c of this.conns) this.send(c, msg);
    }
    // per-connection input rate, once a second
    for (const c of this.conns) if (now - c.rateAt >= 1000) { c.inRate = Math.round(c.inCount * 1000 / (now - c.rateAt)); c.inCount = 0; c.rateAt = now; }
    const dt = this.now() - t0;
    this.recordTickTime(dt);
  }

  // Every starved tick (a repeat or a 0) leaves the late inputs queued one tick further behind, and
  // without this nothing ever took that back: input latency ratcheted up to the worst stall seen
  // (up to the 12-input cap, past which inputs were simply lost). So: if the queue never fell below
  // `min` over the last DRAIN_WINDOW ticks, `min - 1` of its oldest inputs are pure added latency
  // and are skipped, keeping one as a cushion against the next bit of jitter. A fresh jump or
  // slash press in a skipped input is carried into the next tick, so a one-tick tap survives.
  // Batched senders (2-3 inputs a frame) bring the queue to 0 or 1 every frame and are untouched.
  drainBacklog(rec) {
    rec.minQ = Math.min(rec.minQ, rec.inputs.length);
    if (++rec.qTicks < DRAIN_WINDOW) return;
    let prev = rec.lastKeys;
    for (let n = rec.minQ - 1; n > 0; n--) {
      const inp = rec.inputs.shift();
      rec.carry |= inp.keys & ~prev & PRESS_BITS; prev = inp.keys;
      rec.lastSeq = inp.seq;
    }
    rec.minQ = Infinity; rec.qTicks = 0;
  }

  recordTickTime(dt) {
    const s = this.tickStats;
    s.n++; s.sum += dt; s.max = Math.max(s.max, dt);
    s.recent.push(dt); if (s.recent.length > 600) s.recent.shift();
    if (dt > TICK_MS) { s.overruns++; this.event('overrun', null, { tick: this.state.tick, ms: r2(dt) }); }
  }

  // Snapshot (SPEC §6.1): every player as [id, x, y, vx, vy, face, hp, atk, flags, iframes, stun, fx, stars],
  // flags = alive 1 | onGround 2 | sweep 4 | long sword 8; the lying pickups `it` as [[id, x, y, kind]]
  // (kind 1 = ninja stars, 0 = long sword; a star pickup adds its amount: [id, x, y, 1, n]); the stars in flight `st` as [[id, x, y, vx, owner]].
  // Each client also gets its own full player state (`me`, with `stars`) and its last processed
  // input `seq`, for reconciliation.
  snapshot() {
    const st = this.state;
    const p = st.players.map(q => {
      const rec = this.recs.get(q.id), fx = rec ? rec.fx : 0;
      if (rec) rec.fx = 0;
      return [q.id, r2(q.x), r2(q.y), r2(q.vx), r2(q.vy), q.face, q.hp, q.atk,
        (q.alive ? 1 : 0) | (q.onGround ? 2 : 0) | (q.atkType === 'sweep' ? 4 : 0) | (q.long ? 8 : 0), q.iframes, q.stun, fx, q.stars | 0];
    });
    const it = (st.items || []).map(i => (Sim.itemKind(i) === 'star' ? [i.id, i.x, i.y, 1, Sim.starAmount(i)] : [i.id, i.x, i.y, 0]));
    const fl = (st.stars || []).map(f => [f.id, r2(f.x), r2(f.y), f.vx, f.owner]);
    const tail = ',"p":' + JSON.stringify(p) + ',"it":' + JSON.stringify(it) + ',"st":' + JSON.stringify(fl) + '}';
    const head = '{"t":"snapshot","tick":' + st.tick;
    for (const c of this.conns) {
      const rec = c.rec;
      if (rec && rec.state === 'play') {
        const me = Sim.getPlayer(st, rec.id);
        this.send(c, head + ',"seq":' + rec.lastSeq + ',"me":' + JSON.stringify(me) + tail);
      } else this.send(c, head + ',"seq":-1' + tail);
    }
  }

  // ---------- loop ----------
  start() {
    let next = this.now();
    const loop = () => {
      if (this.stopped) return;
      const t = this.now();
      let n = 0;
      while (t >= next && n < 5) { this.tick(); next += TICK_MS; n++; }
      if (t - next > 100) { this.event('overrun', null, { behindMs: r2(t - next) }); next = t; }
      this.timer = setTimeout(loop, Math.max(0, next - this.now()));
    };
    this.stopped = false;
    loop();
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer);
    for (const c of [...this.conns]) this.kick(c, 'shutdown');
  }

  // ---------- views for the debug tools (SPEC §13) ----------
  tickTimeStats() {
    const s = this.tickStats, r = [...s.recent].sort((a, b) => a - b);
    return { ticks: s.n, avgMs: r2(s.n ? s.sum / s.n : 0), p99Ms: r2(r.length ? r[Math.floor(r.length * .99)] : 0),
      maxMs: r2(s.max), overruns: s.overruns, budgetMs: r2(TICK_MS) };
  }
  connView(c) {
    return { conn: c.id, ip: c.ip, player: c.rec ? c.rec.id : null, rttMs: Math.round(c.rtt), inputRate: c.inRate,
      dropped: c.dropCount, ageS: Math.round((this.now() - c.connectedAt) / 1000) };
  }
  recView(rec) {
    const p = Sim.getPlayer(this.state, rec.id);
    return { id: rec.id, name: rec.name, color: rec.color, state: rec.bot ? rec.state + ' (bot)' : rec.conn ? rec.state : rec.state + ' (disconnected)',
      ...(rec.bot ? { bot: true } : {}),
      queuePos: this.queuePos(rec), conn: rec.conn ? rec.conn.id : null, lastSeq: rec.lastSeq, inputQueue: rec.inputs.length,
      idleS: Math.round((this.now() - rec.lastActive) / 1000),
      ...(p ? { x: r2(p.x), y: r2(p.y), hp: p.hp, alive: p.alive, long: !!p.long, stars: p.stars | 0, score: p.score, deaths: p.deaths } : {}) };
  }
  adminState() {
    return { tick: this.state.tick, bots: this.bots.length, uptimeS: Math.round((this.now() - this.startedAt) / 1000),
      items: (this.state.items || []).map(i => ({ ...i, kind: Sim.itemKind(i) })), itemInS: r2(Math.max(0, this.state.itemT) * TICK_MS / 1000),
      starInS: r2(Math.max(0, this.state.starT ?? 0) * TICK_MS / 1000),
      stars: (this.state.stars || []).map(f => ({ id: f.id, owner: f.owner, x: r2(f.x), y: r2(f.y), vx: f.vx, dist: r2(f.dist) })),
      players: [...this.recs.values()].filter(r => r.state === 'play').map(r => this.recView(r)),
      queue: this.queue.map(r => this.recView(r)), tickTime: this.tickTimeStats(),
      conns: [...this.conns].map(c => this.connView(c)) };
  }
  // The server's own view of the connection holding `token`, for a debug report. Never exposes it.
  viewByToken(token) {
    const rec = typeof token === 'string' && this.tokens.get(token);
    if (!rec) return null;
    return { player: this.recView(rec), conn: rec.conn ? this.connView(rec.conn) : null };
  }
}
