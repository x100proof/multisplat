// Ninja stars (SPEC §5.2) in shared/sim.js: pickups (cadence, the max, shared item points, bundles
// of 5/10/15 at 6:3:2, the carry cap of 30, partial pickups, the snapshot packing of the amount), throwing (edge trigger, cooldown, stun, spawn protection), flight (speed, range,
// solid tiles but not planks), hits (first player only, never the thrower, not the invulnerable,
// damage, knockback, stun, kill credit), loss on death and leave, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../shared/sim.js';
import { KEY, DEFAULTS, STAR_HAND, STAR_BUNDLES } from '../shared/constants.js';
import { LEVEL } from '../shared/level.js';

const FLOOR_Y = 272 - 13;
const NO_SPAWN = 1e9;

function world(n = 2, seed = 1) {
  const w = S.createWorld({ seed });
  for (let i = 1; i <= n; i++) S.addPlayer(w, i);
  w.itemT = NO_SPAWN; w.starT = NO_SPAWN;
  return w;
}
function place(w, id, x, y = FLOOR_Y, face = 1) {
  const p = S.getPlayer(w, id);
  Object.assign(p, { x, y, px: x, py: y, vx: 0, vy: 0, face, iframes: 0, onGround: true, stun: 0 });
  return p;
}
function run(w, ticks, inputs = () => ({}), opts) {
  const ev = [];
  for (let i = 0; i < ticks; i++) ev.push(...S.step(w, inputs(i), opts));
  return ev;
}
// press throw on tick 0 (released afterwards) and run on
const toss = (w, id, ticks = 1, opts) => run(w, ticks, i => (i === 0 ? { [id]: KEY.THROW } : {}), opts);
const of = (ev, type) => ev.filter(e => e.type === type);
function lcg(seed) { return () => (seed = (seed * 48271) % 2147483647) / 2147483647; }

test('stars: a pickup every 5-10 s, at most 4 lying at once, at item points', () => {
  const gaps = [];
  for (let seed = 1; seed <= 30; seed++) {
    const w = S.createWorld({ seed });
    const ev = of(run(w, 4000), 'item').filter(e => e.kind === 'star');
    assert.equal(ev.length, 4, 'four appear, then there is no room');
    assert.equal(w.items.filter(i => i.kind === 'star').length, 4);
    gaps.push(ev[0].tick, ...ev.slice(1).map((e, i) => e.tick - ev[i].tick));
    for (const e of ev) assert.ok(LEVEL.items.some(p => p.x === e.x && p.y === e.y), 'at an item point');
    const pts = w.items.map(i => i.x + ',' + i.y);
    assert.equal(new Set(pts).size, pts.length, 'one pickup per point, of either kind');
  }
  for (const g of gaps) assert.ok(g >= DEFAULTS.starMinTicks && g <= DEFAULTS.starMaxTicks, 'gap ' + g);
  assert.ok(Math.min(...gaps) < 360 && Math.max(...gaps) > 540, 'gaps spread over 5-10 s');
});

test('stars: item points are shared with long swords (a point holds one pickup of either kind)', () => {
  const [a, b] = LEVEL.items;
  const L2 = { ...LEVEL, items: [a, b] };
  const w = S.createWorld({ seed: 5 });
  w.itemT = NO_SPAWN;
  w.items.push({ id: 1, x: a.x, y: a.y, kind: 'long' }); w.itemSeq = 1;
  w.starT = 1;
  let ev = S.step(w, {}, { level: L2 });
  assert.deepEqual(of(ev, 'item').map(e => [e.kind, e.x, e.y]), [['star', b.x, b.y]], 'the star goes to the free point');
  w.starT = 1;
  ev = run(w, 5, () => ({}), { level: L2 });
  assert.equal(of(ev, 'item').length, 0, 'no free point: no star');
  assert.equal(w.starT, 0, 'still due, retried every tick');
  // and a long sword cannot appear on a point a star holds
  const w2 = S.createWorld({ seed: 5 });
  w2.starT = NO_SPAWN;
  w2.items.push({ id: 1, x: a.x, y: a.y, kind: 'star' }); w2.itemSeq = 1;
  w2.itemT = 1;
  ev = S.step(w2, {}, { level: L2 });
  assert.deepEqual(of(ev, 'item').map(e => [e.kind, e.x, e.y]), [['long', b.x, b.y]]);
});

