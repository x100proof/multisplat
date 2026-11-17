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

// The full tunable set. The sim reads everything through a cfg object of this shape: the offline
// debug panel edits a copy, and online every room has its own (SPEC §17.1), edited by its admin.
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
  // ninja stars (SPEC §5.2): pickups every 5-10 s, at most 4 lying; bundles of 5, 10 or 15
  // (STAR_BUNDLES), carry 30; throw
  // cooldown 15 ticks; flight 6 units/tick for 240 units; 20 damage and a small knockback
  starMinTicks: 300, starMaxTicks: 600, starMax: 4, starCarry: 30,
  throwCd: 5, starSpeed: 6, starDmg: 20, starKnockX: 1.6, starKnockY: -1.6,
});

// Room settings (SPEC §17.1). Every room has its own cfg: DEFAULTS plus these room-wide display
// switches, which the room's admin edits from the D panel and every page in the room applies.
export const VIEW_DEFAULTS = Object.freeze({ gore: true, realGore: false });
export const ROOM_DEFAULTS = Object.freeze({ ...DEFAULTS, ...VIEW_DEFAULTS });
// The editable sim constants, grouped as the panel shows them: [key, label, min, max, step]. The
// server accepts a value only inside [min, max] and on the step grid (cleanSetting), so the client's
// sliders and the server agree.
export const SETTINGS = Object.freeze([
  ['Jump', [
    ['jumpVel', 'Jump strength', 2, 12, .1],
    ['jumpSpeedBonus', 'Run-jump bonus', 0, 1, .05],
    ['gravity', 'Gravity', .1, 1, .01],
    ['releaseGravity', 'Short-hop gravity', .1, 2, .05],
    ['maxFall', 'Max fall speed', 2, 15, .5],
    ['coyote', 'Coyote time (frames)', 0, 20, 1],
    ['jumpBuffer', 'Jump buffer (frames)', 0, 20, 1],
  ]],
  ['Movement', [
    ['walkSpeed', 'Walk speed', .5, 5, .1],
    ['runSpeed', 'Run speed', .5, 6, .1],
    ['groundAccel', 'Ground accel', .02, 1, .02],
    ['airAccel', 'Air accel', .02, 1, .02],
    ['groundFriction', 'Ground friction', .5, 1, .01],
    ['airFriction', 'Air friction', .8, 1, .01],
    ['pushDamp', 'Body contact damping', 0, 1, .05],
  ]],
  ['Combat', [
    ['chopDmg', 'Chop damage', 0, 100, 1],
    ['sweepDmg', 'Sweep damage', 0, 100, 1],
    ['knockX', 'Knockback x', 0, 8, .25],
    ['knockY', 'Knockback y', -8, 0, .25],
    ['hitStun', 'Hit-stun (ticks)', 0, 40, 1],
    ['spawnIframes', 'Spawn protection (ticks)', 0, 240, 5],
    ['respawnTicks', 'Respawn delay (ticks)', 10, 300, 5],
  ]],
]);
// The room-wide on/off switches: [key, label].
export const SETTING_TOGGLES = Object.freeze([['gore', 'Gore (blood, body pieces)'], ['realGore', 'Real gore (red blood, not neon)']]);
const SETTING_RANGE = new Map([
  ...SETTINGS.flatMap(([, items]) => items.map(([k, , min, max, step]) => [k, { min, max, step }])),
  ...SETTING_TOGGLES.map(([k]) => [k, { bool: true }]),
]);
export const SETTING_KEYS = Object.freeze([...SETTING_RANGE.keys()]);
// The value the server stores for room setting `k`, or undefined: an unknown key, the wrong type,
// outside [min, max] or off the step grid. A number on the grid is snapped (no float noise).
export function cleanSetting(k, v) {
  const r = typeof k === 'string' ? SETTING_RANGE.get(k) : undefined;
  if (!r) return undefined;
  if (r.bool) return typeof v === 'boolean' ? v : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min - 1e-9 || v > r.max + 1e-9) return undefined;
  const n = (v - r.min) / r.step, i = Math.round(n);
  if (Math.abs(n - i) > 1e-6) return undefined;
  return Math.round((r.min + i * r.step) * 1e6) / 1e6;
}
// A room's settings as sent to clients: only what differs from ROOM_DEFAULTS (over every DEFAULTS
// key, so a server started with a non-default cfg is still described exactly).
export function cfgDiff(cfg) {
  const d = {};
  for (const k in ROOM_DEFAULTS) if (cfg[k] !== ROOM_DEFAULTS[k]) d[k] = cfg[k];
  return d;
}
// The full room cfg from such a diff; keys outside ROOM_DEFAULTS or of the wrong type are ignored.
export function cfgFromDiff(d) {
  const cfg = { ...ROOM_DEFAULTS };
  if (d && typeof d === 'object') for (const k in ROOM_DEFAULTS) if (typeof d[k] === typeof ROOM_DEFAULTS[k]) cfg[k] = d[k];
  return cfg;
}

