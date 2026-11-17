# multisplat: architecture (as implemented)

Status: **M6** (in progress). This covers:
- the shared simulation and the arena (M1),
- the authoritative WebSocket server, with lobby, queue, resume and lag compensation,
- the online client, with prediction and interpolation,
- the remote-debugging pipeline (M2),
- client-side gore, the combat music, the kill feed, the scoreboard and touch controls (M3),
- long-sword pickups (M5, SPEC §5.1): sim, item points, protocol, client art and SFX,
- M6 changes: leaving with Escape, no spike traps in the arena (§3), the 5 s heartbeat and resume
  window (§6.4), scores for everyone along the top (§9), neon blood by default with a real-gore
  option (§7), ninja stars (§5.2).
- rooms (SPEC §17): up to 10 rooms of 8 slots, each with an admin; see server/room.js and "Rooms" below.

```
shared/constants.js   tunables: physics (NinjaRunner DEFAULTS), combat, input bits, net constants, colours, name rule
shared/level.js       the 26x18 arena (no spikes), tile queries, spawn points, item points (long swords and ninja stars), spawn picker
shared/sim.js         deterministic 60 Hz world step (movement, player collision, combat, ninja stars, respawn, pickups)
server/server.js      config, static files, /ws upgrade (origin, caps, limits), NET_SIM, entry point
server/arena.js       connections and protocol, rate limits, heartbeat, resume tokens, idle kick, the rooms and the one tick loop
server/room.js        one room: its world, slots/queue, names, colours, bots, admin, sim step with lag comp, snapshots
server/debug.js       server event ring, POST /debug/report intake + storage, loopback admin listener
server/logs.js        streamed client logs: per word id, the last hour in memory, with caps (SPEC §13.5)
shared/logid.js       word ids (`amber-otter`: 100 adjectives x 100 nouns) and the LOG streaming limits
public/index.html     markup + CSS (lobby, HUD, respawn message, debug panel)
public/game.js        client: rendering, input (keys, pad, touch), SFX, camera, lobby, HUD, debug panel; offline sandbox
public/gore.js        gore simulation (DOM-free, seeded by kill.seed): particles, gibs, fountains, decals, pools
public/music.js       the combat score as data, its offline pre-render into two loops, the live player
public/net.js         client netcode: socket, reconnect/resume, clock sync, prediction, interpolation
public/debug.js       client log ring (dbg), debug report builder and sender, log streaming queue
tools/debug.js        CLI for the admin listener
test/*.test.js        node:test unit tests (sim, items, stars, level, server, arena, rooms, bots, spectate, gore, music, logs, hygiene)
test/multiclient.js   headless Chromium: 3 players, fight, kill feed, score strip, gore fingerprint and blood styles, resume, debug report, NET_SIM prediction, long sword, leave, ninja stars, heartbeat
test/abuse.js         server limits against a real server process
test/smoke.js         connect to a deployed /ws and expect `welcome`
test/lib.js, bot.js   test helpers (spare ports, server process, Chromium lookup) and the scripted player
deploy/               systemd unit + nginx site templates (placeholders only)
```

No bundler. `shared/` holds plain ES modules. The server can `import` them and the browser loads them
from `/shared/*.js`.

## shared/constants.js

