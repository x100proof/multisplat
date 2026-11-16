// Tunables shared by the server and the client. Plain data, no side effects.
// Physics values are NinjaRunner's DEFAULTS; combat values are SPEC §5.

export const TICK_HZ = 60;               // fixed simulation rate
export const VW = 320, VH = 192, T = 16; // view size and tile size, in world units

// Per-player input bitmask, sampled once per tick (level-triggered: a bit is set while held).
// Jump and slash presses are detected inside the sim as 0 -> 1 edges against the previous tick.
export const KEY = Object.freeze({ LEFT: 1, RIGHT: 2, JUMP: 4, RUN: 8, SLASH: 16, THROW: 32 });
export const KEY_MASK = 63;

// Cosmetic per-tick flags the sim sets on a player (player.fx) so a client can play sounds.
export const FX = Object.freeze({ JUMP: 1, SLASH: 2, BONK: 4, LAND: 8, THROW: 16 });

// Player body (Kanbei, from NinjaRunner) and sword timing.
export const PW = 10, PH = 13;
export const ATK_LEN = 12;     // ticks a swing lasts
export const ATK_CD = 16;      // ticks between swings
export const COMBO_T = 40;     // ticks after a chop in which the next swing is a sweep

// The full tunable set. The sim reads everything through a cfg object of this shape, so a client
// debug panel can edit a copy; the server always uses these defaults.
export const DEFAULTS = Object.freeze({
  // NinjaRunner movement
  gravity: .27, jumpVel: 7.2, jumpSpeedBonus: .25, releaseGravity: .8, maxFall: 7,
  walkSpeed: 1.6, runSpeed: 2.6, groundAccel: .22, airAccel: .14, groundFriction: .78, airFriction: .96,
  coyote: 6, jumpBuffer: 8,
  // player-player collision
  pushDamp: .5,            // velocity multiplier on side contact when moving into the other body
  // combat (SPEC §5)
  maxHp: 100, chopDmg: 34, sweepDmg: 25,
  knockX: 3.5, knockY: -3, killKnockMul: 1.4,
  hitStun: 10, stunMoveMul: .25,
  spawnIframes: 90, respawnTicks: 120, creditTicks: 300,
  spawnMinDist: 64,
  // long-sword pickups (SPEC §5.1): a new one 20-40 s after the previous appeared, at most 2 lying
  // at once, at an item point with no player within itemClear units
  itemMinTicks: 1200, itemMaxTicks: 2400, itemMax: 2, itemClear: 32,
  // ninja stars (SPEC §5.2): pickups every 5-10 s, at most 4 lying; +3 each, carry 9; throw
  // cooldown 15 ticks; flight 6 units/tick for 240 units; 20 damage and a small knockback
  starMinTicks: 300, starMaxTicks: 600, starMax: 4, starGive: 3, starCarry: 9,
  throwCd: 15, starSpeed: 6, starRange: 240, starDmg: 20, starKnockX: 1.6, starKnockY: -1.6,
});

// Long sword (SPEC §5.1): the holder's swordBoxOf length is scaled by this, for chop and sweep.
// Not in DEFAULTS on purpose: the client debug panel edits cfg, and reach must match the server.
export const LONG_REACH = 1.6;
// A pickup's body, centred on its item point's x and resting on the point's surface (y).
export const ITEM_W = 8, ITEM_H = 14;
export const STAR_W = 4, STAR_H = 4;    // a flying star's box (centred on its x, y)
export const STAR_HAND = 6;             // a star leaves the hand this far below the body's top

// Netcode values shared by the server and the client (SPEC §6).
export const NET = Object.freeze({
  historyMs: 200, rewindCapMs: 150, snapshotHz: 30, maxInputBatch: 3,
  interpMs: 100,           // remote players are drawn this far behind the newest snapshot
  extrapMs: 100,           // at most this much extrapolation when snapshots stall
  maxPlayers: 12,          // active fighters; later joiners queue as spectators
  graceMs: 5000,           // a dropped player keeps its slot and score this long (resume token)
  heartbeatMs: 5000,       // the server closes a connection it has heard nothing from for this long
  timeoutClose: 4100,      // the close code for that: the client treats it as a network drop (resume), not a kick
  pingMs: 500,             // the client pings twice a second, from socket open, in every mode
  idleMs: 120000,          // no input for this long sends a player back to the lobby
  inputRate: 90,           // input messages per second per connection
  smoothUnits: 2,          // corrections below this are smoothed over smoothFrames, larger ones snap
  smoothFrames: 6,
});
export const TICK_MS = 1000 / TICK_HZ;

// Lobby names (SPEC §9): 1-16 characters from this allowlist, trimmed. Checked on both sides.
export const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
export function cleanName(s) {
  if (typeof s !== 'string') return null;
  const n = s.trim().replace(/ {2,}/g, ' ');
  return NAME_RE.test(n) ? n : null;
}
export const HISTORY_TICKS = Math.ceil(NET.historyMs * TICK_HZ / 1000);

// The 8 lobby colours (SPEC §9). The first six are NinjaRunner's NEON palette.
export const COLORS = Object.freeze(['#ff2a6d', '#05d9e8', '#f9f871', '#b026ff', '#39ff14', '#ff6ec7', '#ff8c1a', '#ffffff']);