// Long sword (SPEC §5.1): the holder's swordBoxOf length is scaled by this, for chop and sweep.
// Not in DEFAULTS on purpose: the debug panel edits cfg, and reach must match the server.
export const LONG_REACH = 1.6;
// A pickup's body, centred on its item point's x and resting on the point's surface (y).
export const ITEM_W = 8, ITEM_H = 14;
// Ninja-star bundles (SPEC §5.2): a star pickup holds n stars, drawn when it appears with weights
// 6 : 3 : 2 (likelihood inversely proportional to n). Not in DEFAULTS: the debug panel edits numbers.
export const STAR_BUNDLES = [{ n: 5, w: 6 }, { n: 10, w: 3 }, { n: 15, w: 2 }];
export const STAR_LEGACY_N = 3;   // a star pickup without n (made before bundles) holds this many
export const STAR_W = 4, STAR_H = 4;    // a flying star's box (centred on its x, y)
export const STAR_HAND = 6;             // a star leaves the hand this far below the body's top

// Netcode values shared by the server and the client (SPEC §6).
export const NET = Object.freeze({
  historyMs: 200, rewindCapMs: 150, snapshotHz: 30, maxInputBatch: 3,
  interpMs: 100,           // remote players are drawn this far behind the newest snapshot
  extrapMs: 100,           // at most this much extrapolation when snapshots stall
  maxPlayers: 8,           // active fighters per room (SPEC §17), AI players included; later joiners queue
  graceMs: 5000,           // a dropped player keeps its slot and score this long (resume token)
  heartbeatMs: 5000,       // the server closes a connection it has heard nothing from for this long
  timeoutClose: 4100,      // the close code for that: the client treats it as a network drop (resume), not a kick
  restartClose: 1012,      // the server is restarting and saved the rooms (SPEC §18): reconnect and resume (the standard "service restart" code)
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
// Rooms (SPEC §17). At most `max` rooms at once and `perIp` open rooms created from one address.
// Creating is limited per connection (burst 2, one more every 15 s); renaming and admin transfers
// share another bucket (burst 4, one more every 2 s). Room names use the player-name allowlist plus
// the apostrophe (so the default "Ann's room" is a name one could type), 1-20 characters.
export const ROOM = Object.freeze({ max: 10, perIp: 2, nameMax: 20,
  createBurst: 2, createRefillMs: 15000, editBurst: 4, editRefillMs: 2000,
  cfgBurst: 6, cfgRefillMs: 1000,   // room-settings changes (SPEC §17.1): per connection, burst 6, one more a second
  pendingMs: 600000 });   // a room held open only by its pending admin closes after 10 min without an admin action
export const ROOM_NAME_RE = /^[A-Za-z0-9 _'-]{1,20}$/;
export function cleanRoomName(s) {
  if (typeof s !== 'string') return null;
  const n = s.trim().replace(/ {2,}/g, ' ');
  return ROOM_NAME_RE.test(n) ? n : null;
}
// The name a room gets when its creator leaves the field blank: "<name>'s room", cut to fit (a "#2"
// de-duplication suffix is dropped first: it is outside the allowlist).
export function defaultRoomName(playerName) {
  const base = String(playerName).replace(/#\d+$/, '').slice(0, ROOM.nameMax - 7).trim() || 'New';
  return `${base}'s room`;
}
// Chat (SPEC §9): the longest message, in code points, and the per-player rate (1 per 1.5 s, burst 3).
export const CHAT = Object.freeze({ maxLen: 80, burst: 3, refillMs: 1500, showMs: 6000, fadeMs: 1000 });
// Whitespace (tabs, newlines and Unicode spaces) becomes one space; control (Cc), format (Cf: zero-width, bidi
// and tag characters, soft hyphen, BOM) and unpaired surrogates are removed; the result is trimmed
// and cut to CHAT.maxLen code points, so an emoji is never split. Returns '' for "drop this" and
// null for a non-string. Used by the server (authoritative) and by the client and tests.
export function cleanChat(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\t-\r\p{Z}]/gu, ' ').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/ {2,}/g, ' ').trim();
  return Array.from(t).slice(0, CHAT.maxLen).join('').trim();
}
export const HISTORY_TICKS = Math.ceil(NET.historyMs * TICK_HZ / 1000);

// The 8 lobby colours (SPEC §9). The first six are NinjaRunner's NEON palette.
// 12 colours for 12 fighters: no two players in the arena share one (the server enforces it).
export const COLORS = Object.freeze(['#ff2a6d', '#05d9e8', '#f9f871', '#b026ff', '#39ff14', '#ff6ec7', '#ff8c1a', '#ffffff',
  '#3d6bff', '#ff2d1a', '#00c9a7', '#c6ff1a']);

// AI players (SPEC §15). Every bot wears BOT.hex, which is not in COLORS, so no human can pick it
// (a hello with any colour index outside COLORS is refused); clients look colours up in PALETTE,
// where it sits at index BOT.color. Names are "AI 1", "AI 2", … Adding or removing is rate-limited
// per connection (burst 4, one more every 250 ms) and arena-wide (burst 12, then 8 a second).
export const BOT = Object.freeze({ color: COLORS.length, hex: '#9fb4c8', name: 'AI',
  burst: 4, refillMs: 250, globalBurst: 12, globalRefillMs: 125 });
export const PALETTE = Object.freeze([...COLORS, BOT.hex]);
