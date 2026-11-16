// Gore (SPEC §7): NinjaRunner's blood system, grown for kills between players. This module is the
// simulation only: blood particles, gibs (the cut-up body, hood and sword), fountains, decals,
// pools and blood-stained spikes. It has no DOM access, so node can test it; public/game.js draws it.
//
// Every client must render the same spatter for a kill, so:
//  - all randomness comes from a Park-Miller generator seeded by the server's kill.seed (or, for a
//    hit spurt, by a hash of the hit event's fields). No Math.random anywhere in this file;
//  - no Math.sin/cos/atan (their last bit may differ between engines). Rotations are unit vectors
//    turned by a small-angle step and renormalised with sqrt, which IEEE makes exact everywhere;
//  - each kill's particles and gibs only touch the level, never each other or the players, so a
//    kill's outcome does not depend on what else is flying. The step rate is the game's fixed 60 Hz.
// The server never runs any of this.
import { T } from '../shared/constants.js';
import { tileAt } from '../shared/level.js';

export const GORE = {
  life: 4 * 60 * 60,      // decals, pools and stained spikes last about 4 minutes (ticks)...
  fade: 90 * 60,          // ...fading out over the last 90 s
  decalCap: 6000,         // oldest dropped first
  partCap: 4000,          // flying blood particles; new ones are skipped past this
  gibCap: 64,             // body pieces (5-6 per kill); the oldest is dropped past this
  gibLife: 12 * 60,       // body pieces lie around for 12 s, then fade over 1 s
  fountainT: 80,          // NinjaRunner's FOUNTAIN_T
  spatter: 240,           // radial spatter particles on a kill
  killRecs: 64,           // per-kill fingerprints kept
};
export const BLOOD_N = 6;   // blood colours are indices into the renderer's neon palette (NinjaRunner's BLOOD)

// ---------- deterministic helpers ----------
const M = 2147483647;
export function prng(seed) {
  let s = Math.floor(Math.abs(seed)) % M;
  if (s <= 0) s = 1;
  return () => (s = (s * 16807) % M) / M;
}
const mix = (h, v) => Math.imul(h ^ (v | 0), 16777619) >>> 0;
// A seed for a hit spurt from the event's own fields, identical on every client.
export function hitSeed(e) {
  let h = 2166136261;
  for (const v of [e.tick, e.attacker, e.victim, e.dmg, e.hp, Math.round((e.x || 0) * 100), Math.round((e.y || 0) * 100)]) h = mix(h, v);
  return (h % (M - 1)) + 1;
}
// Sine without Math.sin: Bhaskara's approximation after an exact range reduction (max error ~0.2 %).
const PI = 3.141592653589793;
export function sinp(x) {
  x -= 2 * PI * Math.floor((x + PI) / (2 * PI));   // -> [-PI, PI)
  const a = x < 0 ? -x : x, p = a * (PI - a), v = 16 * p / (5 * PI * PI - 4 * p);
  return x < 0 ? -v : v;
}
// Commutative per-landing hash, so the order in which a kill's blood lands does not matter.
function landHash(x, y, c) { return mix(mix(mix(2166136261, Math.round(x * 4)), Math.round(y * 4)), c); }

