// Deterministic 60 Hz simulation of the arena, shared by the server (authoritative) and the
// client (offline play now, prediction later). Pure: no DOM, no clocks, no Math.random. All
// randomness comes from a Park-Miller generator whose seed lives in the state, so the same
// starting state plus the same per-tick input bitmasks always gives the same result.
//
// Movement and the sword are ported from NinjaRunner (updatePlay, moveBody, swordBoxOf).
import { T, KEY, KEY_MASK, FX, PW, PH, ATK_LEN, ATK_CD, COMBO_T, DEFAULTS, HISTORY_TICKS, LONG_REACH, ITEM_W, ITEM_H,
  STAR_W, STAR_H, STAR_HAND } from './constants.js';
import { LEVEL, isSolid, isPlat, tileAt, pickSpawn, spawnPos } from './level.js';

export { KEY, FX, DEFAULTS, LEVEL };

// ---------- RNG (NinjaRunner's rng(), but the seed is kept in the state) ----------
const RNG_M = 2147483647;
export function nextRand(state) {
  state.rng = (state.rng * 16807) % RNG_M;   // exact: the product stays below 2^53
  return state.rng / RNG_M;                  // (0, 1)
}

// ---------- world ----------
export function createWorld({ seed = 1 } = {}) {
  let s = Math.floor(Math.abs(seed)) % RNG_M;
  if (s === 0) s = 1;
  // items: pickups lying in the arena [{id, x, y, kind: 'long'|'star'}] (a long sword or ninja
  // stars; one per item point); itemT / starT: ticks until the next long sword / star pickup may
  // appear (-1 = not drawn yet; drawn on the first step); itemSeq: the last pickup id used.
  // stars: ninja stars in flight [{id, owner, x, y, vx, dist}] (x, y = centre); starSeq: last id.
  return { tick: 0, rng: s, players: [], items: [], itemT: -1, itemSeq: 0, starT: -1, stars: [], starSeq: 0 };
}

function newPlayer(id) {
  return {
    id, x: 0, y: 0, w: PW, h: PH, vx: 0, vy: 0, px: 0, py: 0, face: 1,
    onGround: false, coyote: 0, buf: 0, walk: 0,
    atk: 0, atkCd: 0, atkType: 'chop', combo: 0, swing: 0, hitSet: [],
    hp: 0, alive: false, iframes: 0, stun: 0, respawn: 0,
    lastHitBy: null, lastHitTick: -1, score: 0, deaths: 0,
    keys: 0, fx: 0, standOn: null, long: false, stars: 0, throwCd: 0,
  };
}

export const getPlayer = (state, id) => state.players.find(p => p.id === id) || null;

// Add a player (ids are numbers; players are kept sorted by id so every loop runs in a fixed
// order). The player spawns at once. Returns the events produced (one 'spawn').
export function addPlayer(state, id, { cfg = DEFAULTS, level = LEVEL } = {}) {
  if (getPlayer(state, id)) throw new Error('duplicate player id ' + id);
  const p = newPlayer(id);
  state.players.push(p);
  state.players.sort((a, b) => a.id - b.id);
  const events = [];
  spawnPlayer(state, p, cfg, level, events);
  return events;
}

export function removePlayer(state, id) {
  state.players = state.players.filter(p => p.id !== id);
}

function spawnPlayer(state, p, cfg, L, events) {
  const living = state.players.filter(o => o.alive && o !== p);
  const s = pickSpawn(L, living, () => nextRand(state), cfg.spawnMinDist);
  const pos = spawnPos(s);
  Object.assign(p, {
    x: pos.x, y: pos.y, px: pos.x, py: pos.y, vx: 0, vy: 0, face: s.x < L.w * T / 2 ? 1 : -1,
    onGround: false, coyote: 0, buf: 0, atk: 0, atkCd: 0, atkType: 'chop', combo: 0, hitSet: [],
    hp: cfg.maxHp, alive: true, iframes: cfg.spawnIframes, stun: 0, respawn: 0,
    lastHitBy: null, lastHitTick: -1, standOn: null, long: false, stars: 0, throwCd: 0,
  });
  events.push({ type: 'spawn', tick: state.tick, id: p.id, x: p.x, y: p.y });
}

