// Room settings (SPEC §17.1) on the socket-less arena: only the room's admin may change them, values
// are checked against the shared table, a change applies to that room's sim only and reaches every
// viewer of the room (welcome, lobby, `cfg` event), reset, settings die with the room, the bots'
// route table follows movement changes, determinism with a non-default cfg, and public/net.js
// predicting with the room's settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Arena, KICK } from '../server/arena.js';
import { navOf } from '../server/ai.js';
import * as Sim from '../shared/sim.js';
import { DEFAULTS, ROOM_DEFAULTS, ROOM, TICK_MS, KEY, SETTINGS, SETTING_KEYS, cleanSetting, cfgDiff, cfgFromDiff } from '../shared/constants.js';

function setup(opts = {}) {
  let t = 1000;
  const arena = new Arena({ now: () => t, seed: 5, heartbeatMs: 0, ...opts });
  const conn = (ip = 'test') => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, typeof m === 'string' ? m : JSON.stringify(m));
    c.last = ty => [...c.msgs].reverse().find(m => m.t === ty);
    c.events = () => c.msgs.filter(m => m.t === 'event').flatMap(m => m.ev);
    c.id = () => c.last('welcome')?.id;
    return c;
  };
  const maker = (name, ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'create', name }); return c; };
  const creator = (name, ip = 'ip-' + name) => { const c = maker(name, ip); c.say({ t: 'hello', name, color: 0, room: c.last('lobby').room }); return c; };
  const joiner = (name, room, color = 1, ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'hello', name, color, room }); return c; };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { t += TICK_MS; arena.tick(); } };
  const advance = ms => { t += ms; };
  return { arena, conn, maker, creator, joiner, tick, advance };
}
const refused = c => c.last('refused');

test('room settings: the shared table — allowlist, range, step grid, defaults on the grid', () => {
  for (const [, items] of SETTINGS) for (const [k, , min, max] of items) {
    assert.ok(k in DEFAULTS, k);
    assert.equal(cleanSetting(k, DEFAULTS[k]), DEFAULTS[k], `default ${k} is a valid value`);
    assert.equal(cleanSetting(k, min - 1), undefined); assert.equal(cleanSetting(k, max + 1), undefined);
  }
  assert.equal(cleanSetting('gravity', .5), .5);
  assert.equal(cleanSetting('gravity', .1 + .2), .3, 'float noise is snapped to the grid');
  assert.equal(cleanSetting('gravity', .505), undefined, 'off the .01 grid');
  assert.equal(cleanSetting('coyote', 2.5), undefined);
  assert.equal(cleanSetting('gravity', '0.5'), undefined); assert.equal(cleanSetting('gravity', NaN), undefined);
  assert.equal(cleanSetting('gore', false), false); assert.equal(cleanSetting('gore', 0), undefined);
  for (const k of ['maxHp', 'itemMinTicks', 'gameSpeed', 'musicVol', 'hitboxes', '__proto__', 'constructor', 'toString'])
    assert.equal(cleanSetting(k, 1), undefined, `${k} is not a room setting`);
  assert.ok(SETTING_KEYS.includes('gore') && SETTING_KEYS.includes('realGore') && SETTING_KEYS.includes('jumpVel'));
  assert.deepEqual(cfgDiff(ROOM_DEFAULTS), {});
  assert.deepEqual(cfgFromDiff({ gravity: .5, gore: false, bogus: 1, jumpVel: 'x' }), { ...ROOM_DEFAULTS, gravity: .5, gore: false });
});

test('room settings: only the admin (pending or playing) may change them; anyone else is refused', () => {
  const { arena, maker, joiner, conn } = setup();
  const a = maker('Ann');                       // pending admin
  const room = arena.rooms.get(1);
  a.say({ t: 'cfg', set: { gore: false } });
  assert.equal(room.cfg.gore, false, 'the pending admin may change them');
  a.say({ t: 'hello', name: 'Ann', color: 0, room: 1 });
  const b = joiner('Bob', 1), v = conn('v');
  v.say({ t: 'view', room: 1 });
  b.say({ t: 'cfg', set: { gore: true } });
  assert.deepEqual(refused(b), { t: 'refused', what: 'cfg', why: 'admin' });
  v.say({ t: 'cfg', reset: true });
  assert.deepEqual(refused(v), { t: 'refused', what: 'cfg', why: 'admin' });
  assert.equal(room.cfg.gore, false, 'unchanged');
  assert.equal(b.closed, null); assert.equal(v.closed, null);
  a.say({ t: 'cfg', set: { gravity: .4 } });
  assert.equal(room.cfg.gravity, .4, 'the admin playing may change them');
  // the role moves: the old admin is refused, the new one may
  a.say({ t: 'admin', id: b.id() });
  a.say({ t: 'cfg', set: { gravity: .5 } });
  assert.equal(refused(a).why, 'admin'); assert.equal(room.cfg.gravity, .4);
  b.say({ t: 'cfg', set: { gravity: .5 } });
  assert.equal(room.cfg.gravity, .5);
});

