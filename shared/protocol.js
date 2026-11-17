// The wire protocol between the server and the page (SPEC §6, §17, §18): every message both ways,
// every field, and every event a room broadcasts, plus the packed snapshot rows. This file is the
// whole interface the two ends share, and its text (comments and whitespace aside) is one of the three
// parts of the rules hash (server/version.js, SPEC §18), with the level and the prediction fingerprint. public/net.js is deliberately *not* in that hash: a change to
// how the page handles messages (its prediction, its reconnects, its sessionStorage) does not stop
// a running game, because the old page keeps its old net.js and the server never sees it.
//
// So that this file cannot fall behind the code, both ends are held to it:
//  - the server reads incoming messages only through readUp(): fields not declared under UP are
//    dropped before any handler sees them, and a declared field of the wrong kind is a kick. A server
//    that wants to read a new field must declare it here, which changes the hash.
//  - every message the server sends in the unit tests is checked against DOWN and EVENTS
//    (test/wire.js, loaded into every test file), and so is everything net.js sends (UP).
// A change of *meaning* with the same shape (a field that now counts in other units, say) is the one
// thing code can't see: bump PROTOCOL for it, which changes this file and so the hash.
//
// A field is 'kind' or 'kind?' (optional; null counts as absent only where 'null' is one of the
// kinds). Kinds: int, num (any finite number), str, bool, hex32 (32 lower-case hex digits), null,
// arr, obj, any; 'a|b' is either. An array of objects of one shape: list(shape, optional).
import * as Sim from './sim.js';

export const PROTOCOL = 5;

// client → server
export const UP = {
  hello: { name: 'str', color: 'int', room: 'int?', token: 'hex32?', resume: 'bool?', w: 'str?' },
  create: { room: 'str?', name: 'str?' },
  view: { room: 'int', name: 'str?', watch: 'bool?', seat: 'hex32?' },
  rename: { name: 'str' },
  admin: { id: 'int?', conn: 'int?' },
  cfg: { set: 'obj?', reset: 'bool?' },
  leave: {},
  bots: { d: 'int?', n: 'int?' },
  chat: { text: 'str' },
  ping: { id: 'int?', ct: 'num?' },
  input: { seq: 'int', keys: 'int|arr' },
  log: { e: 'arr', lost: 'int?' },
};

const list = (of, opt = false) => ({ of, opt });   // an array of objects of shape `of` (opt: may be absent)
const PLAYER = { id: 'int', name: 'str', color: 'int', score: 'int', deaths: 'int', away: 'bool', bot: 'bool?' };
const QUEUED = { id: 'int', name: 'str', color: 'int', away: 'bool' };

// server → client
export const DOWN = {
  welcome: {
    v: 'int', b: 'str', r: 'str', tick: 'int', cap: 'int', colors: 'arr?', w: 'str?', expired: 'bool?',
    id: 'int?', token: 'hex32?', resumed: 'bool?', state: 'str?', name: 'str?', color: 'int?', queuePos: 'int|null?',
    room: 'int?', rname: 'str?', admin: 'int|null?', cfg: 'obj?', players: list(PLAYER, true), queue: list(QUEUED, true),
  },
  lobby: {
    rooms: list({ id: 'int', name: 'str', admin: 'str|null', n: 'int', cap: 'int', bots: 'int', q: 'int', watch: 'int' }),
    maxRooms: 'int', room: 'int|null?', rname: 'str|null?', admin: 'int|null?', padmin: 'int|null?', held: 'bool?',
    players: list(PLAYER, true), queue: list(QUEUED, true), lobby: list({ c: 'int', name: 'str|null', w: 'bool?' }, true),
    cap: 'int?', bots: 'int?', botMax: 'int?', cfg: 'obj?', mine: 'bool', you: 'int', seat: 'hex32?',
  },
  snapshot: { tick: 'int', seq: 'int', me: 'obj?', p: 'arr', it: 'arr', st: 'arr' },
  event: { tick: 'int', ev: 'arr' },
  pong: { id: 'int', ct: 'num', tick: 'int', tf: 'num' },
  refused: { what: 'str', why: 'str' },
  closed: { room: 'int', name: 'str', why: 'str' },
  kick: { reason: 'str' },
  restart: {},
};

// the events in an `event` message's `ev`, by `type`
export const EVENTS = {
  join: { tick: 'int', id: 'int', name: 'str', color: 'int', bot: 'bool?' },
  leave: { tick: 'int', id: 'int', reason: 'str' },
  spawn: { tick: 'int', id: 'int', x: 'num', y: 'num' },
  hit: { tick: 'int', attacker: 'int', victim: 'int', move: 'str', dmg: 'int', hp: 'int', x: 'num', y: 'num', star: 'int?', dir: 'int?' },
  kill: { tick: 'int', killer: 'int', victim: 'int', move: 'str', seed: 'int', x: 'num', y: 'num', vx: 'num', vy: 'num', face: 'int', stars: 'int?', long: 'bool?', held: 'bool?' },
  score: { tick: 'int', id: 'int', score: 'int', deaths: 'int' },
  item: { tick: 'int', id: 'int', kind: 'str', x: 'num', y: 'num', n: 'int?', drop: 'bool?' },
  pickup: { tick: 'int', id: 'int', item: 'int', kind: 'str', x: 'num', y: 'num', stars: 'int?', gain: 'int?', left: 'int?' },
  break: { tick: 'int', id: 'int', item: 'int', x: 'num', y: 'num' },
  throw: { tick: 'int', id: 'int', star: 'int', x: 'num', y: 'num', face: 'int', stars: 'int' },
  starEnd: { tick: 'int', star: 'int', x: 'num', y: 'num', wall: 'bool' },
  chat: { id: 'int', text: 'str' },
  room: { tick: 'int', id: 'int', name: 'str' },
  rename: { tick: 'int', id: 'int', name: 'str' },
  admin: { tick: 'int', id: 'int|null', conn: 'int?', from: 'int|null', why: 'str' },
  cfg: { tick: 'int', cfg: 'obj', ch: 'obj?', reset: 'bool?' },
};

