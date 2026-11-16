// Arena invariants (SPEC §3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, isSolid, isPlat, tileAt, pickSpawn, spawnPos } from '../shared/level.js';
import { T, PW, PH } from '../shared/constants.js';

const L = LEVEL;

test('arena is 26 x 18 and uses only NinjaRunner tile codes', () => {
  assert.equal(L.w, 26); assert.equal(L.h, 18);
  for (const row of L.grid) { assert.equal(row.length, 26); assert.match(row, /^[#B=^.]+$/); }
});

test('arena is closed: walls left and right, floor and ceiling', () => {
  for (let y = 0; y < L.h; y++) { assert.ok(isSolid(L, 0, y), `left wall row ${y}`); assert.ok(isSolid(L, L.w - 1, y), `right wall row ${y}`); }
  for (let x = 0; x < L.w; x++) { assert.ok(isSolid(L, x, L.h - 1), `floor col ${x}`); assert.ok(isSolid(L, x, 0), `ceiling col ${x}`); }
});

test('3-4 tiers of platforms above the floor', () => {
  const rows = new Set();
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) if (isSolid(L, x, y) || isPlat(L, x, y)) rows.add(y);
  assert.ok(rows.size >= 3 && rows.size <= 4, `platform rows: ${[...rows]}`);
});

test('two short spike strips', () => {
  const strips = [];
  L.grid.forEach((row, y) => { for (const m of row.matchAll(/\^+/g)) strips.push({ y, x: m.index, n: m[0].length }); });
  assert.equal(strips.length, 2);
  for (const s of strips) {
    assert.ok(s.n <= 3, 'short');
    for (let x = s.x; x < s.x + s.n; x++) assert.ok(isSolid(L, x, s.y + 1), 'spikes sit on something solid');
  }
});

test('at least 10 spawn points, each on solid footing, clear of walls and spikes', () => {
  assert.ok(L.spawns.length >= 10);
  for (const s of L.spawns) {
    const p = spawnPos(s), l = Math.floor(p.x / T), r = Math.floor((p.x + PW - .01) / T);
    const fy = s.y / T;
    assert.ok(Number.isInteger(fy), 'spawn stands on a tile top');
    for (let tx = l; tx <= r; tx++) {
      assert.ok(isSolid(L, tx, fy) || isPlat(L, tx, fy), `footing under ${s.x},${s.y}`);
      for (let ty = Math.floor(p.y / T); ty < fy; ty++) assert.ok(!isSolid(L, tx, ty), `body clear at ${s.x},${s.y}`);
    }
    // no spike anywhere below the spawn (columns it spans, plus one either side), nor beside it
    for (let tx = l - 1; tx <= r + 1; tx++) for (let ty = Math.floor(p.y / T); ty < L.h; ty++)
      assert.notEqual(tileAt(L, tx, ty), '^', `spike under/beside spawn ${s.x},${s.y}`);
  }
});

test('pickSpawn never picks a point within 64 units of a living player', () => {
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let trial = 0; trial < 300; trial++) {
    const living = Array.from({ length: 1 + (trial % 4) }, () => {
      const s = L.spawns[Math.floor(rand() * L.spawns.length)];
      return { x: s.x - PW / 2 + (rand() - .5) * 20, y: s.y - PH, w: PW, h: PH };
    });
    const s = pickSpawn(L, living, rand, 64);
    const near = Math.min(...living.map(p => Math.hypot(p.x + PW / 2 - s.x, p.y + PH - s.y)));
    const anyFar = L.spawns.some(q => Math.min(...living.map(p => Math.hypot(p.x + PW / 2 - q.x, p.y + PH - q.y))) >= 64);
    if (anyFar) assert.ok(near >= 64, `picked a spawn ${near} from a player`);
  }
});

test('pickSpawn favours far points', () => {
  let seed = 3;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const p = { x: 35, y: 259, w: PW, h: PH };   // bottom-left corner
  let far = 0;
  for (let i = 0; i < 500; i++) { const s = pickSpawn(L, [p], rand); if (s.x > L.w * T / 2) far++; }
  assert.ok(far > 300, `right half chosen ${far}/500`);
});