// ---------- the pieces a body is cut into ----------
// Coordinates are Kanbei's local space (game.js drawKanbei): x across (unmirrored), y up from the feet,
// so y < 0. The body ellipse spans x -5.4..5.4, y -13..-0.6. Each piece is a clip polygon,
// its centre of mass (cx, cy), the cut face (point fx, fy and outward normal nx, ny) that its
// fountain gushes from, and a collision radius. `sl` slants the cut line, picked from the seed.
const HOOD_Y = -9.9;
function pieces(kind, sl) {
  const X0 = -5.6, X1 = 5.6, Y0 = -13.4, Y1 = .6;
  const hood = { id: 'H', poly: [[X0, Y0], [X1, Y0], [X1, HOOD_Y], [X0, HOOD_Y]], r: 2.4, cut: [0, HOOD_Y, 0, 1] };
  if (kind === 'chop') {   // vertical split; the cut runs from (sl, top) to (-sl, bottom)
    const xa = sl, xb = -sl, xm = (xa + xb) / 2;
    return [hood,
      { id: 'L', poly: [[X0, HOOD_Y], [xa, HOOD_Y], [xb, Y1], [X0, Y1]], r: 3.2, cut: [xm, -5, 1, 0] },
      { id: 'R', poly: [[xa, HOOD_Y], [X1, HOOD_Y], [X1, Y1], [xb, Y1]], r: 3.2, cut: [xm, -5, -1, 0] }];
  }
  if (kind === 'quarter') {   // a body that bursts (leave): four chunks plus the hood
    const ym = -5.5;
    return [hood,
      { id: 'Q0', poly: [[X0, HOOD_Y], [0, HOOD_Y], [0, ym], [X0, ym]], r: 2.4, cut: [-1, ym, .7, .7] },
      { id: 'Q1', poly: [[0, HOOD_Y], [X1, HOOD_Y], [X1, ym], [0, ym]], r: 2.4, cut: [1, ym, -.7, .7] },
      { id: 'Q2', poly: [[X0, ym], [0, ym], [0, Y1], [X0, Y1]], r: 2.4, cut: [-1, ym, .7, -.7] },
      { id: 'Q3', poly: [[0, ym], [X1, ym], [X1, Y1], [0, Y1]], r: 2.4, cut: [1, ym, -.7, -.7] }];
  }
  // sweep and spikes: horizontal split at the waist, slanted by sl
  const ya = -6 - sl * .6, yb = -6 + sl * .6, ym = (ya + yb) / 2;
  return [hood,
    { id: 'T', poly: [[X0, HOOD_Y], [X1, HOOD_Y], [X1, yb], [X0, ya]], r: 2.8, cut: [0, ym, 0, 1] },
    { id: 'B', poly: [[X0, ya], [X1, yb], [X1, Y1], [X0, Y1]], r: 3.2, cut: [0, ym, 0, -1] }];
}
// centre of a polygon's area (shoelace), clipped to the body's bounding box by construction
function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], k = x0 * y1 - x1 * y0;
    a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------- world ----------
export function createGore(level, opts = {}) {
  return {
    L: level, cfg: { ...GORE, ...opts }, t: 0,
    parts: [], gibs: [], decals: [], pools: new Map(), bloody: new Map(),
    kills: new Map(),
    newDecals: [], newPools: new Set(), dirty: true,     // for the renderer's baked layer
    stats: { decalsEvicted: 0, partsSkipped: 0, gibsEvicted: 0, expired: 0, killsSeen: 0 },
    onCap: null,                                          // (what, count) when a cap bites
  };
}
export function clearGore(G) {
  G.parts = []; G.gibs = []; G.decals = []; G.pools.clear(); G.bloody.clear(); G.kills.clear();
  G.newDecals = []; G.newPools.clear(); G.dirty = true;
}
export const killKey = e => e.tick + ':' + e.victim;

function addPart(G, rec, x, y, vx, vy, c, s = 1) {
  if (G.parts.length >= G.cfg.partCap) { G.stats.partsSkipped++; if (G.onCap) G.onCap('particles', G.parts.length); return; }
  G.parts.push({ x, y, vx, vy, c, s, life: 240, rec });
}

// A short spurt from the impact point in the direction of the blow (dir = +1 or -1).
export function goreHit(G, e, dir) {
  const r = prng(hitSeed(e)), cx = e.x + 5, cy = e.y + 6, n = 16 + Math.floor(r() * 10);
  const d = dir || (r() < .5 ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const k = r();
    addPart(G, null, cx + d * 2 + (r() - .5) * 3, cy + (r() - .5) * 4,
      d * (.8 + k * 3.2) + (r() - .5) * .8, -(r() * 2.6) - .4, Math.floor(r() * BLOOD_N), .7 + r() * .5);
  }
}

