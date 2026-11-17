// AI players ("bots", SPEC §15). Once per tick the arena asks botKeys() for a bot's key mask and feeds
// it into the same input path as a human's (Arena.tick → Sim.step), so a bot obeys every rule a human
// does. A bot reads only what a player could see: its own state, the lying pickups and the other
// fighters' positions, and those `brain.delay` ticks late (its reaction time). Its few random choices
// come from its own seeded generator (`brain.rng`), never Math.random and never the sim's state.rng,
// so the sim stays deterministic and a bot run is repeatable for a given seed.
//
// Getting around: navOf(level) cuts the arena into surfaces (runs of standable tiles: ground, blocks,
// planks) and links them by simulating, with the real movePlayer, jumps and walk-offs from points
// along each surface. A bot on surface A heading for surface B walks to the takeoff point of the
// first hop on the shortest route and, each tick near it, simulates the jump from its own current
// state: when that lands on the next surface it jumps, holding the same keys until it lands.
import * as Sim from '../shared/sim.js';
import { KEY, T, PW, PH, LONG_REACH, DEFAULTS, STAR_BUNDLES } from '../shared/constants.js';
import { LEVEL, isSolid, isPlat } from '../shared/level.js';

const RNG_M = 2147483647;
const FLY_TICKS = 90;          // the longest jump or drop the planner simulates
const THINK = 20;              // ticks between target choices (a hysteresis keeps the current one)
const TRY_NEAR = 40;           // simulate takeoffs only this close (units) to the chosen takeoff point

// The bot's own Park-Miller generator (the sim's, but with its own state). Returns (0, 1).
function rand(b) { b.rng = (b.rng * 16807) % RNG_M; return b.rng / RNG_M; }

// A fresh brain. `seed` is any integer; reaction time and aggression vary per bot, so a room of bots
// does not move in lockstep: reaction 6-12 ticks (100-200 ms; the arena keeps 12 ticks of history), a 5-10 % chance per tick of
// swinging once in reach and a 20-40 tick pause after each swing; a 40-90 tick pause after landing
// before the next jump (tuned down at the user's request: the bots jumped and slashed too much).
export function newBrain(seed) {
  let s = Math.floor(Math.abs(seed)) % RNG_M; if (s === 0) s = 1;
  const b = { rng: s, delay: 0, aggr: 0, throwP: 0, slashWait: 0, jumpWait: 0, wasAir: false, target: null, thinkT: 0, prev: 0, air: 0, lastX: null, still: 0, unstick: 0, wander: 0, wanderT: 0 };
  b.delay = 6 + Math.floor(rand(b) * 7);
  b.aggr = .05 + rand(b) * .05;
  b.throwP = .075 + rand(b) * .075;                        // the throw rate the bots had before the tuning
  b.stillMax = 12 + Math.floor(rand(b) * 14);
  return b;
}

// ---------- navigation ----------
// The route table depends only on the level and the movement constants, so it is cached per level
// under a key made of those values (not per cfg object): a room whose admin changes damage or gore
// keeps its table, one whose movement changes (SPEC §17.1) gets a table built for the new values on
// the next bot tick (~30 ms), and switching back to earlier values is free. At most NAV_KEEP tables
// per level are kept (least recently used out).
const NAV_KEYS = ['gravity', 'jumpVel', 'jumpSpeedBonus', 'releaseGravity', 'maxFall', 'walkSpeed', 'runSpeed',
  'groundAccel', 'airAccel', 'groundFriction', 'airFriction', 'coyote', 'jumpBuffer', 'stunMoveMul'];
const NAV_KEEP = 12;
const navCache = new WeakMap();
export const navKey = cfg => NAV_KEYS.map(k => cfg[k]).join(',');
export function navOf(L = LEVEL, cfg = DEFAULTS) {
  let byKey = navCache.get(L);
  if (!byKey) navCache.set(L, byKey = new Map());
  const key = navKey(cfg);
  let nav = byKey.get(key);
  if (nav) { byKey.delete(key); byKey.set(key, nav); return nav; }   // most recently used last
  byKey.set(key, nav = buildNav(L, cfg));
  while (byKey.size > NAV_KEEP) byKey.delete(byKey.keys().next().value);
  return nav;
}

const standable = (L, c, r) => c >= 0 && c < L.w && (isSolid(L, c, r) || isPlat(L, c, r)) && !isSolid(L, c, r - 1);