test('stars: a pickup gives its bundle, carrying at most 30; at 30 the pickup stays; a part-full player leaves the rest', () => {
  assert.equal(DEFAULTS.starCarry, 30);
  const w = world(2);
  const p = place(w, 1, 300), q = place(w, 2, 60);
  w.items.push({ id: 5, x: 305, y: 272, kind: 'star', n: 10 });
  let ev = S.step(w, {});
  assert.deepEqual(of(ev, 'pickup'), [{ type: 'pickup', tick: 1, id: 1, item: 5, kind: 'star', x: 305, y: 272, stars: 10, gain: 10 }]);
  assert.equal(p.stars, 10); assert.equal(w.items.length, 0);
  // 27 + a 10: 3 fit, 7 stay lying on the same pickup
  p.stars = 27;
  w.items.push({ id: 6, x: 305, y: 272, kind: 'star', n: 10 });
  ev = S.step(w, {});
  assert.deepEqual(of(ev, 'pickup').map(e => [e.item, e.gain, e.stars, e.left]), [[6, 3, 30, 7]]);
  assert.equal(p.stars, 30, 'capped at 30');
  assert.deepEqual(w.items.map(i => [i.id, i.n]), [[6, 7]], 'the rest stays as a smaller pickup');
  ev = run(w, 20);
  assert.equal(of(ev, 'pickup').length, 0, 'a full player leaves it');
  assert.deepEqual(w.items.map(i => [i.id, i.n]), [[6, 7]]);
  place(w, 2, 300);                                   // a player with room takes it (contact, 2 is pushed out a bit)
  ev = run(w, 2);
  assert.deepEqual(of(ev, 'pickup').map(e => [e.id, e.item, e.gain, e.stars, 'left' in e]), [[2, 6, 7, 7, false]]);
  assert.equal(q.stars, 7); assert.equal(w.items.length, 0);
  // exactly filling up removes the pickup; a pickup made before bundles (no n) gives 3
  const w1 = world(1);
  const f = place(w1, 1, 300); f.stars = 15;
  w1.items.push({ id: 1, x: 305, y: 272, kind: 'star', n: 15 });
  assert.deepEqual(of(S.step(w1, {}), 'pickup').map(e => [e.gain, e.stars, 'left' in e]), [[15, 30, false]]);
  assert.equal(w1.items.length, 0);
  f.stars = 0;
  w1.items.push({ id: 2, x: 305, y: 272, kind: 'star' });
  S.step(w1, {});
  assert.equal(f.stars, 3, 'legacy pickup: 3');
  // a long sword holder can still take stars, and a star carrier a long sword
  const w2 = world(1);
  const r = place(w2, 1, 300); r.long = true;
  w2.items.push({ id: 1, x: 305, y: 272, kind: 'star', n: 5 });
  S.step(w2, {});
  assert.equal(r.stars, 5);
});