// A kill: cut the body up, launch the pieces, spatter, start the fountains.
// e is the kill event; opts.meta is stored on every gib for the renderer (e.g. the player colour).
export function goreKill(G, e, opts = {}) {
  const r = prng(e.seed), key = killKey(e);
  const rec = { key, hash: 0, n: 0, t0: G.t };
  G.kills.set(key, rec); G.stats.killsSeen++;
  if (G.kills.size > G.cfg.killRecs) G.kills.delete(G.kills.keys().next().value);
  const move = e.move, face = e.face < 0 ? -1 : 1;
  const blow = e.vx > .01 ? 1 : e.vx < -.01 ? -1 : face;          // direction the killing blow pushed
  const feetX = e.x + 5, feetY = e.y + 13, kvx = e.vx || 0, kvy = e.vy || 0;
  // a ninja star (SPEC §5.2) cuts like a sweep: it flies flat at hand height
  const kind = move === 'chop' ? 'chop' : move === 'sweep' || move === 'star' ? 'sweep' : move === 'spikes' ? 'spikes' : 'quarter';
  const sl = (r() - .5) * 2.4;
  const ps = pieces(kind === 'spikes' ? 'sweep' : kind, sl);
  for (const p of ps) {
    const [cx, cy] = centroid(p.poly);
    const g = { rec, id: p.id, kind, poly: p.poly, x: feetX + cx, y: feetY + cy, ox: cx, oy: cy, vx: 0, vy: 0, c: 1, s: 0, w: 0,
      r: p.r, cut: [p.cut[0] - cx, p.cut[1] - cy, p.cut[2], p.cut[3]], fount: 0, fpow: 1, age: 0, rest: false, pinned: false,
      face, victim: e.victim, meta: opts.meta, fc: Math.floor(r() * 4) };
    const j = () => (r() - .5);
    if (p.id === 'H') {                       // the hood flies high, spinning fast
      g.vx = kvx * .2 + blow * (.3 + r() * .8) + j() * .6; g.vy = -3.2 - r() * 1.2; g.w = blow * (.25 + r() * .2); g.fount = 30; g.fpow = .55;
    } else if (kind === 'chop') {             // the halves fall apart sideways, the far one thrown with the blow
      const out = p.id === 'L' ? -1 : 1, withBlow = out === blow;
      g.vx = kvx * (withBlow ? .3 : .1) + out * (.4 + r() * .6); g.vy = -1.4 - r() * 1.2;
      g.w = out * (.08 + r() * .1); g.fount = GORE.fountainT; g.fpow = 1;
    } else if (kind === 'sweep' || kind === 'spikes') {
      if (p.id === 'T') { g.vx = kvx * .35 + blow * (.3 + r() * .6); g.vy = kind === 'spikes' ? -3.4 - r() * 1.2 : -2.2 - r(); g.w = blow * (.12 + r() * .12); }
      else { g.vx = kind === 'spikes' ? 0 : kvx * .2 + j() * .4; g.vy = kind === 'spikes' ? 0 : -.6; g.w = kind === 'spikes' ? 0 : blow * .03; g.pinned = kind === 'spikes'; }
      g.fount = GORE.fountainT; g.fpow = p.id === 'B' ? 1.15 : .9;
    } else {                                   // quarters burst out from the middle
      const dx = p.cut[2] < 0 ? 1 : -1, dy = p.cut[3] > 0 ? -1 : 1;
      g.vx = kvx * .15 + dx * (.6 + r()); g.vy = dy < 0 ? -2.6 - r() * 1.4 : -1.2 - r(); g.w = dx * (.1 + r() * .2);
      g.fount = p.id === 'Q0' || p.id === 'Q3' ? 60 : 0; g.fpow = .8;
    }
    addGib(G, g);
  }
  // the sword spins away on its own
  addGib(G, { rec, id: 'S', kind, poly: null, x: feetX - face * 3, y: feetY - 8, ox: 0, oy: 0, vx: kvx * .25 - blow * (.3 + r()),
    vy: -3 - r() * 1.5, c: 1, s: 0, w: (r() < .5 ? -1 : 1) * (.3 + r() * .2), r: 1.2, cut: [0, 0, 0, 0], fount: 0, fpow: 0,
    age: 0, rest: false, pinned: false, face, victim: e.victim, meta: opts.meta, fc: 0 });
  // heavy radial spatter, biased up and along the blow
  const cx = e.x + 5, cy = e.y + 7, n = G.cfg.spatter + (kind === 'spikes' ? 80 : 0);
  for (let i = 0; i < n; i++) {
    let dx, dy, d2;
    do { dx = r() * 2 - 1; dy = r() * 2 - 1; d2 = dx * dx + dy * dy; } while (d2 > 1 || d2 < .02);
    const d = Math.sqrt(d2), sp = 1 + r() * r() * 5.5;
    let vx = dx / d * sp + blow * (.6 + r() * 1.2), vy = dy / d * sp - 1.4;
    if (kind === 'spikes') vy -= 1.5;
    addPart(G, rec, cx + (r() - .5) * 6, cy + (r() - .5) * 8, vx, vy, i % BLOOD_N, .7 + r() * r() * 1.6);
  }
}