// The surface a body (top-left x, feet y) stands on, or null. Feet are within 1 unit of a tile top.
export function surfaceAt(nav, x, feet) {
  const row = Math.round(feet / T);
  if (Math.abs(feet - row * T) > 1) return null;
  for (const s of nav.byRow[row] || []) if (x + PW > s.c0 * T && x < (s.c1 + 1) * T) return s.i;
  return null;
}
// The surface below a point (centre x, feet y): where a body there would come down.
export function surfaceBelow(nav, cx, feet) {
  for (let r = Math.max(1, Math.round(feet / T)); r < nav.L.h; r++) {
    const c = Math.floor(cx / T);
    for (const s of nav.byRow[r] || []) if (c >= s.c0 && c <= s.c1) return s.i;
    if (isSolid(nav.L, c, r)) return null;
  }
  return null;
}

// Simulate holding `keys` from body state `src` (with no keys held the tick before) until it has left
// the ground and come down again. Returns the surface landed on, or null (never left, or still flying).
function fly(nav, src, keys, cfg) {
  const p = { ...src, keys: 0, fx: 0 };
  let left = false;
  for (let t = 0; t < FLY_TICKS; t++) {
    Sim.movePlayer(p, keys, cfg, nav.L);
    if (!p.onGround) left = true;
    else if (left) return surfaceAt(nav, p.x, p.y + p.h);
    if (p.y > nav.L.h * T) return null;
  }
  return null;
}

function buildNav(L, cfg) {
  const nav = { L, surf: [], byRow: [], edges: [], next: [] };
  for (let r = 1; r < L.h; r++) {
    for (let c = 0; c < L.w; c++) {
      if (!standable(L, c, r)) continue;
      let c1 = c; while (c1 + 1 < L.w && standable(L, c1 + 1, r)) c1++;
      const s = { i: nav.surf.length, row: r, c0: c, c1, y: r * T };
      nav.surf.push(s); (nav.byRow[r] ||= []).push(s);
      c = c1;
    }
  }
  // takeoffs: from points 3 units apart along each surface, both ways, a jump from standing and one
  // at running speed with direction + run + jump held; and a run off each end
  const body = (x, y, vx) => ({ x, y, w: PW, h: PH, vx, vy: 0, face: vx < 0 ? -1 : 1,
    onGround: true, coyote: cfg.coyote, buf: 0, atk: 0, atkCd: 0, combo: 0, atkType: 'chop', swing: 0, hitSet: [], standOn: null, stun: 0, iframes: 0, walk: 0, keys: 0, fx: 0, px: x, py: y });
  const fits = (x, y) => { for (let c = Math.floor(x / T); c <= Math.floor((x + PW - .01) / T); c++) if (isSolid(L, c, Math.floor(y / T)) || isSolid(L, c, Math.floor((y + PH - .01) / T))) return false; return true; };
  for (const s of nav.surf) {
    const out = new Map();
    const add = (to, e) => { if (to == null || to === s.i) return; (out.get(to) || out.set(to, []).get(to)).push(e); };
    const y = s.y - PH;
    for (let x = s.c0 * T - PW + 2; x <= (s.c1 + 1) * T - 2; x += 3) {
      if (!fits(x, y)) continue;
      for (const dir of [-1, 1]) {
        const k = (dir < 0 ? KEY.LEFT : KEY.RIGHT) | KEY.RUN;
        add(fly(nav, body(x, y, 0), k | KEY.JUMP, cfg), { x, dir, jump: true, run: false });
        add(fly(nav, body(x, y, dir * cfg.runSpeed), k | KEY.JUMP, cfg), { x, dir, jump: true, run: true });
      }
    }
    for (const dir of [-1, 1]) {
      const x = dir < 0 ? s.c0 * T - PW + 3 : (s.c1 + 1) * T - 3;
      if (fits(x, y)) add(fly(nav, body(x, y, dir * cfg.runSpeed), (dir < 0 ? KEY.LEFT : KEY.RIGHT) | KEY.RUN, cfg), { x, dir, jump: false, run: true });
    }
    nav.edges.push(out);
  }
  // first hops of the fewest-hops route between every pair of surfaces (BFS from each start)
  const n = nav.surf.length;
  for (let a = 0; a < n; a++) {
    const first = new Array(n).fill(null), seen = new Array(n).fill(false);
    seen[a] = true;
    let frontier = [];
    for (const b of nav.edges[a].keys()) if (!seen[b]) { seen[b] = true; first[b] = b; frontier.push(b); }
    while (frontier.length) {
      const nx = [];
      for (const u of frontier) for (const v of nav.edges[u].keys()) if (!seen[v]) { seen[v] = true; first[v] = first[u]; nx.push(v); }
      frontier = nx;
    }
    nav.next.push(first);
  }
  return nav;
}

