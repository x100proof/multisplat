// Unit tests for the long-sword pickups (SPEC §5.1) in shared/sim.js: spawning, pickup, reach,
// lag compensation, loss on death or leave, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../shared/sim.js';
import { KEY, DEFAULTS, LONG_REACH, ITEM_H } from '../shared/constants.js';
import { LEVEL } from '../shared/level.js';

const FLOOR_Y = 272 - 13;
const NO_SPAWN = 1e9;     // itemT far in the future: no pickup appears during a test

function world(n = 2, seed = 1) {
  const w = S.createWorld({ seed });
  for (let i = 1; i <= n; i++) S.addPlayer(w, i);
  w.itemT = NO_SPAWN;
  return w;
}
function place(w, id, x, y, face = 1) {
  const p = S.getPlayer(w, id);
  Object.assign(p, { x, y, px: x, py: y, vx: 0, vy: 0, face, iframes: 0, onGround: true });
  return p;
}
function run(w, ticks, inputs = () => ({}), opts) {
  const ev = [];
  for (let i = 0; i < ticks; i++) ev.push(...S.step(w, inputs(i), opts));
  return ev;
}
const swing = (w, id, ticks = 13, opts) => run(w, ticks, i => (i === 0 ? { [id]: KEY.SLASH } : {}), opts);
// a sweep: the combo window of a chop is open, then slash
const sweep = (w, id, opts) => { Object.assign(S.getPlayer(w, id), { atkType: 'chop', combo: 30 }); return swing(w, id, 13, opts); };
function lcg(seed) { return () => (seed = (seed * 48271) % 2147483647) / 2147483647; }

test('items: spawn timer is 20-40 s after the previous one appeared, at most 2 lie at once', () => {
  const gaps = [];
  for (let seed = 1; seed <= 40; seed++) {
    const w = S.createWorld({ seed }), ev = run(w, 6000).filter(e => e.type === 'item');
    assert.equal(ev.length, 2, 'two appear, then the arena is full');
    assert.equal(w.items.length, 2);
    gaps.push(ev[0].tick, ev[1].tick - ev[0].tick);
    assert.notDeepEqual([ev[0].x, ev[0].y], [ev[1].x, ev[1].y], 'not on the same point');
    for (const e of ev) assert.ok(LEVEL.items.some(p => p.x === e.x && p.y === e.y), 'at an item point');
  }
  for (const g of gaps) assert.ok(g >= DEFAULTS.itemMinTicks && g <= DEFAULTS.itemMaxTicks, 'gap ' + g);
  assert.ok(Math.min(...gaps) < 1500 && Math.max(...gaps) > 2100, 'gaps spread over the window');
});

test('items: the countdown runs only while there is room; a taken pickup frees a slot', () => {
  const cfg = { ...DEFAULTS, itemMinTicks: 100, itemMaxTicks: 100 };
  const w = S.createWorld({ seed: 7 });
  const ev = run(w, 500, () => ({}), { cfg }).filter(e => e.type === 'item');
  assert.deepEqual(ev.map(e => e.tick), [100, 200]);
  assert.equal(w.itemT, 100, 'drawn when the second appeared, held while full');
  w.items.shift();                                  // as if taken
  const more = run(w, 150, () => ({}), { cfg }).filter(e => e.type === 'item');
  assert.deepEqual(more.map(e => e.tick), [600], 'the held countdown resumes when there is room');
});

test('items: a pickup appears only at a free point, away from players and other pickups', () => {
  const [a, b] = LEVEL.items;
  const L2 = { ...LEVEL, items: [a, b] };
  for (let seed = 1; seed <= 20; seed++) {
    const w = S.createWorld({ seed });
    S.addPlayer(w, 1, { level: L2 });
    place(w, 1, a.x - 5 + 20, a.y - 13);          // 20 units from point a: too close
    w.itemT = 1;
    const ev = S.step(w, {}, { level: L2 }).filter(e => e.type === 'item');
    assert.deepEqual(ev.map(e => [e.x, e.y]), [[b.x, b.y]]);
  }
  const w = S.createWorld({ seed: 3 });
  S.addPlayer(w, 1, { level: L2 });
  place(w, 1, a.x - 5, a.y - 13);
  w.items.push({ id: 1, x: b.x, y: b.y }); w.itemSeq = 1;
  assert.deepEqual(S.freeItemPoints(w, DEFAULTS, L2), [], 'a has a player, b has a pickup');
  w.itemT = 1;
  const ev = run(w, 5, () => ({}), { level: L2 }).filter(e => e.type === 'item');
  assert.equal(ev.length, 0, 'no free point: none appears');
  assert.equal(w.itemT, 0, 'still due, retried every tick');
  place(w, 1, a.x - 5 + 40, a.y - 13);
  assert.deepEqual(S.freeItemPoints(w, DEFAULTS, L2), [a], '40 units away is clear');
});