// ---------- physics (NinjaRunner) ----------
export const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function moveBody(e, L = LEVEL) {
  const hit = { wall: false, bonk: false };
  e.x += e.vx;
  const top = Math.floor(e.y / T), bot = Math.floor((e.y + e.h - .01) / T);
  if (e.vx > 0) {
    const tx = Math.floor((e.x + e.w - .01) / T);
    for (let ty = top; ty <= bot; ty++) if (isSolid(L, tx, ty)) { e.x = tx * T - e.w; e.vx = 0; hit.wall = true; break; }
  } else if (e.vx < 0) {
    const tx = Math.floor(e.x / T);
    for (let ty = top; ty <= bot; ty++) if (isSolid(L, tx, ty)) { e.x = (tx + 1) * T; e.vx = 0; hit.wall = true; break; }
  }
  const prevBottom = e.y + e.h;
  e.y += e.vy; e.onGround = false;
  const l = Math.floor(e.x / T), r = Math.floor((e.x + e.w - .01) / T);
  if (e.vy >= 0) {
    const ty = Math.floor((e.y + e.h) / T);
    for (let tx = l; tx <= r; tx++) {
      if (isSolid(L, tx, ty) || (isPlat(L, tx, ty) && prevBottom <= ty * T + .5)) {
        e.y = ty * T - e.h; e.vy = 0; e.onGround = true; break;
      }
    }
  } else {
    const ty = Math.floor(e.y / T);
    for (let tx = l; tx <= r; tx++) if (isSolid(L, tx, ty)) { e.y = (ty + 1) * T; e.vy = 0; hit.bonk = true; break; }
  }
  return hit;   // returned, not stored, so the state's shape stays stable
}

// Sword hitbox for a swing, NinjaRunner swordBoxOf. A long-sword holder (p.long) has the box's
// length scaled by LONG_REACH. The box stays anchored at its near edge, 2 units inside the body on
// the facing side, and grows outward in the facing direction only (never back through the body).
export function swordBoxOf(p) {
  const sweep = p.atkType === 'sweep', len = (sweep ? 22 : 18) * (p.long ? LONG_REACH : 1);
  const x = p.face > 0 ? p.x + p.w - 2 : p.x + 2 - len;
  return sweep ? { x, y: p.y + 1, w: len, h: 10 } : { x, y: p.y - 5, w: len, h: p.h + 8 };
}
export const swordLive = p => p.alive && p.atk > 3 && p.atk <= ATK_LEN - 2;

// One player's own update for one tick: input, jump, gravity, sword timers, tile collision.
// Returns true if the player ended the tick in spikes. Used by step() for every player and,
// on its own, by a client predicting its local player.
export function movePlayer(p, keys, cfg = DEFAULTS, L = LEVEL) {
  const prev = p.keys;
  p.keys = keys; p.fx = 0;
  p.px = p.x; p.py = p.y;
  const stun = p.stun > 0, wasGround = p.onGround;
  const Lk = keys & KEY.LEFT, Rk = keys & KEY.RIGHT;
  const max = keys & KEY.RUN ? cfg.runSpeed : cfg.walkSpeed;
  const acc = (p.onGround ? cfg.groundAccel : cfg.airAccel) * (stun ? cfg.stunMoveMul : 1);
  if (Lk && !Rk) { p.vx = p.vx > -max ? Math.max(p.vx - acc, -max) : p.vx * .97; p.face = -1; }
  else if (Rk && !Lk) { p.vx = p.vx < max ? Math.min(p.vx + acc, max) : p.vx * .97; p.face = 1; }
  else { p.vx *= p.onGround ? cfg.groundFriction : cfg.airFriction; if (Math.abs(p.vx) < .05) p.vx = 0; }

  // jump: a press (0 -> 1 edge) fills the buffer; coyote time allows a late jump off a ledge
  const jumpHeld = (keys & KEY.JUMP) !== 0;
  if (jumpHeld && !(prev & KEY.JUMP) && !stun) p.buf = cfg.jumpBuffer; else if (p.buf > 0) p.buf--;
  p.coyote = p.onGround ? cfg.coyote : Math.max(0, p.coyote - 1);
  if (p.buf > 0 && p.coyote > 0 && !stun) {
    p.vy = -(cfg.jumpVel + Math.abs(p.vx) * cfg.jumpSpeedBonus); p.buf = 0; p.coyote = 0; p.onGround = false; p.fx |= FX.JUMP;
  }
  // release early = shorter hop (not while knocked back, so the knock-up isn't cut short)
  p.vy += (p.vy < 0 && !jumpHeld && !stun) ? cfg.releaseGravity : cfg.gravity;
  if (p.vy > cfg.maxFall) p.vy = cfg.maxFall;

  // sword: chop, then a sweep if slash is pressed again within the combo window
  if ((keys & KEY.SLASH) && !(prev & KEY.SLASH) && p.atkCd <= 0 && !stun) {
    p.atkType = p.combo > 0 && p.atkType === 'chop' ? 'sweep' : 'chop';
    p.atk = ATK_LEN; p.atkCd = ATK_CD; p.combo = COMBO_T;
    p.swing++; p.hitSet = []; p.iframes = 0;   // attacking ends spawn protection
    p.fx |= FX.SLASH;
  }
  if (p.atk > 0) p.atk--;
  if (p.atkCd > 0) p.atkCd--;
  if (p.combo > 0 && p.atk === 0) p.combo--;

  if (moveBody(p, L).bonk) p.fx |= FX.BONK;
  if (p.onGround && !wasGround) p.fx |= FX.LAND;
  p.standOn = null;
  p.walk += Math.abs(p.vx);
  if (p.iframes > 0) p.iframes--;
  if (p.stun > 0) p.stun--;
  return inSpikes(p, L);
}