test('stars: bundles of 5, 10 and 15 with odds 6 : 3 : 2 (inversely proportional to the amount)', () => {
  assert.deepEqual(STAR_BUNDLES.map(b => b.n), [5, 10, 15]);
  assert.deepEqual(STAR_BUNDLES.map(b => b.w), [6, 3, 2]);
  // the draw itself, over many seeds: each share within 1.5 points of 6/11, 3/11, 2/11
  const N = 66000, count = { 5: 0, 10: 0, 15: 0 };
  const w = S.createWorld({ seed: 12345 });
  for (let i = 0; i < N; i++) {
    const before = w.rng, n = S.drawStarAmount(w);
    assert.notEqual(w.rng, before, 'one RNG draw');
    count[n]++;
  }
  assert.equal(count[5] + count[10] + count[15], N, 'only 5, 10 or 15');
  for (const [n, share] of [[5, 6 / 11], [10, 3 / 11], [15, 2 / 11]]) assert.ok(Math.abs(count[n] / N - share) < .015, `${n}: ${count[n] / N}`);
  // the same draw is what real spawns get: 4 pickups x 300 seeds, each with its n on the item and event
  const real = { 5: 0, 10: 0, 15: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const ws = S.createWorld({ seed });
    const ev = of(run(ws, 2500), 'item').filter(e => e.kind === 'star');
    for (const e of ev) { real[e.n]++; assert.equal(ws.items.find(i => i.id === e.id).n, e.n); }
  }
  const tot = real[5] + real[10] + real[15];
  assert.ok(tot >= 1000, 'enough spawns: ' + tot);
  for (const [n, share] of [[5, 6 / 11], [10, 3 / 11], [15, 2 / 11]]) assert.ok(Math.abs(real[n] / tot - share) < .05, `spawned ${n}: ${real[n] / tot}`);
  assert.ok(real[5] > real[10] && real[10] > real[15], 'bigger bundles are rarer');
});

test('stars: the snapshot packs a star pickup amount and the page unpacks it (absent from an old server: 3)', async () => {
  const { Arena } = await import('../server/arena.js');
  const arena = new Arena({ now: () => 0, seed: 3, heartbeatMs: 0 });
  const room = arena.createRoom('Test');
  room.state.items.push({ id: 1, x: 305, y: 272, kind: 'star', n: 15 }, { id: 2, x: 72, y: 208, kind: 'long' }, { id: 3, x: 40, y: 272, kind: 'star' });
  const msgs = [];
  const v = arena.connect({ ip: 'test', send: m => msgs.push(JSON.parse(m)), close: () => {} });   // a lobby viewer
  arena.onMessage(v, JSON.stringify({ t: 'view', room: room.id }));                             // who selected the room
  room.snapshot();
  const it = msgs.filter(m => m.t === 'snapshot').at(-1).it;
  assert.deepEqual(it, [[1, 305, 272, 1, 15], [2, 72, 208, 0], [3, 40, 272, 1, 3]]);
  // the page's unpacker (shared/protocol.js, which net.js uses)
  const { unpackItems } = await import('../shared/protocol.js');
  const items = unpackItems([[1, 305, 272, 1, 15], [2, 72, 208, 0], [9, 40, 272, 1]]);
  assert.deepEqual(items, [{ id: 1, x: 305, y: 272, kind: 'star', n: 15 }, { id: 2, x: 72, y: 208, kind: 'long' }, { id: 9, x: 40, y: 272, kind: 'star' }]);
  assert.deepEqual(items.map(S.starAmount), [15, 3, 3]);
});

test('throw: edge-triggered, one star per press, short cooldown, needs a star', () => {
  const w = world(1);
  const p = place(w, 1, 60); p.stars = 5;
  // held for 30 ticks: one throw
  let ev = run(w, 30, () => ({ 1: KEY.THROW }));
  assert.equal(of(ev, 'throw').length, 1);
  assert.equal(p.stars, 4);
  // released, then pressed again at once: blocked by the cooldown until it runs out
  const w2 = world(1);
  const p2 = place(w2, 1, 60); p2.stars = 5;
  const at = [];
  ev = run(w2, 40, i => ({ 1: i % 2 ? 0 : KEY.THROW }));      // tapping every other tick
  for (const e of of(ev, 'throw')) at.push(e.tick);
  assert.ok(at.length >= 2);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= DEFAULTS.throwCd, 'cooldown ' + (at[i] - at[i - 1]));
  assert.equal(at[1] - at[0], DEFAULTS.throwCd + 1, 'the first tap after the cooldown throws (taps land on even ticks)');
  // no stars: nothing happens
  const w3 = world(1);
  place(w3, 1, 60);
  assert.equal(of(toss(w3, 1, 3), 'throw').length, 0);
  assert.equal(w3.stars.length, 0);
});

