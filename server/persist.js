// Restarts without losing games (SPEC §18): the rooms are written to a file when the server is
// asked to stop, and read back by the next server if it can run them.
//
// What is saved. Every room as it stands between two ticks: its sim state (rng, players, pickups,
// stars, timers, scores), its settings, its admin, its queue and bots (brains included) and every
// record (name, colour, id, resume token, state, chat bucket …). Not saved: anything tied to a
// connection or to the moment (sockets, watchers, input queues and sequencing, the lag-compensation
// history, the streamed logs and word ids, rate buckets).
//
// How fields are chosen. Not from a list of what to keep, but from what to leave out: every own
// field of a Room and of a record is saved unless it is named in ROOM_SKIP / REC_SKIP or handled by
// the codec ($recs, $queue, $bots, $pending). A field someone adds later is therefore saved and
// restored without anyone touching this file, and it changes the shape hash (below), so a save
// file written before the field existed is not loaded into a server that expects it. A field
// holding something that is not plain data (a Map, a class instance, a function, Infinity/NaN)
// makes the serializer throw: the shape hash cannot be computed at start (persistence is then off
// and the start log says why) and test/persist.test.js fails, so it is noticed before a deploy.
//
// Times. performance.now() restarts with the process, so every timestamp (TIME_KEYS) is saved as
// an age in ms and turned back into a timestamp of the new clock on restore.
//
// The shape hash (SPEC §18): a fingerprint of the structure of what the save routine writes,
// computed at start from a sample arena built in memory (rooms with a pending and a playing admin,
// humans connected and away, a bot with its brain, a queued player, non-default settings, pickups,
// a star in flight, a dropped long sword, a chat bucket). Same code, same fingerprint; a field
// added, removed or changing type anywhere in that sample gives another. A save file is loaded only
// if its shape hash and its rules hash both equal the new server's.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Sim from '../shared/sim.js';
import { DEFAULTS, KEY, T } from '../shared/constants.js';
import { Arena } from './arena.js';
import { Room } from './room.js';

export const STATE_MAX_AGE_MS = 120000;   // an older save file is ignored (the players have long gone)
export const RESTORE_GRACE_MS = 30000;    // restored humans have this long to resume (then the usual expiry)
export const TRIAL_TICKS = 60;            // each restored room is first stepped this long on a copy

// Room fields not saved: the owner and config (the new server's), connections, per-moment data.
const ROOM_SKIP = new Set(['arena', 'level', 'maxPlayers', 'baseCfg', 'hist', 'viewers', 'pendingEvents',
  'recs', 'queue', 'bots', 'adminConn', 'stepMs', 'stepMax', 'closing']);
// Record fields not saved: the connection, the room (implied), and input sequencing, which a resume
// restarts anyway (Arena.resetInputs).
const REC_SKIP = new Set(['conn', 'room', 'inputs', 'lastSeq', 'maxSeq', 'lastKeys', 'starve', 'carry', 'minQ', 'qTicks',
  'retry', 'tried', 'tries', 'fx']);
// performance.now() timestamps (anywhere outside the sim state): saved as ages.
const TIME_KEYS = new Set(['joinedAt', 'lastActive', 'discAt', 'createdAt', 'adminActAt', 'seatAt', 'at']);