// NinjaRunner's spike test: inside a '^' cell with the feet past the spike tips.
export function inSpikes(p, L = LEVEL) {
  const l = Math.floor((p.x + 2) / T), r = Math.floor((p.x + p.w - 2) / T);
  const t0 = Math.floor(p.y / T), t1 = Math.floor((p.y + p.h - .01) / T);
  for (let ty = t0; ty <= t1; ty++) for (let tx = l; tx <= r; tx++)
    if (tileAt(L, tx, ty) === '^' && p.y + p.h > ty * T + 9) return true;
  return false;
}

// ---------- player-player collision (SPEC §4) ----------
function boxHitsSolid(p, L) {
  const l = Math.floor(p.x / T), r = Math.floor((p.x + p.w - .01) / T);
  const t0 = Math.floor(p.y / T), t1 = Math.floor((p.y + p.h - .01) / T);
  for (let ty = t0; ty <= t1; ty++) for (let tx = l; tx <= r; tx++) if (isSolid(L, tx, ty)) return true;
  return false;
}
// Move p horizontally by dx, stopping at walls. Returns the distance actually moved.
function pushX(p, dx, L) {
  if (!dx) return 0;
  let nx = p.x + dx;
  const top = Math.floor(p.y / T), bot = Math.floor((p.y + p.h - .01) / T);
  if (dx > 0) {
    const tx = Math.floor((nx + p.w - .01) / T);
    for (let ty = top; ty <= bot; ty++) if (isSolid(L, tx, ty)) { nx = Math.max(p.x, tx * T - p.w); break; }
  } else {
    const tx = Math.floor(nx / T);
    for (let ty = top; ty <= bot; ty++) if (isSolid(L, tx, ty)) { nx = Math.min(p.x, (tx + 1) * T); break; }
  }
  const moved = nx - p.x;
  p.x = nx;
  return moved;
}
// a lands on b's head: b is a temporary platform. a rides along with b's horizontal motion.
function landOn(a, b, L) {
  a.y = b.y - a.h; a.vy = 0; a.onGround = true; a.standOn = b.id;
  if (boxHitsSolid(a, L)) {                  // b carried a into a ceiling: a stays, b is held below
    a.y = (Math.floor(a.y / T) + 1) * T;
    b.y = a.y + a.h; if (b.vy < 0) b.vy = 0;
  }
  const carry = b.x - b.px;
  if (carry) pushX(a, carry, L);
}
// Resolve one overlapping pair. `fixed` (a set of ids) are treated as immovable: used for
// prediction, where other players are obstacles the local player cannot move.
function resolvePair(a, b, cfg, L, fixed) {
  if (!overlap(a, b)) return;
  const aFixed = fixed && fixed.has(a.id), bFixed = fixed && fixed.has(b.id);
  if (a.py + a.h <= b.py + 1 && a.vy >= b.vy && !aFixed) return landOn(a, b, L);
  if (b.py + b.h <= a.py + 1 && b.vy >= a.vy && !bFixed) return landOn(b, a, L);
  // side contact: push apart symmetrically along x (ties broken by id)
  const ca = a.x + a.w / 2, cb = b.x + b.w / 2;
  const dir = ca < cb ? -1 : ca > cb ? 1 : (a.id < b.id ? -1 : 1);   // a's push direction
  const ox = dir < 0 ? a.x + a.w - b.x : b.x + b.w - a.x;
  let ma = 0, mb = 0;
  if (aFixed && bFixed) return;
  if (aFixed) mb = pushX(b, -dir * ox, L);
  else if (bFixed) ma = pushX(a, dir * ox, L);
  else {
    ma = pushX(a, dir * ox / 2, L); mb = pushX(b, -dir * ox / 2, L);
    const rest = ox - Math.abs(ma) - Math.abs(mb);   // one side hit a wall: the other takes the rest
    if (rest > 1e-9) { if (Math.abs(ma) < ox / 2) pushX(b, -dir * rest, L); else pushX(a, dir * rest, L); }
  }
  if (a.vx * dir < 0) a.vx *= cfg.pushDamp;   // moving into the other body
  if (b.vx * -dir < 0) b.vx *= cfg.pushDamp;
}

