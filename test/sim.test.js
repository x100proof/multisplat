// Unit tests for shared/sim.js: determinism, collision, combat, lag-compensation helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../shared/sim.js';
import { KEY, DEFAULTS } from '../shared/constants.js';

const FLOOR_Y = 272 - 13;   // y of a player standing on the floor

function world(n = 2, seed = 1) {
  const w = S.createWorld({ seed });
  for (let i = 1; i <= n; i++) S.addPlayer(w, i);
  return w;
}
// Put a player somewhere, at rest and without spawn protection.
function place(w, id, x, y, face = 1) {
  const p = S.getPlayer(w, id);
  Object.assign(p, { x, y, px: x, py: y, vx: 0, vy: 0, face, iframes: 0, onGround: true });
  return p;
}
function lcg(seed) { return () => (seed = (seed * 48271) % 2147483647) / 2147483647; }

// Run ticks with a function giving the inputs for each tick; returns all events.
function run(w, ticks, inputs = () => ({}), opts) {
  const ev = [];
  for (let i = 0; i < ticks; i++) ev.push(...S.step(w, inputs(i), opts));
  return ev;
}
// Press slash on tick 0 (released afterwards) and run until the swing is over.
const swing = (w, id, ticks = 13) => run(w, ticks, i => (i === 0 ? { [id]: KEY.SLASH } : {}));

test('determinism: identical input streams give identical state', () => {
  const play = seed => {
    const w = world(6, seed), r = lcg(99), log = [];
    for (let t = 0; t < 3000; t++) {
      const inp = {};
      for (const p of w.players) inp[p.id] = Math.floor(r() * 32);
      log.push(...S.step(w, inp));
      if (t === 1500) { S.removePlayer(w, 3); S.addPlayer(w, 9); }
    }
    return { state: S.serialize(w), events: JSON.stringify(log) };
  };
  const a = play(42), b = play(42);
  assert.equal(a.state, b.state);
  assert.equal(a.events, b.events);
  assert.ok(JSON.parse(a.events).some(e => e.type === 'hit'), 'random play produces some hits');
  assert.notEqual(play(43).state, a.state, 'a different seed gives a different world');
});

test('determinism: a deserialized state continues identically', () => {
  const w = world(4, 5), r = lcg(7);
  const inputs = Array.from({ length: 600 }, () => ({ 1: r() * 32 | 0, 2: r() * 32 | 0, 3: r() * 32 | 0, 4: r() * 32 | 0 }));
  run(w, 300, i => inputs[i]);
  const copy = S.deserialize(S.serialize(w));
  run(w, 300, i => inputs[300 + i]);
  run(copy, 300, i => inputs[300 + i]);
  assert.equal(S.serialize(copy), S.serialize(w));
});

test('shared/ uses no Math.random, Date or DOM', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../shared/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '');   // code only
    assert.doesNotMatch(src, /Math\.random|Date\.|performance\.|document\.|window\./, f);
  }
});

test('movement: walk, run and jump follow NinjaRunner constants', () => {
  const w = world(1);
  const p = place(w, 1, 230, FLOOR_Y);
  run(w, 30, () => ({ 1: KEY.RIGHT }));
  // NinjaRunner's accel rule flickers between max and max * .97 at top speed
  assert.ok(p.vx >= DEFAULTS.walkSpeed * .97 && p.vx <= DEFAULTS.walkSpeed);
  run(w, 30, () => ({ 1: KEY.RIGHT | KEY.RUN }));
  assert.ok(p.vx >= DEFAULTS.runSpeed * .97 && p.vx <= DEFAULTS.runSpeed);
  run(w, 1, () => ({ 1: KEY.RIGHT | KEY.RUN | KEY.JUMP }));
  assert.ok(p.vy < -DEFAULTS.jumpVel, 'run-jump is stronger than a standing jump');
  // holding jump keeps rising longer than a tap (variable jump height)
  const hi = world(1), lo = world(1);
  const ph = place(hi, 1, 290, FLOOR_Y), pl = place(lo, 1, 290, FLOOR_Y);
  let minH = FLOOR_Y, minL = FLOOR_Y;
  for (let i = 0; i < 60; i++) {
    S.step(hi, { 1: i < 40 ? KEY.JUMP : 0 }); S.step(lo, { 1: i < 2 ? KEY.JUMP : 0 });
    minH = Math.min(minH, ph.y); minL = Math.min(minL, pl.y);
  }
  assert.ok(minH < minL - 20, `held jump peaks higher (${minH} vs ${minL})`);
});