function addGib(G, g) {
  G.gibs.push(g);
  if (G.gibs.length > G.cfg.gibCap) {
    G.gibs.shift(); G.stats.gibsEvicted++;
    if (G.onCap) G.onCap('gibs', G.gibs.length);
  }
}

const blocks = c => c === '#' || c === 'B';
function gibStep(G, g, r) {
  const L = G.L;
  g.age++;
  // where each piece is 3 s after the kill goes into the kill's fingerprint
  if (g.age === 180 && g.rec) { g.rec.hash = (g.rec.hash + landHash(g.x, g.y, 7 + g.id.length)) >>> 0; g.rec.n++; }
  if (!g.pinned && !g.rest) {
    g.vy = Math.min(g.vy + .3, 7);
    // horizontal
    let nx = g.x + g.vx;
    const ty = Math.floor(g.y / T);
    if (blocks(tileAt(L, Math.floor((nx + (g.vx > 0 ? g.r : -g.r)) / T), ty))) {
      nx = g.vx > 0 ? Math.floor((nx + g.r) / T) * T - g.r - .01 : (Math.floor((nx - g.r) / T) + 1) * T + g.r + .01;
      g.vx = -g.vx * .45; g.w = -g.w * .6;
    }
    g.x = nx;
    // vertical
    const prevBot = g.y + g.r;
    let ny = g.y + g.vy;
    const tx = Math.floor(g.x / T);
    if (g.vy > 0) {
      const by = Math.floor((ny + g.r) / T), top = by * T, c = tileAt(L, tx, by);
      if (c === '^' && ny + g.r >= top + 9 && g.id !== 'S') {          // impaled on the spikes
        ny = top + 9 - g.r * .3; g.pinned = true; g.vx = g.vy = g.w = 0; stain(G, tx, by);
      } else if (blocks(c) || ((c === '=' || c === '^') && prevBot <= top + .01)) {
        ny = top - g.r;
        if (c === '^') stain(G, tx, by);
        if (g.vy > 1.2) { g.vy = -g.vy * .32; g.vx *= .7; g.w *= .6; }
        else { g.vy = 0; g.vx *= .8; g.w *= .7; if (Math.abs(g.vx) < .05 && Math.abs(g.w) < .01) { g.rest = true; g.vx = g.w = 0; } }
      }
    } else if (g.vy < 0 && blocks(tileAt(L, tx, Math.floor((ny - g.r) / T)))) {
      ny = (Math.floor((ny - g.r) / T) + 1) * T + g.r + .01; g.vy = -g.vy * .3;
    }
    g.y = ny;
    // turn by w: small-angle step on the unit vector, renormalised (deterministic, no trig)
    if (g.w) {
      const c2 = g.c - g.s * g.w, s2 = g.s + g.c * g.w, n = Math.sqrt(c2 * c2 + s2 * s2);
      g.c = c2 / n; g.s = s2 / n;
    }
    // a blood trail while it flies
    if (g.id !== 'S' && g.age < 70 && (g.age & 1) === 0 && Math.abs(g.vx) + Math.abs(g.vy) > 1.2)
      addPart(G, g.rec, g.x + (r() - .5) * 2, g.y + (r() - .5) * 2, g.vx * .3 + (r() - .5) * .6, g.vy * .3 - r() * .5, g.fc, .8);
  }
  // the pulsing fountain from the cut face (NinjaRunner's bleedEnemy), turned with the piece
  if (g.fount > 0) {
    g.fount--;
    const p = g.fount / G.cfg.fountainT, pulse = 1 + .35 * sinp(g.fount * .5);
    const n = 2 + Math.round(p * 6 * g.fpow);
    const [fx, fy, nx, ny] = g.cut;
    const ox = g.x + fx * g.c - fy * g.s, oy = g.y + fx * g.s + fy * g.c;
    const dx = nx * g.c - ny * g.s, dy = nx * g.s + ny * g.c;
    for (let i = 0; i < n; i++) {
      const sp = (2 + r() * 3) * (.45 + p * .8) * pulse * g.fpow, side = (r() - .5) * 1.6;
      addPart(G, g.rec, ox + (r() - .5) * 1.5, oy + (r() - .5) * 1.5,
        dx * sp - dy * side + g.vx * .5, dy * sp + dx * side - .8 * pulse + g.vy * .5, (g.fc + Math.floor(r() * 3)) % BLOOD_N, .8 + r() * .5);
    }
  }
}