export function resolvePlayers(players, cfg = DEFAULTS, L = LEVEL, fixed = null) {
  const live = players.filter(p => p.alive);
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) resolvePair(live[i], live[j], cfg, L, fixed);
}

// ---------- combat (SPEC §5) ----------
// Lag-compensation helper: test attacker's current sword box against explicitly supplied
// target positions (e.g. rewound to what the attacker saw). targets: [{id, x, y, w?, h?}].
// Returns the ids hit, in the order given, skipping the attacker and anyone already hit by
// this swing. Does not change any state.
export function slashHits(attacker, targets) {
  if (!swordLive(attacker)) return [];
  const box = swordBoxOf(attacker), out = [];
  for (const t of targets) {
    if (t.id === attacker.id || attacker.hitSet.includes(t.id)) continue;
    if (overlap(box, { x: t.x, y: t.y, w: t.w ?? PW, h: t.h ?? PH })) out.push(t.id);
  }
  return out;
}

function kill(state, v, killerId, move, cfg, events) {
  const held = v.long, killer = killerId != null ? getPlayer(state, killerId) : null;
  const longKill = !!(killer && killer.long && (move === 'chop' || move === 'sweep'));
  const lostStars = v.stars | 0;
  v.long = false;                               // a long sword is lost on death, never dropped
  v.stars = 0;                                  // so are unthrown ninja stars
  v.alive = false; v.hp = 0; v.deaths++; v.respawn = cfg.respawnTicks;
  v.atk = 0; v.stun = 0; v.iframes = 0; v.buf = 0;
  let credit = killerId;
  if (credit == null && v.lastHitBy != null && state.tick - v.lastHitTick <= cfg.creditTicks) credit = v.lastHitBy;
  const k = credit != null && credit !== v.id ? getPlayer(state, credit) : null;
  if (k) k.score++;
  nextRand(state);
  events.push({ type: 'kill', tick: state.tick, killer: k ? k.id : null, victim: v.id, move, seed: state.rng,
                x: v.x, y: v.y, vx: v.vx, vy: v.vy, face: v.face,
                ...(longKill ? { long: true } : {}), ...(held ? { held: true } : {}), ...(lostStars ? { stars: lostStars } : {}) });
}

// Kill a player from outside the normal rules (e.g. a disconnect). Credit rules still apply.
export function killPlayer(state, id, cause = 'self', cfg = DEFAULTS) {
  const v = getPlayer(state, id), events = [];
  if (v && v.alive) kill(state, v, null, cause, cfg, events);
  return events;
}

