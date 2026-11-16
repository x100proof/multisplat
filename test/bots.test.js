// AI players (SPEC §15): the lobby control, slots, the reserved colour and the brain, headless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, KICK } from '../server/arena.js';
import { newBrain, botKeys, navOf, surfaceAt } from '../server/ai.js';
import * as Sim from '../shared/sim.js';
import { KEY, NET, BOT, COLORS, PALETTE, PW, PH, DEFAULTS } from '../shared/constants.js';
import { LEVEL } from '../shared/level.js';

// An arena on a fake clock with fake connections (no heartbeat: these tests are about bots).
function setup(opts = {}) {
  let t = 1000;
  const evlog = [];
  const arena = new Arena({ now: () => t, seed: 7, heartbeatMs: 0, event: (type, conn, data) => evlog.push({ type, conn, ...data }), ...opts });
  const sent = [];
  const orig = arena.broadcastEvents.bind(arena);
  arena.broadcastEvents = evs => { sent.push(...evs); orig(evs); };
  const conn = (ip = 'test') => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, JSON.stringify(m));
    c.last = ty => [...c.msgs].reverse().find(m => m.t === ty);
    return c;
  };
  const advance = ms => { t += ms; };
  const ticks = n => { for (let i = 0; i < n; i++) { t += 1000 / 60; arena.tick(); } };
  return { arena, conn, advance, ticks, sent, evlog };
}

test('bots: + and - from any connection, the count is in every lobby message', () => {
  const { arena, conn, advance, ticks } = setup();
  const a = conn(), b = conn();
  a.say({ t: 'bots', d: 1 });
  assert.equal(arena.bots.length, 1);
  assert.equal(a.last('lobby').bots, 1);                       // the sender hears at once
  assert.equal(a.last('lobby').botMax, NET.maxPlayers - 1);
  ticks(1);
  assert.equal(b.last('lobby').bots, 1);                       // everyone else with the next broadcast
  const bot = b.last('lobby').players.find(p => p.bot);
  assert.equal(bot.name, 'AI 1'); assert.equal(bot.color, BOT.color); assert.equal(bot.away, false);
  advance(1000);
  b.say({ t: 'bots', d: 1 }); b.say({ t: 'bots', d: 1 });
  assert.deepEqual(arena.bots.map(r => r.name), ['AI 1', 'AI 2', 'AI 3']);
  b.say({ t: 'bots', d: -1 });                                // the newest goes first
  assert.deepEqual(arena.bots.map(r => r.name), ['AI 1', 'AI 2']);
  advance(1000);
  a.say({ t: 'bots', n: 0 });
  assert.equal(arena.bots.length, 0);
  assert.equal(arena.state.players.length, 0);
  a.say({ t: 'bots', d: -1 });                                // - at zero: nothing, no kick
  assert.equal(a.closed, null);
});

test('bots: count limits, at most slots - 1, and + is refused when no slot is free', () => {
  const { arena, conn, advance } = setup();
  const a = conn();
  a.say({ t: 'bots', n: NET.maxPlayers - 1 });
  assert.equal(arena.bots.length, NET.maxPlayers - 1);
  advance(2000);
  a.say({ t: 'bots', d: 1 });                                 // at botMax
  assert.equal(arena.bots.length, NET.maxPlayers - 1);
  const h = conn();
  h.say({ t: 'hello', name: 'Kit', color: 0 });               // the last slot goes to a human
  assert.equal(h.last('welcome').state, 'play');
  assert.equal(arena.activeCount(), NET.maxPlayers);
  advance(2000);
  a.say({ t: 'bots', n: 3 });
  assert.equal(arena.bots.length, 3);
  advance(2000);
  for (let i = 0; i < 8; i++) conn('ip' + i).say({ t: 'hello', name: 'P' + i, color: i % COLORS.length });   // fill the arena
  assert.equal(arena.activeCount(), NET.maxPlayers);
  a.say({ t: 'bots', d: 1 });                                 // full: refused, nobody evicted
  assert.equal(arena.bots.length, 3);
  const q = conn('q');
  q.say({ t: 'hello', name: 'Late', color: 1 });             // humans queue as before, bots are not evicted
  assert.equal(q.last('welcome').state, 'queue');
  assert.equal(arena.bots.length, 3);
  advance(2000);
  a.say({ t: 'bots', d: -1 });                                // a removed bot's slot goes to the queue
  assert.equal(arena.bots.length, 2);
  assert.equal(arena.recs.get(q.last('welcome').id).state, 'play');
});