test('throw: not in hit-stun; throwing ends spawn invulnerability', () => {
  const w = world(1);
  const p = place(w, 1, 60); p.stars = 3; p.stun = 5;
  assert.equal(of(toss(w, 1), 'throw').length, 0, 'stunned: no throw');
  assert.equal(p.stars, 3);
  run(w, 6);
  assert.equal(of(toss(w, 1), 'throw').length, 1, 'after the stun it works');
  const w2 = world(1);
  const q = place(w2, 1, 60); q.stars = 1; q.iframes = 90;
  toss(w2, 1);
  assert.equal(q.iframes, 0, 'spawn protection ended by the throw');
});

test('flight: 6 units a tick from hand height in the facing direction, no range: flies on to the wall', () => {
  const w = world(1);
  const p = place(w, 1, 100, 1 * 16 + 3, -1); p.stars = 1; p.onGround = false;   // in the open air near the ceiling, facing left
  Object.assign(p, { x: 300, px: 300, y: 40, py: 40 });
  const ev = toss(w, 1);
  const th = of(ev, 'throw')[0];
  assert.ok(th);
  const st = w.stars[0];
  assert.equal(st.y, th.y); assert.equal(th.face, -1);
  assert.ok(Math.abs(th.y - (S.getPlayer(w, 1).y + STAR_HAND)) < 1e-9, 'at hand height');
  assert.equal(st.vx, -6);
  const x0 = th.x;
  assert.equal(st.x, x0 - 6, 'moved 6 on the throw tick');
  const xs = [];
  let end = null;
  for (let t = 0; t < 200 && !end; t++) { const e = S.step(w, {}); end = e.find(x => x.type === 'starEnd'); if (!end) xs.push(w.stars[0].x); }
  for (let i = 1; i < xs.length; i++) assert.equal(xs[i - 1] - xs[i], 6);
  assert.ok(end, 'the star ends');
  assert.equal(end.wall, true, 'by a wall, not a range');
  assert.ok(x0 - end.x > 240, `flew past the old 240-unit range (${x0 - end.x})`);
  assert.equal(w.stars.length, 0);
});

test('flight: stopped by a solid tile, not by a plank', () => {
  const grid = LEVEL.grid.slice();
  grid[16] = '#' + '.'.repeat(9) + '=' + '.'.repeat(5) + 'B' + '.'.repeat(8) + '#';   // a plank at col 10, a block at col 16
  const L2 = { ...LEVEL, grid };
  const w = world(1);
  const p = place(w, 1, 100); p.stars = 1;
  const ev = run(w, 40, i => (i === 0 ? { 1: KEY.THROW } : {}), { level: L2 });
  const end = of(ev, 'starEnd')[0];
  assert.ok(end && end.wall, 'stopped by the block');
  assert.equal(end.x, 16 * 16 - 2, 'its leading edge at the block face');
  assert.ok(end.tick - of(ev, 'throw')[0].tick < 40);
});

test('hits: the first player in its path only, never the thrower, not the invulnerable', () => {
  // two in line: the nearer one is hit, the farther one is not, and the star is spent
  let w = world(3);
  let a = place(w, 1, 60); a.stars = 1;
  const near = place(w, 2, 140), far = place(w, 3, 180);
  let ev = run(w, 30, i => (i === 0 ? { 1: KEY.THROW } : {}));
  let hits = of(ev, 'hit');
  assert.deepEqual(hits.map(h => [h.attacker, h.victim, h.move]), [[1, 2, 'star']]);
  assert.equal(far.hp, 100); assert.equal(w.stars.length, 0);
  assert.equal(of(ev, 'starEnd').length, 0, 'spent on the hit');
  // the thrower overlapping its own star is never hit; a body right next to it is (point blank)
  w = world(2);
  a = place(w, 1, 100); a.stars = 1;
  const pb = place(w, 2, 108);
  ev = toss(w, 1);
  assert.deepEqual(of(ev, 'hit').map(h => h.victim), [2]);
  assert.equal(a.hp, 100); assert.equal(pb.hp, 80);
  // an invulnerable player is passed through; the one behind is hit
  w = world(3);
  a = place(w, 1, 60); a.stars = 1;
  const inv = place(w, 2, 140); inv.iframes = 90;
  const behind = place(w, 3, 180);
  ev = run(w, 30, i => (i === 0 ? { 1: KEY.THROW } : {}));
  assert.deepEqual(of(ev, 'hit').map(h => h.victim), [3]);
  assert.equal(inv.hp, 100); assert.equal(behind.hp, 80);
  // dead players are passed through too
  w = world(3);
  a = place(w, 1, 60); a.stars = 1;
  const dead = place(w, 2, 140); dead.alive = false; dead.respawn = 1e9;
  place(w, 3, 180);
  ev = run(w, 30, i => (i === 0 ? { 1: KEY.THROW } : {}));
  assert.deepEqual(of(ev, 'hit').map(h => h.victim), [3]);
  // stars are not lag-compensated: a rewind hook does not change where a star hits
  w = world(2);
  a = place(w, 1, 60); a.stars = 1;
  place(w, 2, 140);
  ev = run(w, 30, i => (i === 0 ? { 1: KEY.THROW } : {}), { rewind: () => [{ id: 2, x: 400, y: 0 }] });
  assert.deepEqual(of(ev, 'hit').map(h => h.victim), [2]);
});