function stain(G, tx, ty) {
  const k = tx + ',' + ty;
  if (!G.bloody.has(k)) G.dirty = true;
  G.bloody.set(k, G.t);
}

function addDecal(G, rec, x, y, c, s, drip) {
  const d = { x, y, c, s, d: drip, t: G.t };
  G.decals.push(d); G.newDecals.push(d);
  if (rec) { rec.hash = (rec.hash + landHash(x, y, c)) >>> 0; rec.n++; }
}
function addPool(G, rec, b, px, sy) {
  for (const [dx, amt] of [[0, .45], [-1, .25], [1, .25], [-2, .1], [2, .1], [-3, .04], [3, .04]]) {
    const key = (px + dx) + ',' + sy, pl = G.pools.get(key);
    if (pl) { pl.h = Math.min(4, pl.h + amt); if (dx === 0) pl.c = b.c; pl.t = G.t; G.newPools.add(pl); }
    else { const n = { x: px + dx, y: sy, h: amt, c: b.c, t: G.t }; G.pools.set(key, n); G.newPools.add(n); }
  }
  if (rec) { rec.hash = (rec.hash + landHash(px, sy, b.c + 8)) >>> 0; rec.n++; }
}

// Blood particles: NinjaRunner's updateBlood, with separate wall, floor and ceiling hits.
function partStep(G, b, r) {
  const L = G.L;
  b.vy = Math.min(b.vy + .2, 5); b.life--;
  const nx = b.x + b.vx, ny = b.y + b.vy, tx = Math.floor(nx / T), ty = Math.floor(ny / T);
  const tile = tileAt(L, tx, ty);
  const hit = blocks(tile) || (tile === '=' && b.vy > 0 && ny - ty * T < 5) || (tile === '^' && ny - ty * T >= 9);
  if (!hit) { b.x = nx; b.y = ny; return; }
  b.life = 0;
  const ox = Math.floor(b.x / T), oy = Math.floor(b.y / T);
  if (tile === '^') {                                                  // splats on spikes soak the spike
    addDecal(G, b.rec, Math.round(nx * 2) / 2, Math.round(ny * 2) / 2, b.c, b.s, 0); stain(G, tx, ty); return;
  }
  if (blocks(tile) && tx !== ox && !blocks(tileAt(L, ox, ty))) {       // side of a wall or block
    const ex = b.vx > 0 ? tx * T + .2 + r() * .6 : (tx + 1) * T - .2 - r() * .6;
    addDecal(G, b.rec, Math.round(ex * 2) / 2, Math.round(ny * 2) / 2, b.c, b.s, r() < .3 ? 1.5 + r() * 4 : 0);
    return;
  }
  if (b.vy > 0 && ty !== oy) {                                         // landed on top of a surface
    if (!blocks(tileAt(L, tx, ty - 1))) { addPool(G, b.rec, b, Math.round(b.x), ty * T); return; }
    addDecal(G, b.rec, Math.round(nx * 2) / 2, ty * T, b.c, b.s, 0); return;
  }
  if (b.vy < 0 && blocks(tile)) {                                      // ceiling or underside: drips hang down
    addDecal(G, b.rec, Math.round(nx * 2) / 2, (ty + 1) * T - .3, b.c, b.s, r() < .45 ? 1 + r() * 3.5 : 0);
    return;
  }
  addDecal(G, b.rec, Math.round(b.x * 2) / 2, Math.round(Math.min(ny, ty * T + (b.vy > 0 ? 0 : T)) * 2) / 2, b.c, b.s, 0);
}

