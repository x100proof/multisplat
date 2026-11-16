// The arena: 26 x 18 tiles (416 x 288 units), closed on every side.
// Tile codes are NinjaRunner's: '#' ground, 'B' block, '=' one-way plank, '^' spikes, '.' air.
// The shipped arena has no spikes (SPEC §3): the only way to die is another player. The sim still
// supports '^' (tests use a level of their own).
import { T, PW, PH } from './constants.js';

const MAP = [
  '##########################', //  0 ceiling
  '#........................#', //  1
  '#........................#', //  2
  '#...=====........=====...#', //  3 tier 4: high planks
  '#........................#', //  4
  '#........................#', //  5
  '#BBB.......BBBB.......BBB#', //  6 tier 3: wall ledges + centre block
  '#........................#', //  7
  '#........................#', //  8
  '#.....======..======.....#', //  9 tier 2: planks
  '#........................#', // 10
  '#........................#', // 11
  '#........................#', // 12
  '#BBBB....==....==....BBBB#', // 13 tier 1: wall ledges + small planks
  '#........................#', // 14
  '#........................#', // 15
  '#...........BB...........#', // 16 a low block in the middle of the floor
  '##########################', // 17 floor
];

// Spawn points: feet position (x = centre, y = top of the tile stood on).
const SPAWNS = [
  [40, 272], [104, 272], [312, 272], [376, 272],   // floor
  [40, 208], [376, 208], [160, 208], [256, 208],   // tier 1
  [120, 144], [296, 144],                          // tier 2
  [40, 96], [376, 96],                             // tier 3
  [104, 48], [312, 48],                            // tier 4
  [192, 96],                                       // tier 3: the centre block
].map(([x, y]) => ({ x, y }));

// Long-sword item points (SPEC §5.1), given like spawns: x = centre, y = top of the surface the
// pickup lies on. Two per surface level, plus one on the centre block. Indexes are stable (tests pin
// pickups to points by index).
const ITEMS = [
  [72, 272], [344, 272],     // floor, either side of the low centre block
  [152, 208], [264, 208],    // tier 1: the small planks
  [168, 144], [248, 144],    // tier 2: inner ends of the long planks
  [56, 96], [360, 96],       // tier 3: wall ledges
  [136, 48], [280, 48],      // tier 4: high planks
  [208, 96],                 // tier 3: the centre block
].map(([x, y]) => Object.freeze({ x, y }));

export const LEVEL = Object.freeze({
  w: MAP[0].length, h: MAP.length, grid: Object.freeze(MAP.slice()), spawns: Object.freeze(SPAWNS),
  items: Object.freeze(ITEMS),
});

export const tileAt = (L, tx, ty) => (ty >= 0 && ty < L.h && tx >= 0 && tx < L.w ? L.grid[ty][tx] : '.');
// NinjaRunner isSolid: outside the side edges is solid; above and below are open (this arena
// is closed by its own border tiles anyway).
export function isSolid(L, tx, ty) {
  if (tx < 0 || tx >= L.w) return true;
  if (ty < 0 || ty >= L.h) return false;
  const c = L.grid[ty][tx]; return c === '#' || c === 'B';
}
export const isPlat = (L, tx, ty) => ty >= 0 && ty < L.h && tx >= 0 && tx < L.w && L.grid[ty][tx] === '=';

// Top-left of a player body standing on spawn point s.
export const spawnPos = s => ({ x: s.x - PW / 2, y: s.y - PH });

// Pick a spawn point (SPEC §3): never within minDist of a living player, weighted toward points
// farthest from them (weight = squared distance to the nearest living player). If every point is
// too close, take the farthest one. rand() returns a float in [0, 1) and is the sim's seeded RNG.
export function pickSpawn(L, living, rand, minDist = 64) {
  const pts = L.spawns;
  if (!living.length) return pts[Math.floor(rand() * pts.length) % pts.length];
  const near = s => {
    let best = Infinity;
    for (const p of living) {
      const dx = p.x + p.w / 2 - s.x, dy = p.y + p.h - s.y, d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return best;
  };
  const d2 = pts.map(near), min2 = minDist * minDist;
  let total = 0;
  for (const d of d2) if (d >= min2) total += d;
  if (total === 0) {
    let bi = 0;
    for (let i = 1; i < pts.length; i++) if (d2[i] > d2[bi]) bi = i;
    return pts[bi];
  }
  let r = rand() * total;
  for (let i = 0; i < pts.length; i++) {
    if (d2[i] < min2) continue;
    r -= d2[i];
    if (r < 0) return pts[i];
  }
  for (let i = pts.length - 1; i >= 0; i--) if (d2[i] >= min2) return pts[i];
  return pts[0];
}

export { T };