test('room settings: an unknown key or a bad value is refused (whole message); a malformed message is a kick', () => {
  const { arena, creator, advance } = setup();
  const a = creator('Ann'), room = arena.rooms.get(1);
  for (const set of [{ maxHp: 50 }, { gameSpeed: 2 }, { gravity: 5 }, { gravity: .505 }, { knockY: 1 }, { gravity: .5, nope: 1 }, { __proto__x: 1 }]) {
    a.msgs.length = 0; advance(ROOM.cfgRefillMs);
    a.say({ t: 'cfg', set });
    assert.deepEqual(refused(a), { t: 'refused', what: 'cfg', why: 'value' }, JSON.stringify(set));
  }
  assert.deepEqual(cfgDiff(room.cfg), {}, 'nothing applied, not even the valid key of a mixed message');
  assert.equal(a.closed, null);
  for (const m of [{ t: 'cfg' }, { t: 'cfg', set: {} }, { t: 'cfg', set: [] }, { t: 'cfg', set: null }, { t: 'cfg', set: { gravity: '0.5' } },
    { t: 'cfg', set: { gore: null } }, { t: 'cfg', reset: 1 }, { t: 'cfg', reset: true, set: { gore: false } }]) {
    const c = creator('K' + Math.random().toString(36).slice(2, 8));
    c.say(m);
    assert.equal(c.closed && c.closed.code, KICK.malformed, JSON.stringify(m));
  }
});

test('room settings: rate-limited per connection', () => {
  const { creator, advance } = setup();
  const a = creator('Ann');
  for (let i = 0; i < ROOM.cfgBurst; i++) a.say({ t: 'cfg', set: { chopDmg: 10 + i } });
  assert.equal(refused(a), undefined);
  a.say({ t: 'cfg', set: { chopDmg: 50 } });
  assert.deepEqual(refused(a), { t: 'refused', what: 'cfg', why: 'rate' });
  advance(ROOM.cfgRefillMs);
  a.msgs.length = 0;
  a.say({ t: 'cfg', set: { chopDmg: 50 } });
  assert.equal(refused(a), undefined);
});

test('room settings: in the welcome, the lobby and a cfg event, to members and watchers of that room only', () => {
  const { arena, creator, joiner, conn, tick } = setup();
  const a = creator('Ann'), other = creator('Oz');   // room 1 and room 2
  const v = conn('v'); v.say({ t: 'view', room: 1 });
  a.say({ t: 'cfg', set: { gore: false, jumpVel: 9 } });
  for (const c of [a, v]) {
    const ev = c.events().find(e => e.type === 'cfg');
    assert.deepEqual(Object.keys(ev.cfg).sort(), Object.keys(ROOM_DEFAULTS).sort(), 'every setting, not a diff (SPEC §17.1)');
    assert.deepEqual(cfgDiff(ev.cfg), { gore: false, jumpVel: 9 }); assert.deepEqual(ev.ch, { gore: false, jumpVel: 9 });
  }
  assert.equal(other.events().find(e => e.type === 'cfg'), undefined, 'another room hears nothing');
  tick(40);
  assert.deepEqual(cfgDiff(v.last('lobby').cfg), { gore: false, jumpVel: 9 });
  assert.deepEqual(cfgDiff(other.last('lobby').cfg), {}, 'another room keeps the defaults');
  const b = joiner('Bob', 1);
  assert.deepEqual(cfgDiff(b.last('welcome').cfg), { gore: false, jumpVel: 9 });
  // setting a value it already has: no event
  const n = a.events().filter(e => e.type === 'cfg').length;
  a.say({ t: 'cfg', set: { gore: false } });
  assert.equal(a.events().filter(e => e.type === 'cfg').length, n);
  // reset
  a.say({ t: 'cfg', reset: true });
  const r = b.events().filter(e => e.type === 'cfg').at(-1);
  assert.equal(r.reset, true); assert.deepEqual(cfgDiff(r.cfg), {});
  assert.equal(arena.rooms.get(1).cfg, arena.rooms.get(1).baseCfg);
  assert.ok(Object.isFrozen(arena.rooms.get(1).cfg));
});