test('movement: jump buffer and coyote time', () => {
  // buffer: pressing jump a few ticks before landing still jumps on landing
  const w = world(1);
  const p = place(w, 1, 40, FLOOR_Y - 10); p.onGround = false; p.vy = 2;
  let jumped = false;
  for (let i = 0; i < 10; i++) { S.step(w, { 1: i < 1 ? KEY.JUMP : 0 }); if (p.vy < -5) jumped = true; }
  assert.ok(jumped, 'buffered jump fires on landing');
  // coyote: walk off the tier-1 ledge (cols 1-4) and jump after leaving it
  const v = world(1);
  const q = place(v, 1, 4 * 16 + 5, 208 - 13);
  let left = -1;
  for (let i = 0; i < 40 && left < 0; i++) { S.step(v, { 1: KEY.RIGHT }); if (!q.onGround) left = i; }
  assert.ok(left >= 0);
  S.step(v, { 1: KEY.RIGHT });
  S.step(v, { 1: KEY.RIGHT | KEY.JUMP });
  assert.ok(q.vy < -5, 'jump within coyote time');
});

test('collision: overlapping players are pushed apart symmetrically', () => {
  const w = world(2);
  const a = place(w, 1, 100, FLOOR_Y), b = place(w, 2, 104, FLOOR_Y);
  S.step(w, {});
  assert.ok(!S.overlap(a, b), 'no overlap after one step');
  assert.ok(Math.abs((100 - a.x) - (b.x - 104)) < 1e-9, 'pushed by equal amounts');
  assert.ok(a.x < b.x);
});

test('collision: players walking into each other never pass through', () => {
  const w = world(2);
  const a = place(w, 1, 80, FLOOR_Y), b = place(w, 2, 140, FLOOR_Y);
  for (let i = 0; i < 120; i++) {
    S.step(w, { 1: KEY.RIGHT | KEY.RUN, 2: KEY.LEFT });
    assert.ok(a.x + a.w <= b.x + 1e-9, `tick ${i}: a stays left of b`);
  }
  assert.ok(Math.abs(a.vx) < DEFAULTS.runSpeed, 'velocity damped on contact');
});

test('collision: a pushed player stops at the wall and the pusher stops too', () => {
  const w = world(2);
  const a = place(w, 1, 16, FLOOR_Y), b = place(w, 2, 40, FLOOR_Y);
  for (let i = 0; i < 90; i++) S.step(w, { 2: KEY.LEFT | KEY.RUN });
  assert.equal(a.x, 16, 'a against the left wall');
  assert.ok(b.x >= a.x + a.w - 1e-9);
});

test('collision: standing on another player\'s head', () => {
  const w = world(2);
  const b = place(w, 2, 100, FLOOR_Y);
  const a = place(w, 1, 101, FLOOR_Y - 40); a.onGround = false;
  const hpA = a.hp, hpB = b.hp;
  run(w, 60);
  assert.ok(Math.abs(a.y - (b.y - a.h)) < 1e-9, 'a rests on b\'s head');
  assert.equal(a.standOn, 2);
  assert.ok(a.onGround);
  assert.equal(a.hp, hpA); assert.equal(b.hp, hpB, 'stomping is not an attack');
  // b walks: a rides along
  const ax = a.x;
  run(w, 10, () => ({ 2: KEY.RIGHT }));
  assert.ok(a.x > ax + 3 && a.standOn === 2, 'a is carried');
  // a can jump off the head
  S.step(w, { 1: KEY.JUMP });
  assert.ok(a.vy < -5);
});

test('combat: chop hits once per swing for 34 with knockback and hit-stun', () => {
  const w = world(2);
  const a = place(w, 1, 60, FLOOR_Y, 1), b = place(w, 2, 72, FLOOR_Y);
  // hold slash for the whole swing: still one swing, one hit
  const ev = run(w, 14, () => ({ 1: KEY.SLASH }));
  const hits = ev.filter(e => e.type === 'hit');
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].attacker, hits[0].victim, hits[0].move, hits[0].dmg], [1, 2, 'chop', 34]);
  assert.equal(b.hp, 66);
  assert.equal(a.swing, 1);
  // knockback was applied away from the attacker
  assert.ok(b.x > 72);
  // hit-stun: 10 ticks without attacking
  const w2 = world(2);
  place(w2, 1, 60, FLOOR_Y, 1); const v = place(w2, 2, 72, FLOOR_Y, -1);
  run(w2, 4, i => (i === 0 ? { 1: KEY.SLASH } : {}));
  assert.ok(v.stun > 0 && v.stun <= DEFAULTS.hitStun);
  S.step(w2, { 2: KEY.SLASH });
  assert.equal(v.atk, 0, 'cannot attack while stunned');
  run(w2, DEFAULTS.hitStun);
  assert.equal(v.stun, 0);
  S.step(w2, { 2: KEY.SLASH });
  assert.ok(v.atk > 0, 'can attack after stun');
});

