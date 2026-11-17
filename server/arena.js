// The authoritative game server without sockets: the protocol (SPEC §6.1), connections, rate limits,
// the heartbeat, resume tokens, idle kicks, and the rooms (SPEC §17). Up to ROOM.max (10) rooms live
// at once, each a server/room.js Room with its own world, 8 slots, queue, bots, chat and events; this
// class creates and closes them, routes every message to the right one and steps them all from one
// timer. There is no permanent room: a lobby visitor sees the room list, may select a room (then it
// gets that room's lobby detail, snapshots and events: this is also how Watch works), and joins one
// with `hello` or creates one with `create`. A connection is any object with send(string) and
// close(code, reason), so unit tests can drive it with fakes and call tick() by hand.
// AI players (SPEC §15) are records with `bot: true` and no connection; server/ai.js drives them.
import { randomBytes } from 'node:crypto';
import * as Sim from '../shared/sim.js';
import { DEFAULTS, NET, TICK_MS, COLORS, KEY_MASK, cleanName, cleanChat, cleanRoomName, defaultRoomName, CHAT, BOT, ROOM, SETTING_KEYS, cleanSetting, cfgDiff } from '../shared/constants.js';
import { navOf } from './ai.js';
import { createLogStore } from './logs.js';
import { isWordId, LOG } from '../shared/logid.js';
import { Room, r2 } from './room.js';

// 2: rooms (SPEC §17). hello needs a room id; create, view, rename and admin are new; bots is admin-only.
// 3: create no longer joins (its connection is the room's pending admin); lobby carries `mine`.
// 4: room settings (SPEC §17.1): `cfg` message (admin only), `cfg` event, cfg in welcome and lobby.
// 5: lobby visitors of a room (SPEC §17): `view` carries name/watch, lobby carries `lobby`, `padmin`
//    and `you`, `admin` may name a visitor's connection (`conn`), and so may the `admin` event.
export const PROTOCOL = 5;
const MAX_QUEUED_INPUTS = 12;                       // ~200 ms of buffered inputs per player
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

