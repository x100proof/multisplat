// Arena invariants (SPEC §3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL, isSolid, isPlat, tileAt, pickSpawn, spawnPos } from '../shared/level.js';
import { T, PW, PH, ITEM_W, ITEM_H } from '../shared/constants.js';

const L = LEVEL;

test('arena is 26 x 18 and uses only NinjaRunner tile codes', () => {
  assert.equal(L.w, 26); assert.equal(L.h, 18);
  for (const row of L.grid) { assert.equal(row.length, 26); assert.match(row, /^[#B=^.]+$/); }
});

test('arena is closed: walls left and right, floor and ceiling', () => {
  for (let y = 0; y < L.h; y++) { assert.ok(isSolid(L, 0, y), `left wall row ${y}`); assert.ok(isSolid(L, L.w - 1, y), `right wall row ${y}`); }
  for (let x = 0; x < L.w; x++) { assert.ok(isSolid(L, x, L.h - 1), `floor col ${x}`); assert.ok(isSolid(L, x, 0), `ceiling col ${x}`); }
});

test('3-4 tiers of platforms above the floor, and a low block on the floor', () => {
  // a tier is a row of platforms with room to stand under it; the rows just above the floor only
  // hold the low centre block, which is a step, not a tier
  const rows = new Set(), low = [];
  for (let y = 1; y < L.h - 1; y++) for (let x = 1; x < L.w - 1; x++) if (isSolid(L, x, y) || isPlat(L, x, y)) {
    if (y < L.h - 2) rows.add(y); else low.push([x, y]);
  }
  assert.ok(rows.size >= 3 && rows.size <= 4, `platform rows: ${[...rows]}`);
  assert.ok(low.length >= 1 && low.length <= 3, 'a short, one-tile block on the floor');
  for (const [x] of low) assert.ok(x > 3 && x < L.w - 4, 'away from the walls');
});

test('no spike traps in the shipped arena (SPEC §3)', () => {
  for (const row of L.grid) assert.ok(!row.includes('^'), 'spikes in ' + row);
});

test('at least 10 spawn points, each on solid footing, clear of walls', () => {
  assert.ok(L.spawns.length >= 10);
  for (const s of L.spawns) {
    const p = spawnPos(s), l = Math.floor(p.x / T), r = Math.floor((p.x + PW - .01) / T);
    const fy = s.y / T;
    assert.ok(Number.isInteger(fy), 'spawn stands on a tile top');
    for (let tx = l; tx <= r; tx++) {
      assert.ok(isSolid(L, tx, fy) || isPlat(L, tx, fy), `footing under ${s.x},${s.y}`);
      for (let ty = Math.floor(p.y / T); ty < fy; ty++) assert.ok(!isSolid(L, tx, ty), `body clear at ${s.x},${s.y}`);
    }
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

test('long-sword item points: >= 6, on every tier, on footing, distinct, reachable', () => {
  const pts = L.items;
  assert.ok(pts.length >= 6);
  const standable = (tx, ty) => isSolid(L, tx, ty) || isPlat(L, tx, ty);
  const surfaces = new Set(L.spawns.map(s => s.y));
  assert.deepEqual(new Set(pts.map(p => p.y)), surfaces, 'one or more on every surface level spawns use (floor and 4 tiers)');
  const seen = new Set();
  for (const p of pts) {
    const key = p.x + ',' + p.y;
    assert.ok(!seen.has(key), 'distinct ' + key); seen.add(key);
    assert.equal(p.y % T, 0, 'y is a tile top');
    const ty = p.y / T, l = Math.floor((p.x - ITEM_W / 2) / T), r = Math.floor((p.x + ITEM_W / 2 - .01) / T);
    for (let tx = l; tx <= r; tx++) {
      assert.ok(standable(tx, ty), `footing under ${key}`);
      for (let y = Math.floor((p.y - Math.max(ITEM_H, PH)) / T); y < ty; y++) assert.equal(tileAt(L, tx, y), '.', `air at ${key}`);
    }
    // reachable: a spawn on the same surface, connected by walkable tiles with headroom
    const s = L.spawns.find(sp => sp.y === p.y && (() => {
      const a = Math.floor(Math.min(sp.x, p.x) / T), b = Math.floor(Math.max(sp.x, p.x) / T);
      for (let tx = a; tx <= b; tx++) if (!standable(tx, ty) || tileAt(L, tx, ty - 1) !== '.') return false;
      return true;
    })());
    assert.ok(s, 'walkable from a spawn: ' + key);
  }
});