test('combat: sweep follows a chop within the combo window for 25', () => {
  const w = world(2);
  const a = place(w, 1, 60, FLOOR_Y, 1), b = place(w, 2, 72, FLOOR_Y);
  swing(w, 1, 17);
  place(w, 2, 72, FLOOR_Y); b.hp = 100;
  const ev = swing(w, 1);
  const hit = ev.find(e => e.type === 'hit');
  assert.equal(a.atkType, 'sweep');
  assert.equal(hit.move, 'sweep'); assert.equal(hit.dmg, 25); assert.equal(b.hp, 75);
});

test('combat: kill, score, respawn delay and spawn invulnerability', () => {
  const w = world(2);
  const a = place(w, 1, 60, FLOOR_Y, 1), b = S.getPlayer(w, 2);
  const ev = [];
  for (let s = 0; s < 6 && b.alive; s++) { place(w, 2, 72, FLOOR_Y); ev.push(...swing(w, 1, 17)); }
  assert.deepEqual(ev.filter(e => e.type === 'hit').map(e => e.dmg), [34, 25, 34, 25], 'chop, sweep, chop, sweep');
  const kill = ev.find(e => e.type === 'kill');
  assert.ok(kill, 'b died');
  assert.equal(kill.killer, 1); assert.equal(kill.victim, 2);
  assert.ok(['chop', 'sweep'].includes(kill.move));
  assert.equal(typeof kill.seed, 'number');
  assert.equal(a.score, 1); assert.equal(b.deaths, 1); assert.equal(b.alive, false);
  assert.ok(Math.abs(kill.vx - DEFAULTS.knockX * DEFAULTS.killKnockMul) < 1e-9, 'killing blow knocks back x1.4');
  assert.ok(Math.abs(kill.vy - DEFAULTS.knockY * DEFAULTS.killKnockMul) < 1e-9);
  // respawn after 2 s
  const t0 = w.tick, before = b.respawn;
  const ev2 = run(w, before);
  const sp = ev2.find(e => e.type === 'spawn' && e.id === 2);
  assert.ok(sp, 'spawn event');
  assert.equal(sp.tick - (t0 - (DEFAULTS.respawnTicks - before)), DEFAULTS.respawnTicks);
  assert.ok(b.alive); assert.equal(b.hp, 100); assert.equal(b.iframes, DEFAULTS.spawnIframes);
  // invulnerable: a swing that overlaps does nothing
  place(w, 1, b.x - 12, b.y, 1); S.getPlayer(w, 1).iframes = 0;
  b.vx = 0; b.vy = 0;
  const ev3 = swing(w, 1);
  assert.equal(ev3.filter(e => e.type === 'hit').length, 0);
  assert.equal(b.hp, 100);
});

test('combat: attacking ends spawn invulnerability early', () => {
  const w = world(1);
  const p = S.getPlayer(w, 1);
  assert.ok(p.iframes > 0);
  S.step(w, { 1: KEY.SLASH });
  assert.equal(p.iframes, 0);
});

test('combat: simultaneous swings trade', () => {
  const w2 = world(2);
  place(w2, 1, 60, FLOOR_Y, 1); place(w2, 2, 72, FLOOR_Y, -1);
  const ev2 = run(w2, 4, i => (i === 0 ? { 1: KEY.SLASH, 2: KEY.SLASH } : {}));
  const hits = ev2.filter(e => e.type === 'hit');
  assert.deepEqual(hits.map(h => h.victim).sort(), [1, 2]);
});