test('items: determinism with pickups (same inputs -> identical serialized state)', () => {
  const cfg = { ...DEFAULTS, itemMinTicks: 60, itemMaxTicks: 180 };
  const play = seed => {
    const w = S.createWorld({ seed }), r = lcg(5), log = [];
    for (let i = 1; i <= 6; i++) S.addPlayer(w, i, { cfg });
    for (let t = 0; t < 6000; t++) {
      const inp = {};
      for (const p of w.players) inp[p.id] = Math.floor(r() * 32);
      log.push(...S.step(w, inp, { cfg }));
      if (t === 3000) { S.removePlayer(w, 2); S.addPlayer(w, 8, { cfg }); }
      if (t === 2000) { const copy = S.deserialize(S.serialize(w)); assert.deepEqual(copy, w); }
    }
    return { state: S.serialize(w), events: JSON.stringify(log), log };
  };
  const a = play(11), b = play(11);
  assert.equal(a.state, b.state);
  assert.equal(a.events, b.events);
  assert.ok(a.log.filter(e => e.type === 'pickup').length >= 3, 'pickups happened');
  assert.ok(a.log.filter(e => e.type === 'item').length >= 5, 'items appeared');
  assert.notEqual(play(12).state, a.state);
  // resuming from a deserialized mid-run state continues identically
  const w = S.createWorld({ seed: 4 });
  for (let i = 1; i <= 4; i++) S.addPlayer(w, i, { cfg });
  const r = lcg(9), inputs = Array.from({ length: 3000 }, () => [1, 2, 3, 4].map(() => Math.floor(r() * 32)));
  const feed = (st, from, to) => { for (let t = from; t < to; t++) S.step(st, { 1: inputs[t][0], 2: inputs[t][1], 3: inputs[t][2], 4: inputs[t][3] }, { cfg }); };
  feed(w, 0, 1500);
  const copy = S.deserialize(S.serialize(w));
  feed(w, 1500, 3000); feed(copy, 1500, 3000);
  assert.equal(S.serialize(copy), S.serialize(w));
});

test('items: taken on body contact; a tie goes to the lower id; a holder cannot take a second', () => {
  const w = world(3);
  place(w, 3, 40, FLOOR_Y); place(w, 1, 300, FLOOR_Y); place(w, 2, 300, FLOOR_Y);   // 1 and 2 overlap; pushed apart
  w.items.push({ id: 5, x: 305, y: 272 }, { id: 6, x: 72, y: 272 });
  let ev = S.step(w, {});
  assert.deepEqual(ev.filter(e => e.type === 'pickup'), [{ type: 'pickup', tick: 1, id: 1, item: 5, x: 305, y: 272 }]);
  assert.equal(S.getPlayer(w, 1).long, true);
  assert.equal(S.getPlayer(w, 2).long, false);
  assert.deepEqual(w.items.map(i => i.id), [6], 'an unclaimed pickup stays');
  // a holder leaves a second one where it is; a non-holder touching it with them takes it
  w.items.push({ id: 7, x: 305, y: 272 });
  place(w, 1, 300, FLOOR_Y); place(w, 2, 160, FLOOR_Y);
  ev = run(w, 30);
  assert.equal(ev.filter(e => e.type === 'pickup').length, 0);
  assert.deepEqual(w.items.map(i => i.id), [6, 7]);
  place(w, 2, 306, FLOOR_Y);
  ev = S.step(w, {});
  assert.deepEqual(ev.filter(e => e.type === 'pickup').map(e => [e.id, e.item]), [[2, 7]]);
  // a dead player takes nothing
  const p3 = S.getPlayer(w, 3); p3.alive = false; p3.respawn = 1e6;
  place(w, 3, 67, FLOOR_Y); p3.alive = false;
  assert.equal(run(w, 3).filter(e => e.type === 'pickup').length, 0);
  // the pickup box rests on the surface: a player standing on the point overlaps it
  assert.equal(S.itemBox({ x: 72, y: 272 }).y + ITEM_H, 272);
});

test('reach: a target just outside standard reach but inside x1.6 is hit only by a holder', () => {
  // [move, face, target x] with the attacker at x 100: just past the standard box's far end
  const cases = [['chop', 1, 130], ['chop', -1, 66], ['sweep', 1, 135], ['sweep', -1, 60]];
  for (const [move, face, tx] of cases) {
    for (const long of [false, true]) {
      const w = world(2);
      const a = place(w, 1, 100, FLOOR_Y, face); a.long = long;
      place(w, 2, tx, FLOOR_Y);
      const ev = (move === 'chop' ? swing(w, 1) : sweep(w, 1)).filter(e => e.type === 'hit');
      assert.deepEqual(ev.map(e => e.move), long ? [move] : [], `${move} face ${face} long ${long}`);
      if (long) assert.equal(ev[0].dmg, move === 'chop' ? DEFAULTS.chopDmg : DEFAULTS.sweepDmg, 'damage unchanged');
    }
  }
});