test('hits: 20 damage, a small knockback along the flight, hit-stun', () => {
  const w = world(2);
  const a = place(w, 1, 170, FLOOR_Y, -1); a.stars = 1;
  const v = place(w, 2, 90);
  const ev = run(w, 30, i => (i === 0 ? { 1: KEY.THROW } : {}));
  const h = of(ev, 'hit')[0];
  assert.equal(h.dmg, 20); assert.equal(h.hp, 80); assert.equal(h.move, 'star'); assert.equal(h.attacker, 1); assert.equal(h.dir, -1);
  assert.ok(Number.isInteger(h.star));
  // knockback and stun were applied on the hit tick; check via a fresh run stopped there
  const w2 = world(2);
  const a2 = place(w2, 1, 170, FLOOR_Y, -1); a2.stars = 1;
  const v2 = place(w2, 2, 90);
  let hit = null;
  for (let t = 0; t < 30 && !hit; t++) hit = S.step(w2, t === 0 ? { 1: KEY.THROW } : {}).find(e => e.type === 'hit');
  assert.equal(v2.vx, -DEFAULTS.starKnockX); assert.equal(v2.vy, DEFAULTS.starKnockY);
  assert.equal(v2.stun, DEFAULTS.hitStun);
  assert.ok(DEFAULTS.starKnockX < DEFAULTS.knockX, 'smaller than a sword knockback');
  assert.equal(v2.lastHitBy, 1);
  assert.equal(v.hp, 80);
});

test('kills: credit to the thrower, the kill event says star, the knock is x1.4', () => {
  const w = world(2);
  const a = place(w, 1, 60); a.stars = 1;
  const v = place(w, 2, 140); v.hp = 20;
  let k = null;
  for (let t = 0; t < 30 && !k; t++) k = S.step(w, t === 0 ? { 1: KEY.THROW } : {}).find(e => e.type === 'kill');
  assert.ok(k);
  assert.equal(k.killer, 1); assert.equal(k.victim, 2); assert.equal(k.move, 'star');
  assert.ok(Number.isInteger(k.seed));
  assert.equal(a.score, 1); assert.equal(v.deaths, 1); assert.equal(v.alive, false);
  assert.ok(Math.abs(v.vx - DEFAULTS.starKnockX * DEFAULTS.killKnockMul) < 1e-9);
  assert.equal('long' in k, false);
  // the thrower dying while the star flies still gets the credit
  const w2 = world(3);
  const t2 = place(w2, 1, 230); t2.stars = 1;
  const v2 = place(w2, 2, 370); v2.hp = 20;
  place(w2, 3, 40);
  S.step(w2, { 1: KEY.THROW });
  S.killPlayer(w2, 1, 'test');
  let k2 = null;
  for (let t = 0; t < 40 && !k2; t++) k2 = S.step(w2, {}).find(e => e.type === 'kill');
  assert.equal(k2.killer, 1); assert.equal(k2.move, 'star');
});