// ---------- checking ----------
const KINDS = {
  int: Number.isInteger, num: Number.isFinite, str: v => typeof v === 'string', bool: v => typeof v === 'boolean',
  hex32: v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v), null: v => v === null, arr: Array.isArray,
  obj: v => !!v && typeof v === 'object' && !Array.isArray(v), any: () => true,
};
function fieldOk(spec, v, path, out) {
  if (typeof spec === 'string') {
    const kinds = spec.replace(/\?$/, '').split('|');
    if (!kinds.some(k => KINDS[k](v))) out.push(`${path}: ${JSON.stringify(v)?.slice(0, 40)} is not ${kinds.join('|')}`);
    return;
  }
  if (!Array.isArray(v)) { out.push(`${path}: not an array`); return; }
  v.forEach((e, i) => shapeOk(spec.of, e, `${path}[${i}]`, out));
}
const optional = spec => (typeof spec === 'string' ? spec.endsWith('?') : spec.opt);
function shapeOk(shape, m, path, out, skip = 't') {
  if (!KINDS.obj(m)) { out.push(`${path}: not an object`); return; }
  for (const k of Object.keys(m)) if (k !== skip && !(k in shape)) out.push(`${path}.${k}: not in the protocol`);
  for (const [k, spec] of Object.entries(shape)) {
    if (m[k] === undefined) { if (!optional(spec)) out.push(`${path}.${k}: missing`); continue; }
    fieldOk(spec, m[k], `${path}.${k}`, out);
  }
}
// What is wrong with message `m` going `dir` ('up' | 'down'): a list of problems, empty if none.
export function checkMessage(dir, m) {
  const out = [], table = dir === 'up' ? UP : DOWN;
  if (!KINDS.obj(m) || typeof m.t !== 'string') return ['not a message'];
  const shape = Object.hasOwn(table, m.t) ? table[m.t] : null;
  if (!shape) return [`${dir} ${m.t}: not in the protocol`];
  shapeOk(shape, m, `${dir} ${m.t}`, out);
  if (dir === 'down' && m.t === 'event' && Array.isArray(m.ev))
    m.ev.forEach((e, i) => {
      const es = e && Object.hasOwn(EVENTS, e.type) ? EVENTS[e.type] : null;
      if (!es) out.push(`event ev[${i}]: type ${e && e.type} not in the protocol`);
      else shapeOk(es, e, `event ${e.type}`, out, 'type');
    });
  return out;
}

// An incoming message as the server may read it: only the fields UP declares for its type, each of
// its declared kind. Returns {m} (m.t is checked by the caller's switch), or {bad: [problems]}.
export function readUp(raw) {
  if (!KINDS.obj(raw) || typeof raw.t !== 'string') return { bad: ['not a message'] };
  const shape = Object.hasOwn(UP, raw.t) ? UP[raw.t] : null;
  if (!shape) return { m: { t: raw.t } };   // an unknown type: the caller kicks
  const m = { t: raw.t }, bad = [];
  for (const [k, spec] of Object.entries(shape)) {
    if (raw[k] === undefined) { if (!optional(spec)) bad.push(`${k}: missing`); continue; }
    fieldOk(spec, raw[k], k, bad);
    m[k] = raw[k];
  }
  return bad.length ? { bad } : { m };
}

// ---------- snapshot rows ----------
// A snapshot's `p`: per player [id, x, y, vx, vy, face, hp, atk, flags, iframes, stun, fx, stars], flags
// 1 alive, 2 on the ground, 4 sweep, 8 long sword; `it`: items lying in the arena, [id, x, y, 0] for a
// long sword and [id, x, y, 1, n] for n ninja stars; `st`: stars in flight, [id, x, y, vx, owner].
// Positions to 2 decimals.
export const r2 = v => Math.round(v * 100) / 100;
export const packPlayer = (q, fx) => [q.id, r2(q.x), r2(q.y), r2(q.vx), r2(q.vy), q.face, q.hp, q.atk,
  (q.alive ? 1 : 0) | (q.onGround ? 2 : 0) | (q.atkType === 'sweep' ? 4 : 0) | (q.long ? 8 : 0), q.iframes, q.stun, fx, q.stars | 0];
export const unpackPlayer = (a, w, h) => ({ id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], face: a[5], hp: a[6], atk: a[7],
  alive: !!(a[8] & 1), onGround: !!(a[8] & 2), atkType: a[8] & 4 ? 'sweep' : 'chop', long: !!(a[8] & 8),
  iframes: a[9], stun: a[10], fx: a[11], stars: a[12] | 0, w, h });
export const packItem = i => (Sim.itemKind(i) === 'star' ? [i.id, i.x, i.y, 1, Sim.starAmount(i)] : [i.id, i.x, i.y, 0]);
export const unpackItems = it => (Array.isArray(it) ? it.filter(Array.isArray).map(a => (a[3] === 1
  ? { id: a[0], x: a[1], y: a[2], kind: 'star', ...(a[4] > 0 ? { n: a[4] } : {}) }
  : { id: a[0], x: a[1], y: a[2], kind: 'long' })) : []);
export const packFlying = f => [f.id, r2(f.x), r2(f.y), f.vx, f.owner];
export const unpackFlying = st => new Map(Array.isArray(st) ? st.filter(Array.isArray).map(a => [a[0], { id: a[0], x: a[1], y: a[2], vx: a[3], owner: a[4] }]) : []);