// ---------- the step ----------
// inputs: { [id]: bitmask } or a Map. Missing ids get 0 (no keys).
// opts.rewind(attacker, state) may return [{id,x,y}] positions to test that attacker's slash
// against (server lag compensation); otherwise current positions are used.
// Returns the events of this tick: spawn, hit, kill.
export function step(state, inputs = {}, { cfg = DEFAULTS, level: L = LEVEL, rewind = null } = {}) {
  const get = inputs instanceof Map ? id => inputs.get(id) : id => inputs[id];
  const events = [];
  state.tick++;
  const P = state.players;

  // 1. respawns and movement, in id order; a throw press launches a star from where the thrower
  // ends up (SPEC §5.2): edge-triggered, cooldown cfg.throwCd, not in hit-stun, needs a star
  const spiked = [];
  if (!state.stars) { state.stars = []; state.starSeq = 0; state.starT = -1; }   // a pre-M6 state
  for (const p of P) {
    const keys = (get(p.id) | 0) & KEY_MASK;
    if (!p.alive) {
      p.keys = keys; p.fx = 0;
      if (--p.respawn <= 0) spawnPlayer(state, p, cfg, L, events);
      continue;
    }
    const throwPress = (keys & KEY.THROW) && !(p.keys & KEY.THROW) && p.stun <= 0 && (p.throwCd | 0) <= 0 && (p.stars | 0) > 0;
    if (p.throwCd > 0) p.throwCd--;
    movePlayer(p, keys, cfg, L);
    if (throwPress) throwStar(state, p, cfg, events);
  }
  // 2. player-player collision
  resolvePlayers(P, cfg, L);
  // 3. spikes: instant kill, credited to a recent hitter
  for (const p of P) if (p.alive && inSpikes(p, L)) spiked.push(p);
  for (const p of spiked) kill(state, p, null, 'spikes', cfg, events);
  // 4. slashes: gather every hit first so simultaneous swings trade, then apply in id order
  const hits = [];
  for (const a of P) {
    if (!swordLive(a)) continue;
    const pos = (rewind && rewind(a, state)) || P;
    for (const id of slashHits(a, pos.filter(t => t.id !== a.id))) {
      const v = getPlayer(state, id);
      if (v && v.alive && v.iframes <= 0) hits.push([a, v]);
    }
  }
  for (const [a, v] of hits) {
    if (!v.alive || a.hitSet.includes(v.id)) continue;
    const dmg = a.atkType === 'sweep' ? cfg.sweepDmg : cfg.chopDmg;
    a.hitSet.push(v.id);
    v.hp -= dmg; v.lastHitBy = a.id; v.lastHitTick = state.tick;
    const dead = v.hp <= 0, mul = dead ? cfg.killKnockMul : 1;
    v.vx = cfg.knockX * a.face * mul; v.vy = cfg.knockY * mul; v.onGround = false;
    events.push({ type: 'hit', tick: state.tick, attacker: a.id, victim: v.id, move: a.atkType, dmg, hp: Math.max(0, v.hp), x: v.x, y: v.y });
    if (dead) kill(state, v, a.id, a.atkType, cfg, events);
    else v.stun = cfg.hitStun;
  }
  // 4b. a live sword swing breaks any long-sword pickup lying in its box (it is destroyed, not taken)
  if (state.items && state.items.length) for (const a of P) {
    if (!swordLive(a)) continue;
    const sb = swordBoxOf(a);
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i], b = itemBox(it);
      if (itemKind(it) !== 'long' || !(sb.x < b.x + b.w && sb.x + sb.w > b.x && sb.y < b.y + b.h && sb.y + sb.h > b.y)) continue;
      state.items.splice(i--, 1);
      events.push({ type: 'break', tick: state.tick, id: a.id, item: it.id, x: it.x, y: it.y });
    }
  }
  // 5. ninja stars in flight: move, stop at solid tiles or the range, hit the first player
  stepStars(state, cfg, L, events);
  // 6. pickups: taken on body contact, in id order; then the spawn countdowns
  stepItems(state, cfg, L, events);
  return events;
}

// ---------- ninja stars (SPEC §5.2) ----------
export const starBox = st => ({ x: st.x - STAR_W / 2, y: st.y - STAR_H / 2, w: STAR_W, h: STAR_H });

function throwStar(state, p, cfg, events) {
  p.stars--; p.throwCd = cfg.throwCd;
  p.iframes = 0;                                // throwing ends spawn protection, like attacking
  p.fx |= FX.THROW;
  // it starts on the body's centre line, so a point-blank target is still hit, and flies at hand height
  const st = { id: ++state.starSeq, owner: p.id, x: p.x + p.w / 2, y: p.y + STAR_HAND, vx: cfg.starSpeed * p.face, dist: 0 };
  state.stars.push(st);
  events.push({ type: 'throw', tick: state.tick, id: p.id, star: st.id, x: st.x, y: st.y, face: p.face, stars: p.stars });
}