test('room settings: a change applies to that room\'s sim and not to another room', () => {
  const { arena, creator, tick } = setup();
  const a = creator('Ann'), o = creator('Oz');
  const r1 = arena.rooms.get(1), r2 = arena.rooms.get(2);
  a.say({ t: 'cfg', set: { gravity: .8, maxFall: 15 } });
  assert.notEqual(r1.cfg, r2.cfg);
  assert.equal(r2.cfg.gravity, DEFAULTS.gravity);
  // both players up in the air at the same height, not moving: room 1's falls faster
  tick(1);
  const p1 = Sim.getPlayer(r1.state, a.id()), p2 = Sim.getPlayer(r2.state, o.id());
  for (const p of [p1, p2]) Object.assign(p, { x: 150, y: 40, vx: 0, vy: 0, onGround: false });
  tick(10);
  assert.ok(p1.y > p2.y + 5, `room 1 fell further (${p1.y} vs ${p2.y})`);
  assert.ok(Math.abs(p1.vy - Math.min(15, 10 * .8)) < 1e-9 || p1.onGround, 'room 1 used its gravity');
  assert.ok(Math.abs(p2.vy - 10 * DEFAULTS.gravity) < 1e-9 || p2.onGround, 'room 2 used the default');
  // damage: a hit in room 1 does the room's chop damage
  a.say({ t: 'cfg', set: { chopDmg: 7 } });
  assert.equal(r1.cfg.chopDmg, 7); assert.equal(r2.cfg.chopDmg, DEFAULTS.chopDmg);
});

test('room settings die with the room: a new room starts at the defaults', () => {
  const { arena, creator, conn } = setup();
  const a = creator('Ann');
  a.say({ t: 'cfg', set: { gore: false, gravity: .5 } });
  a.say({ t: 'leave' });                  // the only human: pending admin of the room it looks at
  a.say({ t: 'view', room: 0 });          // looks away: the room closes
  assert.equal(arena.rooms.size, 0);
  const b = conn('ip-b'); b.say({ t: 'create', name: 'Bea' });
  const room = [...arena.rooms.values()][0];
  assert.deepEqual(cfgDiff(room.cfg), {});
  assert.deepEqual(cfgDiff(b.last('lobby').cfg), {});
  b.say({ t: 'hello', name: 'Bea', color: 0, room: room.id });
  assert.deepEqual(cfgDiff(b.last('welcome').cfg), {});
});

test('room settings: a server started with its own cfg resets to it; the diff describes it exactly', () => {
  const { arena, creator } = setup({ cfg: { ...DEFAULTS, itemMinTicks: 30, itemMaxTicks: 30 } });
  const a = creator('Ann'), room = arena.rooms.get(1);
  assert.deepEqual(cfgDiff(a.last('welcome').cfg), { itemMinTicks: 30, itemMaxTicks: 30 });
  a.say({ t: 'cfg', set: { gravity: .5 } });
  a.say({ t: 'cfg', reset: true });
  assert.equal(room.cfg.itemMinTicks, 30); assert.equal(room.cfg.gravity, DEFAULTS.gravity);
});

test('room settings: the bots\' route table follows the movement constants (rebuilt for new ones, kept otherwise)', () => {
  const { arena, creator, tick } = setup();
  const a = creator('Ann'), room = arena.rooms.get(1);
  a.say({ t: 'bots', n: 2 });
  tick(30);
  const before = navOf(arena.level, room.cfg);
  a.say({ t: 'cfg', set: { chopDmg: 50, gore: false } });
  assert.equal(navOf(arena.level, room.cfg), before, 'damage and gore do not touch the route table');
  a.say({ t: 'cfg', set: { jumpVel: 10 } });
  const high = navOf(arena.level, room.cfg);
  assert.notEqual(high, before, 'a jump change gets its own table');
  // higher jumps reach at least as many surfaces from each one
  const links = n => n.edges.reduce((s, m) => s + m.size, 0);
  assert.ok(links(high) >= links(before), `${links(high)} >= ${links(before)}`);
  tick(120);                              // the bots keep running on it
  assert.equal(room.bots.length, 2);
  a.say({ t: 'cfg', reset: true });
  assert.equal(navOf(arena.level, room.cfg), before, 'back to the defaults: the cached table');
});