test('spikes: instant kill, credited to the last hitter within 5 s', () => {
  // floor spikes are at columns 12-13, row 16
  const onSpikes = (w, id) => { const p = place(w, id, 12 * 16 + 3, FLOOR_Y - 4); p.onGround = false; p.vy = 2; };
  // no hitter: nobody scores, the death still counts
  let w = world(2);
  onSpikes(w, 2);
  let ev = run(w, 3);
  let k = ev.find(e => e.type === 'kill');
  assert.ok(k); assert.equal(k.move, 'spikes'); assert.equal(k.killer, null);
  assert.equal(S.getPlayer(w, 2).deaths, 1); assert.equal(S.getPlayer(w, 1).score, 0);
  // hit by 1, then onto spikes: 1 gets the point
  w = world(2);
  place(w, 1, 60, FLOOR_Y, 1); place(w, 2, 72, FLOOR_Y);
  swing(w, 1);
  assert.equal(S.getPlayer(w, 2).lastHitBy, 1);
  onSpikes(w, 2);
  ev = run(w, 3);
  k = ev.find(e => e.type === 'kill');
  assert.equal(k.killer, 1); assert.equal(k.move, 'spikes');
  assert.equal(S.getPlayer(w, 1).score, 1);
  // a hit more than 5 s ago earns nothing
  w = world(2);
  place(w, 1, 60, FLOOR_Y, 1); place(w, 2, 72, FLOOR_Y);
  swing(w, 1);
  run(w, DEFAULTS.creditTicks + 5);
  onSpikes(w, 2);
  ev = run(w, 3);
  assert.equal(ev.find(e => e.type === 'kill').killer, null);
  assert.equal(S.getPlayer(w, 1).score, 0);
});

test('lag compensation: slashHits tests a swing against supplied positions', () => {
  const w = world(3);
  const a = place(w, 1, 60, FLOOR_Y, 1);
  place(w, 2, 200 - 50, FLOOR_Y); place(w, 3, 300, FLOOR_Y);
  S.step(w, { 1: KEY.SLASH }); S.step(w, {});   // the swing is now live
  assert.ok(S.swordLive(a));
  // current positions: nobody in reach
  assert.deepEqual(S.slashHits(a, w.players), []);
  // rewound: 2 was in reach, 3 was not; the attacker itself is ignored
  const rewound = [{ id: 1, x: 60, y: FLOOR_Y }, { id: 2, x: 72, y: FLOOR_Y }, { id: 3, x: 120, y: FLOOR_Y }];
  assert.deepEqual(S.slashHits(a, rewound), [2]);
  // already hit by this swing: not again
  a.hitSet.push(2);
  assert.deepEqual(S.slashHits(a, rewound), []);
  a.hitSet = [];
  // no live swing: nothing
  assert.deepEqual(S.slashHits({ ...a, atk: 0 }, rewound), []);
});

test('lag compensation: step uses rewound positions and history interpolates', () => {
  const w = world(2);
  const hist = S.createHistory();
  place(w, 1, 60, FLOOR_Y, 1); const b = place(w, 2, 72, FLOOR_Y);
  for (let i = 0; i < 5; i++) { S.step(w, {}); S.recordHistory(hist, w); }
  const seenTick = w.tick;
  // b runs away; by the time the attacker's swing lands b is out of reach "now"
  for (let i = 0; i < 20; i++) { S.step(w, { 2: KEY.RIGHT | KEY.RUN }); S.recordHistory(hist, w); }
  assert.ok(b.x > 100);
  assert.equal(hist.frames.length, hist.maxTicks + 1, 'history keeps 200 ms');
  // without rewind: miss
  const w1 = S.cloneState(w);
  assert.equal(run(w1, 4, i => (i === 0 ? { 1: KEY.SLASH } : {})).filter(e => e.type === 'hit').length, 0);
  // with rewind to what the attacker saw (oldest kept frame, clamped): hit
  const rewind = () => S.positionsAt(hist, seenTick);
  const ev = run(w, 4, i => (i === 0 ? { 1: KEY.SLASH } : {}), { rewind });
  assert.equal(ev.filter(e => e.type === 'hit').length, 1);
  // interpolation between frames
  const h = S.createHistory(4);
  h.frames.push({ tick: 10, pos: [{ id: 1, x: 0, y: 0 }] }, { tick: 12, pos: [{ id: 1, x: 10, y: 20 }] });
  assert.deepEqual(S.positionsAt(h, 11), [{ id: 1, x: 5, y: 10 }]);
});

test('predictStep matches step for a lone player and treats others as fixed', () => {
  const w = world(1), r = lcg(3);
  const copy = S.cloneState(w);
  for (let i = 0; i < 400; i++) {
    const k = r() * 32 & ~KEY.SLASH;
    S.step(w, { 1: k }); S.predictStep(copy, 1, k);
  }
  const strip = s => { const p = s.players[0]; return [p.x, p.y, p.vx, p.vy, p.onGround]; };
  assert.deepEqual(strip(copy), strip(w));
  const w2 = world(2);
  place(w2, 1, 100, FLOOR_Y); const b = place(w2, 2, 104, FLOOR_Y);
  S.predictStep(w2, 1, 0);
  assert.equal(b.x, 104, 'the other player is not moved');
  assert.ok(!S.overlap(S.getPlayer(w2, 1), b));
});