// One 60 Hz tick. Randomness inside the step (fountain jitter, drip lengths) comes from a generator
// seeded per kill and tick, so it too is identical everywhere.
export function stepGore(G) {
  G.t++;
  const L = G.L;
  if (G.gibs.length) {
    const keep = [];
    for (const g of G.gibs) {
      gibStep(G, g, prng(mix(mix(hashKey(g), g.age), 77)));
      if (g.age < G.cfg.gibLife + 60 && g.y < L.h * T + 32) keep.push(g);
    }
    G.gibs = keep;
  }
  if (G.parts.length) {
    const tr = new Map();   // per-kill generator for this tick
    for (const b of G.parts) {
      const k = b.rec ? b.rec.key : '';
      let r = tr.get(k);
      if (!r) { r = prng(mix(mix(strHash(k), b.rec ? G.t - b.rec.t0 : G.t), 13)); tr.set(k, r); }
      partStep(G, b, r);
    }
    G.parts = G.parts.filter(b => b.life > 0 && b.y < L.h * T + 16);
  }
  if (G.decals.length > G.cfg.decalCap) {
    const n = G.decals.length - G.cfg.decalCap;
    G.decals.splice(0, n); G.stats.decalsEvicted += n; G.dirty = true;
    if (G.onCap) G.onCap('decals', G.decals.length);
  }
  if ((G.t & 63) === 0) expire(G);
}
const strHash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i)); return h; };
const hashKey = g => mix(strHash(g.rec ? g.rec.key : ''), g.id.charCodeAt(0) * 31 + (g.id.charCodeAt(1) || 0));

// Drop decals, pools and stains past their life (every 64 ticks).
function expire(G) {
  const old = G.t - G.cfg.life;
  let i = 0;
  while (i < G.decals.length && G.decals[i].t <= old) i++;
  if (i) { G.decals.splice(0, i); G.stats.expired += i; G.dirty = true; }
  for (const [k, p] of G.pools) if (p.t <= old) { G.pools.delete(k); G.dirty = true; }
  for (const [k, t] of G.bloody) if (t <= old) { G.bloody.delete(k); G.dirty = true; }
}

// 0..1: how visible something born at tick t is now.
export function fadeOf(G, t) {
  const age = G.t - t, left = G.cfg.life - age;
  return left >= G.cfg.fade ? 1 : left <= 0 ? 0 : left / G.cfg.fade;
}

// The fingerprint of one kill's gore: count and hash of everywhere its blood landed, plus where each
// piece was 3 s after the kill. Equal on every client once the kill has played out (a few seconds).
export function fingerprint(G, key) {
  const rec = G.kills.get(key);
  return rec ? `${rec.n}:${rec.hash.toString(16)}` : null;
}
export const settled = (G, key) => !G.parts.some(b => b.rec && b.rec.key === key) && !G.gibs.some(g => g.rec && g.rec.key === key && (g.fount > 0 || g.age < 180));