// A plain-data copy of v; throws on anything JSON would not carry exactly. times: convert TIME_KEYS.
function plain(v, path, now, times, key = '') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${path}: ${v} is not a finite number`);
    return times && TIME_KEYS.has(key) ? now - v : v;
  }
  if (Array.isArray(v)) return v.map((x, i) => {
    if (x === undefined) throw new Error(`${path}[${i}]: undefined in an array`);
    return plain(x, `${path}[${i}]`, now, times);
  });
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`${path}: a ${v.constructor && v.constructor.name || 'non-plain object'} is not plain data`);
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = plain(v[k], `${path}.${k}`, now, times, k);
    return o;
  }
  throw new Error(`${path}: a ${typeof v} is not plain data`);
}
// The inverse for times: ages back to timestamps of this process's clock.
function revive(v, now, times, key = '') {
  if (typeof v === 'number') return times && TIME_KEYS.has(key) ? now - v : v;
  if (Array.isArray(v)) return v.map(x => revive(x, now, times));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k], now, times, k); return o; }
  return v;
}

function recData(rec, now) {
  const d = {};
  for (const k of Object.keys(rec)) if (!REC_SKIP.has(k) && rec[k] !== undefined) d[k] = plain(rec[k], `rec ${rec.id}.${k}`, now, true, k);
  return d;
}
export function roomData(room, now) {
  const d = {};
  for (const k of Object.keys(room)) if (!ROOM_SKIP.has(k) && room[k] !== undefined) d[k] = plain(room[k], `room ${room.id}.${k}`, now, k !== 'state', k);
  d.$recs = [...room.recs.values()].map(r => recData(r, now));
  d.$queue = room.queue.map(r => r.id);
  d.$bots = room.bots.map(r => r.id);
  // the admin was a pending one (a connection, gone with the old process), or its page had dropped
  // and the room was holding its seat
  d.$pending = !!room.adminConn || (!!room.seat && room.adminId == null);
  return d;
}

// Everything the save file holds. Rooms that fail to serialize are left out (and listed in `failed`).
export function snapshotArena(arena, { rulesHash = '', shapeHash = '', wallNow = Date.now() } = {}) {
  const now = arena.now(), rooms = [], failed = [];
  for (const room of arena.rooms.values()) {
    try { rooms.push(roomData(room, now)); } catch (e) { failed.push({ room: room.id, err: e.message }); }
  }
  const data = { rulesHash, shapeHash, savedAt: wallNow, tick: arena.tickNo, nextId: arena.nextId, nextRoom: arena.nextRoom, rooms };
  if (failed.length) Object.defineProperty(data, 'failed', { value: failed });   // not written
  return data;
}

// A Room for `arena` from saved data (not yet registered with the arena: see adopt). Restored humans
// are away, with RESTORE_GRACE_MS to resume. A room whose admin was pending holds its seat for the
// same grace (its page takes it back, SPEC §17); a save without a seat passes the role to the
// longest-present human, or is not restored with nobody in it. Returns null for a room that must not come back.
export function restoreRoom(arena, saved, { graceMs = RESTORE_GRACE_MS } = {}) {
  const d = structuredClone(saved), now = arena.now();
  const room = new Room(arena, { id: d.id, name: d.name, seed: 1, creatorIp: d.creatorIp ?? null });
  for (const k of Object.keys(d)) if (!k.startsWith('$')) room[k] = revive(d[k], now, k !== 'state', k);
  const base = room.baseCfg, cfg = room.cfg;
  room.cfg = Object.keys(base).every(k => cfg[k] === base[k]) && Object.keys(cfg).length === Object.keys(base).length ? base : Object.freeze(cfg);
  for (const rd of d.$recs) {
    const rec = revive(rd, now, true);
    Object.assign(rec, { conn: null, room, inputs: [], lastKeys: 0, fx: 0 });
    arena.resetInputs(rec);
    if (!rec.bot) rec.discAt = now + graceMs - arena.graceMs;   // the usual expiry check then gives graceMs
    room.recs.set(rec.id, rec);
  }
  room.queue = d.$queue.map(id => room.recs.get(id));
  room.bots = d.$bots.map(id => room.recs.get(id));
  room.adminConn = null;
  if (d.$pending) {
    // its pending admin's page comes back with the seat (SPEC §17) within the restore grace; with no
    // seat (an old save) the role passes on as before, and a room with nobody is not restored
    if (room.seat) room.seatAt = now + graceMs - arena.graceMs;
    else if (!room.humans().length) return null;
    else room.adminId = room.successor().id;
  }
  return room;
}
// Register a restored room with its arena: room list, global record and token maps.
export function adopt(arena, room) {
  arena.rooms.set(room.id, room);
  for (const rec of room.recs.values()) { arena.recs.set(rec.id, rec); if (rec.token) arena.tokens.set(rec.token, rec); }
  arena.lobbyDirty = true;
}

// What is wrong with a room (an empty list: nothing): records against slots, queue and sim players,
// tokens, the admin, and every number in the sim state finite with players inside the level.
export function checkRoom(room) {
  const bad = [], st = room.state, L = room.level;
  if (!st || !Array.isArray(st.players)) return ['no sim state'];
  const tokens = new Set();
  for (const [id, r] of room.recs) {
    if (!r || r.id !== id || !Number.isInteger(id)) { bad.push(`record ${id} malformed`); continue; }
    if (r.state !== 'play' && r.state !== 'queue') bad.push(`record ${id} state ${r.state}`);
    if (r.bot) { if (!r.brain || typeof r.brain !== 'object') bad.push(`bot ${id} has no brain`); }
    else if (typeof r.token !== 'string' || !/^[0-9a-f]{32}$/.test(r.token) || tokens.has(r.token)) bad.push(`record ${id} token`);
    else tokens.add(r.token);
    if (typeof r.name !== 'string' || !r.name) bad.push(`record ${id} name`);
  }
  const playing = [...room.recs.values()].filter(r => r.state === 'play').map(r => r.id).sort((a, b) => a - b);
  const simIds = st.players.map(p => p.id).sort((a, b) => a - b);
  if (playing.join() !== simIds.join()) bad.push(`slots ${playing} vs sim players ${simIds}`);
  if (playing.length > room.maxPlayers) bad.push(`${playing.length} players over ${room.maxPlayers} slots`);
  const queued = [...room.recs.values()].filter(r => r.state === 'queue');
  if (room.queue.some(r => !r || r.state !== 'queue') || queued.length !== room.queue.length) bad.push('queue');
  if (room.bots.some(r => !r || !r.bot) || room.bots.length !== [...room.recs.values()].filter(r => r.bot).length) bad.push('bots');
  if (!room.humans().length && !room.seat) bad.push('no human');   // a held seat: its pending admin's page comes back
  if (room.adminId != null && (!room.recs.has(room.adminId) || room.recs.get(room.adminId).bot)) bad.push('admin');
  const nonFinite = [];
  const walk = (v, path) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) nonFinite.push(path); }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(st, 'state');
  if (nonFinite.length) bad.push(`non-finite ${nonFinite.slice(0, 3).join(' ')}`);
  for (const p of st.players) for (const k of ['x', 'y', 'vx', 'vy', 'hp', 'score', 'deaths'])
    if (!Number.isFinite(p[k])) { bad.push(`player ${p.id}.${k} = ${p[k]}`); break; }
  for (const p of st.players) if (!(p.x >= -T && p.x <= (L.w + 1) * T && p.y >= -T && p.y <= (L.h + 1) * T)) bad.push(`player ${p.id} outside the level`);
  return bad;
}

// Step a copy of a saved room TRIAL_TICKS ticks in a scratch arena (catching anything it throws) and
// check it before and after. Returns null if it is fine, else what went wrong.
export function trialRoom(arena, saved, tick) {
  try {
    const scratch = new Arena({ cfg: arena.cfg, level: arena.level, now: arena.now, maxPlayers: arena.maxPlayers, graceMs: arena.graceMs, seed: 1 });
    scratch.tickNo = tick;
    const room = restoreRoom(scratch, saved);
    if (!room) return 'its pending admin was the only one in it';
    adopt(scratch, room);
    let bad = checkRoom(room);
    if (room.state.tick !== tick) bad.push(`tick ${room.state.tick} vs ${tick}`);
    if (bad.length) return bad.join('; ');
    const now = arena.now();
    for (let i = 0; i < TRIAL_TICKS; i++) { scratch.tickNo++; room.step(now); }
    bad = checkRoom(room);
    return bad.length ? 'after the trial: ' + bad.join('; ') : null;
  } catch (e) {
    return 'threw: ' + String(e && e.message || e).slice(0, 200);
  }
}

// ---------- the file ----------
// Write atomically (a temp file in the same directory, fsync, rename): a reader sees the old file or
// the whole new one. The directory is created 0700 and the file is 0600: it holds resume tokens.
export function writeState(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { chmodSync(tmp, 0o600); writeSync(fd, JSON.stringify(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

// Save every room of `arena` to `file`. Returns {rooms, bytes, failed}.
export function saveState(arena, file, hashes) {
  const data = snapshotArena(arena, hashes);
  writeState(file, data);
  return { rooms: data.rooms.length, failed: data.failed || [] };
}

// At start, before the arena runs: load `file` if it exists, is recent and was written by a server
// with the same rules hash and shape hash; each room is restored only if its trial step passes.
// The file is deleted first, whatever happens next, so it is never loaded twice. Returns
// {loaded, dropped: [{room, why}], why} (why: why nothing was loaded, or null).
export function loadState(arena, file, { rulesHash, shapeHash, wallNow = Date.now(), maxAgeMs = STATE_MAX_AGE_MS, graceMs = RESTORE_GRACE_MS } = {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { loaded: 0, dropped: [], why: e.code === 'ENOENT' ? 'no save file' : `unreadable: ${e.code || e.message}` }; }
  try { unlinkSync(file); } catch { /* gone already */ }
  let data;
  try { data = JSON.parse(text); } catch { return { loaded: 0, dropped: [], why: 'not JSON' }; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.rooms)) return { loaded: 0, dropped: [], why: 'malformed' };
  if (data.rulesHash !== rulesHash) return { loaded: 0, dropped: [], why: `rules hash ${data.rulesHash} differs from ${rulesHash}` };
  if (data.shapeHash !== shapeHash) return { loaded: 0, dropped: [], why: `shape hash ${data.shapeHash} differs from ${shapeHash}` };
  const age = wallNow - data.savedAt;
  if (!(age >= -5000 && age <= maxAgeMs)) return { loaded: 0, dropped: [], why: `saved ${Math.round(age / 1000)} s ago` };
  if (!Number.isInteger(data.tick) || !Number.isInteger(data.nextId) || !Number.isInteger(data.nextRoom)) return { loaded: 0, dropped: [], why: 'malformed' };
  if (arena.rooms.size) return { loaded: 0, dropped: [], why: 'the arena already has rooms' };
  arena.tickNo = data.tick;
  arena.nextId = Math.max(arena.nextId, data.nextId);
  arena.nextRoom = Math.max(arena.nextRoom, data.nextRoom);
  const dropped = [];
  let loaded = 0;
  for (const saved of data.rooms) {
    const id = saved && saved.id;
    if (!Number.isInteger(id) || arena.rooms.has(id) || id >= arena.nextRoom) { dropped.push({ room: id, why: 'bad id' }); continue; }
    const why = trialRoom(arena, saved, data.tick);
    if (why) { dropped.push({ room: id, why }); continue; }
    const room = restoreRoom(arena, saved, { graceMs });
    if (!room) { dropped.push({ room: id, why: 'no human' }); continue; }
    if ([...room.recs.keys()].some(rid => rid >= arena.nextId || arena.recs.has(rid)) ||
        [...room.recs.values()].some(r => r.token && arena.tokens.has(r.token))) { dropped.push({ room: id, why: 'record ids or tokens clash' }); continue; }
    adopt(arena, room);
    room.log(`room-restore name=${JSON.stringify(room.name)} players=${room.activeCount()} queue=${room.queue.length} bots=${room.bots.length}`);
    room.event('room-restore', null, { name: room.name });
    loaded++;
  }
  return { loaded, dropped, why: null };
}

// ---------- the shape hash ----------
// The structure of a value: types, object keys (sorted) and, for arrays, the set of their elements'
// structures (so their lengths and order don't matter).
export function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + [...new Set(v.map(shapeOf))].sort().join('|') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${shapeOf(v[k])}`).join(',') + '}';
  return typeof v;
}
export const shapeHashOf = data => createHash('sha256').update(shapeOf(data)).digest('hex').slice(0, 16);