- `TICK_HZ = 60`, `VW = 320`, `VH = 192`, `T = 16`, `PW = 10`, `PH = 13` (Kanbei's body).
- `KEY` is the input bitmask: `LEFT 1, RIGHT 2, JUMP 4, RUN 8, SLASH 16, THROW 32` (`KEY_MASK 63`;
  the server kicks a mask outside it as malformed). Bits are level-triggered
  (set while held). The sim detects jump and slash presses as 0→1 edges against the previous tick.
- `FX`: cosmetic per-tick flags the sim writes to `player.fx` (`JUMP 1, SLASH 2, BONK 4, LAND 8, THROW 16`).
- `ATK_LEN 12`, `ATK_CD 16`, `COMBO_T 40` are NinjaRunner's sword timing.
- `DEFAULTS` holds every tunable the sim reads: NinjaRunner movement, `pushDamp`, and the SPEC §5
  combat values (`maxHp 100`, `chopDmg 34`, `sweepDmg 25`, `knockX 3.5`, `knockY -3`, `killKnockMul 1.4`,
  `hitStun 10`, `stunMoveMul .25`, `spawnIframes 90`, `respawnTicks 120`, `creditTicks 300`,
  `spawnMinDist 64`) and the pickup tunables `itemMinTicks 1200`, `itemMaxTicks 2400` (20–40 s),
  `itemMax 2`, `itemClear 32`, and the ninja-star tunables (SPEC §5.2): `starMinTicks 300`,
  `starMaxTicks 600` (5–10 s), `starMax 4`, `starCarry 30`, `throwCd 15`, `starSpeed 6`,
  `starDmg 20`, `starKnockX 1.6`, `starKnockY -1.6` (a small knockback).
- Room settings (SPEC §17.1): `VIEW_DEFAULTS` (`gore: true, realGore: false`), `ROOM_DEFAULTS`
  (`DEFAULTS` + those), `SETTINGS` (the panel's slider table, `[group, [[key, label, min, max, step]…]]`),
  `SETTING_TOGGLES`, `SETTING_KEYS`, `cleanSetting(k, v)` (the stored value, snapped to the step grid,
  or undefined: unknown key, wrong type, out of range, off the grid), `cfgDiff(cfg)` / `cfgFromDiff(d)`
  (the wire form: only what differs from `ROOM_DEFAULTS`). `ROOM.cfgBurst 6`, `ROOM.cfgRefillMs 1000`.
- `LONG_REACH = 1.6` (the holder's sword-box length factor) is a separate constant, not in `DEFAULTS`,
  because the offline debug panel edits `cfg` and reach must always match the server.
  `ITEM_W 8`, `ITEM_H 14` is a pickup's body (both kinds). `STAR_W 4`, `STAR_H 4` is a flying star's
  box (centred on its x, y) and `STAR_HAND 6` its height below the thrower's top. `STAR_BUNDLES`
  (`[{n: 5, w: 6}, {n: 10, w: 3}, {n: 15, w: 2}]`) are the star-pickup amounts and their weights
  (odds inversely proportional to the amount); `STAR_LEGACY_N 3` is the amount of a star pickup
  without `n` (made before bundles).
- `NET` holds the netcode values:
  - `historyMs 200`, `rewindCapMs 150`,
  - `snapshotHz 30`, `maxInputBatch 3`,
  - `interpMs 100`, `extrapMs 100`,
  - `maxPlayers 8` (per room, bots included; SPEC §17), `graceMs 5000`, `idleMs 120000`, `inputRate 90`,
  - `heartbeatMs 5000` (a connection silent this long is closed), `timeoutClose 4100` (its close
    code, which the client treats as a network drop), `pingMs 500` (the client's ping period),
  - `smoothUnits 2`, `smoothFrames 6`.

  Next to it are `HISTORY_TICKS` (12) and `TICK_MS` (16.67).
- `COLORS` holds the 8 lobby colours. The first six are NinjaRunner's NEON set. Players pick one
  by index (0–11). No two fighters share one: `Arena.freeColor` runs when a record enters the arena.
- `NAME_RE` / `cleanName(s)` trims, collapses double spaces and checks for 1–16 characters from
  `[A-Za-z0-9 _-]`. It returns the clean name or `null`. The lobby and the server both use it.
- Rooms (SPEC §17): `ROOM` (`max 10`, `perIp 2`, `nameMax 20`, the create bucket `createBurst 2` /
  `createRefillMs 15000`, the rename/transfer bucket `editBurst 4` / `editRefillMs 2000`),
  `ROOM_NAME_RE` / `cleanRoomName(s)` (the name rule plus `'`, 1–20 characters) and
  `defaultRoomName(name)` ("Ann's room", the name's `#n` dropped and cut to fit).

## shared/level.js

`LEVEL = {w: 26, h: 18, grid: string[], spawns: [{x, y}]}`. Tiles use NinjaRunner's codes (`#`, `B`, `=`, `^`, `.`).
The arena has a solid border on all four sides (including a ceiling). Above the floor there are four
platform tiers, at rows 13, 9, 6 and 3. There are **no spikes** (SPEC §3): the only way to die is
another player. A low 2×1 block sits in the middle of the floor (columns 12–13), a step to jump or
fight over. The sim still supports the `^` tile; tests that need it use `test/spikelevel.js`, a copy of
the arena with spike strips on the floor and on the centre block. There are 15 spawn points (one on
the centre block). Each one is given as a feet position:
x is the centre and y is the top of the tile stood on.

- `isSolid(L, tx, ty)` and `isPlat` are NinjaRunner's tile tests. `tileAt` returns the tile code.
- `LEVEL.items`: 11 long-sword item points, given like spawns (x centre, y the surface top), two per
  surface level (floor and the four tiers) plus one on the centre block (index 10; indexes are stable
  because `ITEM_POINTS` pins pickups by index). Each lies on the same walkable surface as a spawn point
  (a test checks footing, headroom and the walk from that spawn).
- `spawnPos(s)` gives the top-left of a body standing on spawn point `s`.
- `pickSpawn(L, living, rand, minDist)` skips points within `minDist` of a living player. It weights
  the remaining points by the squared distance to the nearest living player. If every point is too
  close, it takes the farthest one. With no living players, the pick is uniform.

## shared/sim.js

The sim is pure. It uses no DOM, clock or `Math.random`, and a test enforces that. The state is
plain JSON:

```js
state = { tick, rng, players: [player…],   // players kept sorted by numeric id
          items: [{id, x, y, kind: 'long'|'star', n?}…],  // pickups lying in the arena (x, y = their item
                                 // point; one pickup of either kind per point; no kind = 'long';
                                 // n = the stars a star pickup holds, 5|10|15 or a rest left lying)
          itemT, starT,          // ticks until the next long sword / star pickup may appear (-1: drawn on the first step)
          itemSeq,               // last pickup id used (shared by both kinds)
          stars: [{id, owner, x, y, vx, dist}…],   // ninja stars in flight (x, y = centre)
          starSeq }              // last star id used
player = { id, x, y, w, h, vx, vy, px, py, face, onGround, coyote, buf, walk,
           atk, atkCd, atkType: 'chop'|'sweep', combo, swing, hitSet: [ids],
           hp, alive, iframes, stun, respawn, lastHitBy, lastHitTick, score, deaths,
           keys /* previous tick's bitmask */, fx, standOn, long /* holds a long sword */,
           stars /* ninja stars carried, 0-30 */, throwCd }
```

Randomness comes from NinjaRunner's Park–Miller generator, with its seed stored in `state.rng`.
`nextRand(state)` advances it. The sim uses it to pick spawns, to make kill seeds, and to draw the
pickup countdown and point.

### API

| Function | Purpose |
|---|---|
| `createWorld({seed})` | Creates an empty world. |
| `addPlayer(state, id, {cfg, level})` → events | Inserts a player in id order and spawns it at once. |
| `removePlayer(state, id)`, `getPlayer(state, id)` | |
| `step(state, inputs, {cfg, level, rewind})` → events | One 60 Hz tick. `inputs` is `{[id]: bitmask}` or a `Map`. A missing id counts as 0. |
| `predictStep(state, id, keys, {cfg, level})` → inSpikes | Moves one player only and collides it against the others, which stay fixed. It does not advance `tick`, run combat or kill. Meant for client prediction. |
| `movePlayer(p, keys, cfg, level)` → inSpikes | The per-player NinjaRunner update: run/walk, coyote time, jump buffer, variable jump, sword timers, tile collision. |
| `resolvePlayers(players, cfg, level, fixedIds?)` | Player–player collision. |
| `slashHits(attacker, targets)` → ids | Lag-compensation helper. It tests the attacker's live sword box (`swordBoxOf`, so a holder's longer box) against supplied `{id, x, y, w?, h?}` positions. It skips the attacker and ids already in `hitSet`, and changes no state. |
| `swordBoxOf(p)` | NinjaRunner's box. With `p.long` its length is ×`LONG_REACH` (chop 18 → 28.8, sweep 22 → 35.2); height, y and the near edge (2 units inside the body on the facing side) stay, so it grows outward in the facing direction only. |
| `itemBox(it)`, `freeItemPoints(state, cfg, level)` | A pickup's body (centred on x, resting on y); the item points with no pickup (of either kind) and no living player's feet within `itemClear`. |
| `itemKind(it)`, `starBox(st)` | `'star'` or `'long'` (an item without `kind` is a long sword); a flying star's box. |
| `starAmount(it)`, `drawStarAmount(state)` | The stars a star pickup holds (`n`, or `STAR_LEGACY_N` 3 without one); a new bundle's amount, 5/10/15 with weights 6:3:2, from one RNG draw. |
| `createHistory()`, `recordHistory(hist, state)`, `positionsAt(hist, tick)` | A position ring of 200 ms (12 ticks). `positionsAt` interpolates for fractional ticks and clamps to the oldest or newest frame. |
| `killPlayer(state, id, cause)` → events | Kills a player from outside the rules (for example on disconnect). Last-hitter credit still applies. |
| `serialize`, `deserialize`, `cloneState` | JSON. |
| `swordLive`, `overlap`, `moveBody`, `inSpikes`, `nextRand` | Building blocks. |

### Order of a tick (`step`)

1. `tick++`. Players are handled in id order. A dead player counts down `respawn` and respawns at 0
   (`spawn` event, 90 ticks of iframes). A live player runs `movePlayer`.
2. Player–player collision runs over every pair `(i < j)` in id order:
   - **Head landing.** It applies when one player's previous bottom was at or above the other's
     previous top (within 1 unit) and it is falling no slower than the other. The top player is
     placed on the other's head with `onGround = true` and `standOn = id`. It rides along
     horizontally. If the head carried it into a ceiling, the lower player is held below instead.
   - **Otherwise** the players are pushed apart along x by half the overlap each, with ties broken
     by id. A push stops at walls, and the other player then takes the rest. A velocity into the
     other body is multiplied by `pushDamp`.
3. **Spikes.** A live player in a `^` cell, with its feet past the tips, dies at once.
4. **Slashes.** For every attacker whose swing is live (`3 < atk <= ATK_LEN - 2`), the step tests its
   sword box with `slashHits`. It uses the current positions, or the ones returned by
   `opts.rewind(attacker, state)`. Targets must be alive and not invulnerable. All hits are gathered
   first and then applied in id order, so simultaneous swings trade. Each hit:
   - deals chop 34 or sweep 25 damage,
   - knocks back `(3.5 * face, -3)`, or ×1.4 on a killing blow,
   - applies 10 ticks of hit-stun if the target survives,
   - adds the target to `hitSet`, so a target is hit at most once per swing,
   - records `lastHitBy` and `lastHitTick`.

While stunned, a player's movement acceleration is ×0.25, it cannot start a jump or a swing, and
gravity does not cut the knock-up short. Starting a swing clears `iframes`.

5. **Pickups** (`stepItems`). Each lying pickup, in list order, goes to the first living player in id
   order whose body overlaps it and who has no long sword (so a tie goes to the lower id and a holder
   leaves a second one where it is): `long = true`, `pickup` event. Then the spawn countdown: drawn
   (`itemMinTicks + floor(rand × (max − min + 1))`) on the first step and whenever a pickup appears, it
   counts down only while fewer than `itemMax` lie. When it is due, a point is chosen uniformly among
   `freeItemPoints`; if none is free it retries every tick without using the RNG. `item` event.

   **Ninja-star pickups** use the same list, points and rule: a star pickup goes to the first living
   player in id order who touches it and carries fewer than `starCarry` (30). It takes
   `gain = min(n, 30 − stars)`; if stars are left over the pickup stays with `n − gain` (taken from the
   next tick on, by the same rule), else it is removed. `pickup` event with `kind: 'star'`, the new
   count `stars`, `gain` and `left` (only when some stay); a player at 30 leaves it. Their own countdown
   (`starT`, `starMinTicks`–`starMaxTicks`, 5–10 s) runs while fewer than `starMax` (4) star pickups
   lie. A new star pickup draws its point, then its amount (`drawStarAmount`), then the next countdown. Each tick the long-sword countdown runs first, then the stars'.

**Ninja stars (SPEC §5.2).**
- **Throw.** In step 1, before a living player moves, a throw is due if `THROW` went 0→1 against the
  previous tick's keys, the player is not stunned, `throwCd` is 0 and it carries a star. After its move
  (`throwStar`): `stars--`, `throwCd = 15`, `iframes = 0` (ends spawn protection), `FX.THROW`, and a star
  `{x: body centre, y: top + 6, vx: ±6}` is added, `throw` event. `throwCd` counts down once a tick.
  `movePlayer` and `predictStep` never throw (the client does not predict it).
- **Flight** (`stepStars`, after the slashes, before the pickups; in throw order). The star sweeps
  `vx` along x, cut short by the first solid tile column its leading edge would enter (`isSolid`:
  planks do not stop it); there is no range limit (the side edges are solid, so every star ends). Inside the swept box (4 units tall) it hits
  the nearest living player along the flight who is not the thrower and has no `iframes` (ties go to
  the lower id): `starDmg` 20, knockback `(1.6 × dir, -1.6)` (×1.4 on a kill), `hitStun`, `lastHitBy`
  = the thrower, `hit` event with `move: 'star'`, `star` and `dir`; on 0 HP `kill(…, 'star')` credits
  the thrower (even if the thrower died meanwhile). A hit spends the star. A star stopped by a wall or
  the range ends with a `starEnd` event (`wall` true or false). Stars are not lag-compensated
  (`rewind` is never used for them).
- **Loss.** `kill()` sets `stars = 0` and reports the count in the kill event (`stars`); `spawnPlayer`
  starts with 0; a removed player takes them along. Stars already in flight keep flying.

**Long sword lost.** `kill()` clears `long` for every death cause (sword, spikes, `killPlayer`), and
`spawnPlayer` clears it too; a removed player takes it along. It is never dropped.

**Credit.** The killer scores +1. For spikes or a `killPlayer` call, the last hitter within 300 ticks
(5 s) scores. If there is no such hitter, nobody scores, but `deaths` still goes up.

### Events (the return value of `step`)

```js
{ type: 'spawn', tick, id, x, y }
{ type: 'hit',   tick, attacker, victim, move: 'chop'|'sweep', dmg, hp, x, y }
{ type: 'kill',  tick, killer /* credited id or null */, victim, move: 'chop'|'sweep'|'spikes'|<cause>,
                 seed /* uint31 from the state RNG, for identical gore everywhere */, x, y, vx, vy, face,
                 long? /* true: the killing blow was a holder's chop or sweep */,
                 held? /* true: the victim held a long sword (lost now) */ }
{ type: 'item',   tick, id /* pickup id */, kind: 'long'|'star', x, y, n? /* star: its amount */ }   // a pickup appeared
{ type: 'pickup', tick, id /* player */, item, kind, x, y, stars?, gain?, left? }
     // star pickups: the new count, the stars gained, and the stars still lying there (only if any)
{ type: 'throw',  tick, id /* thrower */, star, x, y, face, stars /* left */ }
{ type: 'hit',    tick, attacker, victim, move: 'star', star, dmg: 20, hp, x, y, dir }   // a star hit
{ type: 'starEnd', tick, star, x, y, wall }                // a star stopped by a wall (true) or its range
// kill: move 'star' for a star kill; stars? = the unthrown stars the victim lost
```

### Notes for M2

- The server calls `step(state, inputsById, {rewind})`. `rewind` can be
  `(attacker) => positionsAt(hist, tick - delayTicks(attacker))`, with `recordHistory` called after
  each step.
- Inputs are level bitmasks. Jump and slash need a 0→1 edge, so if the server repeats the last input
  when one is missing, it will not re-trigger a press.
- `player.keys` (the previous mask) is part of the state. A client resetting its own player to a
  snapshot needs it, or it should send it.
- `predictStep` runs exactly the movement code that `step` runs (a test checks they match for a lone
  player). Other players are fixed obstacles in it.
- A client may edit `cfg` (the offline debug panel does). An online client uses its room's settings
  (`net.cfg`, SPEC §17.1), which the server steps the room with, so its prediction matches.

## Protocol (SPEC §6.1)

The protocol is JSON text frames, each with a `t` field. Server limits:
- 1 KB per message (`maxPayload`, close 1009).
- 90 `input` messages/s and 10 other messages/s per connection (token buckets). Excess messages
  are dropped, and 90 drops within 3 s is a kick.
- Malformed JSON or an unknown `t` is a kick.

Client → server:

```js
{ t: 'hello', name, color /* 0-11 */, room /* SPEC §17: the room id to join; not needed with a live token */,
  token? /* resume */, resume? /* true: resume only (an automatic
  reconnect); a dead token gets the `expired` welcome below instead of a fresh join */ }
{ t: 'create', room /* the new room's name, '' = default */, name? /* the creator's player name */ }
                                        // create; the sender is its pending admin and looks at it (no join)
{ t: 'view', room /* id, or 0 = none */, name? /* our name field */, watch? /* watching */ }
                                        // the room a lobby visitor looks at (roster, snapshots, events);
                                        // re-sent for the same room when name or watch change (SPEC §17)
{ t: 'rename', name }                   // admin: rename the room (cleanRoomName)
{ t: 'admin', id } | { t: 'admin', conn } // admin: hand the role to human player `id` of the same room, or
                                        // to the lobby visitor on connection `conn` (it becomes the pending admin)
{ t: 'cfg', set: { key: value, … } } | { t: 'cfg', reset: true }
                                        // admin: the room's settings (SPEC §17.1); allowlist + range + step
                                        // (cleanSetting), else `refused` cfg/value; wrong shape: `malformed`
{ t: 'input', seq, keys }              // keys: bitmask, or an array of 1-3 masks for seq, seq+1, …
{ t: 'ping', id, ct /* client clock, echoed */ }
{ t: 'leave' }                          // give up the slot or queue place now; the socket stays as a viewer
{ t: 'chat', text }                     // SPEC §9: a chat line (rules below); a non-string text is a `malformed` kick
{ t: 'bots', d: 1|-1 } | { t: 'bots', n } // SPEC §15: one AI player more/fewer, or n in all (0..7); else a `malformed` kick;
                                        // only from the room's admin (else `refused`)
{ t: 'log', e: [{ ts, tick, cat, msg, data? }…], lost? } // SPEC §13.5: streamed debug entries (≤ 20 kept, own bucket
                                        // 6 + 1/s); a non-array e is a `malformed` kick
// hello may also carry w: the browser's word id (SPEC §13.5); an invalid one is ignored.
// The socket URL may carry it too: /ws?id=amber-otter.
```

Server → client:

```js
{ t: 'welcome', v: 3, tick, cap, colors, w /* word id, SPEC §13.5 */ } // on connect, before hello
{ t: 'welcome', v: 3, tick, cap, resumed: false, expired: true } // a `resume: true` hello came too late:
                                                               // no record; the socket stays a viewer
{ t: 'welcome', v: 3, id, token, resumed, state: 'play'|'queue', name /* maybe 'Kit#2' */, color,
  tick, queuePos, room, rname, admin /* the admin's player id */,
  players: [roster], queue: [{id, name, color, away}], cap }   // reply to hello
{ t: 'snapshot', tick, seq /* last input processed for you, -1 if none */, me? /* your full sim
  player object, only while you play */, p: [[id, x, y, vx, vy, face, hp, atk, flags, iframes, stun, fx, stars], …],
  it: [[id, x, y, kind, n?], …], st: [[id, x, y, vx, owner], …] }
     // 30 Hz; positions rounded to 0.01; flags = alive 1 | onGround 2 | sweep 4 | long sword 8;
     // it = the long-sword pickups lying in the arena (so a joiner or resumer learns them, and the
     // holders from the flags, from one snapshot); `me` carries `long` and `stars` for the local player;
     // kind 1 = ninja stars (with its amount n; absent from an older server = 3), 0 = long sword; st = the ninja stars in flight; stars = the count carried
     // fx = the FX bits OR-ed over the ticks since the last snapshot (for remote sounds)
{ t: 'event', tick, ev: [event…] }     // reliable, in order, sent as they happen
{ t: 'lobby', rooms: [{id, name, admin /* name */, n, cap, bots, q, watch}], maxRooms,
  room /* the room played in or selected, or null */, rname, admin /* player id; null while pending */,
  padmin /* the pending admin's connection id, or null */, lobby: [{c /* connection id */, name /* or null */, w? /* watching */}],
  players: [roster], queue: [...], cap, bots, botMax, mine /* we are its admin */, you /* our connection id */ }   // that room's detail (empty without one); on connect and on
                                       // any change (≤ 2/s); at once after hello, create, view, leave and a `bots` request
{ t: 'refused', what, why }            // SPEC §17: a request turned down without a kick
{ t: 'closed', room, name, why }       // the room this connection looked at closed (why: 'left' | 'empty')
{ t: 'pong', id, ct, tick, tf /* 0..1 into the current tick */ }
{ t: 'kick', reason }                  // then close with 4001 idle, 4002 malformed, 4003 unknown,
                                       // 4004 flood, 4005 protocol, 4006 bad hello, 4007 replaced, 4008 shutdown
// The heartbeat timeout is not a kick: no `kick` message, close code 4100 (`NET.timeoutClose`).
roster = { id, name, color /* 0-11, or BOT.color = 12 for a bot */, score, deaths, away /* disconnected, inside the grace period */, bot? /* true: an AI player */ }
```

Events are the sim's `spawn`, `hit`, `kill`, `item`, `pickup`, `throw` and `starEnd` (shapes above), relayed unchanged. `kill.seed` lets every client
render identical gore. There are also:

```js
{ type: 'join',  tick, id, name, color, bot? }
{ type: 'leave', tick, id, reason: 'timeout'|'kick' }
{ type: 'score', tick, id, score, deaths }   // after every kill, for the killer and the victim
{ type: 'rename', tick, id, name }           // a freed name passed to its lowest "#n" holder (SPEC §9); no
                                             // position, so released at once; net.meta and net.lobby take it
{ type: 'chat',  id, text }                  // a chat line, to the room's connections (viewers too); no position, so it is released at once
{ type: 'admin', tick, id, conn?, from, why } // SPEC §17: the admin role moved ('transfer' or 'auto' at the old admin's release);
                                             // to a lobby visitor: id null, `conn` its connection id (now the pending admin)
{ type: 'room',  tick, id, name }            // SPEC §17: the room was renamed
{ type: 'cfg',   tick, cfg, ch?, reset? }     // SPEC §17.1: the room's settings changed; cfg = the whole new
                                             // state as a diff against ROOM_DEFAULTS, ch = what this change set
```

If a player leaves within `creditTicks` of being hit, it is first killed with `move: 'leave'`, so
the hitter gets the point.

## server/server.js

- `loadConfig(vars)` reads `HOST`, `PORT`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `MAX_PER_IP`,
  `MAX_CONN`, `DEBUG_DIR`, `DEBUG_PORT`, `NET_SIM` (SPEC §10) and three more test-only knobs:
  `ITEM_SECS=min,max` (the long-sword countdown in seconds, passed to the arena as a `cfg` copy),
  `STAR_SECS=min,max` (the same for star pickups) and `ITEM_POINTS=i,j,…` (pickups of both kinds only
  at those `LEVEL.items` indexes, passed as a `level` copy). It throws on any of the four with
  `NODE_ENV=production`, and the entry point then exits 2.
- `handler` / `resolvePath` are the M1 static server for `public/` and `/shared/`: GET/HEAD only,
  traversal-safe. `POST /debug/report` goes to `server/debug.js`.
- **Upgrades** are accepted only on `/ws`. Refusals:
  - an `Origin` not in `ALLOWED_ORIGINS` gets 403,
  - over `MAX_CONN` gets 503,
  - over `MAX_PER_IP` gets 429.

  `clientIpOf` uses `X-Real-IP` only when `TRUST_PROXY` is set. Binary frames are a kick.
- Each socket becomes an arena connection `{ip, send, close}`. A client with over 256 KB buffered
  is terminated on the next send. Protocol-level pings every 2 s measure the server-side RTT
  (`conn.rtt`, smoothed), and a socket with no pong for 30 s is dropped.
- **`NET_SIM=delayMs,jitterPct`** delays every message in both directions, including the RTT
  pings, by `delayMs ± jitterPct %`, keeping order. So `120,2` gives an RTT of about 240 ms.
- `startServer(cfg)` returns `{http, wss, arena, debug, admin, events, port, adminPort, close()}`.
- Logs (stdout): listen, connect, join/promote/queue, resume, drop, timeout, leave, kick, refuse, report
  and errors. Never message bodies.

## server/arena.js

`new Arena({cfg, level, now, log, event, maxPlayers, graceMs, idleMs, heartbeatMs, maxPerIp, seed, maxRooms, roomsPerIp})`. It has no sockets: tests
drive it with fake connections and call `tick()` themselves, and `start()` runs the real loop.

**Rooms (SPEC §17).** The arena owns the connections, the protocol, the global record and token maps
(`recs`, `tokens`: ids are global and never reused) and `rooms` (id → `Room`, server/room.js, ids from 1,
never reused). `createRoom(name, creatorIp)` (seed `seed + id − 1` when the arena has a `seed`, else
random; its world starts at the arena's `tickNo`), `closeRoom(room, why)` (bots released silently with
`room.closing` set, `room-close` log and ring event, `{t:'closed'}` and a lobby to every viewer, whose
`conn.room` is cleared). `conn.room` is the room a connection looks at: members always their own room,
lobby visitors the one they selected with `view` (`setView` keeps `room.viewers` in step; the watcher count
is the viewers without a record there). Handlers:
- `onCreate`: a member or a pending admin is kicked (`protocol`); string types (`malformed`); the
  optional player name (`cleanName`, only for the default room name and the list), the create bucket
  (`take(conn, 'createBucket', …)`; a miss is a `dropped()` and `refused rate`), the room name (typed:
  `cleanRoomName`, else `refused name`; blank: `defaultRoomName` or "Room <id>"), `maxRooms` (`refused
  full`) and `roomsOfIp` (rooms whose `creatorIp` is this address, `refused ip`). Then `createRoom`,
  `setView` to it and `setPending(room, conn)`: the **pending admin** (`room.adminConn` = `conn`,
  `conn.adminOf` = room, `room.adminId` null), plus a lobby. `setView` away from that room (or
  `disconnect`) calls `pendingGone` → `room.handOn('left')`: the longest-present human
  (`setAdmin(successor, 'auto')`), else the longest-looking lobby visitor (`setAdminConn`), else the room
  closes. The creator's player name is its `conn.vname` (the name the room list shows for a pending admin).
  `join` binds a pending admin to its new record. `onLeave` of an admin who is the only human makes it the
  pending admin again (`setPending`) before releasing the record. `tick` closes a room held only by its
  pending admin after `ROOM.pendingMs` (10 min) without an admin action (`room.adminActAt`, touched by
  `adminRoom`).
- `onHello`: resume by token as before (into the record's room: `setView`, `room.promote`); otherwise
  `room` must be a positive integer (`bad hello`) of an open room (`refused join gone` + lobby).
  `join` applies the per-address record cap (all rooms), makes the record (`room.uniqueName`), sets
  `conn.rec` and the view, makes it admin if it is the room's pending admin (or when the room has no
  admin at all, which only test rooms made by `createRoom` without a creator have), `room.add`s it and
  sends the welcome plus a lobby.
- `onView`: a non-negative integer, an optional string `name` and boolean `watch` (else `malformed`);
  ignored for members; otherwise `conn.vname` (`cleanName`, null for none or a bad one) and
  `conn.vwatch` are kept (a change marks the lobby dirty); a pending admin looking away while humans
  are in its room is refused (`leave admin`); else `setView` (which stamps `conn.viewAt`); lobby at once.
- `onCfg` (SPEC §17.1): shape checks (`malformed`), the per-connection `cfgBucket` (`refused` cfg/rate
  + a flood drop), admin only (`adminRoom`, else `refused` cfg/admin), every key through `cleanSetting`
  (else `refused` cfg/value, nothing applied), then `room.applyCfg(set, reset, conn)` and its `cfg` event
  to the room's viewers; the lobby is marked dirty (its detail carries `cfg`). The join `welcome` carries
  `cfg` too. `PROTOCOL` is 5 (lobby visitors: `view` name/watch, lobby `lobby`/`padmin`/`you`, `admin` to a `conn`).
- `onRename` / `onAdmin`: type checks (`malformed`), the shared edit bucket (`editBucket`), admin only
  (`adminRoom(conn)`: the room whose `adminId` is the sender's record, or whose pending admin it is), then `cleanRoomName` (rename,
  event `{type:'room'}` to the room's viewers) or a target that is another human record of the room
  (`room.setAdmin(to, 'transfer')`, event `{type:'admin'}`), or (`conn` instead of `id`, exactly one of
  them) another connection among `room.viewers` without a record (`room.setAdminConn(to, 'transfer')`:
  its pending admin; a viewer of this room is never another room's pending admin, since looking away
  gives that up). Refusals go through `refuse(conn, what, why)`
  (a `refused-req` ring event and `{t:'refused'}`).
- `onBots`: shape check (n ≤ maxPlayers − 1), the per-connection bucket, then admin only (`refused bots
  admin` plus a lobby), then the server-wide `botBucket` across all rooms.
- `onLeave`: the admin is refused (`leave admin`) while `room.humans()` has someone else (lobby visitors
  do not count); otherwise the record is released (an admin alone stays as the pending admin), the
  connection is a lobby visitor of the room under its player name, and a lobby follows.
- `lobbyMsg(conn, cache)`: `rooms` (`room.summary()` each; a pending admin's name is its `vname`),
  `maxRooms`, the viewed room's `detail()` (`room, rname, admin, padmin, players, queue, lobby, cap, bots,
  botMax`; empty without one) and the per-connection `mine` and `you`. The coalesced broadcast
  computes the list and each room's detail once (`cache`) and sends every connection its own message.
- `tick()`: heartbeat, grace expiry and idle kicks over all records, `tickNo++`, then `room.step(now)`
  for every room (its time kept as `room.stepMs` (EMA) and `stepMax`), the lobby broadcast, input rates
  and the tick statistics (an `overrun` carries the room count). Pongs carry `tickNo`.

- **Records.** `hello` creates a record `{id, room, name, color, token, conn, state: 'play'|'queue',
  ip, inputs, lastSeq, lastKeys, lastActive, discAt, joinedAt}`. Ids count up from 1 and are never reused.
  Names are de-duplicated case-insensitively **per room** with `#2`, `#3`, and so on (`room.uniqueName`). When
  `release` frees a name, `reclaimName` gives the bare name to the record (playing, queued or away,
  human or bot) holding its lowest-numbered `#n` variant, logs `rename id= from= to=`, records a
  `rename` event in the ring and broadcasts `{type:'rename'}`; nobody else is renumbered. A drop
  inside the grace period is not a release, so it renames nobody. The token is 16 random
  bytes in hex. One address may hold at most `maxPerIp` records (the server passes `MAX_PER_IP`;
  the class default is unlimited): a new `hello` past that releases the address's oldest
  *disconnected* record (`leave` with reason `replaced`), so churning connect + hello + close
  cannot fill the slots with records waiting out their grace period.
- **Slots and queue** (per room). Up to `maxPlayers` (8) records of a room play. The rest wait in a FIFO queue and receive
  snapshots and events as spectators. When a slot frees, the first *connected* queued record is
  promoted (`join` event, then its `spawn`).
- **Heartbeat (SPEC §6.4).** Every message a connection sends (any type, even one the rate limit
  then drops) sets `conn.heardAt`. Each tick, before grace expiry, a connection (playing, queued or a
  lobby viewer) silent for `heartbeatMs` (5 s; `0`/`Infinity` turns it off, which only a caller could
  ask for) goes through `timeout(conn)`: a `timeout` log line and ring event (`player`, `silentMs`),
  `disconnect` (so a player takes the normal drop path below) and `close(4100, 'timeout')`.
- **Resume.** When a socket closes, the record keeps its slot (or queue place) for `graceMs`
  (5 s), and the sim player stays in the world, idle. A `hello` with its token within that time
  rebinds the record (`resumed: true`, same id, score kept). An open socket holding the same token
  is kicked with `replaced`. A queued record that resumes is promoted at once if a slot is free
  (it was skipped while away). After the grace period the record is released (`leave`) and the token
  stops working. A kick always releases at once. A `hello` with a dead token and `resume: true` (what
  the client sends when it reconnects by itself) gets the `expired` welcome and does not join; without
  the flag (Fight pressed in the lobby) it joins afresh as before. A player silenced by the heartbeat is
  closed 5 s after its last message and released 5 s after that, unless it resumes in between.
- **Idle kick.** A playing record with no non-zero input for `idleMs` (120 s) is kicked with
  `idle`, and the client goes back to the lobby.
- **Leave.** A `leave` message releases the record at once (`leave` event, reason `left`, token
  dead, queue promoted) and keeps the connection as a viewer; a later `hello` on it joins afresh.
  On the client, Escape (or ✕ on touch) opens the `#leave` confirm menu (`leaveMenu`, `leaveGame`
  in `game.js`): inputs are zeroed while it is open, "Stay" has the focus, and "Leave" calls
  `net.leave()` and reopens the lobby. In `?offline` it reloads to the lobby. The menu carries the room
  panel `#lvRoom` (`renderLeave`, re-run on every lobby update while open): the room name, the admin's
  rename row, the AI row (`renderBots('lv')`) and the room's humans with Make admin buttons. For an
  admin with other humans in the room Leave is disabled and the note says to make someone admin
  first; an admin alone is told it stays the admin on the room's screen. The server enforces the rule too (`refused leave admin`).
- **Inputs.** They are queued per record, at most 12, with older ones dropped. Each tick takes
  one input per playing record. If none is queued, the last keys repeat for up to 8 ticks, then 0.
  A repeat cannot re-fire a jump or slash, because those need a 0→1 edge. Every starved tick
  leaves the late inputs, when they arrive, queued one tick further behind, so the queue is also
  drained (`drainBacklog`): if it never fell below `min` over a 30-tick window, the `min - 1`
  oldest inputs are skipped (`lastSeq` moves past them), keeping one as a cushion against jitter.
  A fresh jump or slash press in a skipped input is carried into the next tick, so a one-tick tap
  survives. Without the drain, input latency ratcheted up to the worst stall seen, up to the
  12-input cap. Inputs with `seq` ≤ the highest seen are ignored.
- **Tick.** Each tick runs, in order:
  1. the heartbeat, grace expiry and idle kicks (all rooms),
  2. per room (`room.step`): input selection, `Sim.step(state, inputs, {rewind})` and `recordHistory`,
     events with `score` events added (to the room's viewers), a snapshot every 2nd tick (to the room's viewers),
  3. the coalesced `lobby` broadcast,
  4. tick-time statistics. A tick over 16.7 ms is an `overrun` event.
  Measured headless (one process, a laptop Ryzen 5 3550H): 10 rooms of 8 (an input-sending human and 7
  bots each) plus 2 watchers per room: about 0.5 ms a tick on average, p99 1.3 ms, worst 5.7 ms
  (warm-up), against the 16.7 ms budget.
- **Lag compensation.** `rewind(attacker)` returns `positionsAt(hist, tick − d)`, with
  `d = min(150 ms, interpMs 100 + attacker RTT/2)` in ticks. It uses the server-measured RTT.
- **Loop.** A `setTimeout` scheduler on a fixed 16.67 ms grid. It catches up at most 5 ticks at
  once and resets the grid if it falls more than 100 ms behind.
- **Debug views.** `adminState()` returns `{tick, uptimeS, maxRooms, rooms, tickTime, conns}`; each room
  (`room.adminView()`) has `id, name, admin {id, name}, creatorIp, ageS, bots, watchers, stepMs, stepMaxMs`,
  its players (`recView`, with `room` and `admin: true` for the admin; with `long`), the lying pickups (`items`), the
  seconds until the next may appear (`itemInS`) and its queue; connections carry `room`. `tools/debug.js
  state` prints a `long-sword pickups` line and marks holders `LONG`. For ninja stars, `adminState()`
  also has each item's `kind`, `starInS`, the stars in flight (`stars`: id, owner, x, y, vx, dist) and
  each player's `stars`; the CLI prints `star pickups` (each with its amount, `#id xN at x,y`),
  `stars in flight` and `stars=n` per player.
  `PRESS_BITS` (carried over a skipped input) includes `THROW`; the input-mask check is `KEY_MASK` (63).
  `viewByToken(token)` returns the server's view of one connection for a report (with the room). Neither contains
  a token. Log word ids and the `log` message (SPEC §13.5) are under server/logs.js below.

## server/room.js (SPEC §17)

`new Room(arena, {id, name, seed, creatorIp})`: `state` (its own sim world, tick = the arena's), `hist`,
`recs` (its records), `queue`, `bots`, `viewers` (connections getting its snapshots and events),
`adminId`, `pendingEvents`. It does what the single arena did for its world: `add(rec, by)` (into the
global `recs`/`tokens` too; a free slot via `activate` with its `join` and `spawn` events sent at once,
else the queue), `activate`, `promote`, `freeColor` (unique among this room's fighters), `uniqueName` /
`reclaimName` (per room), `addBot` / `removeBot` (`maxBots()` = 7), `roster`, `queueList`, `detail()`
(the room's part of a lobby message), `summary()` (its row in the room list), `withScores`,
`broadcastEvents` (to `viewers` only), `step(now)` (inputs, bots' keys, `Sim.step` with the rewind,
history, events, a snapshot every 2nd tick), `drainBacklog`, `snapshot()` (to `viewers` only), `recView`
and `adminView()`. Logs end in `room=<id>` and ring events carry `room`.
Settings (SPEC §17.1): `baseCfg` (frozen: `VIEW_DEFAULTS` + the arena's cfg) and `cfg` (the room's own,
a new frozen object per change, `baseCfg` itself after a reset), used by `activate`, `release` (credit),
`step` (the sim and `botKeys`); `applyCfg(set, reset, by)` returns the `cfg` event (null if nothing
changed) and logs `room-cfg`; `detail()` and `adminView()` carry `cfgDiff(cfg)`. They die with the Room.
`release(rec, reason, by)` frees the slot, name and token as before and then applies the room rules:
when the admin went, `handOn` (the connected human with the earliest `joinedAt`, then away ones; else
the lobby visitor with the earliest `viewAt`, `visitors()`, as pending admin via `setAdminConn`) and
its `admin` event go out with the leave, and with nobody to take over it calls `arena.closeRoom` (why
`left` for a leave, else `empty`); a room with no human, no pending admin and no admin also closes;
then `promote()`. A drop inside the grace period is not a release, so the admin keeps the
role until the grace runs out (or the record resumes).

## server/debug.js

- `createEventRing(2000)`: `push(type, conn, data)` adds `{n, ts, type, conn, …data}`. The arena
  and server push `connect`, `close`, `join`, `promote`, `queue`, `resume`, `resume-refused`,
  `drop`, `timeout` (heartbeat, with `player` and `silentMs`), `leave`, `kick` (with `reason`), `ratelimit`, `overrun`, `refused` (upgrade refusals,
  with `why`), `report` and `report-rejected`; for rooms (SPEC §17) also `room-create`, `room-rename`,
  `admin`, `room-close`, `bots` and `refused-req` (`what`, `why`), and every room-scoped event carries `room`.
- `validateReport(body)` returns `{report, token}`, with the token removed from the report. Rules:
  - top-level keys must be among `v, kind, reason, ts, env, net, player, entries, token, reportId, w`
    (`w`: the word id, SPEC §13.5),
  - `entries` ≤ 300,
  - strings are cut to 300 characters, line breaks become spaces, and other control characters
    (C0, DEL, C1, U+2028/2029 and the bidi controls) are removed,
  - depth ≤ 5 and ≤ 60 keys per object, plain JSON only.
- `createDebug({dir, allowedOrigins, clientIp, arena, events, keepBytes})` gives:
  - `handleReport`, which checks in this order:
    - `POST` only (405),
    - the Origin (403),
    - `application/json` (400),
    - a `Content-Length` or streamed body over 16 KiB (413),
    - 6 per minute per IP and 120 per minute in total (429),
    - validation (400).

    If the report carries a token, it is looked up with `arena.viewByToken` and then dropped.
    The stored line is `{meta: {id, received, ip, server}, report}`. `meta` sits outside the
    client's object, and a client `meta` key is a 400. `server.recentEvents` holds that player's
    last 30 ring events. The id is 8 random `[a-z0-9]` characters.

    Lines are appended to `DEBUG_DIR/reports-YYYY-MM-DD.jsonl` (UTC, mode 600). At start and then
    every 10 min, the directory is pruned to 14 days and 50 MB (`keepBytes`), oldest first, never
    touching today's file. The prune's total plus every append since is kept as a running count,
    and an append that would take it over 50 MB is refused, so today's file cannot grow past the
    cap between prunes. If a write fails or the cap is reached, the answer is 503.
  - `adminHandler` / `listenAdmin(port)`: GET-only JSON on `127.0.0.1` (hard-coded). Routes:
    `/state`, `/events?n=`, `/reports?n=` (summaries, newest first), `/reports/<id>`, and the
    streamed logs `/logs` and `/logs/<word|name|ip>` (`arena.logs`, see server/logs.js).

## server/logs.js (SPEC §13.5)

`createLogStore({now, keepMs, rand, maxIds, maxPerId, maxBytes})` (defaults: `Date.now`, 1 h, crypto,
2000, 4000, 32 MB) keeps, per word id, `{names, ips, first, seen, entries, lost, bad}` in memory
only. Each stored entry is `{at, c, size, e}`: the server's receive time, connection id, its JSON
size and the cleaned client entry (`validateEntry`: keys `ts, tick, cat, msg, data` only, finite
numbers, `cat` lower case and not `verbose`, strings through `debug.js` `clean()`), plus `r`: the room the
connection was looking at (the arena passes `room`; `find` returns it as `room`). The arena owns
one (`arena.logs`, the `logs` option) and:
- `connect` calls `assign(transport.word)` (the `/ws?id=` the server passed on; a valid list pair is
  kept, else a fresh random id, avoiding ids already held) and `touch(word, {ip})`, and sends the
  word in the connection welcome; `hello` may switch to a valid `w` and `touch`es the cleaned name;
  `disconnect` `touch`es (last seen). `connView` shows `word` and `logDropped`, so reports' server
  view and `tools/debug.js state` have it.
- `onLog` charges the connection's own bucket (`LOG.burst` 6, `LOG.perSec` 1; a miss counts in
  `conn.logDropped` and goes through `dropped()`, the flood-kick path) and calls `add(word, e[0..20],
  {ip, conn, lost})`; entries past 20 and the client's own `lost` count are added to `lost`.
- Pruning (at most every 10 s on writes, always before `list`/`find`) drops entries older than
  `keepMs` and ids with no entries not seen within it. Caps: past `maxPerId` the id's oldest go;
  a new id past `maxIds` evicts one (no entries first, then oldest seen); past `maxBytes` the
  oldest entries anywhere go, an eighth of that id's at a time.
- `list()` (newest seen first) and `find(q)` (exact word, any name case-insensitively, or any IP;
  entries oldest first with ISO `at`) serve the admin listener's `/logs` and `/logs/<q>`.

## tools/debug.js

`node tools/debug.js [--port N] state | events [n] | reports [n] | report <id> | tail | logs | log <word|name|ip>`.
`state` prints the tick line, then `rooms (n/10):` and per room a `room <id> "<name>" admin=… players=…
bots=… queue=… watchers=… creator=… age=… step avg/max` line with its players (marked `ADMIN`, `LONG`),
pickups, stars in flight and queue indented under it, then the connections (with `room=`). `log` lines show
the room as `r<id>` after the connection.
`logs` prints one line per identity (last seen, word, name, IPs, entry count, lost/refused counts);
`log <q>` prints each matching identity's header and then one line per entry: server time,
connection, client clock, tick, `[cat] msg` and the data as JSON, under an untrusted-input line. The port is
`--port` or `DEBUG_PORT`. It prints `# UNTRUSTED INPUT: …` above report listings and bodies.
Every line it prints has C0 (except newline), DEL, C1 and bidi control characters replaced with
U+FFFD, so a stored report cannot drive the terminal even if intake cleaning were bypassed.
`tail` polls every 2 s.

## public/net.js

`createNet({onLobby, onStatus})` returns `net`:

- **Rooms (SPEC §17).** `lobby` also holds `rooms`, `maxRooms`, `room`, `rname` and `admin`.
  `join(name, color, room)` and `create(name, color, rname)` set what the next `hello`/`create` sends (a
  resume sends only the token); `viewRoom(id)` sends `view` and is repeated on a new socket's connection
  welcome (`viewWant`; also kept on `leave`, cleared by `closed`) with `viewInfo` (our name field and
  whether we watch; `setViewInfo(info)` re-sends `view` when they change while we look at a room
  without being in it); `rename(name)`, `makeAdmin({id} | {conn})`, `isAdmin()`. `lobby` also holds
  `padmin`, `lobby` (the room's visitors) and `you`. `refused` (a refused join or create clears `want`) and `closed` go to the `onRefused` /
  `onClosed` callbacks; a lobby whose `room` differs from the last one resets the view (`resetView`:
  snapshots, the event queue, taken pickups, the arrival clock) and calls `onRoom`. `admin` and `room`
  events update `lobby.admin` / `lobby.padmin` / `lobby.mine` / `lobby.rname` (and the list) and call
  `onLobby`; an `admin` event naming our connection (`conn` = `you`) makes us the pending admin.
- **State.**
  - `id`, `token`, `queuePos`, `lobby`.
  - `state`: `connecting`, `open`, `reconnecting` or `kicked`.
  - `mode`: `viewer`, `play` or `queue`.
  - `meta`: id → `{name, color, score, deaths, away}`, fed by `welcome`, `lobby`, `join` and
    `score`.
  - `me`: the predicted local sim player.
  - `stats`: `rtt`, `rttAvg`, `rttMax`, `offset`, `jitter`, `reconnects`, `snaps`, the `predErr`
    ring, `snapsSnapped` and more.
- **Connection.**
  - `connect()` opens `ws(s)://<page host>/ws`, with `?id=<word>` once the browser has a word id
    (`net.word`, from `localStorage` `multisplat-id`; the connection welcome's `w` replaces and saves it,
    then `net.onWord(word)` runs; `hello` carries it as `w`). The page loads as a viewer, so the lobby is live.
  - `join(name, color)` sends `hello`, with the token if there is one.
  - On an unexpected close it reconnects with backoff (0.5 s doubling to 8 s, ±25 %), and the next
    `hello` carries the token and `resume: true`. An `expired` welcome (the 5 s window is over)
    clears the session and reports status `expired`: `game.js` reopens the lobby with "Connection lost
    for over 5 s: your slot and score were released. Press Fight to play again."
  - A kick (close code 4000–4999, except the heartbeat's 4100) clears the token and goes back to the
    lobby as a viewer. 4100 is handled as a network drop (reconnect and resume).
  - **Heartbeat.** A ping goes out on socket open and then every `NET.pingMs` (0.5 s), in every mode
    (lobby viewer, queue, play). A 1 s watchdog drops a socket that has heard nothing from the server
    for over 6 s (the server sends snapshots or lobby updates and answers every ping), even if no
    close arrived. When the tab becomes visible again it runs the watchdog, pings, and retries a
    pending reconnect at once instead of waiting out the backoff.
  - **Background tabs.** Browsers throttle a hidden tab's timers (Chrome: about once a second, and
    after about 5 minutes hidden only once a minute; phones may freeze the page outright), and
    `requestAnimationFrame` stops, so a hidden player sends no inputs (the server repeats the last
    keys for 8 ticks, then 0: Kanbei stands still and can be hit). As long as pings still get out at
    least every 5 s the player stays in the game (until the 120 s idle kick). Once they stop, the
    server closes the socket after 5 s; if the tab comes back within the next 5 s it reconnects and
    resumes with its score, otherwise it lands in the lobby with the message above.
  - `freeze(ms)` (test hook) simulates a frozen page: nothing is sent, incoming messages are lost and a
    close is only handled after `ms`.
  - `drop()` closes the socket the way a network failure would (for tests).
- **Clock sync.**
  - Pings (every 0.5 s, see above) also drive the clock. RTT avg/max are over 30 samples.
  - `offset` estimates the server tick from `pong.tick + tf + RTT/2`.
  - A second clock, the *arrival clock*, follows the early envelope of `snapshot.tick − now`.
    Late snapshots count as jitter (`stats.jitter`, an EMA in ms).
- **Prediction (§6.2).**
  - No input is produced on a socket until its player `welcome` has arrived (`seq` restarts at 1
    there). Inputs sent between the socket opening and the welcome would carry the old session's
    seq numbers, which the server, having restarted at the hello, would accept and then ignore
    every restarted seq below them as stale: the player froze after a resume.
  - `localTick(keys)` runs each 60 Hz client tick. It numbers the input (`seq`) and keeps it in
    `pending`. It runs `Sim.predictStep` on `me` against the other players' newest snapshot
    positions, which stay fixed. Then it queues the input for `flush()`, which sends at most 3
    per message.
  - On a snapshot with `me`, inputs ≤ `seq` are dropped, `me` is reset to the server's object, and
    the remaining inputs are replayed. `me.long` therefore only ever comes from the server: the
    longer swing (drawn arc, hitbox view) is predicted only after the server confirms the pickup,
    and the pickup itself is never predicted (`predictStep` runs no items).
  - The distance between the old and new prediction is the prediction error (`predErrRms()`,
    `resetPredErr()`). Under 2 units, the drawn position eases from the old one over 6 frames.
    Otherwise it snaps and logs to `sync`.
  - Physics use `net.cfg`, the room's settings (SPEC §17.1): `cfgFromDiff` of the `cfg` in the join
    welcome, every lobby message (the defaults while looking at no room) and the `cfg` event;
    `onCfg(ev)` tells the game (ev null for a welcome/lobby). `setCfg(set)` / `resetCfg()` send `cfg`.
- **Ninja stars.** `unpack` reads the count (`p[12]`, 0 if absent), `unpackItems` the kind (`it[3]`,
  long if absent) and `unpackFlying` the stars in flight (`st`, none if absent), so an older server's
  snapshots still work. `me.stars` only ever comes from the server. `localTick` plays our own throw at
  once: on a local THROW edge with stars, not stunned and off a local 15-tick cooldown, it sets
  `me.fx |= FX.THROW` (sound and arm flick) but predicts neither the star nor the count. `life` entries:
  `stars gained`, `star thrown` (from our `throw` event) and `stars lost` (our kill event's `stars`).
  `throw` events about us are released at once.
- **Interpolation (§6.3).** `view(now)` gives `{tick, players, fx, items, stars}`; `stars` (in flight)
  are interpolated between the snapshots around the render tick like remote players (a star missing
  from the later one ended in between and shows until the midpoint; past the newest, extrapolated by
  `vx` for at most 6 ticks). Snapshots are unpacked
  with `long` (flag bit 8) and `items` (from `it`; a snapshot without it, e.g. from a pre-M5 server,
  means none). `items` are those of the newest snapshot at or before the render tick, minus pickups
  we took ourselves (our `pickup` event is released at once and hides it before the timeline
  catches up; not when it says stars are `left` there).
  - Remote players are drawn at `renderTick = arrival clock − 6 ticks` (100 ms), interpolated
    between the two snapshots around it. Discrete fields switch at the midpoint. There is no
    blending across teleports (respawns) or deaths.
  - Past the newest snapshot it extrapolates with velocity for at most 6 ticks, then logs
    `sync: extrapolation ran out`.
  - `fx` lists the remote FX bits from snapshots the timeline has just passed.
  - Our own player is the predicted `me` plus the smoothing offset.
- **Events.** `dueEvents()` returns events in order once the render timeline reaches their tick.
  Events about us (we hit, are hit, spawn or pick up) and events without a position (`join`, `leave`,
  `score`) are released at once.

## public/gore.js (SPEC §7)

NinjaRunner's blood system (`blood`, `L.decals`, `L.pools`, `L.bloody`, `bleedEnemy`, `spray`,
`updateBlood`) rebuilt as a module with no DOM access. `game.js` creates one world `G =
createGore(level)`, feeds it events and calls `stepGore(G)` once per 60 Hz `update()`. The server
never runs it.

**Determinism.** Every client must draw the same spatter for a kill:
- all randomness is a Park–Miller `prng(seed)`: `kill.seed` for a kill, `hitSeed(e)` (an FNV hash of
  the hit event's tick, ids, damage, hp and position) for a hit spurt. Randomness inside a step comes
  from a generator seeded by the kill and the kill's own age, never the client's clock;
- no `Math.random` and no trig. Pieces turn as a unit vector `(c, s)` with a small-angle step and a
  `sqrt` renormalisation; the fountain's heartbeat uses `sinp` (Bhaskara's approximation). A unit
  test enforces this;
- a kill's particles and pieces collide only with the level (`tileAt`), never with each other or
  the players, so its outcome does not depend on other gore in flight or on when it started.

**API.**

| | |
|---|---|
| `createGore(level, opts?)`, `clearGore(G)` | `G = {t, parts, gibs, decals, pools: Map, bloody: Map, kills: Map, newDecals, newPools, dirty, stats, onCap}` |
| `goreHit(G, e, dir)` | a spurt of 16–25 drops from the victim's centre along `dir` (±1; game.js passes the side the attacker is on, as it sees it) |
| `goreKill(G, e, {meta})` | cuts the body up, launches the pieces, 240 drops of radial spatter (320 on spikes), starts the fountains. `meta` (the victim's colour) rides on the pieces |
| `stepGore(G)` | one tick: pieces, then drops, then the decal cap, and every 64 ticks expiry |
| `fingerprint(G, key)`, `settled(G, key)`, `killKey(e)` | key = `tick:victim`. The fingerprint is `count:hash`, where the hash is a commutative sum over every landing (decal or pool, position and colour) plus each piece's position at age 180 ticks |
| `fadeOf(G, t)` | 1 → 0 over the last 2 s of the 15 s life (`BLOOD_TTL_TICKS` = 900) |

**Pieces** (Kanbei's local space, clip polygons with a centroid, a cut face with an outward normal and
a collision radius):
- `chop`: a vertical split, slanted by the seed. Left and right halves `L`/`R`, the hood cap `H`
  (everything above the headband) and the sword `S`;
- `sweep`: a horizontal split at the waist, `T`/`B`, plus `H` and `S`;
- `spikes`: like a sweep, but `B` stays impaled (pinned) and `T` and `H` are thrown up;
- `leave` (killed for leaving): the body bursts into quarters `Q0`–`Q3`, plus `H` and `S`.

Pieces fall with gravity 0.3, bounce off floors (0.32), walls and ceilings, slide to rest with
friction, land on planks from above and get impaled on spikes (staining them). While they fly they
trail drops. Halves (and the hood, briefly) pump a pulsing fountain from the cut face for 80 ticks
(NinjaRunner's `FOUNTAIN_T`), turned with the piece. Pieces lie for 12 s, then fade over 1 s.

**Drops** follow NinjaRunner's `updateBlood` (gravity 0.2, max fall 5) but tell hits apart:
- a wall or block side: a decal on the face, sometimes with a drip running down;
- landing on a top surface with open air above: a pool (`h` grows up to 4 and spreads ±3 units);
- a ceiling or underside: a decal, often with a hanging drip;
- spikes: a decal, and the spike tile is stained (`G.bloody`).

**Persistence and caps** (`GORE`): decals, pools and stains live 15 s = `BLOOD_TTL_TICKS` = 900 gore ticks from creation, per entry (fading over the last 2 s; a pool column's clock starts when the column is created).
Decals are capped at 6000, oldest first; drops at 4000 (new ones are skipped); pieces at 64 (oldest
dropped). `onCap(what, n)` reports a cap; `stats` counts evictions and skips. A late joiner starts
with an empty world (it only sees later events).

## public/music.js (SPEC §8)

An original score: **156 BPM, E minor**, 8 bars (12.31 s): Em Em C D Em Em C B, with D# over the
B. NinjaRunner's palette (detuned saws through low-passes, its sine "neon bell", a convolution
reverb), made aggressive.

- `scoreEvents(layer)` is the arrangement as data (`{t, v, m, d, g}`):
  - `base`: a 16th-note bass ostinato (two detuned saws and a square sub, plucked low-pass; bars
    4 and 8 run fills; notes outside the key move up a semitone), four-on-the-floor kick (sine
    sweep with a click), snare on 2 and 4 with a roll into the loop, offbeat 8th hats, a stabbing
    3-saw lead riff (each bar different; bars 5–8 vary 1–4), a quiet saw pad and neon bells;
  - `intensity`: 16th hats, claps, ghost kicks, a crash on bars 1 and 5, tom fills, a noise riser
    into the loop and the riff an octave up through an open filter.
- `renderLoop(layer, sr)` renders one layer in an `OfflineAudioContext` with 2 s of tail and folds
  the tail back onto the start, so the loop is seamless (reverb and releases carry over the seam).
  It records the main-thread graph-build time.
- `analyze(x, sr)` measures peak, RMS, the jump at the seam (and, for scale, the largest step around
  the bar-5 downbeat), the tempo (autocorrelation of the low-band onset envelope) and brightness
  (mean squared first difference over mean square).
- `createMusic({ac, out, lite, log})` starts after a user gesture (`initAudio`), yields, then
  renders both layers in parallel off the main thread (22.05 kHz with `LITE_AUDIO`, else up to
  44.1 kHz) and scales both by one gain so base + intensity peaks at 0.9. The two buffers start at
  the same time and loop in sync: `base → low-pass (3.5 kHz at rest) → vol`, `intensity → gain (0) →
  vol`, `vol → MASTER`. `intensity()` (called on every kill) fades the layer in and opens the
  low-pass to 18 kHz, holds 6.5 s, then both decay with a 0.9 s time constant (≈ 8–10 s in all).
  `target` (CFG.musicVol) and `muted` set `vol`. Logs (`audio`): pre-render time / build time / rate /
  lite or full, failure, intensity up and decaying.



- `dbg(cat, msg, data)` appends `{ts, tick, cat, msg, data}` to a 300-entry ring. The categories
  are `net`, `sync`, `perf`, `audio`, `input`, `life` and `error`.
- `dbgv` logs only with `?debug=1`. Verbose mode records every snapshot and correction and also
  echoes them to `console.debug`.
- The game registers `setTickSource` and `setReportSource` (env, net stats, player state, token).
- `buildReport` drops the oldest entries to stay ≤ 16000 bytes.
- `sendReport(kind, reason)` POSTs the report and resolves to the report id. `auto` reports are
  limited to one per 60 s and five per page.
- `installErrorHandlers` logs `error`/`unhandledrejection` (and sends an auto report) and tab
  visibility.
- **Streaming (SPEC §13.5).** `dbg` also queues each entry (not `verbose`; `sync rtt` and `perf slow
  frame` thinned by `LOG.thin`) for the server, at most `LOG.queueMax` (200; older ones are counted in
  `lost`). `flushLog()` runs every `LOG.flushMs` (4 s), on `pagehide` and when the tab is hidden: up
  to `LOG.perFlush` (3) `{t:'log', e, lost?}` messages of ≤ 1000 bytes and ≤ 20 entries, through the
  sink `net.js` registers with `setLogSink` (it sends on the open game socket, or returns false and
  the entries wait). `setWordId` sets the word id that reports carry as `w`.

Automatic reports are sent on an uncaught error, a kick, a refused resume, and after a reconnect
that followed a drop.

## public/game.js

The default page is **online**. `?offline` runs the M1 sandbox: a local sim, the dummy (id 2) and
editable physics.

- **Ported from NinjaRunner:**
  - the drawing helpers (`mk`, `rng`, `NEON`, `rrect`, `oval`, `line`, `shade`),
  - the vector tiles (`tileCanvas`, `drawSpikes`, `buildTiles`),
  - the night city (`paintSky`, `cityLayer`, `buildCity`, `RAIN`, `CARS`, `drawCars`, `STARS`),
  - `resize` (device resolution, dpr capped at 2.5, phones held upright rotated to landscape),
  - `blitTile` and the background/tile/rain parts of `render`,
  - `drawPip` (here `drawKanbei`), `drawTails`, `drawSword` and the `iframes` flashing,
  - the audio (`initAudio`, `audioOut`, `tone`, `noise`, `sfx`, `LITE_AUDIO`),
  - the debug panel (`DBG_SPEC` = `SETTINGS` + offline game speed, `buildDebug`, `toggleDebug`, `saveCfg`).
    Online it is the room's settings panel for the admin only (`panelOk()` = `net.isAdmin()`;
    `syncPanel()` on every lobby update and room change closes it and hides the help line's D hint
    (`#helpD`) otherwise). Sliders send on `change`, checkboxes at once (`panelSet`); the echo (`cfg`
    event) reaches `onRoomCfg`, which copies gore/realGore into `roomView` (`viewCfg()`, `goreOn()`),
    repaints if the blood style changed, rebuilds an open panel and adds a quiet `.sys` line to the chat
    list (`sysLine`). Hitboxes (drawn online only while admin) and music volume stay in `CFG`.
- **Ninja stars (§5.2).**
  - `drawStarItem`: a star pickup is a spinning four-pointed neon shuriken (`shuriken()`, white-pink
    with a magenta glow and a hole) hovering over a magenta light pool, inside a turning dashed violet
    ring, with its amount (`+5`, `+10`, `+15`, from `Sim.starAmount`) above it in the status bar's
    yellow-on-violet: unlike the long sword's upright cyan blade. A bigger bundle's shuriken is a
    little bigger and brighter.
  - `drawFlyingStar`: a star in flight spins fast with a short magenta trail behind it; drawn from
    `state.stars` (online the interpolated view, offline the sim state), after the players.
  - `drawThrowFlick`: for 8 ticks after `FX.THROW` (ours at once from `localTick`, others from the
    snapshot FX bit, offline from the sim) an arm swing and a small star leave the hand.
  - `drawThrowHint`: "X to throw" (on touch "✦ to throw") floats above our own Kanbei for 4 s after
    we take a star pickup (`__mp.throwHint` reads it).
  - The status bar shows `★ n` (`#hStars`, next to HP, the server's count), flashing on a pickup.
  - SFX: `sfx.throw` (airy whip and whistle), `sfx.starHit` (metallic tick and thud), `sfx.starPickup`
    (three bright clinks), `sfx.starWall` (a ting, with a small spark burst where it struck).
  - The kill feed shows `A ✦ B` (pink glow) for a star kill. Gore: a star hit spurts along the star's
    flight (`e.dir`); a star kill is cut like a sweep (gore.js maps `star` to the sweep pieces), so it is
    seeded and identical everywhere like the rest.
  - Debug: the hitbox view adds star-pickup boxes (pink) and flying stars' boxes (white).
- **Long swords (§5.1).**
  - `drawItem` draws a pickup: a cyan blade standing point-up over a light pool, with a halo, slowly
    bobbing and tilting, its glow pulsing and a glint running up the blade. Pickups are drawn before
    the players, from `state.items` (online: the view; offline: the sim state).
  - Kanbei still holds no sword between swings. `drawKanbei` draws a holder's scabbard with
    `drawLongScabbard`: the same line over the back but ×1.6 long (the gold hilt rides well above the
    head, the tip past the heel), lacquered dark blue with a pulsing cyan glow and seam: the holder
    marker (there is no name-tag icon).
  - `drawSword` with `P.long` adds the hitbox's extra length (`18 or 22 × 0.6`) to the blade and to
    the trail's radius, so the blade ends about where the longer box does (a few units short at full
    stretch, as the standard blade is), with a thicker, brighter trail with a white core.
  - SFX: `sfx.pickup(v)` (a bright noise sweep plus a rising triangle arpeggio) at full volume for
    the taker, quieter with distance within 160 units; `sfx.item(v)` (a soft sine shimmer) when one
    appears within 240 units.
  - The kill feed shows `A ⚔ B` (glowing cyan) for a kill with `kill.long`.
  - Gore: for a kill with `kill.held`, the new `S` piece gets `g.long` and is drawn 1.6× long. Only the
    drawing changes, so gore physics and fingerprints stay the same on every page.
  - Debug: `life` entries `long sword taken` and `long sword lost` (online in net.js, offline in
    game.js); the hitbox view adds item points (cyan diamonds) and the pickups' boxes; the sword box
    shown is the real (longer) one.
- **Per-player colour.** `drawKanbei(P, x, y, face, opt, col)` tints the headband, belt, knot, tails
  and rim glow. Online, `colorOf(id)` is the player's chosen colour. Offline, the local player is
  pink and the dummy orange.
- **Input.**
  - Keyboard: arrows to move, Up or Z to jump, Shift to run, Space to slash, **X to throw a ninja
    star** (X no longer runs), Tab for the scoreboard, D for the debug panel, M to mute. The help line
    and the lobby footer say so.
  - Touch (NinjaRunner's `TOUCH_BTN`, `btnAt`, `fingerOn`, `syncTouch`): ◀ ▶ bottom left, » ✦ ⚔ ⤒
    (✦ = `tT`, throw, `THROW_SYMBOL`)
    bottom right, plus a small ♪ (mute) and ? ✕ bar (full screen is the corner button). Every finger is tracked by pointer
    id and can slide between buttons; jump and slash presses are latched like keys. **Run is the »
    toggle** (as in NinjaRunner), so one thumb stays on ◀ ▶ and the other on ⤒ ⚔. The bits are OR-ed
    into the tick mask (`touchBits()`) and log `device touch`. `TOUCH_UI` is on when `pointer: coarse`
    (or `?touch`) at load, and also switches on at the first real touch (`enableTouchUI`, a capturing
    `pointerdown` with `pointerType` touch, or `touchstart`), for tablets with a mouse, Android "desktop
    site" and browsers that report a fine pointer; it only adds buttons, keys and gamepad still work.
    The buttons hide while the lobby is open and live in `#stage`, so they turn with it (in the rotated
    portrait stage the safe-area insets are swapped: the screen's top is the game's left). The ♪ ? ✕ bar
    is 46 px, the full-screen button has a 52x46 hit area, and audio is also unlocked from `touchend` and
    `click` (iOS Safari). No zoom: `touch-action: none` on html/body and the overlays (`pan-y` on the
    lobby and the how-to box, `manipulation` on the name field, which is 16 px so iOS does not zoom on
    focus), `preventDefault()` on `gesture*` events and on multi-finger `touchmove` (both
    `{ passive: false }`; pointer events are unaffected, so two fingers on two buttons are two presses),
    plus the viewport meta (`maximum-scale=1`, which iOS Safari ignores). `test/multiclient.js` `phoneTest` drives all of this with real CDP touches
    in portrait, landscape and a fine-pointer context.
    Fight calls `goLandscape()` (full screen + orientation lock where allowed), as NinjaRunner's
    start does; a phone held upright still gets the rotated stage.
  - Gamepad: stick or d-pad to move, A or d-pad up to jump, X or B to slash, Y to throw, bumpers or
    triggers to run.

  The client builds one bitmask per tick. A press that starts and ends between ticks is latched
  for one tick. Device changes are logged (`input`), keystrokes never.
- **Loop.** A fixed 60 Hz accumulator runs `update()`.
  - Online, `updateOnline()` samples keys (or `__mp.input[id]` / `__mp.autopilot`), calls
    `net.localTick`, plays our own FX and feeds `net.dueEvents()` to `onEvents`.
  - Each frame then calls `net.flush()`, sets `state = net.view()`, plays remote FX and renders.
    `render()` draws the same `state.players` shape online and offline.
  - Offline, `updateOffline()` steps the sim with the dummy, as in M1.
- **`onEvents`** turns events into effects:
  - `hit`: SFX, a damage popup, a small shake if it involves us, and (with `CFG.gore`) `goreHit`;
  - `kill`: a kill-feed entry, `music.intensity()`, a shake for a camera focus within 120 units,
    and with `CFG.gore` `goreKill` (the body is not drawn whole any more) plus gush/impale/die SFX.
    With gore off it falls back to M1's flipped falling corpse;
  - `spawn`: our own spawn snaps the camera.
- **Gore drawing.**
  - Decals and pools are painted into one offscreen canvas covering the arena (`GL`, at
    `min(SCALE, 3)` device pixels per unit, 2 with `LITE_AUDIO`), and each frame draws only the
    visible part with one `drawImage`. New blood is painted in as it lands (`G.newDecals`,
    `G.newPools`). The layer is rebuilt from scratch (batched by colour and 10 fade steps) when a cap
    or expiry removed blood (at most once a second) or every 3 s while anything is fading.
  - Pieces (`drawGib`) are Kanbei clipped to the piece's polygon, turned by `(c, s)`, with a dark
    crimson cut face and a wet highlight, drawn without shadow blur (dozens of blurred shadows were
    too slow). The sword is drawn on its own.
  - Flying drops use the `'lighter'` blend, batched per colour. Stained spikes use `TILE.spikeBloody`.
  - **Two blood styles** (`BLOOD_STYLES`, SPEC §7). gore.js stores a colour index 0–5 with every
    drop, decal and pool (drawn from the kill's seeded RNG, as before), and the style maps the index to
    a colour: `BLOOD` (drops, decals, spike stains and the sword tip) and `POOL` (pools) are the
    current style's palettes, `BSTYLE` holds them plus the layer's blend and the gib cut-face colours.
    - **neon** (the default): NinjaRunner's `NEON_LIST` for drops and decals, dimmer neon for pools,
      and the baked layer drawn with `'lighter'` (alpha .85), so all blood glows; pink cut faces;
    - **real gore** (`CFG.realGore`): the reds (arterial to dark crimson, darker pools), the layer
      drawn normally (alpha .96); flying drops still use `'lighter'`, which keeps stacked red red.

    The choice is the debug panel's "Real gore" checkbox: offline saved with the other client
    settings in `localStorage` (`multisplat-cfg`); online a room setting (SPEC §17.1) set by the admin. `applyBloodStyle()` switches the palettes and
    rebuilds the baked layer (and the stained-spike tile), so blood already on the arena is repainted.
    The style never reaches gore.js, so the particles, decals, pools and fingerprints are the same in
    both. `__mp.gore.style` / `setStyle('neon'|'real')` read and set it (online `setStyle` is a page-local
    test override, not saved or sent); reports' `env.gore.style`
    carries it. Player colours still tint headbands and glows.
- **Music.** `initAudio` (on the first key, pointer or Fight) creates `music` unless `?nomusic`.
  M toggles `muted`, which silences both the SFX and the music. A hidden tab suspends the context.
- **Lobby (§9, rooms §17).** An overlay over the live arena of the viewed room (none: empty), with two
  screens chosen by `net.lobby.room` in `renderLobby` (no explanatory text and no controls help on either):
  - `#scrRooms` (no room viewed): the logo, the room list `#lRoomList` (a big button per room: name,
    `★ admin`, `n/cap`; a click sends `viewRoom`; "No rooms yet — create one below." when empty; kept
    current behind the room screen too), and Create a room (`#lRoomName`, `#lCreate` → `createRoom()`:
    `cleanRoomName` or blank, then `net.create(rname, remembered name)`; disabled with `#lCreateNote` at
    `maxRooms`). The server answers with a lobby for the new room with `mine`, which opens its screen.
  - `#scrRoom` (a room viewed, or our own): `#lBack` "← Rooms" (`backToRooms()`: `viewRoom(0)`, viewers
    only; refused locally and by the server for an admin with other humans in the room) and
    `#lRoomTitle`; the name field (`cleanName`) and 12 swatches (those worn in the room greyed); **Fight**
    (`fight()`: joins the room, its pending admin included; for a member just closes the lobby) and
    Watch with its line; the info line; the admin's rename row (`#lRenameIn`, `#lRenameBtn` →
    `renameRoom`) and AI row (`renderBots('l')`: − / + for the admin, else the count read-only, no row at
    0); the live player list with scores and the queue (`rosterRow`: an ADMIN tag, and for the admin a
    small `button.mkadm` "Make admin" next to every other human); under them `#lVisBox` "In the lobby"
    (`renderVisitors`: the room's visitors, 👁 for watchers, "(no name)", ADMIN for the pending admin, a
    `button.mkadm` with `data-conn` for the admin; hidden while nobody but us is there; the Esc menu has
    the same list, `#lvVisitors`). The name field's value goes to `net.setViewInfo` (700 ms after typing
    stops), `watchUi` sends the watch flag. Lists with buttons are rebuilt only when
    their content changes (`sameList`), so a lobby update between press and release cannot swallow a click,
  - `#lErr` (notices, both screens), and the footer: How to play and the word id (`#lId`,
    ` · id: amber-otter`, set from `net.onWord`; SPEC §13.5).
  - On a short screen (`max-height: 460px`) the card tightens and the room screen drops the logo, so FIGHT
    stays in view on a phone on its side; the room list scrolls inside itself so CREATE does too.

  Admin rights on the page are `net.isAdmin()` = `net.lobby.mine` (from the server's lobby, the welcome,
  and the `admin` event).
  The name and colour are saved in `localStorage` (`multisplat-name`, `multisplat-color`).
  After a kick the lobby comes back and shows the reason. `onRefused` maps `refused` reasons to text
  (`REFUSED`) in `#lErr` and the Esc menu's `#lvErr` (a refused join reopens the lobby); `onRoomClosed`
  sends a watcher back to the lobby with "The room "…" has closed."; `clearRoomView` (net `onRoom`)
  clears gore, corpses, the feed and chat when the viewed room changes.
- **Admin transfer dialog** (`#adm`, `admDialog(target)`): every Make admin tap opens "Make <name> the
  admin of <room>? You will lose admin." with Cancel focused (Enter on it cancels; Esc or a tap outside
  cancels too; the keydown handler hands the keyboard to the dialog) and Confirm, which sends
  `net.makeAdmin(target)` (`{id}` for a player, `{conn}` for a lobby visitor). 44 px buttons, above every other overlay.
- **HUD.** `hudOnline` shows HP and score, a respawn countdown while dead, `ARENA FULL · QUEUE #n`
  with "you are #n of m waiting" under it while queued, and `RECONNECTING…`. Name tags
  (`drawNameTag`, `(away)` during a grace period) and HP bars float over every player.
  `hudCommon` (both modes):
  - the kill feed: `A ✂ B` in the players' colours, `▲ B (spikes)` (only on a level with spikes;
    the shipped arena has none, so spike drawing and stains never show) / `✕ B (left)` without a
    killer, last 5, held 5 s then faded over 1.5 s;
  - the scoreboard while Tab is held: every player by kills, with deaths and the queue length;
  - **the score strip** (`#strip`, `stripRows`): every player in the arena as a chip (colour dot,
    name, score), ordered by score (then fewer deaths, then id), our own chip highlighted (cyan) and
    away players dimmed. It sits across the top of `#stage` (the whole screen, so on a wide phone it
    also uses the bars beside the arena) and shows whenever the lobby is closed, on desktop and touch,
    online and offline. Chips share the width equally up to 13em each, and names ellipsize, so 12
    fit at 960×576 and 844×390. Names go in with `textContent` (`span()`). The standings are checked
    every 100 ms and the strip is rebuilt only when the key (ids, names, colours, scores, order, away,
    our id) changed (`__mp.strip.builds` counts rebuilds). It replaced the phones' top-3 widget.
  - the top of the screen is laid out with CSS variables on `#stage`: `--sh` (strip height), `--hf`
    (status bar font) and `--top` (below the status bar). The status bar `#hud` (HP left, score right)
    sits under the strip, and the kill feed (desktop) and the touch `#tbar` start at `--top`; on touch
    the feed sits above the buttons.

  The lobby's info line turns pink when the arena is full ("you will be #n in the queue"), and a
  numbered queue list marks our own place.
- **Debug panel (D).** In both modes: the FPS line with gore counts and the gore step / render
  times, the **Gore** toggle (`CFG.gore`, on by default), **Real gore** (`CFG.realGore`, off: neon
  blood), and a **Music volume** slider
  (`CFG.musicVol`, 0.5) with the music's state. Online it adds:
  - RTT (current/avg/max) and snapshot jitter,
  - prediction-error RMS, the snap count and reconnects,
  - a 6 s prediction-error graph, with a red line at 2 units,
  - **Send debug report**, which shows the id.

  The physics and combat sliders are disabled online, because the server's values rule. Only
  hitboxes, gore and the music volume can be changed online.
- **Debug entries.** `perf`: `gore: kill` (counts and ms), `gore: <particles|gibs|decals> cap
  reached` (at most every 10 s each), `gore: decal layer rebuilt` (when over 8 ms, and every 50th),
  `gore: slow render` (a frame over 30 ms with heavy gore), `gore: on/off`, and the 5 s FPS sample
  now carries render and gore times. `audio`: context created/state, `music pre-rendered` (ms,
  build ms, rate, lite), `music pre-render failed`, `music intensity up/decaying`, `muted`. Reports'
  `env` carry `music` and `gore` summaries.
  Hitboxes work in both modes. Offline it is M1's panel, with the dummy switches and Restart.
- **`window.__mp`** exposes:
  - `state` (the drawn state), `sim`, `cfg`, `level`, `localId`, `online`, `net`, `lobbyOpen`,
    `fight()`,
  - `debug` (`entries()`, `send(kind, reason)`),
  - `autopilot`: a function `(me, players) → keys` called each tick,
  - `events` (the last 200 events processed), `input`, `fps`,
  - `gore` (`G`, `fingerprint(key)`, `settled(key)`, `keys()`, `counts`), `feed` (the feed's text),
    `perf` (`renderMs`, `goreMs`, `fps`), `music`, `analyzeLoop`, `startAudio`, and `inject(events)`,
    which runs made-up events through `onEvents` (for offline gore and load checks),
  - offline only: `pause()`, `resume()`, `step(n)` and `reset()`.

## Tests

`npm test` runs `node --test test/*.test.js` and then `node test/hygiene.js`.

- `sim.test.js`:
  - determinism (6 players, 3000 random ticks, a mid-run join and leave; serialized state and events
    compared; and resuming from a deserialized state),
  - purity of `shared/`,
  - movement (run, variable jump, buffer, coyote),
  - collision (symmetric push, no pass-through, wall, head-standing and riding),
  - combat (chop, sweep, per-swing once, stun, kill, score, respawn, spawn invulnerability, trades),
  - spike credit (none, recent hitter, expired), on `SPIKE_LEVEL`,
  - `slashHits` and rewound `step`, history interpolation,
  - `predictStep` matching `step`.
- `gore.test.js`: no DOM, `Math.random` or trig in the source; same seed → identical drops,
  pieces, decals, pools and fingerprint for chop, sweep, spikes and leave; different seeds differ;
  the right pieces per move and the impaled half; a kill's fingerprint is the same with other gore
  in flight and a different gore clock; hit spurts seeded from the event; caps (decals oldest first,
  drops, pieces, `onCap`); fade and expiry; `prng`/`sinp`.
- `music.test.js`: 150–160 BPM and a 4–8 bar loop; 16th bass, four-on-the-floor kick, snare on 2
  and 4, offbeat hats; every pitched note in E minor (D# only over B); the riff varies; the
  intensity layer's extra percussion; `analyze` on a synthetic click loop (tempo, seam).
- `level.test.js`: size and tile codes, closed border, 3–4 tiers plus the low floor block, **no
  spikes**, ≥10 spawns with footing, `pickSpawn` distance and weighting, and the item points (≥6,
  every surface level, footing, headroom, walkable from a spawn).
- `spikelevel.js` (a helper, not a test): `SPIKE_LEVEL`, the arena with spike strips, used by the
  spike tests in `sim.test.js`, `items.test.js` and `gore.test.js`.
- `stars.test.js` (SPEC §5.2): spawn cadence 5–10 s and max 4 (30 seeds), points shared with long
  swords both ways, bundles of 5/10/15 at 6:3:2 (statistically, over many seeded draws and real
  spawns), the cap of 30 (a full player leaving it, a part-full one taking what fits and leaving the
  rest), a legacy pickup without `n` giving 3, the snapshot packing and `net.js` unpacking of the
  amount, edge trigger and the 15-tick
  cooldown, no throw without stars or in hit-stun, throwing ending spawn protection, 6 units a tick
  from hand height and gone after 240, stopped by a block but not a plank, first player only, never the
  thrower (point blank), invulnerable and dead players passed through, no rewind, 20 damage with its
  knockback and stun, kill credit (also after the thrower died) and `move: 'star'`, loss on death and
  leave, determinism with stars in flight (and resuming mid-flight), `predictStep` ignoring the bit.
- `items.test.js` (ninja-star pickups switched off with `starMax: 0`): the spawn window (40 seeds, gaps within 20–40 s and spread over it) and the max-2
  rule; the countdown holding while full; free-point selection away from players and pickups (and
  retrying when none is free); determinism with pickups (6 players, serialized state and events, and
  resuming from a deserialized state); pickup on contact, the lower-id tie, a holder leaving a second
  one, dead players; reach (a target just past standard reach is hit only by a holder, chop and sweep,
  both facings), the box anchoring, unchanged damage, knockback and timing; `slashHits` and a rewound
  `step` using the longer box; loss on a sword kill, spikes and leave, standard reach after respawn,
  and the `long`/`held` kill flags.
- `server.test.js`: traversal, MIME types, HEAD, 404, 405.
- `logs.test.js` (SPEC §13.5; fake clocks): the word list and exact id validation; ids assigned on
  connect, a valid offered one kept (URL and `hello`), bad ones replaced or ignored; the typed name
  and the server's IP tagged (a payload `ip` ignored); `log` entries stored with server metadata,
  forged keys, `verbose` and junk refused and counted, strings cleaned, the 20-entry cap and `lost`,
  a non-array `e` kicked; the 6 + 1/s bucket and the flood kick; one-hour pruning of entries and
  ids; the per-id, id-count and byte caps; `/logs` and `/logs/<word|name|ip>` on the admin
  handler; `w` in reports and the server view.
- `roomcfg.test.js` (SPEC §17.1): the shared table (allowlist, range, step grid, defaults valid),
  admin-only changes (pending and playing; refused for a member, a watcher and a former admin), unknown
  key / bad value refused as a whole, malformed shapes kicked, the rate limit, `cfg` in the welcome, the
  lobby and the event to members and watchers only, reset, a change moving that room's players and not
  another's, settings dying with the room, a server started with its own cfg, the bots' route table
  following movement changes only, determinism with a non-default cfg, and `public/net.js` run in Node
  (a module hook for its `/shared/` imports, a fake WebSocket into an in-process Arena) predicting a jump
  with the room's settings.
- `rooms.test.js` (SPEC §17; no sockets, fake clock): protocol 4 and the empty list, create (admin,
  default and cleaned names, refusals), the room-name rule, 10 rooms / 2 per address / the create
  bucket, one room per connection, hello needs a room and `view`, 8 slots and a queue per room,
  isolation of snapshots, events and chat, per-room names and colours (and a freed name passed on in its
  room only), admin transfer validation and its event, the admin's leave rule and a sole admin closing
  the room, the grace-expiry hand-over (a resume inside the grace keeps it; connected humans first), a
  room closing at its last human's grace expiry or kick with its bots, rename (admin only, validated,
  rate-limited), and `adminState`, ring events, log lines and streamed log entries with room ids.
- The older socket-less suites (`arena`, `bots`, `spectate`, `stars`, `logs`) send a bare `hello`;
  `withRoom` in `test/lib.js` gives it the newest room's id (making a room "Test" when none is open,
  whose first human becomes its admin) and `roomOf(arena)` is that room. Tests that leave as the admin
  hand the role on first; lobby viewers `view` the room. `bots.test.js` checks the admin-only rule,
  7 bots in 8 slots and the server-wide budget across 10 rooms.
- `arena.test.js` (no sockets, fake clock):
  - welcome/hello/join/spawn/snapshot,
  - name validation and `#2`,
  - kicks for malformed, unknown, protocol and bad hello,
  - per-tick input consumption, batches and stale seqs,
  - input repeat then zero,
  - slots, queue and promotion,
  - resume inside (4 s) and after (6 s) the 5 s grace period, and `replaced`,
  - the heartbeat: a silent viewer closed with 4100 and no kick message, any message counting and a
    silent queued spectator closed, a silent player dropped (record kept, away) then released 5 s
    later with `leave`/`timeout`, a pinging idle player kept for 60 s, a timed-out player resuming at
    4 s and refused (`expired`, no join) at 6 s, and a manual join with the dead token joining afresh.
    The harness keeps the heartbeat on: each fake connection pings every 0.5 s of fake time as the
    clock advances (in steps of at most 0.5 s), unless the test makes it `silent`,
  - idle kick, input flood,
  - lag-compensated hits through rewound history, and with a long sword (hit only by a holder),
  - ninja stars: the throw bit accepted and bit 64 kicked, the count per player (`p[12]`, `me.stars`),
    pickups with their kind, stars in flight in `st`, the THROW FX bit, `throw` and star `hit` events
    on every connection, admin state,
  - long swords: `item`/`pickup` relayed to players and viewers, `it` and the flag bit in snapshots,
    `me.long`, a mid-game joiner's first snapshot, admin state, the flag gone after death,
  - leave credit and `score` events,
  - `viewByToken` / admin state without tokens,
  - `loadConfig` (defaults, `NET_SIM`, `ITEM_SECS`, `STAR_SECS` and `ITEM_POINTS` refused in production),
  - report validation,
  - the admin listener's loopback bind and read-only routes.

Slower tests, run on their own (each starts its own server on a spare port, never 3008/3009):

- `npm run test:abuse` (`test/abuse.js`) runs against a real server process with `TRUST_PROXY`,
  so each case can use its own `X-Real-IP`. It checks:
  - a message over 1 KB (1009),
  - a bad or missing Origin and a wrong path,
  - an input flood (kick 4004) against a steady 60/s (fine),
  - `MAX_PER_IP`,
  - malformed, unknown, binary and bad hello,
  - client-set ids and scores ignored,
  - reports: stored with server metadata, 413, 403, forged metadata keys 400, wrong type/method,
    flood 429, token view and the token never stored,
  - the event ring contents, no bodies in the logs,
  - `NET_SIM`, `ITEM_SECS`, `STAR_SECS` and `ITEM_POINTS` refused in production,
  - `test/smoke.js` against the server.
- `npm run test:multi` (`test/multiclient.js`) uses headless Chromium through playwright-core.
  Chromium comes from `PLAYWRIGHT_CHROMIUM`, playwright's own lookup, or the newest build in its
  cache. The test:
  - (`roomSettingsTest`, SPEC §17.1) checks a non-admin's D opens nothing and shows no D hint, the
    admin's panel turning gore off on every page of its room but not another room, a slider and Reset
    reaching the others' `net.cfg`, and an admin hand-over closing the old admin's panel;
  - joins 3 players (Ash, Bea, Cy),
  - drives Ash and Bea with `test/bot.js` (down to the floor, jump the low centre block, meet on the
    left half, slash) until
    one kills the other; Cy parks on the right,
  - asserts the kill feed shows `killer ✂ victim` on all pages (`⚔` if a fighter had picked up a long
    sword on the way),
  - asserts the kill (same seed), the score and the respawn on all pages,
  - asserts the score strip on all pages: three chips, the killer first with its point, our own chip
    the only highlighted one, text-only names, the strip above the HP, score and feed, and no
    rebuilds without data changes,
  - waits until the kill's gore has settled on every page and asserts the same gore fingerprint
    everywhere (and that over 100 landings went into it); Cy's page uses real gore and the others
    neon, so this also proves the style does not touch the simulation; then switching Ash's page to
    real gore and back rebuilds the blood layer, saves the choice and keeps the fingerprint,
  - drops the killer's socket and asserts the resume keeps id and score on every page,
  - sends a manual debug report and reads it back with `tools/debug.js report <id>`: the
    untrusted-input line, the server's view of that player, and no token in the files,
  - runs `tools/debug.js state`,
  - checks the word id in the lobby footer, in `localStorage` and in the report, a different id on
    another page, and that `tools/debug.js log <word>` prints the page's streamed `net connect` and
    `life join` entries with its name and IP, and `logs` lists it,
  - on a second server with `NET_SIM=120,2`, has two players pace for 8 s and asserts a
    prediction-error RMS under 3 units,
  - on a third server with `ITEM_SECS=1,2 ITEM_POINTS=0,1` (floor pickups only), with two players and
    a lobby viewer: a `fetch` bot walks onto a pickup; every page sees the `pickup` event and the
    holder's flag (and draws its reach ×1.6); the other player is parked by the left wall and a `spar`
    bot slashes only from 31 units (beyond standard reach) and hits, then kills, and every feed shows
    `Hold ⚔ Opp`; the respawned opponent then comes down in `fight` mode and kills the standing holder
    with its sword (`kill.held`, killer and move checked), and after the respawn every page has it back
    to the standard sword; `tools/debug.js state` lists the pickups,
  - ninja stars, on a fourth server with `STAR_SECS=1,1 ITEM_POINTS=0,1`: a `fetch` bot takes a star
    pickup; `__mp.throwHint` is "X to throw" and `#hStars` shows `★ 3` (`★ 0` before); every page sees
    the pickup; the target waits at x 40, the thrower at x 140 runs the `throw` bot; every page sees
    the `throw` and the star `hit`; the count (and `#hStars`) goes down; `tools/debug.js state` lists
    star pickups, stars in flight and counts,
  - heartbeat, on a fifth server: two players and a lobby viewer stay connected through 7 s of
    quiet; a 3 s `freeze` changes nothing; a 7 s freeze is timed out (ring event, the other player
    sees `away`) and resumes with the same id; a 12 s freeze ends with the player released and the
    page back in the lobby with the "Connection lost" message,
  - asserts no page errors.
- `npm run test:all` runs everything.
- `hygiene.js` (also run through `hygiene.test.js`) scans `git ls-files` plus untracked,
  non-ignored files. It fails on:
  - IPv4 addresses other than loopback and the any-address,
  - home-directory paths,
  - domain names ending in a real TLD unless they are on the small allowlist (example domains and a
    few documentation and registry hosts),
  - the machine's own user name or host name, read at run time.

  Its pattern literals are assembled from pieces, so the file does not match itself. There is one
  exact-text exemption: the SPEC sentence that states the home-path rule.

## Later additions

- **Full-screen button** (`#fsBtn`, `toggleFullscreen`/`syncFullscreen` in `game.js`): top right, in
  the lobby and the game; F toggles it; it follows `fullscreenchange`; on touch it also asks for
  landscape and replaces the old ⛶ button. The score strip leaves room for it (`--fsw`). An Escape
  pressed in full screen, or within 500 ms of leaving it, does not open the leave menu.
- **Build id and caching** (`BUILD`, `hashTree`, `stampIndex` in `server/server.js`): a 10-hex hash
  of everything under `public/` and `shared/`, taken at start. The served `index.html` gets a
  `<meta name="build">` and `game.js?v=<id>`. Every static response has `Cache-Control: no-cache`
  and an `ETag`, and a matching `If-None-Match` gets a 304. Every `welcome` carries `b` (the
  `Arena` `build` option). The client (`net.onStale` in `game.js`) reloads once per build id
  (remembered in `sessionStorage`) when its own id differs. The id is in the debug panel and in
  debug reports (`env.build`).
- **Breaking a long sword** (`shared/sim.js`, step 4b): a live sword box overlapping a lying long-sword
  pickup removes it and emits `{type:'break', tick, id, item, x, y}`. The client plays `sfx.smash`
  and a few sparks. Star pickups are not affected.

## Later additions

- **Full-screen button** (`#fsBtn`, `toggleFullscreen`/`syncFullscreen` in `game.js`): top right, in
  the lobby and the game; F toggles it; it follows `fullscreenchange`; on touch it also asks for
  landscape and replaces the old ⛶ button. The score strip leaves room for it (`--fsw`). An Escape
  pressed in full screen, or within 500 ms of leaving it, does not open the leave menu.
- **Build id and caching** (`BUILD`, `hashTree`, `stampIndex` in `server/server.js`): a 10-hex hash
  of everything under `public/` and `shared/`, taken at start. The served `index.html` gets a
  `<meta name="build">` and `game.js?v=<id>`. Every static response has `Cache-Control: no-cache`
  and an `ETag`, and a matching `If-None-Match` gets a 304. Every `welcome` carries `b` (the
  `Arena` `build` option). The client (`net.onStale` in `game.js`) reloads once per build id
  (remembered in `sessionStorage`) when its own id differs. The id is in the debug panel and in
  debug reports (`env.build`).
- **Breaking a long sword** (`shared/sim.js`, step 4b): a live sword box overlapping a lying long-sword
  pickup removes it and emits `{type:'break', tick, id, item, x, y}`. The client plays `sfx.smash`
  and a few sparks. Star pickups are not affected.
- **Dropping a long sword** (`kill` and `stepItems` in `shared/sim.js`): a killed holder (any cause
  but `leave`) queues a drop in `state.drops`; `stepItems` lays it on the first ground or plank
  below as a `long` pickup and emits `item` with `drop: true`. `it.safe` (30 ticks) stops the
  killing swing from breaking it.
- **How to play** (`#howto`, `helpScreen` in `game.js`): H, the touch ? button or the lobby link opens
  it; H, Escape, Enter, Close or a click outside shuts it; inputs are zeroed while it is open.
- **Chat** (SPEC §9). `{t:'chat', text}` goes through the usual 10/s message bucket, then
  `Arena.onChat`. Rules: a non-string `text` is a `malformed` kick (even from a viewer); a connection
  with no record (a lobby viewer) is ignored; `cleanChat` (`shared/constants.js`, next to `cleanName`)
  turns tabs, newlines and Unicode spaces into one space, removes control characters (C0, DEL, C1),
  format characters (`\p{Cf}`: zero-width, bidi, soft hyphen, BOM, tags; this also drops the zero-width
  joiner, so ZWJ emoji sequences fall apart into their parts) and unpaired surrogates, collapses
  spaces, trims, cuts to `CHAT.maxLen` = 80 code points (`Array.from`, so an emoji is never split)
  and trims again; an empty result is dropped. Each player record has a token bucket (`rec.chat`,
  burst `CHAT.burst` = 3, one token per `CHAT.refillMs` = 1500 ms; it lives on the record so a
  reconnect does not refill it). A message with no token is dropped and counts as a drop toward the
  same flood window as `allow()` (90 drops in 3 s is a `flood` kick). A relayed line becomes the event
  `{type:'chat', id, text}`, broadcast to every connection. The text is never logged: the event ring
  gets `chat` with `player` and `len` only. Queued players may chat.
  Client: `net.chat(text)` sends; `onEvents` in `net.js` logs `chat received` with the length only.
  In `game.js` (block after the leave menu): `chatKey` runs first in the `keydown` handler. C opens
  (`chatScreen(true)`; not in the lobby, as a viewer, or with the leave menu, help or a text input
  focused; the C itself is `preventDefault`ed), and while the `#chatbox` is open it returns true for
  every key so nothing else acts (Enter sends via `cleanChat` then closes, Escape and a blur close,
  Tab is swallowed); `updateOnline` zeroes the input bits (`chatOpen`) and closes the box if another
  screen took over. `#tChat` (💬 in `#tbar`) calls `chatScreen` from the pointerdown handler so the
  focus (and a phone's keyboard) happens inside the tap; on touch the box sits at the top. Incoming
  `chat` events go to `onChatEvent` before the event log: a bubble state (`chats`, id to text and
  time), a row in `#chatlist` (`textContent` only, name in the player's colour, last 5, CSS fade
  from 5 s, removed at 6 s) and `sfx.chat`. `drawChatBubble` runs after all players are drawn: up
  to 3 wrapped lines (80 units wide, ellipsis after the third), bottom edge 25 units above the feet
  (name tag 9, HP bar 7, stars 14.5, throw hint 21), clamped into the view, alpha fading over the
  last `CHAT.fadeMs` of `CHAT.showMs` (6 s); only players in `state.players` and alive are drawn.
  `window.__mp.chat` exposes `{open, bubbles, lines}` for tests. Chat text never enters `dbg()`.
- **Star count above the head** (`drawStarCount`): "★n" above any player with stars; the throw
  reminder sits above it.
- **AI players** (SPEC §15). `BOT` and `PALETTE` (`COLORS` plus `BOT.hex` at index `BOT.color` = 12)
  in `shared/constants.js`. `server/arena.js`: `onBots` (shape check, per-connection bucket
  `conn.botBucket`, arena-wide `this.botBucket` charged per change, then `send(lobbyMsg)` to the
  sender; admin only since rooms), `addBot` (now on `Room`; refused at `maxBots()` = `maxPlayers − 1` = 7 or with no free slot; a record with
  `bot: true`, `botNo`, `brain`, `conn: null`, `ip: null`, `token: null`, kept in `this.bots` in
  order; `activate` skips `freeColor` for it), `removeBot` (pops the newest, `release(…, 'bot
  removed')`, which also promotes from the queue); `dropped(conn)` is the shared drop/flood
  bookkeeping now used by `allow`, `onChat` and `onBots`. In `tick()` a bot's keys come from
  `botKeys(rec.brain, player, state, seen)` where `seen` is `Sim.positionsAt(hist, tick −
  brain.delay)`; the `rewind` callback returns null for a bot. Grace expiry, idle kicks, the
  heartbeat and per-IP record counting all key on `rec.conn`/`rec.ip`, so they skip bots without
  special cases. `roster`, `joinEvent`, `recView` and `adminState` mark bots.
  `server/ai.js`: `navOf(level, cfg)` (cached per level and per movement values, `navKey(cfg)`: the 14
  movement constants, 12 kept LRU, so a room's movement change gets its own table on the next bot tick
  and damage/gore changes keep it; SPEC §17.1) cuts the level into surfaces (runs of standable
  tiles), links them by simulating with `Sim.movePlayer` a standing and a running jump both ways
  from every 3 units of each surface plus a run off each end (`fly`), and keeps a first-hop table
  from a BFS per surface (about 25 ms, built in the `Arena` constructor). `newBrain(seed)` holds
  the bot's own Park–Miller `rng`, reaction `delay` (6–12 ticks) and `aggr` (15–30 % swing chance
  per tick). `botKeys` picks a target (nearest by |dx| + 1.5|dy|, +160 if spawn-protected,
  re-judged every 20 ticks with a 0.7 hysteresis), turns and slashes in reach (`18 × reach + 6`
  units, |dy| < 15), throws when on the same level with no solid tile between (`clearRow`),
  else walks to a pickup (a star pickup only while it has room for the whole bundle or at least
  5) or the target: same surface → walk; other surface → the nearest takeoff
  of the first hop, where each tick within 40 units it simulates the jump from its live state and
  jumps (holding the keys in `brain.air` until it lands) when that lands on the next surface. A
  bot walking but not moving for 12–25 ticks hops. Client: `net.bots(d)`; `net.lobby.bots/botMax`;
  `#lBots` (− `#lBotN` +) in the lobby, rendered in `renderLobby`; colours looked up in `PALETTE`.
  Tests: `test/bots.test.js`, `botTest` in `test/multiclient.js`.
- **Spectator mode** (SPEC §16). A watcher is a lobby viewer
  (`net.mode` `'viewer'`, no `hello`) with the lobby closed, looking at the room it selected (`view`, SPEC
  §17; Watch needs a selected room). `shared/spectate.js`: `PICK_TOL`
  (mouse 6, touch 14 units), `pickAt(players, x, y, tol)` (nearest living ninja, body or name tag),
  `byScore`, `leaderOf(players, rows)`, `followTarget(players, rows, chosen)` (→ `{chosen, id}`,
  `chosen` dropped once that ninja has left) and `cycleTarget(players, rows, cur, dir)`. In `game.js`
  (block after the leave menu): `watching`, `watchChosen` (picked by the watcher, or null for the
  leader), `watchId` (followed now); `watch(on)` (Watch button `#lWatch`, `#wLobby`, Esc, ✕ `tLeave`)
  and `watchUi(on)` (`body.watching`, the `#watch` bar; `backToLobby` calls it, so a kick also ends
  watching); `watchTarget()` re-resolves the target and is what `focus()` uses for the camera;
  `toWorld` / `toClient` map CSS px ↔ world units through the canvas rect (turned stage included);
  a `pointerdown` on `#stage` picks with `pickAt`; `watchKey` (← → ↓) runs after the Escape line of
  the `keydown` handler; `watchHud` (from `hudOnline`) fills `#wWho` / `#wWhy`; `drawWatchRing` marks
  the followed ninja; the strip adds `.watched` to its chip. `__mp.watch(on)`, `__mp.watching`
  (`{on, id, chosen}`) and `__mp.screenOf(id)` (client px) are for tests. Tests:
  `test/spectate.test.js`, `watchTest` in `test/multiclient.js`.