test('stars are lost on death and on leaving', () => {
  const w = world(2);
  const v = place(w, 2, 112); v.stars = 5; v.hp = 10;
  place(w, 1, 100);
  const kill = run(w, 13, i => (i === 0 ? { 1: KEY.SLASH } : {})).find(e => e.type === 'kill');
  assert.equal(kill.stars, 5, 'the kill event says how many were lost');
  assert.equal(v.stars, 0);
  run(w, DEFAULTS.respawnTicks + 2);
  assert.equal(v.alive, true); assert.equal(v.stars, 0, 'respawn with none');
  // killPlayer (e.g. killed for leaving), then removed; the same id rejoins with none
  const w2 = world(2);
  const l = place(w2, 2, 300); l.stars = 9;
  assert.equal(S.killPlayer(w2, 2, 'leave')[0].stars, 9);
  S.removePlayer(w2, 2); S.addPlayer(w2, 2);
  assert.equal(S.getPlayer(w2, 2).stars, 0);
  // removed alive: gone too
  const p1 = S.getPlayer(w2, 1); p1.stars = 4;
  S.removePlayer(w2, 1); S.addPlayer(w2, 1);
  assert.equal(S.getPlayer(w2, 1).stars, 0);
});

test('determinism with stars in play (same inputs -> identical serialized state and events)', () => {
  const cfg = { ...DEFAULTS, starMinTicks: 30, starMaxTicks: 90 };
  const play = seed => {
    const w = S.createWorld({ seed }), r = lcg(17), log = [];
    for (let i = 1; i <= 6; i++) S.addPlayer(w, i, { cfg });
    for (let t = 0; t < 6000; t++) {
      const inp = {};
      for (const p of w.players) inp[p.id] = Math.floor(r() * 64);
      log.push(...S.step(w, inp, { cfg }));
      if (t === 3000) { S.removePlayer(w, 2); S.addPlayer(w, 8, { cfg }); }
      if (t === 2000) assert.deepEqual(S.deserialize(S.serialize(w)), w);
    }
    return { state: S.serialize(w), events: JSON.stringify(log), log };
  };
  const a = play(21), b = play(21);
  assert.equal(a.state, b.state);
  assert.equal(a.events, b.events);
  assert.ok(of(a.log, 'pickup').filter(e => e.kind === 'star').length >= 3, 'star pickups happened');
  assert.ok(of(a.log, 'item').filter(e => e.kind === 'star').every(e => [5, 10, 15].includes(e.n)), 'star bundles drawn');
  assert.ok(of(a.log, 'throw').length >= 5, 'stars were thrown');
  assert.ok(of(a.log, 'hit').some(e => e.move === 'star'), 'stars hit');
  assert.notEqual(play(22).state, a.state);
  // resuming from a deserialized mid-flight state continues identically
  const w = S.createWorld({ seed: 4 });
  for (let i = 1; i <= 4; i++) S.addPlayer(w, i, { cfg });
  for (const p of w.players) p.stars = 30;
  const r = lcg(3), inputs = Array.from({ length: 2000 }, () => [1, 2, 3, 4].map(() => Math.floor(r() * 64)));
  const feed = (st, from, to) => { for (let t = from; t < to; t++) S.step(st, { 1: inputs[t][0], 2: inputs[t][1], 3: inputs[t][2], 4: inputs[t][3] }, { cfg }); };
  let mid = 0;
  for (; mid < 1500; mid++) { feed(w, mid, mid + 1); if (mid > 200 && w.stars.length) break; }
  assert.ok(w.stars.length, 'a star is in flight at the copy');
  const copy = S.deserialize(S.serialize(w));
  feed(w, mid + 1, 2000); feed(copy, mid + 1, 2000);
  assert.equal(S.serialize(copy), S.serialize(w));
});

test('predictStep ignores the throw bit (the throw is never predicted)', () => {
  const w = world(1);
  const p = place(w, 1, 60); p.stars = 3;
  S.predictStep(w, 1, KEY.THROW);
  assert.equal(p.stars, 3); assert.equal(w.stars.length, 0);
});
