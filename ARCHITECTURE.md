# multisplat: architecture (as implemented)

Status: **M1**. This covers the shared simulation, the arena, an offline client with a dummy
opponent, and a static file server. Netcode, gore and music come in later milestones (see `SPEC.md` §14).

```
shared/constants.js   tunables: physics (NinjaRunner DEFAULTS), combat, input bits, net constants, colours
shared/level.js       the 26x18 arena, tile queries, spawn points, spawn picker
shared/sim.js         deterministic 60 Hz world step (movement, player collision, combat, respawn)
public/index.html     markup + CSS (HUD, respawn message, debug panel)
public/game.js        offline client: rendering, input, SFX, camera, dummy AI, debug panel
server/server.js      M1: static http server for public/ and /shared/
test/*.test.js        node:test unit tests (sim, level, server, hygiene)
test/hygiene.js       repo hygiene scan, runnable alone
```

No bundler. `shared/` holds plain ES modules. The server can `import` them and the browser loads them
from `/shared/*.js`.

## shared/constants.js

- `TICK_HZ = 60`, `VW = 320`, `VH = 192`, `T = 16`, `PW = 10`, `PH = 13` (Pip's body).
- `KEY` is the input bitmask: `LEFT 1, RIGHT 2, JUMP 4, RUN 8, SLASH 16`. Bits are level-triggered
  (set while held). The sim detects jump and slash presses as 0→1 edges against the previous tick.
- `FX`: cosmetic per-tick flags the sim writes to `player.fx` (`JUMP 1, SLASH 2, BONK 4, LAND 8`).
- `ATK_LEN 12`, `ATK_CD 16`, `COMBO_T 40` are NinjaRunner's sword timing.
- `DEFAULTS` holds every tunable the sim reads: NinjaRunner movement, `pushDamp`, and the SPEC §5
  combat values (`maxHp 100`, `chopDmg 34`, `sweepDmg 25`, `knockX 3.5`, `knockY -3`, `killKnockMul 1.4`,
  `hitStun 10`, `stunMoveMul .25`, `spawnIframes 90`, `respawnTicks 120`, `creditTicks 300`,
  `spawnMinDist 64`).
- `NET` (`historyMs 200`, `rewindCapMs 150`, …) and `HISTORY_TICKS` (12) are there for M2.
- `COLORS` holds the 8 lobby colours. The first six are NinjaRunner's NEON set.

## shared/level.js

`LEVEL = {w: 26, h: 18, grid: string[], spawns: [{x, y}]}`. Tiles use NinjaRunner's codes (`#`, `B`, `=`, `^`, `.`).
The arena has a solid border on all four sides (including a ceiling). Above the floor there are four
platform tiers, at rows 13, 9, 6 and 3. Two 2-tile spike strips sit in the centre: one on the floor
and one on top of the centre block. There are 14 spawn points. Each one is given as a feet position:
x is the centre and y is the top of the tile stood on.

- `isSolid(L, tx, ty)` and `isPlat` are NinjaRunner's tile tests. `tileAt` returns the tile code.
- `spawnPos(s)` gives the top-left of a body standing on spawn point `s`.
- `pickSpawn(L, living, rand, minDist)` skips points within `minDist` of a living player. It weights
  the remaining points by the squared distance to the nearest living player. If every point is too
  close, it takes the farthest one. With no living players, the pick is uniform.

## shared/sim.js

The sim is pure. It uses no DOM, clock or `Math.random`, and a test enforces that. The state is
plain JSON:

```js
state = { tick, rng, players: [player…] }   // players kept sorted by numeric id
player = { id, x, y, w, h, vx, vy, px, py, face, onGround, coyote, buf, walk,
           atk, atkCd, atkType: 'chop'|'sweep', combo, swing, hitSet: [ids],
           hp, alive, iframes, stun, respawn, lastHitBy, lastHitTick, score, deaths,
           keys /* previous tick's bitmask */, fx, standOn }
```

Randomness comes from NinjaRunner's Park–Miller generator, with its seed stored in `state.rng`.
`nextRand(state)` advances it. The sim uses it only to pick spawns and to make kill seeds.

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
| `slashHits(attacker, targets)` → ids | Lag-compensation helper. It tests the attacker's live sword box against supplied `{id, x, y, w?, h?}` positions. It skips the attacker and ids already in `hitSet`, and changes no state. |
| `createHistory()`, `recordHistory(hist, state)`, `positionsAt(hist, tick)` | A position ring of 200 ms (12 ticks). `positionsAt` interpolates for fractional ticks and clamps to the oldest or newest frame. |
| `killPlayer(state, id, cause)` → events | Kills a player from outside the rules (for example on disconnect). Last-hitter credit still applies. |
| `serialize`, `deserialize`, `cloneState` | JSON. |
| `swordBoxOf`, `swordLive`, `overlap`, `moveBody`, `inSpikes`, `nextRand` | Building blocks. |

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

**Credit.** The killer scores +1. For spikes or a `killPlayer` call, the last hitter within 300 ticks
(5 s) scores. If there is no such hitter, nobody scores, but `deaths` still goes up.

### Events (the return value of `step`)

```js
{ type: 'spawn', tick, id, x, y }
{ type: 'hit',   tick, attacker, victim, move: 'chop'|'sweep', dmg, hp, x, y }
{ type: 'kill',  tick, killer /* credited id or null */, victim, move: 'chop'|'sweep'|'spikes'|<cause>,
                 seed /* uint31 from the state RNG, for identical gore everywhere */, x, y, vx, vy, face }
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
- A client may edit `cfg` (the debug panel does). An online client should use `DEFAULTS` so its
  prediction matches the server.

## public/game.js

- **Ported from NinjaRunner:** the drawing helpers (`mk`, `rng`, `NEON`, `rrect`, `oval`, `line`,
  `shade`), the vector tiles (`tileCanvas`, `drawSpikes`, `buildTiles`), the night city
  (`paintSky`, `cityLayer`, `buildCity`, `RAIN`, `CARS`, `drawCars`, `STARS`), `resize` (device
  resolution, dpr capped at 2.5, phones held upright are rotated to landscape), `blitTile`, the
  background/tile/rain parts of `render`, `drawPip`, `drawTails`, `drawSword`, the `iframes` flashing,
  the audio (`initAudio`, `audioOut`, `tone`, `noise`, `sfx`, `LITE_AUDIO`) and the debug panel
  (`DBG_SPEC`, `buildDebug`, `toggleDebug`, `saveCfg`).
- **Per-player colour.** `drawPip(P, x, y, face, opt, col)` tints the headband, belt, knot, tails
  and rim glow. The local player is pink and the dummy is orange.
- **Input.** Keyboard: arrows to move, Up or Z to jump, Shift or X to run, Space to slash, D for the
  debug panel, M to mute. Gamepad: stick or d-pad to move, A or d-pad up to jump, X or B to slash,
  bumpers or triggers to run. The client builds one bitmask per tick. A press that starts and ends
  between ticks is latched for one tick.
- **Loop.** A fixed 60 Hz accumulator runs `update()`, which steps the sim and turns its events into
  SFX, damage popups, screen shake and corpses. `render()` runs every frame. The camera eases toward
  the local player and is clamped to the arena (NinjaRunner `followY`).
- **Dummy (id 2).** It wanders and turns back before spikes. The debug panel has a "Dummy slashes"
  switch that makes it attack when the player is close.
- **Visuals.** HP bars float over every player. Corpses are drawn client-side from `kill` events:
  they flip and fall, or stay impaled on spikes that are now bloody. Players flash white during
  hit-stun. The HUD shows HP, score and a respawn countdown.
- **Debug panel (D).** It has sliders for jump, movement, combat and game speed, switches for
  hitboxes (bodies, sword box, spawn points), the dummy and invincibility, and shows FPS, tick and
  position. Changed values are saved in `localStorage` under `multisplat-cfg`.
- **`window.__mp`** exposes `state`, `sim`, `cfg`, `level`, `localId`, `dummyId`, `events` (the last
  200 sim events) and `input` (`{id: bitmask}` overrides). It also has `pause()`, `resume()`,
  `step(n)`, `reset()` and `fps`.

## server/server.js (M1)

A static GET/HEAD server: `/shared/*` maps to `shared/` and everything else to `public/`. It
resolves paths after decoding, refuses NUL bytes and backslashes, and returns 404 for anything that
would escape the base directory. It sets MIME types and `nosniff`. Other methods get 405.
Configuration: `HOST` (default `127.0.0.1`) and `PORT` (default `3008`). It exports `handler` and
`resolvePath` for tests.

## Tests

`npm test` runs `node --test test/*.test.js` and then `node test/hygiene.js`.

- `sim.test.js`:
  - determinism (6 players, 3000 random ticks, a mid-run join and leave; serialized state and events
    compared; and resuming from a deserialized state),
  - purity of `shared/`,
  - movement (run, variable jump, buffer, coyote),
  - collision (symmetric push, no pass-through, wall, head-standing and riding),
  - combat (chop, sweep, per-swing once, stun, kill, score, respawn, spawn invulnerability, trades),
  - spike credit (none, recent hitter, expired),
  - `slashHits` and rewound `step`, history interpolation,
  - `predictStep` matching `step`.
- `level.test.js`: size and tile codes, closed border, 3–4 tiers, two short spike strips, ≥10
  spawns with footing and no spikes below or beside them, and `pickSpawn` distance and weighting.
- `server.test.js`: traversal, MIME types, HEAD, 404, 405.
- `hygiene.js` (also run through `hygiene.test.js`) scans `git ls-files` plus untracked,
  non-ignored files. It fails on:
  - IPv4 addresses other than loopback and the any-address,
  - home-directory paths,
  - domain names ending in a real TLD unless they are on the small allowlist (example domains and a
    few documentation and registry hosts),
  - the machine's own user name or host name, read at run time.

  Its pattern literals are assembled from pieces, so the file does not match itself. There is one
  exact-text exemption: the SPEC sentence that states the home-path rule.