test('determinism with a non-default room cfg (same inputs -> identical state and events)', () => {
  const cfg = { ...ROOM_DEFAULTS, gravity: .4, jumpVel: 9, runSpeed: 3.5, chopDmg: 50, knockX: 6, hitStun: 20, gore: false };
  const run = () => {
    const w = Sim.createWorld({ seed: 77 }), evs = [];
    for (let i = 1; i <= 4; i++) evs.push(...Sim.addPlayer(w, i, { cfg }));
    let r = 12345;
    const rnd = () => (r = (r * 16807) % 2147483647);
    for (let t = 0; t < 1500; t++) {
      const inp = {};
      for (let i = 1; i <= 4; i++) inp[i] = rnd() % 64;
      evs.push(...Sim.step(w, inp, { cfg }));
    }
    return JSON.stringify({ w, evs });
  };
  assert.equal(run(), run());
});

// public/net.js in Node: its '/shared/…' imports resolved to this repo, a fake WebSocket wired to an
// in-process Arena, and just enough of a browser (location, localStorage).
test('net.js: prediction uses the room\'s settings, and they follow the cfg event', async () => {
  const root = new URL('../', import.meta.url).href;
  register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      if (spec.startsWith('/shared/')) return { url: ${JSON.stringify(root)} + spec.slice(1), shortCircuit: true };
      return next(spec, ctx);
    }`));
  globalThis.location ??= { search: '', protocol: 'http:', host: 'test', pathname: '/' };
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true, writable: true });
  const { arena, creator } = setup();
  const a = creator('Ann');
  class FakeWS {
    constructor() {
      this.readyState = 1;
      queueMicrotask(() => {
        this.c = arena.connect({ ip: 'net', send: s => this.onmessage && this.onmessage({ data: s }), close: () => {} });
        this.onopen && this.onopen();
      });
    }
    send(s) { arena.onMessage(this.c, s); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWS;
  // net.js pings and watches the socket on timers: let them not keep the test process alive
  const { setInterval: si, setTimeout: st } = globalThis;
  globalThis.setInterval = (...a) => { const h = si(...a); h.unref?.(); return h; };
  globalThis.setTimeout = (...a) => { const h = st(...a); h.unref?.(); return h; };
  const { createNet } = await import('../public/net.js');
  const seen = [];
  const net = createNet({ onCfg: ev => seen.push(ev) });
  net.connect();
  await new Promise(r => setTimeout(r, 5));
  net.join('Bob', 1, 1);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(net.mode, 'play');
  assert.deepEqual(net.cfg, ROOM_DEFAULTS);
  a.say({ t: 'cfg', set: { jumpVel: 11, gravity: .5, gore: false } });
  assert.equal(net.cfg.jumpVel, 11); assert.equal(net.cfg.gore, false);
  assert.deepEqual(seen.at(-1).ch, { jumpVel: 11, gravity: .5, gore: false });
  // a snapshot gives us our player; a predicted jump uses the room's jump strength and gravity
  const room = arena.rooms.get(1);
  for (let i = 0; i < 4 && !net.me; i++) { arena.tick(); }
  assert.ok(net.me, 'own player from a snapshot');
  const me = net.me;
  Object.assign(me, { onGround: true, vx: 0, vy: 0, iframes: 0, stun: 0, alive: true, keys: 0, coyote: 6, buf: 0 });
  net.localTick(KEY.JUMP);
  assert.ok(Math.abs(net.me.vy - (-11 + .5)) < 1e-9, `predicted vy ${net.me.vy} = -jumpVel + gravity of the room`);
  assert.equal(room.cfg.jumpVel, 11);
  // reset: back to the defaults
  a.say({ t: 'cfg', reset: true });
  assert.deepEqual(net.cfg, ROOM_DEFAULTS);
  assert.equal(seen.at(-1).reset, true);
});