// One tick of flight for every star, in throw order. The star sweeps from x to x + vx; the sweep is
// cut short at the first solid tile (planks don't stop it) and at cfg.starRange. Inside the sweep it
// hits the first living, vulnerable player other than the thrower that it touches (nearest along
// the flight, ties to the lower id): starDmg, a small knockback along the flight, hit-stun.
function stepStars(state, cfg, L, events) {
  for (let i = 0; i < state.stars.length; i++) {
    const st = state.stars[i], dir = st.vx > 0 ? 1 : -1, half = STAR_W / 2, speed = Math.abs(st.vx);
    let travel = Math.max(0, Math.min(speed, cfg.starRange - st.dist)), wall = false;
    // solid tiles: the columns the leading edge enters during the sweep
    const top = Math.floor((st.y - STAR_H / 2) / T), bot = Math.floor((st.y + STAR_H / 2 - .01) / T);
    const lead = st.x + dir * half;
    const solidCol = tx => { for (let ty = top; ty <= bot; ty++) if (isSolid(L, tx, ty)) return true; return false; };
    for (let tx = Math.floor((dir > 0 ? lead - .01 : lead) / T); ; tx += dir) {
      const d = dir > 0 ? Math.max(0, tx * T - lead) : Math.max(0, lead - (tx + 1) * T);   // where the edge enters column tx
      if (d > 0 && d >= travel) break;                         // not reached (touching a face is not entering)
      if (solidCol(tx)) { travel = d; wall = true; break; }
    }
    // players inside the swept box
    const x0 = st.x, x1 = st.x + dir * travel;
    const sweep = { x: Math.min(x0, x1) - half, y: st.y - STAR_H / 2, w: Math.abs(x1 - x0) + STAR_W, h: STAR_H };
    let victim = null, best = Infinity;
    for (const v of state.players) {
      if (v.id === st.owner || !v.alive || v.iframes > 0 || !overlap(sweep, v)) continue;
      const d = dir > 0 ? v.x - x0 : x0 - (v.x + v.w);         // how far along the flight its near side is
      if (d < best) { best = d; victim = v; }
    }
    if (victim) {
      st.x = dir > 0 ? Math.min(x1, Math.max(x0, victim.x - half)) : Math.max(x1, Math.min(x0, victim.x + victim.w + half));
      starHit(state, st, victim, cfg, events);
      state.stars.splice(i--, 1);
      continue;
    }
    st.x = x1; st.dist += travel;
    if (wall || st.dist >= cfg.starRange) {
      state.stars.splice(i--, 1);
      events.push({ type: 'starEnd', tick: state.tick, star: st.id, x: st.x, y: st.y, wall });
    }
  }
}

function starHit(state, st, v, cfg, events) {
  const dir = st.vx > 0 ? 1 : -1;
  v.hp -= cfg.starDmg; v.lastHitBy = st.owner; v.lastHitTick = state.tick;
  const dead = v.hp <= 0, mul = dead ? cfg.killKnockMul : 1;
  v.vx = cfg.starKnockX * dir * mul; v.vy = cfg.starKnockY * mul; v.onGround = false;
  events.push({ type: 'hit', tick: state.tick, attacker: st.owner, victim: v.id, move: 'star', star: st.id, dmg: cfg.starDmg,
                hp: Math.max(0, v.hp), x: v.x, y: v.y, dir });
  if (dead) kill(state, v, st.owner, 'star', cfg, events);
  else v.stun = cfg.hitStun;
}

// ---------- long-sword pickups (SPEC §5.1) ----------
export const itemBox = it => ({ x: it.x - ITEM_W / 2, y: it.y - ITEM_H, w: ITEM_W, h: ITEM_H });

// Item points that may take a new pickup: no pickup on them and no living player's feet within
// cfg.itemClear units. In level order.
export function freeItemPoints(state, cfg = DEFAULTS, L = LEVEL) {
  const c2 = cfg.itemClear * cfg.itemClear, live = state.players.filter(p => p.alive);
  return (L.items || []).filter(pt => !state.items.some(it => it.x === pt.x && it.y === pt.y) &&
    live.every(p => { const dx = p.x + p.w / 2 - pt.x, dy = p.y + p.h - pt.y; return dx * dx + dy * dy >= c2; }));
}

const drawItemT = (state, cfg) => cfg.itemMinTicks + Math.floor(nextRand(state) * (cfg.itemMaxTicks - cfg.itemMinTicks + 1));

export const itemKind = it => (it.kind === 'star' ? 'star' : 'long');   // pre-M6 items are long swords
const drawStarT = (state, cfg) => cfg.starMinTicks + Math.floor(nextRand(state) * (cfg.starMaxTicks - cfg.starMinTicks + 1));