// A token bucket kept on an object: true (and one token spent) if a token was there.
function take(holder, key, burst, refillMs, now) {
  const b = holder[key] || (holder[key] = { tokens: burst, at: now });
  b.tokens = Math.min(burst, b.tokens + (now - b.at) / refillMs); b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export class Arena {
  constructor({ cfg = DEFAULTS, level = Sim.LEVEL, now = () => performance.now(), log = () => {}, event = () => {},
    maxPlayers = NET.maxPlayers, graceMs = NET.graceMs, idleMs = NET.idleMs, heartbeatMs = NET.heartbeatMs,
    maxPerIp = Infinity, seed, build = '', rules = '', logs = createLogStore(), maxRooms = ROOM.max, roomsPerIp = ROOM.perIp } = {}) {
    this.logs = logs;     // the streamed client logs, per word id (SPEC §13.5; server/logs.js)
    this.build = build;   // the server's build id, sent in every welcome (SPEC §10)
    this.rules = rules;   // and its rules hash (SPEC §18): a page whose own differs can't share a game with it
    this.cfg = cfg; this.level = level; this.now = now; this.log = log; this.event = event; this.maxPerIp = maxPerIp;
    this.maxPlayers = maxPlayers; this.graceMs = graceMs; this.idleMs = idleMs;
    this.heartbeatMs = heartbeatMs;   // 0 or Infinity: no heartbeat (never used by the server itself)
    this.maxRooms = maxRooms; this.roomsPerIp = roomsPerIp;
    this.seed = seed;     // tests pin it: room n then gets seed + n - 1; otherwise each room draws its own
    this.tickNo = 0;      // the one tick number every room shares (each room steps once per tick)
    this.rooms = new Map();       // room id -> Room, in creation order
    this.nextRoom = 1;
    this.conns = new Set();
    this.recs = new Map();        // player id -> record, every room (ids are global and never reused)
    this.tokens = new Map();      // resume token -> record (never logged or stored)
    // record -> the browser word id it joined from: a page reloaded without its token takes its own
    // dropped record back (takeOver). Kept beside the records, so saves (SPEC §18) don't include it.
    this.recWord = new WeakMap();
    this.botBucket = { tokens: BOT.globalBurst, at: now() };   // server-wide bot add/remove budget (all rooms)
    navOf(level, cfg);            // build the bots' route table now, not on the first + press
    this.nextId = 1; this.nextConn = 1;
    this.lobbyDirty = false; this.lobbyAt = -Infinity;
    this.tickStats = { n: 0, sum: 0, max: 0, overruns: 0, recent: [] };
    this.startedAt = now();
  }

  // ---------- rooms (SPEC §17) ----------
  createRoom(name, creatorIp = null) {
    const id = this.nextRoom++;
    const seed = this.seed != null ? this.seed + id - 1 : (randomBytes(4).readUInt32BE() % 2147483646) + 1;
    const room = new Room(this, { id, name, seed, creatorIp });
    this.rooms.set(id, room);
    this.lobbyDirty = true;
    return room;
  }

  // The last human is gone for good (left, kicked or the resume grace ran out): the room's bots go,
  // and everyone still looking at it (watchers, lobby visitors who selected it) is told and goes back
  // to the room list.
  closeRoom(room, why) {
    if (!this.rooms.has(room.id)) return;
    room.closing = true;
    for (const b of [...room.bots]) room.release(b, 'room closed');
    this.rooms.delete(room.id);
    if (room.adminConn) { room.adminConn.adminOf = null; room.adminConn = null; }
    room.log(`room-close name=${JSON.stringify(room.name)} why=${why}`);
    room.event('room-close', null, { why });
    for (const c of [...room.viewers]) {
      c.room = null;
      this.send(c, { t: 'closed', room: room.id, name: room.name, why });
      this.send(c, this.lobbyMsg(c));
    }
    room.viewers.clear();
    this.lobbyDirty = true;
  }

  // The room this connection looks at (gets snapshots and events from). Members always look at their own.
  // A pending admin (SPEC §17: created the room, not fighting) looking away gives the room up.
  setView(conn, room) {
    if (conn.room === room) return;
    if (conn.room) conn.room.viewers.delete(conn);
    conn.room = room; conn.viewAt = this.now();
    if (room) room.viewers.add(conn);
    this.lobbyDirty = true;   // watcher counts changed
    if (conn.adminOf && conn.adminOf !== room) this.pendingGone(conn);
  }

  // Make `conn` the pending admin of `room`: admin with no player record (SPEC §17). It is bound to
  // a record again when this connection joins the room (FIGHT).
  setPending(room, conn) {
    room.adminId = null; room.adminConn = conn; conn.adminOf = room; room.adminActAt = this.now();
    room.log(`admin pending conn=${conn.id}`);
    this.lobbyDirty = true;
  }

  // The pending admin of a room looked away (back to the room list, another room) or disconnected.
  // The role passes at once to the longest-present human, else to the visitor who has looked at the
  // room longest (it becomes the pending admin); with nobody left the room closes.
  pendingGone(conn) {
    const room = conn.adminOf;
    conn.adminOf = null;
    if (!room || room.adminConn !== conn) return;
    room.adminConn = null;
    if (!this.rooms.has(room.id)) return;
    room.handOn('left');
  }

  roomsOfIp(ip) { let n = 0; for (const r of this.rooms.values()) if (r.creatorIp === ip) n++; return n; }

  // ---------- connections ----------
  // conn: { send(str), close(code, reason), ip }. Returns the connection record.
  connect(transport) {
    const conn = { ...transport, id: this.nextConn++, rec: null, room: null, rtt: 0, connectedAt: this.now(),
      bucket: NET.inputRate, pingBucket: PING_RATE, bucketAt: this.now(), drops: [], dropCount: 0,
      inCount: 0, inRate: 0, rateAt: this.now(), heardAt: this.now(), closed: false };
    // Log identity (SPEC §13.5): the word id the browser offered (transport.word, from the /ws URL)
    // if valid, else a new one; told to the client in the welcome. The IP is the server's own view.
    conn.word = this.logs.assign(transport.word);
    conn.logBucket = LOG.burst; conn.logAt = this.now(); conn.logDropped = 0;
    this.logs.touch(conn.word, { ip: conn.ip });
    this.conns.add(conn);
    this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, r: this.rules, tick: this.tickNo, cap: this.maxPlayers, colors: COLORS, w: conn.word });
    this.send(conn, this.lobbyMsg(conn));
    return conn;
  }

  send(conn, msg) {
    if (conn.closed) return;
    try { conn.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  kick(conn, reason) {
    if (conn.closed) return;
    this.log(`kick conn=${conn.id} ip=${conn.ip} reason=${reason}${conn.room ? ` room=${conn.room.id}` : ''}`);
    this.event('kick', conn.id, { reason, player: conn.rec ? conn.rec.id : null, room: conn.room ? conn.room.id : null });
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

  // The socket closed (or was kicked). A player keeps its slot (and an admin its role) for graceMs.
  disconnect(conn) {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    this.setView(conn, null);
    this.logs.touch(conn.word);         // last seen
    const rec = conn.rec;
    if (rec && rec.conn === conn) {
      rec.conn = null; rec.discAt = this.now(); rec.inputs.length = 0;
      this.log(`drop conn=${conn.id} id=${rec.id} room=${rec.room.id}`);
      this.event('drop', conn.id, { player: rec.id, room: rec.room.id });
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
      case 'create': return this.onCreate(conn, m);
      case 'view': return this.onView(conn, m);
      case 'rename': return this.onRename(conn, m);
      case 'admin': return this.onAdmin(conn, m);
      case 'cfg': return this.onCfg(conn, m);
      case 'leave': return this.onLeave(conn);
      case 'chat': return this.onChat(conn, m);
      case 'bots': return this.onBots(conn, m);
      case 'log': return this.onLog(conn, m);
      default: return this.kick(conn, 'unknown');
    }
  }

  // A request the server turned down without a kick (a full server, a closed room, not the admin, a
  // rate limit, a bad room name …): the client shows `why` (SPEC §17).
  refuse(conn, what, why) {
    this.event('refused-req', conn.id, { what, why, room: conn.room ? conn.room.id : null });
    this.send(conn, { t: 'refused', what, why });
  }

  // Chat (SPEC §9). Only a player in a room (arena or queue) may chat; a viewer's message is ignored.
  // Per-player token bucket kept on the record (so a reconnect does not refill it): burst 3, one
  // more every 1.5 s. A message over the limit is dropped and counts toward the flood kick. The
  // text is relayed as an event to the room's viewers and is never logged: only its length is.
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
    this.event('chat', conn.id, { player: rec.id, room: rec.room.id, len: Array.from(text).length });
    rec.room.broadcastEvents([{ type: 'chat', id: rec.id, text }]);
  }

  // Streamed client log (SPEC §13.5): {t:'log', e:[entry…], lost?}. Any connection may send it (lobby
  // viewers too). A non-array `e` is a `malformed` kick; entries past LOG.maxEntries and entries of
  // the wrong shape are dropped and counted in the store. Its own bucket per connection (LOG.burst,
  // LOG.perSec): a message over it is dropped and counts toward the flood kick. Entries are tagged
  // with the room the connection was looking at (SPEC §17).
  onLog(conn, m) {
    if (!Array.isArray(m.e)) return this.kick(conn, 'malformed');
    const now = this.now();
    conn.logBucket = Math.min(LOG.burst, conn.logBucket + (now - conn.logAt) / 1000 * LOG.perSec);
    conn.logAt = now;
    if (conn.logBucket < 1) { conn.logDropped++; return this.dropped(conn); }
    conn.logBucket -= 1;
    const over = Math.max(0, m.e.length - LOG.maxEntries);
    const lost = (Number.isInteger(m.lost) && m.lost > 0 ? m.lost : 0) + over;
    this.logs.add(conn.word, m.e.slice(0, LOG.maxEntries), { ip: conn.ip, conn: conn.id, lost, room: conn.room ? conn.room.id : null });
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

  // The room whose admin plays on this connection (or is this connection, pending), or null.
  adminRoom(conn) {
    const rec = conn.rec;
    if (rec && rec.room && rec.room.adminId === rec.id) return rec.room;
    const p = conn.adminOf;
    if (p && p.adminConn === conn && this.rooms.has(p.id)) { p.adminActAt = this.now(); return p; }
    return null;
  }

  // AI players (SPEC §15, §17): {t:'bots', d: 1|-1} adds or removes one, {t:'bots', n} asks for n in
  // all, in the sender's room. Anything else in d/n is a `malformed` kick. Only the room's admin may
  // ask; anyone else gets `refused` (not a kick: an admin transfer may have crossed the click). Each
  // connection has a bucket (BOT.burst, one more every BOT.refillMs; an empty bucket drops the message
  // and counts toward the flood kick) and the server one more, charged per bot actually added or
  // removed in any room (BOT.globalBurst, one every BOT.globalRefillMs), so many admins together still
  // can't put more than a few spawns a second on the tick loop. The sender gets the lobby at once;
  // everyone else with the next (coalesced) lobby broadcast.
  onBots(conn, m) {
    const hasD = m.d !== undefined, hasN = m.n !== undefined;
    if (hasD === hasN || (hasD && m.d !== 1 && m.d !== -1) || (hasN && (!Number.isInteger(m.n) || m.n < 0 || m.n > Math.max(0, this.maxPlayers - 1))))
      return this.kick(conn, 'malformed');
    const now = this.now();
    if (!take(conn, 'botBucket', BOT.burst, BOT.refillMs, now)) return this.dropped(conn);
    const room = this.adminRoom(conn);
    if (!room) { this.refuse(conn, 'bots', 'admin'); return this.send(conn, this.lobbyMsg(conn)); }
    const want = hasN ? m.n : room.bots.length + m.d;
    const g = this.botBucket;
    g.tokens = Math.min(BOT.globalBurst, g.tokens + (now - g.at) / BOT.globalRefillMs); g.at = now;
    let changed = 0;
    while (g.tokens >= 1 && want > room.bots.length && room.addBot(conn)) { g.tokens -= 1; changed++; }
    while (g.tokens >= 1 && want < room.bots.length) { room.removeBot(conn); g.tokens -= 1; changed++; }
    room.event('bots', conn.id, { want, n: room.bots.length, changed });
    this.send(conn, this.lobbyMsg(conn));
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
  // the connection stays open as a lobby viewer of that room. A recently hit leaver still counts as
  // a kill. The admin may not leave while another human is in the room (SPEC §17): it must make
  // someone admin first (`refused` leave/admin). An admin who is the only human stays the room's
  // admin, pending (the room stays open while it looks at it).
  onLeave(conn) {
    const rec = conn.rec;
    if (!rec) return;   // already a viewer: nothing to do
    const room = rec.room;
    if (room.adminId === rec.id && room.humans().some(r => r !== rec)) return this.refuse(conn, 'leave', 'admin');
    conn.rec = null;
    // now a lobby visitor of the room, under its player name, from now on (SPEC §17)
    conn.vname = rec.name.replace(/#\d+$/, ''); conn.vwatch = false; conn.viewAt = this.now();
    if (room.adminId === rec.id && conn.room === room) this.setPending(room, conn);
    this.release(rec, 'left');
    if (this.rooms.has(room.id)) this.send(conn, this.lobbyMsg(conn));
  }

  onPing(conn, m) {
    if (m.id !== undefined && !Number.isInteger(m.id)) return this.kick(conn, 'malformed');
    if (m.ct !== undefined && !Number.isFinite(m.ct)) return this.kick(conn, 'malformed');
    // tf: how far into the current tick the server is (0..1), for the client's clock sync
    this.send(conn, { t: 'pong', id: m.id ?? 0, ct: m.ct ?? 0, tick: this.tickNo,
      tf: r2(Math.min(1, Math.max(0, (this.now() - this.lastTickAt) / TICK_MS))) });
  }

  // The name, colour and word id of a hello or create; null after a `bad hello` kick.
  helloFields(conn, m) {
    const name = cleanName(m.name);
    const color = m.color;
    // Only the 12 human colours: BOT.color (= COLORS.length, SPEC §15) and anything past it is refused.
    if (!name || !Number.isInteger(color) || color < 0 || color >= COLORS.length) { this.kick(conn, 'bad hello'); return null; }
    // The word id may come again in the hello (SPEC §13.5); an invalid one is ignored. Tag it with the typed name.
    if (isWordId(m.w) && m.w !== conn.word) { conn.word = m.w; this.logs.touch(conn.word, { ip: conn.ip }); }
    this.logs.touch(conn.word, { name });
    return { name, color };
  }

  // {t:'hello', name, color, room, token?, resume?}: join room `room` (an id from the lobby list), or
  // resume the record holding `token` (in whatever room it is; `room` is then not needed).
  onHello(conn, m) {
    if (conn.rec) return this.kick(conn, 'protocol');
    if (m.token !== undefined && (typeof m.token !== 'string' || !/^[0-9a-f]{32}$/.test(m.token))) return this.kick(conn, 'bad hello');
    const f = this.helloFields(conn, m);
    if (!f) return;

    // resume: the token is valid while the record exists (connected or within the grace period)
    const old = m.token && this.tokens.get(m.token);
    if (old) return this.resumeRec(conn, old, 'token');
    if (m.token) this.event('resume-refused', conn.id, {});
    // An automatic reconnect asks to resume only: with the token gone (the grace period ran out),
    // it is told so and stays a lobby viewer instead of silently joining as a new player.
    if (m.token && m.resume === true) {
      this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, r: this.rules, tick: this.tickNo, cap: this.maxPlayers, resumed: false, expired: true });
      return;
    }
    if (!Number.isInteger(m.room) || m.room < 1) return this.kick(conn, 'bad hello');
    const room = this.rooms.get(m.room);
    if (!room) { this.refuse(conn, 'join', 'gone'); return this.send(conn, this.lobbyMsg(conn)); }
    // A reloaded page that lost its token: the same browser (word id), address and name as a record
    // of this room whose connection has dropped (it is within its grace) takes that record back,
    // rather than joining beside it as "Name#2". A connected record is never taken.
    const mine = this.takeOver(conn, room, f.name);
    if (mine) return this.resumeRec(conn, mine, 'reload');
    this.join(conn, room, f.name, f.color);
  }

  takeOver(conn, room, name) {
    if (!conn.word) return null;
    const base = n => String(n).replace(/#\d+$/, '').toLowerCase();
    for (const r of room.humans ? room.humans() : []) {
      if (!r.conn && r.discAt != null && r.ip === conn.ip && this.recWord.get(r) === conn.word && base(r.name) === base(name)) return r;
    }
    return null;
  }

  // Attach `conn` to the existing record `old` (a token resume, or a reloaded page taking its own
  // dropped record back): same id, name, score and slot.
  resumeRec(conn, old, how) {
    {
      if (old.conn) { const prev = old.conn; prev.rec = null; this.kick(prev, 'replaced'); }
      old.conn = conn; old.ip = conn.ip; old.discAt = null; old.lastActive = this.now(); old.inputs.length = 0; this.resetInputs(old);
      conn.rec = old;
      this.setView(conn, old.room);
      if (conn.word) this.recWord.set(old, conn.word);
      old.room.log(`resume conn=${conn.id} id=${old.id}${how === 'reload' ? ' (reload, no token)' : ''}`);
      old.room.event('resume', conn.id, { player: old.id, how });
      // A queued player who was away while a slot freed up was skipped by promote(): retry now.
      if (old.state === 'queue') old.room.promote();
      this.welcome(conn, old, true);
      this.lobbyDirty = true;
    }
  }

  // {t:'create', room, name?}: create a room named `room` ('' or absent: "<name>'s room", or "Room
  // <id>" without a valid player name). The creating connection becomes its admin, pending: it has no
  // player record and takes no slot until it joins the room with a hello (FIGHT), and it now looks
  // at the room (SPEC §17). `name` (optional) is the creator's player name, for the default room name
  // and the room list. Turned down (`refused`) at ROOM.max rooms, at ROOM.perIp open rooms created
  // from this address, over the per-connection create bucket, or for a bad room name. A connection
  // is admin of at most one room: a create from a connection already in a room, or already the
  // pending admin of one, is a `protocol` kick, like a second hello.
  onCreate(conn, m) {
    if (conn.rec || conn.adminOf) return this.kick(conn, 'protocol');
    if ((m.room !== undefined && typeof m.room !== 'string') || (m.name !== undefined && typeof m.name !== 'string')) return this.kick(conn, 'malformed');
    const pname = m.name !== undefined ? cleanName(m.name) : null;
    if (pname) { this.logs.touch(conn.word, { name: pname }); conn.vname = pname; }
    const now = this.now();
    if (!take(conn, 'createBucket', ROOM.createBurst, ROOM.createRefillMs, now)) { this.dropped(conn); return this.refuse(conn, 'create', 'rate'); }
    const typed = (m.room || '').trim();
    const name = typed ? cleanRoomName(typed) : pname ? defaultRoomName(pname) : `Room ${this.nextRoom}`;
    if (!name) return this.refuse(conn, 'create', 'name');
    if (this.rooms.size >= this.maxRooms) return this.refuse(conn, 'create', 'full');
    if (this.roomsOfIp(conn.ip) >= this.roomsPerIp) return this.refuse(conn, 'create', 'ip');
    const room = this.createRoom(name, conn.ip);
    room.log(`room-create conn=${conn.id} ip=${conn.ip} name=${JSON.stringify(name)}`);
    room.event('room-create', conn.id, { name });
    this.setView(conn, room);
    this.setPending(room, conn);
    this.send(conn, this.lobbyMsg(conn));
  }

  // A new record for `conn` in `room`: a free slot, else the room's queue.
  join(conn, room, name, color) {
    // Records outlive their sockets for graceMs, so without this one address could churn
    // connect + hello + close and hold every slot and queue place. Past maxPerIp records (all
    // rooms), the oldest disconnected one from that address is released.
    const mine = [...this.recs.values()].filter(r => r.ip === conn.ip);
    if (mine.length >= this.maxPerIp) {
      const away = mine.filter(r => !r.conn).sort((a, b) => a.discAt - b.discAt)[0];
      if (away) this.release(away, 'replaced');
      if (!this.rooms.has(room.id)) { this.refuse(conn, 'join', 'gone'); return this.send(conn, this.lobbyMsg(conn)); }
    }
    const now = this.now();
    const rec = {
      id: this.nextId++, name: room.uniqueName(name), color, token: randomBytes(16).toString('hex'),
      conn, ip: conn.ip, state: 'queue', inputs: [], lastSeq: -1, maxSeq: -1, lastKeys: 0, starve: 0, carry: 0, minQ: Infinity, qTicks: 0,
      lastActive: now, discAt: null, fx: 0, joinedAt: now,
    };
    conn.rec = rec;
    if (conn.word) this.recWord.set(rec, conn.word);
    this.setView(conn, room);
    // The pending admin joining its room is bound to its record; a room without any admin (only
    // made by tests) takes its first human.
    if (room.adminConn === conn) { room.adminConn = null; conn.adminOf = null; room.adminId = rec.id; }
    else if (room.adminId == null && !room.adminConn) room.adminId = rec.id;
    room.add(rec);
    this.welcome(conn, rec, false);
  }

  welcome(conn, rec, resumed) {
    const room = rec.room;
    this.send(conn, { t: 'welcome', v: PROTOCOL, b: this.build, r: this.rules, id: rec.id, token: rec.token, resumed, state: rec.state,
      name: rec.name, color: rec.color, tick: this.tickNo, queuePos: room.queuePos(rec),
      room: room.id, rname: room.name, admin: room.adminId, cfg: cfgDiff(room.cfg),
      players: room.roster(), queue: room.queueList(), cap: this.maxPlayers });
    this.send(conn, this.lobbyMsg(conn));
  }

  // {t:'view', room: id|0, name?, watch?}: the room a lobby visitor looks at (its roster, snapshots and
  // events; Watch is this with the lobby closed). 0 (or a room that has closed meanwhile) means none:
  // the plain room list. `name`: what the visitor's name field holds (player-name rules; anything else
  // is no name), shown to the room in its "In the lobby" list; `watch`: the page is watching (SPEC
  // §16). A page re-sends `view` for the same room when these change. A member always looks at its own
  // room, so its view request is ignored. The answer is a lobby message at once.
  // A pending admin may not look away from its room while another human is in it (`refused`
  // leave/admin, as for a player admin's leave): it must make someone admin first.
  onView(conn, m) {
    if (!Number.isInteger(m.room) || m.room < 0 || (m.name !== undefined && typeof m.name !== 'string') ||
        (m.watch !== undefined && typeof m.watch !== 'boolean')) return this.kick(conn, 'malformed');
    const to = m.room ? this.rooms.get(m.room) || null : null;
    const p = conn.adminOf;
    if (!conn.rec) {
      const vname = m.name !== undefined ? cleanName(m.name) : conn.vname ?? null, vwatch = !!m.watch && !!to;
      if (vname !== (conn.vname ?? null) || vwatch !== !!conn.vwatch) { conn.vname = vname; conn.vwatch = vwatch; this.lobbyDirty = true; }
      if (vname) this.logs.touch(conn.word, { name: vname });
    }
    if (!conn.rec && p && p !== to && p.adminConn === conn && p.humans().length) this.refuse(conn, 'leave', 'admin');
    else if (!conn.rec) this.setView(conn, to);
    this.send(conn, this.lobbyMsg(conn));
  }

  // {t:'rename', name}: the admin names its room (SPEC §17). Same cleaning and allowlist as player
  // names, plus the apostrophe, 1-20 characters. Rate-limited per connection (the edit bucket).
  onRename(conn, m) {
    if (typeof m.name !== 'string') return this.kick(conn, 'malformed');
    if (!take(conn, 'editBucket', ROOM.editBurst, ROOM.editRefillMs, this.now())) { this.dropped(conn); return this.refuse(conn, 'rename', 'rate'); }
    const room = this.adminRoom(conn);
    if (!room) return this.refuse(conn, 'rename', 'admin');
    const name = cleanRoomName(m.name);
    if (!name) return this.refuse(conn, 'rename', 'name');
    if (name === room.name) return;
    const from = room.name;
    room.name = name;
    room.log(`room-rename conn=${conn.id} from=${JSON.stringify(from)} to=${JSON.stringify(name)}`);
    room.event('room-rename', conn.id, { from, to: name });
    room.broadcastEvents([{ type: 'room', tick: room.state.tick, id: room.id, name }]);
    this.lobbyDirty = true;
  }

  // {t:'admin', id} or {t:'admin', conn}: the admin hands the role to player `id`, or to the lobby
  // visitor on connection `conn` (SPEC §17), after the client's confirm dialog. Valid only from the
  // room's current admin, to another human record of the same room, playing or queued (an `away` one
  // inside its grace period too), or to another connection looking at this room without a record (on
  // its screen or watching), which becomes the room's pending admin. Such a connection is admin of no
  // other room: a pending admin looking away gives its room up. Everyone in the room is told with an
  // `admin` event. Rate-limited per connection (the edit bucket).
  onAdmin(conn, m) {
    const hasId = m.id !== undefined, hasConn = m.conn !== undefined;
    if (hasId === hasConn || !Number.isInteger(hasId ? m.id : m.conn)) return this.kick(conn, 'malformed');
    if (!take(conn, 'editBucket', ROOM.editBurst, ROOM.editRefillMs, this.now())) { this.dropped(conn); return this.refuse(conn, 'admin', 'rate'); }
    const room = this.adminRoom(conn);
    if (!room) return this.refuse(conn, 'admin', 'admin');
    if (hasConn) {
      const to = [...room.viewers].find(c => c.id === m.conn);
      if (!to || to === conn || to.rec || to.closed || (to.adminOf && to.adminOf !== room)) return this.refuse(conn, 'admin', 'target');
      return room.broadcastEvents([room.setAdminConn(to, 'transfer', conn)]);
    }
    const to = room.recs.get(m.id);
    if (!to || to.bot || to === conn.rec) return this.refuse(conn, 'admin', 'target');
    room.broadcastEvents([room.setAdmin(to, 'transfer', conn)]);
  }

  // {t:'cfg', set: {key: value, …}} or {t:'cfg', reset: true}: the admin changes its room's settings
  // (SPEC §17.1). A message of the wrong shape (no or both of set/reset, set not a plain object of
  // 1..all keys, a value that is neither a number nor a boolean) is a `malformed` kick. Only the
  // room's admin (playing or pending) may send it: anyone else gets `refused` cfg/admin. A key outside
  // the allowlist or a value outside its range or off its step grid refuses the whole message
  // (cfg/value). Own bucket per connection (ROOM.cfgBurst, one more every ROOM.cfgRefillMs). The
  // change goes to the room's viewers as a `cfg` event and applies from the next tick.
  onCfg(conn, m) {
    const hasSet = m.set !== undefined, hasReset = m.reset !== undefined;
    if (hasSet === hasReset || (hasReset && m.reset !== true)) return this.kick(conn, 'malformed');
    if (hasSet) {
      if (!m.set || typeof m.set !== 'object' || Array.isArray(m.set)) return this.kick(conn, 'malformed');
      const ks = Object.keys(m.set);
      if (!ks.length || ks.length > SETTING_KEYS.length || ks.some(k => !['number', 'boolean'].includes(typeof m.set[k]))) return this.kick(conn, 'malformed');
    }
    if (!take(conn, 'cfgBucket', ROOM.cfgBurst, ROOM.cfgRefillMs, this.now())) { this.dropped(conn); return this.refuse(conn, 'cfg', 'rate'); }
    const room = this.adminRoom(conn);
    if (!room) return this.refuse(conn, 'cfg', 'admin');
    if (hasSet && Object.keys(m.set).some(k => cleanSetting(k, m.set[k]) === undefined)) return this.refuse(conn, 'cfg', 'value');
    const ev = room.applyCfg(hasSet ? m.set : null, hasReset, conn);
    if (ev) { room.broadcastEvents([ev]); this.lobbyDirty = true; }
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

  // Forget input sequencing: a new session (resume) restarts its seq from 1.
  resetInputs(rec) {
    rec.lastSeq = -1; rec.maxSeq = -1; rec.starve = 0; rec.carry = 0; rec.retry = []; rec.tried = 0; rec.tries = null; rec.minQ = Infinity; rec.qTicks = 0;
  }

  // The player is gone for good (its room does the work, including admin hand-over and closing).
  release(rec, reason, by = null) { if (rec.room) rec.room.release(rec, reason, by); }

  // ---------- lobby messages (SPEC §9, §17) ----------
  // Every connection gets the room list; a member or a visitor who selected a room also gets that
  // room's detail (roster, queue, admin, bots) in the same fields the single arena used to send.
  roomList() { return [...this.rooms.values()].map(r => r.summary()); }
  lobbyMsg(conn, cache = null) {
    const rooms = cache ? cache.rooms || (cache.rooms = this.roomList()) : this.roomList();
    const room = conn.room;
    let detail;
    if (room) detail = cache ? cache[room.id] || (cache[room.id] = room.detail()) : room.detail();
    else detail = { room: null, rname: null, admin: null, padmin: null, players: [], queue: [], lobby: [], cap: this.maxPlayers, bots: 0, botMax: Math.max(0, this.maxPlayers - 1), cfg: {} };
    // mine: this connection is the admin of the room it looks at (pending, or as its player);
    // you: its connection id, as the room's `lobby` list and a visitor's `padmin` name it
    const mine = !!room && (room.adminConn === conn || (!!conn.rec && conn.rec.room === room && room.adminId === conn.rec.id));
    return { t: 'lobby', rooms, maxRooms: this.maxRooms, ...detail, mine, you: conn.id };
  }

  // ---------- the tick ----------
  lastTickAt = 0;

  tick() {
    const t0 = this.now();
    this.lastTickAt = t0;
    const now = t0;
    // heartbeat: close connections that have gone silent (playing, queued or lobby viewers)
    if (this.heartbeatMs > 0 && this.heartbeatMs < Infinity)
      for (const c of [...this.conns]) if (now - c.heardAt >= this.heartbeatMs) this.timeout(c);
    // a room held open only by its pending admin closes after ROOM.pendingMs without an admin action
    for (const room of [...this.rooms.values()])
      if (room.adminConn && !room.humans().length && now - room.adminActAt >= ROOM.pendingMs) {
        const c = room.adminConn;
        room.adminConn = null; c.adminOf = null;
        this.closeRoom(room, 'idle');
      }
    // grace expiry and idle kicks (every room)
    for (const rec of [...this.recs.values()]) {
      if (!rec.conn && rec.discAt != null && now - rec.discAt >= this.graceMs) this.release(rec, 'timeout');
      else if (rec.conn && rec.state === 'play' && now - rec.lastActive >= this.idleMs) this.kick(rec.conn, 'idle');
    }
    // every room steps once (empty rooms don't exist: a room closes with its last human)
    this.tickNo++;
    // a bug in one room's step closes that room (its players land on the room list) instead of
    // taking the whole server, and every other room, down with it
    for (const room of [...this.rooms.values()]) {
      const r0 = this.now();
      try { room.step(now); } catch (e) {
        this.log(`room-error room=${room.id} ${String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')}`);
        this.event({ type: 'room-error', room: room.id, err: String(e && e.message || e).slice(0, 200) });
        try { this.closeRoom(room, 'error'); } catch (e2) { this.rooms.delete(room.id); this.log(`room-error close failed room=${room.id} ${String(e2 && e2.message)}`); }
        continue;
      }
      const d = this.now() - r0;
      room.stepMs += (d - room.stepMs) * .05; room.stepMax = Math.max(room.stepMax, d);
    }
    if (this.lobbyDirty && now - this.lobbyAt >= LOBBY_MIN_MS) {
      this.lobbyDirty = false; this.lobbyAt = now;
      const cache = {};
      for (const c of this.conns) this.send(c, this.lobbyMsg(c, cache));
    }
    // per-connection input rate, once a second
    for (const c of this.conns) if (now - c.rateAt >= 1000) { c.inRate = Math.round(c.inCount * 1000 / (now - c.rateAt)); c.inCount = 0; c.rateAt = now; }
    const dt = this.now() - t0;
    this.recordTickTime(dt);
  }

  recordTickTime(dt) {
    const s = this.tickStats;
    s.n++; s.sum += dt; s.max = Math.max(s.max, dt);
    s.recent.push(dt); if (s.recent.length > 600) s.recent.shift();
    if (dt > TICK_MS) { s.overruns++; this.event('overrun', null, { tick: this.tickNo, ms: r2(dt), rooms: this.rooms.size }); }
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
  // restart: the server is restarting and has saved the rooms (SPEC §18): every connection is told
  // ({t:'restart'}) and closed with NET.restartClose, and no record is released (the next server
  // restores them and the pages resume). Otherwise every connection is kicked ('shutdown').
  stop({ restart = false } = {}) {
    this.stopped = true; clearTimeout(this.timer);
    if (!restart) { for (const c of [...this.conns]) this.kick(c, 'shutdown'); return; }
    for (const c of [...this.conns]) {
      this.send(c, { t: 'restart' });
      try { c.close(NET.restartClose, 'restart'); } catch { /* already closed */ }
    }
  }

  // ---------- views for the debug tools (SPEC §13) ----------
  tickTimeStats() {
    const s = this.tickStats, r = [...s.recent].sort((a, b) => a - b);
    return { ticks: s.n, avgMs: r2(s.n ? s.sum / s.n : 0), p99Ms: r2(r.length ? r[Math.floor(r.length * .99)] : 0),
      maxMs: r2(s.max), overruns: s.overruns, budgetMs: r2(TICK_MS) };
  }
  connView(c) {
    return { conn: c.id, ip: c.ip, word: c.word, player: c.rec ? c.rec.id : null, room: c.room ? c.room.id : null,
      ...(c.adminOf ? { pendingAdmin: c.adminOf.id } : {}), ...(!c.rec && c.room ? { vname: c.vname ?? null, watching: !!c.vwatch } : {}),
      rttMs: Math.round(c.rtt), inputRate: c.inRate,
      dropped: c.dropCount, logDropped: c.logDropped, ageS: Math.round((this.now() - c.connectedAt) / 1000) };
  }
  recView(rec) { return rec.room.recView(rec); }
  adminState() {
    return { tick: this.tickNo, uptimeS: Math.round((this.now() - this.startedAt) / 1000), maxRooms: this.maxRooms,
      rooms: [...this.rooms.values()].map(r => r.adminView()), tickTime: this.tickTimeStats(),
      conns: [...this.conns].map(c => this.connView(c)) };
  }
  // The server's own view of the connection holding `token`, for a debug report. Never exposes it.
  viewByToken(token) {
    const rec = typeof token === 'string' && this.tokens.get(token);
    if (!rec) return null;
    return { player: this.recView(rec), conn: rec.conn ? this.connView(rec.conn) : null };
  }
}