test('bots: malformed requests are kicks, floods are dropped then kicked', () => {
  for (const bad of [{}, { d: 2 }, { d: '1' }, { n: -1 }, { n: 12 }, { n: 1.5 }, { d: 1, n: 1 }, { n: null }]) {
    const { conn } = setup();
    const c = conn();
    c.say({ t: 'bots', ...bad });
    assert.equal(c.closed && c.closed.code, KICK.malformed, JSON.stringify(bad));
  }
  const { arena, conn, advance } = setup();
  const c = conn();
  for (let i = 0; i < 10; i++) c.say({ t: 'bots', d: 1 });   // 10/s message bucket, 4-burst bot bucket
  assert.equal(arena.bots.length, BOT.burst);
  assert.ok(c.conn.dropCount >= 10 - BOT.burst);
  assert.equal(c.closed, null);                               // a few drops are no kick
});

test('bots: the arena-wide budget caps bot changes per second', () => {
  const { arena, conn, evlog } = setup();
  const cs = Array.from({ length: 10 }, (_, i) => conn('ip' + i));
  for (let r = 0; r < 4; r++) for (const c of cs) c.say({ t: 'bots', d: r % 2 ? -1 : 1 });
  const changed = evlog.filter(e => e.type === 'bots').reduce((s, e) => s + e.changed, 0);
  assert.ok(changed <= BOT.globalBurst, `changed ${changed}`);
});

test('bots: the reserved colour is not in the human palette and a human hello with it is refused', () => {
  assert.ok(!COLORS.includes(BOT.hex));
  assert.equal(PALETTE[BOT.color], BOT.hex);
  const { arena, conn } = setup();
  const c = conn();
  c.say({ t: 'hello', name: 'Sneaky', color: BOT.color });
  assert.equal(c.closed && c.closed.code, KICK['bad hello']);
  assert.equal(arena.recs.size, 0);
  // and a human never gets it handed out by the free-colour rule, even among many bots
  const { arena: a2, conn: conn2 } = setup();
  conn2().say({ t: 'bots', n: 4 });
  const h = conn2('h');
  h.say({ t: 'hello', name: 'Kit', color: 3 });
  assert.equal(h.last('welcome').color, 3);
  for (const r of a2.bots) assert.equal(r.color, BOT.color);
});

test('bots: names respect the #suffix rule and the debug views show them', () => {
  const { arena, conn } = setup();
  const h = conn();
  h.say({ t: 'hello', name: 'AI 1', color: 0 });
  conn('v').say({ t: 'bots', d: 1 });
  assert.equal(arena.bots[0].name, 'AI 1#2');
  const s = arena.adminState();
  assert.equal(s.bots, 1);
  const bv = s.players.find(p => p.bot);
  assert.equal(bv.state, 'play (bot)'); assert.equal(bv.conn, null);
  assert.equal(arena.viewByToken(null), null);
});

test('bots: never idle-kicked, never timed out, and not counted toward a per-IP cap', () => {
  const { arena, conn, advance, ticks } = setup({ maxPerIp: 1, idleMs: 1000, graceMs: 500 });
  conn().say({ t: 'bots', n: 2 });
  advance(5000); ticks(5);
  assert.equal(arena.bots.length, 2);
  const h = conn();
  h.say({ t: 'hello', name: 'Kit', color: 0 });
  assert.equal(h.last('welcome').state, 'play');
});

// ---------- the brain ----------
const standAt = (state, id, cx, feet) => { const p = Sim.getPlayer(state, id); Object.assign(p, { x: cx - PW / 2, y: feet - PH, vx: 0, vy: 0, onGround: true, iframes: 0 }); return p; };

test('ai: the route table reaches every surface from every other', () => {
  const nav = navOf(LEVEL, DEFAULTS);
  assert.ok(nav.surf.length > 5);
  for (let a = 0; a < nav.surf.length; a++) for (let b = 0; b < nav.surf.length; b++)
    if (a !== b) assert.notEqual(nav.next[a][b], null, `${a} -> ${b}`);
  assert.equal(nav, navOf(LEVEL, DEFAULTS));                   // cached
});

test('ai: walks toward an opponent on its level, turns to face one in reach, then slashes', () => {
  const st = Sim.createWorld({ seed: 3 });
  Sim.addPlayer(st, 1); Sim.addPlayer(st, 2);
  const floor = (LEVEL.h - 1) * 16;
  const me = standAt(st, 1, 40, floor); standAt(st, 2, 150, floor); me.face = 1;
  const b = newBrain(5);
  let k = botKeys(b, me, st, new Map());
  assert.ok(k & KEY.RIGHT, `keys ${k}`);
  assert.ok(!(k & KEY.LEFT));
  // in reach, facing away: turn first, then a slash within a few ticks (the bot hesitates a bit)
  standAt(st, 2, 30, floor); me.face = 1; b.prev = 0;
  k = botKeys(b, me, st, new Map());
  assert.equal(k, KEY.LEFT);
  me.face = -1;
  let slashed = false;
  for (let i = 0; i < 60 && !slashed; i++) { b.prev = 0; slashed = (botKeys(b, me, st, new Map()) & KEY.SLASH) !== 0; }
  assert.ok(slashed);
  // it sees the others late: a remembered position wins over the live one
  standAt(st, 2, 30, floor); me.face = -1; b.thinkT = 0; b.target = null;
  k = botKeys(b, me, st, new Map([[2, { id: 2, x: 300, y: floor - PH }]]));
  assert.ok(k & KEY.RIGHT);
});