function stepItems(state, cfg, L, events) {
  if (!state.items) { state.items = []; state.itemT = -1; state.itemSeq = 0; }   // a pre-M5 state
  if (state.starT == null) state.starT = -1;
  // pickups: each lying item, in list order, goes to the lowest-id living toucher who can take it:
  // a long sword to one without one; stars (+starGive, up to starCarry) to one below starCarry
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i], box = itemBox(it), kind = itemKind(it);
    const p = state.players.find(q => q.alive && (kind === 'star' ? (q.stars | 0) < cfg.starCarry : !q.long) && overlap(q, box));
    if (!p) continue;
    if (kind === 'star') p.stars = Math.min(cfg.starCarry, (p.stars | 0) + cfg.starGive); else p.long = true;
    state.items.splice(i--, 1);
    events.push({ type: 'pickup', tick: state.tick, id: p.id, item: it.id, kind, x: it.x, y: it.y, ...(kind === 'star' ? { stars: p.stars } : {}) });
  }
  // spawning, per kind: the countdown is drawn when a pickup of that kind appears (and on the first
  // step) and runs only while there is room for another of that kind; when it is due and no point
  // is free (a point holds one pickup of either kind), it retries every tick
  spawnKind(state, cfg, L, events, 'long', 'itemT', cfg.itemMax, drawItemT);
  spawnKind(state, cfg, L, events, 'star', 'starT', cfg.starMax, drawStarT);
}

function spawnKind(state, cfg, L, events, kind, key, max, draw) {
  if (state[key] < 0) state[key] = draw(state, cfg);
  let n = 0;
  for (const it of state.items) if (itemKind(it) === kind) n++;
  if (n >= max) return;
  if (state[key] > 0) state[key]--;
  if (state[key] > 0) return;
  const free = freeItemPoints(state, cfg, L);
  if (!free.length) return;
  const pt = free[Math.floor(nextRand(state) * free.length) % free.length];
  const it = { id: ++state.itemSeq, x: pt.x, y: pt.y, kind };
  state.items.push(it);
  state[key] = draw(state, cfg);
  events.push({ type: 'item', tick: state.tick, id: it.id, kind, x: it.x, y: it.y });
}

// Re-simulate only one player for client prediction: its own movement, then collisions against
// the other living players held fixed. Does not advance state.tick, run combat or kill.
// Returns true if the player is in spikes (the server decides the death).
export function predictStep(state, id, keys, { cfg = DEFAULTS, level: L = LEVEL } = {}) {
  const p = getPlayer(state, id);
  if (!p || !p.alive) return false;
  movePlayer(p, keys & KEY_MASK, cfg, L);
  const fixed = new Set(state.players.filter(o => o !== p).map(o => o.id));
  resolvePlayers(state.players, cfg, L, fixed);
  return inSpikes(p, L);
}

// ---------- serialisation ----------
export const serialize = state => JSON.stringify(state);
export const deserialize = s => JSON.parse(s);
export const cloneState = state => JSON.parse(JSON.stringify(state));

// ---------- position history for lag compensation ----------
// A ring of recent ticks: [{tick, pos: [{id, x, y}]}], newest last, HISTORY_TICKS long (200 ms).
export function createHistory(maxTicks = HISTORY_TICKS) { return { maxTicks, frames: [] }; }
export function recordHistory(hist, state) {
  hist.frames.push({ tick: state.tick, pos: state.players.filter(p => p.alive).map(p => ({ id: p.id, x: p.x, y: p.y })) });
  while (hist.frames.length > hist.maxTicks + 1) hist.frames.shift();
}
// Positions at a (possibly fractional) tick, interpolated between the two recorded frames around
// it and clamped to the oldest/newest frame. Returns [{id, x, y}] or null if nothing is recorded.
export function positionsAt(hist, tick) {
  const f = hist.frames;
  if (!f.length) return null;
  if (tick <= f[0].tick) return f[0].pos.map(o => ({ ...o }));
  if (tick >= f[f.length - 1].tick) return f[f.length - 1].pos.map(o => ({ ...o }));
  let i = 1;
  while (f[i].tick < tick) i++;
  const a = f[i - 1], b = f[i], k = (tick - a.tick) / (b.tick - a.tick);
  return b.pos.map(pb => {
    const pa = a.pos.find(o => o.id === pb.id);
    return pa ? { id: pb.id, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k } : { ...pb };
  });
}