// ---------- the brain ----------
const dirKey = d => (d < 0 ? KEY.LEFT : KEY.RIGHT);
const cxOf = p => p.x + p.w / 2;

// Distance as a bot judges it: height costs more than width (it has to find a way up or down).
const far = (ax, ay, bx, by) => Math.abs(ax - bx) + 1.5 * Math.abs(ay - by);

// No solid tile on row `row` between x a and x b (planks don't stop a star).
function clearRow(L, row, a, b) {
  const lo = Math.floor(Math.min(a, b) / T), hi = Math.floor(Math.max(a, b) / T);
  for (let c = lo; c <= hi; c++) if (isSolid(L, c, row)) return false;
  return true;
}

// The key mask for bot `me` this tick. `seen` maps id -> {x, y} as the bot perceives the others
// (delayed by brain.delay ticks; anyone missing is read from the state).
export function botKeys(b, me, state, seen, { cfg = DEFAULTS, level: L = LEVEL } = {}) {
  const k = think(b, me, state, seen, cfg, L);
  b.prev = k;
  return k;
}

function think(b, me, state, seen, cfg, L) {
  if (!me || !me.alive) { b.target = null; b.air = 0; b.still = 0; b.lastX = null; return 0; }
  const nav = navOf(L, cfg), cx = cxOf(me), feet = me.y + me.h;
  const moved = b.lastX == null ? 1 : Math.abs(me.x - b.lastX);
  b.lastX = me.x;
  if (me.onGround) { if (b.wasAir) b.jumpWait = 40 + Math.floor(rand(b) * 51); b.air = 0; }   // just landed: no jump for a while
  b.wasAir = !me.onGround;
  if (b.slashWait > 0) b.slashWait--;
  if (me.onGround && b.jumpWait > 0) b.jumpWait--;

  // what the bot sees of the others
  const view = new Map();
  for (const p of state.players) {
    if (p.id === me.id || !p.alive) continue;
    const s = seen && seen.get(p.id);
    view.set(p.id, { id: p.id, x: s ? s.x : p.x, y: s ? s.y : p.y, w: p.w, h: p.h, iframes: p.iframes });
  }
  // target: the nearest opponent (one still spawn-protected counts as farther), kept unless a new one
  // is clearly nearer; re-judged every THINK ticks or when the current one is gone
  const cost = o => far(cx, feet, cxOf(o), o.y + o.h) + (o.iframes > 0 ? 160 : 0);
  let tgt = b.target != null ? view.get(b.target) : null;
  if (!tgt || --b.thinkT <= 0) {
    b.thinkT = THINK;
    let best = null;
    for (const o of view.values()) if (!best || cost(o) < cost(best)) best = o;
    if (best && (!tgt || cost(best) < cost(tgt) * .7)) tgt = best;
    b.target = tgt ? tgt.id : null;
  }

  let k = 0;
  const ready = bit => !(b.prev & bit) && (bit !== KEY.JUMP || b.jumpWait <= 0) && (bit !== KEY.SLASH || b.slashWait <= 0);   // key up the tick before, and no pause
  if (tgt) {
    const tcx = cxOf(tgt), dx = tcx - cx, dy = tgt.y - me.y, toward = Math.sign(dx) || me.face;
    // slash: the chop box reaches len + 8 units ahead (centre to centre) and 13-18 units up or down
    const reach = (18 * (me.long ? LONG_REACH : 1)) + 6;
    if (Math.abs(dx) < reach && Math.abs(dy) < 15) {
      if (me.face !== toward) return dirKey(toward);          // turn first
      if (me.atkCd <= 0 && me.atk === 0 && ready(KEY.SLASH) && tgt.iframes <= 20 && rand(b) < b.aggr) { b.slashWait = 20 + Math.floor(rand(b) * 21); return KEY.SLASH; }
      return me.onGround ? 0 : b.air;
    }
    // throw: stars in hand, the target on the same level, nothing solid in between, facing it
    if ((me.stars | 0) > 0 && Math.abs(dy) < 6 && Math.abs(dx) > reach + 6 && tgt.iframes <= 20 &&
        clearRow(L, Math.floor((me.y + 6) / T), cx, tcx)) {
      if (me.face !== toward) k = dirKey(toward);
      else if ((me.throwCd | 0) <= 0 && ready(KEY.THROW) && rand(b) < b.throwP) return KEY.THROW;
    }
  }
  if (!me.onGround) return b.air || k || (tgt ? dirKey(cxOf(tgt) - cx) : 0);
  if (k) return k;

  // goal: a pickup worth the detour, else the target
  let gx = null, gs = null, tol = 2;
  const tcost = tgt ? cost(tgt) : Infinity;
  let item = null, icost = Infinity;
  for (const it of state.items || []) {
    const kind = Sim.itemKind(it);
    // stars: worth it while there is room for the whole pickup or for at least a smallest bundle
    // (5 of the 30); a near-full bot leaves the bundles to others
    if (kind === 'long' ? me.long : cfg.starCarry - (me.stars | 0) < Math.min(Sim.starAmount(it), STAR_BUNDLES[0].n)) continue;
    const c = far(cx, feet, it.x, it.y);
    if (c < icost) { icost = c; item = it; }
  }
  if (item && (icost < 60 || icost < tcost * .7)) { gx = item.x; gs = surfaceBelow(nav, item.x, item.y - 1); tol = 2; }
  else if (tgt) { gx = cxOf(tgt); gs = surfaceBelow(nav, gx, tgt.y + tgt.h - 1); tol = 10; }
  else {                                                      // nobody to fight: wander
    if (--b.wanderT <= 0) { b.wanderT = 90 + Math.floor(rand(b) * 120); b.wander = 24 + rand(b) * (L.w * T - 48); }
    gx = b.wander; gs = null; tol = 6;
  }

  // stuck walking (another body in the way): hop over it, then for a while try the other way
  const unstick = keys => {
    if (!(keys & (KEY.LEFT | KEY.RIGHT))) { b.still = 0; return keys; }
    b.still = moved < .2 ? b.still + 1 : 0;
    if (b.still < b.stillMax || !ready(KEY.JUMP)) return keys;
    b.still = 0; b.air = keys | KEY.JUMP;
    return keys | KEY.JUMP;
  };

  const mine = surfaceAt(nav, me.x, feet);
  if (mine == null || gs == null || gs === mine || nav.next[mine][gs] == null) {
    const d = gx - cx;
    if (Math.abs(d) <= tol) { b.still = 0; return 0; }
    return unstick(dirKey(d) | (Math.abs(d) > 40 ? KEY.RUN : 0));
  }
  // another surface: head for the nearest takeoff of the first hop
  const s2 = nav.next[mine][gs], opts = nav.edges[mine].get(s2);
  let e = opts[0];
  for (const o of opts) if (Math.abs(o.x - me.x) + (o.run ? 24 : 0) < Math.abs(e.x - me.x) + (e.run ? 24 : 0)) e = o;
  const dx = e.x - me.x, ek = dirKey(e.dir) | KEY.RUN;
  if (e.jump) {
    if (Math.abs(dx) < TRY_NEAR && ready(KEY.JUMP)) {
      const land = fly(nav, me, ek | KEY.JUMP, cfg);
      if (land === s2 || land === gs) { b.air = ek | KEY.JUMP; return b.air; }
    }
    if (Math.abs(dx) <= 2) {
      if (!e.run && Math.abs(me.vx) > .3) return 0;           // settle, then the standing jump will test true
      if (ready(KEY.JUMP)) { b.air = ek | KEY.JUMP; return b.air; }   // the planner says it lands: go
      return 0;
    }
    return unstick(dirKey(dx) | (Math.abs(dx) > 24 || e.run ? KEY.RUN : 0));
  }
  // a walk-off: go to the edge and keep going
  if (Math.abs(dx) < 20 || Math.sign(dx) === e.dir) { b.air = ek; return unstick(ek); }
  return unstick(dirKey(dx) | KEY.RUN);
}