// The sample arena the shape hash is taken of: deterministic (a fixed seed and a fake clock), built
// through the normal protocol paths so its records look exactly like real ones.
export function sampleArena() {
  let t = 1000;
  const cfg = { ...DEFAULTS, itemMinTicks: 1, itemMaxTicks: 2, starMinTicks: 1, starMaxTicks: 2 };
  const arena = new Arena({ cfg, now: () => t, seed: 7, maxPlayers: 3, heartbeatMs: 0 });
  const conn = ip => arena.connect({ ip, send() {}, close() {} });
  const say = (c, m) => arena.onMessage(c, JSON.stringify(m));
  const tick = n => { for (let i = 0; i < n; i++) { t += 1000 / 60; arena.tick(); } };
  // room 1: a pending admin, two humans (one goes away), a bot, a queued human, non-default settings
  const a = conn('sample-1'), b = conn('sample-2'), c = conn('sample-3'), q = conn('sample-4');
  say(a, { t: 'create', room: 'Sample', name: 'Ann' });
  const r1 = [...arena.rooms.values()].at(-1);
  say(b, { t: 'hello', name: 'Bob', color: 1, room: r1.id });
  say(c, { t: 'hello', name: 'Cy', color: 2, room: r1.id });
  r1.addBot(a);
  say(q, { t: 'hello', name: 'Pat', color: 3, room: r1.id });
  r1.applyCfg({ gore: false }, false, a);
  say(b, { t: 'chat', text: 'hi' });
  tick(90);                                          // pickups appear, the bot thinks
  const bob = Sim.getPlayer(r1.state, b.rec.id);
  Object.assign(bob, { stars: 3, stun: 0, throwCd: 0, alive: true });
  say(b, { t: 'input', seq: 1, keys: KEY.THROW });
  tick(1);                                           // a star in flight
  const cy = Sim.getPlayer(r1.state, c.rec.id);
  Object.assign(cy, { long: true, alive: true });
  Sim.killPlayer(r1.state, cy.id, 'chop', r1.cfg);   // a long sword waiting to be dropped
  arena.disconnect(c);                               // Cy is away, inside the grace
  // room 2: an admin who fights
  const d = conn('sample-5');
  say(d, { t: 'create', room: 'Other', name: 'Dee' });
  say(d, { t: 'hello', name: 'Dee', color: 4, room: [...arena.rooms.values()].at(-1).id });
  return arena;
}
export const sampleSave = () => snapshotArena(sampleArena(), { rulesHash: '0', shapeHash: '0', wallNow: 0 });
export const computeShapeHash = () => shapeHashOf(sampleSave());