test('ai: throws a star along a clear row, not through a block', () => {
  const st = Sim.createWorld({ seed: 3 });
  Sim.addPlayer(st, 1); Sim.addPlayer(st, 2);
  const floor = (LEVEL.h - 1) * 16;
  const me = standAt(st, 1, 40, floor); standAt(st, 2, 150, floor); me.face = 1; me.stars = 3;
  const b = newBrain(9);
  let threw = false;
  for (let i = 0; i < 120 && !threw; i++) { b.prev = 0; threw = (botKeys(b, me, st, new Map()) & KEY.THROW) !== 0; }
  assert.ok(threw);
  standAt(st, 2, 300, floor);                                   // behind the low centre block
  for (let i = 0; i < 120; i++) { b.prev = 0; assert.ok(!(botKeys(b, me, st, new Map()) & KEY.THROW)); }
});

test('ai: climbs to an opponent on a higher surface', () => {
  const { arena, ticks } = setup();
  arena.addBot();
  const st = arena.state, nav = navOf(arena.level, arena.cfg);
  // a dummy (no brain, no inputs) standing on the high left plank
  Sim.addPlayer(st, 99);
  const bot = Sim.getPlayer(st, arena.bots[0].id);
  standAt(st, bot.id, 40, (LEVEL.h - 1) * 16);
  const dummy = standAt(st, 99, 100, 3 * 16); dummy.iframes = 0;
  let reached = false;
  for (let i = 0; i < 1800 && !reached; i++) {
    ticks(1);
    const d = Sim.getPlayer(st, 99); d.iframes = 0; d.hp = 1000; // keep the dummy alive and hittable
    reached = bot.alive && surfaceAt(nav, bot.x, bot.y + bot.h) === surfaceAt(nav, d.x, d.y + d.h);
  }
  assert.ok(reached, `bot at ${bot.x},${bot.y}`);
});

test('ai: bots kill each other, kill a passive human and can be killed (60 s headless)', () => {
  const { arena, conn, ticks, sent } = setup({ idleMs: 1e9 });
  const h = conn();
  h.say({ t: 'hello', name: 'Kit', color: 0 });
  const hid = h.last('welcome').id;
  arena.addBot(); arena.addBot(); arena.addBot();
  ticks(3600);
  const kills = sent.filter(e => e.type === 'kill');
  const isBot = id => arena.bots.some(r => r.id === id);
  assert.ok(kills.some(e => isBot(e.killer) && isBot(e.victim)), 'bot kills bot');
  assert.ok(kills.some(e => isBot(e.killer) && e.victim === hid), 'bot kills human');
  // bots respawn like players
  assert.ok(sent.filter(e => e.type === 'spawn' && isBot(e.id)).length > 3);
  assert.ok(sent.some(e => e.type === 'pickup' && isBot(e.id)), 'a bot picked something up');
});

test('ai: a human that fights back kills bots', () => {
  const { arena, conn, ticks, sent } = setup({ idleMs: 1e9 });
  const h = conn();
  h.say({ t: 'hello', name: 'Kit', color: 0 });
  const hid = h.last('welcome').id;
  arena.addBot(); arena.addBot();
  // the "human": an un-delayed copy of the bot brain, swinging at every chance (no hesitation)
  const brain = newBrain(1); brain.delay = 0; brain.aggr = 1;
  let seq = 0;
  for (let i = 0; i < 3600; i++) {
    const me = Sim.getPlayer(arena.state, hid);
    h.say({ t: 'input', seq: seq++, keys: botKeys(brain, me, arena.state, null) });
    ticks(1);
  }
  assert.ok(sent.some(e => e.type === 'kill' && e.killer === hid), 'human kills a bot');
});

test('ai: deterministic: the same seed gives the same fight, and the sim stays deterministic', () => {
  const run = () => {
    const { arena, ticks, sent } = setup();
    for (let i = 0; i < 4; i++) arena.addBot();
    ticks(1200);
    return JSON.stringify([Sim.serialize(arena.state), sent.filter(e => e.type === 'kill')]);
  };
  assert.equal(run(), run());
  // bots act only through their key masks: replaying the masks into a bare sim gives the same world
  const { arena, ticks } = setup();
  for (let i = 0; i < 4; i++) arena.addBot();
  const ids = arena.bots.map(r => r.id), masks = [];
  for (let i = 0; i < 900; i++) { ticks(1); masks.push(new Map(arena.bots.map(r => [r.id, r.lastKeys]))); }
  const w = Sim.createWorld({ seed: 7 });
  for (const id of ids) Sim.addPlayer(w, id);
  for (const m of masks) Sim.step(w, m);
  assert.equal(Sim.serialize(w), Sim.serialize(arena.state));
});