test('reach: the long box extends outward from the near edge, never backwards through the body', () => {
  for (const atkType of ['chop', 'sweep']) for (const face of [1, -1]) {
    const p = { x: 100, y: 200, w: 10, h: 13, face, atkType };
    const s = S.swordBoxOf(p), l = S.swordBoxOf({ ...p, long: true });
    assert.ok(Math.abs(l.w - s.w * LONG_REACH) < 1e-9, 'length x1.6');
    assert.equal(l.y, s.y); assert.equal(l.h, s.h);
    if (face > 0) assert.equal(l.x, s.x, 'near edge kept (right)');
    else assert.equal(l.x + l.w, s.x + s.w, 'near edge kept (left)');
    assert.ok(face > 0 ? l.x >= p.x + p.w - 2 : l.x + l.w <= p.x + 2);
  }
});

test('reach: knockback and timing are unchanged for a holder', () => {
  const res = long => {
    const w = world(2);
    const a = place(w, 1, 100, FLOOR_Y); a.long = long;
    place(w, 2, 112, FLOOR_Y);
    const ev = swing(w, 1, 4);
    return { hit: ev.find(e => e.type === 'hit')?.tick, v: S.getPlayer(w, 2).vy, atk: a.atk, cd: a.atkCd };
  };
  assert.deepEqual(res(true), res(false));
});

test('lag compensation: slashHits and a rewound step use the longer box', () => {
  const w = world(2);
  const a = place(w, 1, 100, FLOOR_Y); place(w, 2, 300, FLOOR_Y);
  Object.assign(a, { atk: 8, atkType: 'chop' });
  const seen = [{ id: 2, x: 130, y: FLOOR_Y }];
  assert.deepEqual(S.slashHits(a, seen), []);
  a.long = true;
  assert.deepEqual(S.slashHits(a, seen), [2]);
  for (const long of [false, true]) {
    const w2 = world(2);
    const b = place(w2, 1, 100, FLOOR_Y); b.long = long;
    place(w2, 2, 300, FLOOR_Y);                        // really far away; the attacker saw it at 130
    const ev = swing(w2, 1, 13, { rewind: () => [{ id: 2, x: 130, y: FLOOR_Y }] });
    assert.equal(ev.filter(e => e.type === 'hit').length, long ? 1 : 0);
  }
});

test('lost on death (sword, spikes, leave); standard reach after respawn; kill flags', () => {
  // sword kill by a holder: the victim (also a holder) loses it, the kill is marked long
  let w = world(2);
  const a = place(w, 1, 100, FLOOR_Y); a.long = true;
  const v = place(w, 2, 130, FLOOR_Y); v.long = true; v.hp = 10;
  let kill = swing(w, 1).find(e => e.type === 'kill');
  assert.equal(kill.long, true); assert.equal(kill.held, true);
  assert.equal(v.long, false); assert.equal(a.long, true, 'the killer keeps theirs');
  run(w, DEFAULTS.respawnTicks + 2);
  assert.equal(v.alive, true); assert.equal(v.long, false);
  assert.equal(S.swordBoxOf({ ...v, atkType: 'chop' }).w, 18, 'standard reach after respawn');
  // a standard kill of a non-holder carries neither flag
  w = world(2);
  place(w, 1, 100, FLOOR_Y); const v2 = place(w, 2, 112, FLOOR_Y); v2.hp = 10;
  kill = swing(w, 1).find(e => e.type === 'kill');
  assert.equal('long' in kill, false); assert.equal('held' in kill, false);
  // spikes
  w = world(1);
  const s = place(w, 1, 196, 272 - 13); s.long = true; s.onGround = false;
  kill = run(w, 2).find(e => e.type === 'kill');
  assert.equal(kill.move, 'spikes'); assert.equal(kill.held, true); assert.equal('long' in kill, false);
  assert.equal(s.long, false);
  // leave (killed for leaving, then removed): gone; the same id rejoining has the standard sword
  w = world(2);
  const l = place(w, 2, 300, FLOOR_Y); l.long = true;
  kill = S.killPlayer(w, 2, 'leave')[0];
  assert.equal(kill.held, true);
  S.removePlayer(w, 2);
  S.addPlayer(w, 2);
  assert.equal(S.getPlayer(w, 2).long, false);
  // removed while alive without a kill: also gone
  const p1 = S.getPlayer(w, 1); p1.long = true;
  S.removePlayer(w, 1); S.addPlayer(w, 1);
  assert.equal(S.getPlayer(w, 1).long, false);
});
