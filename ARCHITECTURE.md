# multisplat: architecture (as implemented)

Status: **M6** (in progress). This covers:
- the shared simulation and the arena (M1),
- the authoritative WebSocket server, with lobby, queue, resume and lag compensation,
- the online client, with prediction and interpolation,
- the remote-debugging pipeline (M2),
- client-side gore, the combat music, the kill feed, the scoreboard and touch controls (M3),
- long-sword pickups (M5, SPEC §5.1): sim, item points, protocol, client art and SFX,
- M6 changes: leaving with Escape, no spike traps in the arena (§3), the 5 s heartbeat and resume
  window (§6.4), scores for everyone along the top (§9).

```
shared/constants.js   tunables: physics (NinjaRunner DEFAULTS), combat, input bits, net constants, colours, name rule
shared/level.js       the 26x18 arena, tile queries, spawn points, long-sword item points, spawn picker
shared/sim.js         deterministic 60 Hz world step (movement, player collision, combat, respawn, pickups)
server/server.js      config, static files, /ws upgrade (origin, caps, limits), NET_SIM, entry point
server/arena.js       authoritative world: protocol, tick loop, slots/queue, resume, idle kick, lag comp
server/debug.js       server event ring, POST /debug/report intake + storage, loopback admin listener
public/index.html     markup + CSS (lobby, HUD, respawn message, debug panel)
public/game.js        client: rendering, input (keys, pad, touch), SFX, camera, lobby, HUD, debug panel; offline sandbox
public/gore.js        gore simulation (DOM-free, seeded by kill.seed): particles, gibs, fountains, decals, pools
public/music.js       the combat score as data, its offline pre-render into two loops, the live player
public/net.js         client netcode: socket, reconnect/resume, clock sync, prediction, interpolation
public/debug.js       client log ring (dbg), debug report builder and sender
tools/debug.js        CLI for the admin listener
test/*.test.js        node:test unit tests (sim, items, level, server, arena, gore, music, hygiene)
test/multiclient.js   headless Chromium: 3 players, fight, kill feed, gore fingerprint, resume, debug report, NET_SIM prediction, long sword
test/abuse.js         server limits against a real server process
test/smoke.js         connect to a deployed /ws and expect `welcome`
test/lib.js, bot.js   test helpers (spare ports, server process, Chromium lookup) and the scripted player
deploy/               systemd unit + nginx site templates (placeholders only)
```

No bundler. `shared/` holds plain ES modules. The server can `import` them and the browser loads them
from `/shared/*.js`.

## shared/constants.js

- `TICK_HZ = 60`, `VW = 320`, `VH = 192`, `T = 16`, `PW = 10`, `PH = 13` (Kanbei's body).
- `KEY` is the input bitmask: `LEFT 1, RIGHT 2, JUMP 4, RUN 8, SLASH 16`. Bits are level-triggered
  (set while held). The sim detects jump and slash presses as 0→1 edges against the previous tick.
- `FX`: cosmetic per-tick flags the sim writes to `player.fx` (`JUMP 1, SLASH 2, BONK 4, LAND 8`).
- `ATK_LEN 12`, `ATK_CD 16`, `COMBO_T 40` are NinjaRunner's sword timing.
- `DEFAULTS` holds every tunable the sim reads: NinjaRunner movement, `pushDamp`, and the SPEC §5
  combat values (`maxHp 100`, `chopDmg 34`, `sweepDmg 25`, `knockX 3.5`, `knockY -3`, `killKnockMul 1.4`,
  `hitStun 10`, `stunMoveMul .25`, `spawnIframes 90`, `respawnTicks 120`, `creditTicks 300`,
  `spawnMinDist 64`) and the pickup tunables `itemMinTicks 1200`, `itemMaxTicks 2400` (20–40 s),
  `itemMax 2`, `itemClear 32`.
- `LONG_REACH = 1.6` (the holder's sword-box length factor) is a separate constant, not in `DEFAULTS`,
  because the offline debug panel edits `cfg` and reach must always match the server.
  `ITEM_W 8`, `ITEM_H 14` is a pickup's body.
- `NET` holds the netcode values:
  - `historyMs 200`, `rewindCapMs 150`,
  - `snapshotHz 30`, `maxInputBatch 3`,
  - `interpMs 100`, `extrapMs 100`,
  - `maxPlayers 12`, `graceMs 5000`, `idleMs 120000`, `inputRate 90`,
  - `heartbeatMs 5000` (a connection silent this long is closed), `timeoutClose 4100` (its close
    code, which the client treats as a network drop), `pingMs 500` (the client's ping period),
  - `smoothUnits 2`, `smoothFrames 6`.

  Next to it are `HISTORY_TICKS` (12) and `TICK_MS` (16.67).
- `COLORS` holds the 8 lobby colours. The first six are NinjaRunner's NEON set. Players pick one
  by index (0–7).
- `NAME_RE` / `cleanName(s)` trims, collapses double spaces and checks for 1–16 characters from
  `[A-Za-z0-9 _-]`. It returns the clean name or `null`. The lobby and the server both use it.

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
          items: [{id, x, y}…],  // long-sword pickups lying in the arena (x, y = their item point)
          itemT,                 // ticks until the next may appear (-1: drawn on the first step)
          itemSeq }              // last pickup id used
player = { id, x, y, w, h, vx, vy, px, py, face, onGround, coyote, buf, walk,
           atk, atkCd, atkType: 'chop'|'sweep', combo, swing, hitSet: [ids],
           hp, alive, iframes, stun, respawn, lastHitBy, lastHitTick, score, deaths,
           keys /* previous tick's bitmask */, fx, standOn, long /* holds a long sword */ }
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
| `itemBox(it)`, `freeItemPoints(state, cfg, level)` | A pickup's body (centred on x, resting on y); the item points with no pickup and no living player's feet within `itemClear`. |
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
{ type: 'item',   tick, id /* pickup id */, x, y }          // a pickup appeared
{ type: 'pickup', tick, id /* player */, item, x, y }       // who took which
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

## Protocol (SPEC §6.1)

The protocol is JSON text frames, each with a `t` field. Server limits:
- 1 KB per message (`maxPayload`, close 1009).
- 90 `input` messages/s and 10 other messages/s per connection (token buckets). Excess messages
  are dropped, and 90 drops within 3 s is a kick.
- Malformed JSON or an unknown `t` is a kick.

Client → server:

```js
{ t: 'hello', name, color /* 0-7 */, token? /* resume */, resume? /* true: resume only (an automatic
  reconnect); a dead token gets the `expired` welcome below instead of a fresh join */ }
{ t: 'input', seq, keys }              // keys: bitmask, or an array of 1-3 masks for seq, seq+1, …
{ t: 'ping', id, ct /* client clock, echoed */ }
{ t: 'leave' }                          // give up the slot or queue place now; the socket stays as a viewer
```

Server → client:

```js
{ t: 'welcome', v: 1, tick, cap, colors }                     // on connect, before hello
{ t: 'welcome', v: 1, tick, cap, resumed: false, expired: true } // a `resume: true` hello came too late:
                                                               // no record; the socket stays a viewer
{ t: 'welcome', v: 1, id, token, resumed, state: 'play'|'queue', name /* maybe 'Kit#2' */, color,
  tick, queuePos, players: [roster], queue: [{id, name, color, away}], cap }   // reply to hello
{ t: 'snapshot', tick, seq /* last input processed for you, -1 if none */, me? /* your full sim
  player object, only while you play */, p: [[id, x, y, vx, vy, face, hp, atk, flags, iframes, stun, fx], …], it: [[id, x, y], …] }
     // 30 Hz; positions rounded to 0.01; flags = alive 1 | onGround 2 | sweep 4 | long sword 8;
     // it = the long-sword pickups lying in the arena (so a joiner or resumer learns them, and the
     // holders from the flags, from one snapshot); `me` carries `long` for the local player;
     // fx = the FX bits OR-ed over the ticks since the last snapshot (for remote sounds)
{ t: 'event', tick, ev: [event…] }     // reliable, in order, sent as they happen
{ t: 'lobby', players: [roster], queue: [...], cap }   // on connect and on roster/score change (≤ 2/s)
{ t: 'pong', id, ct, tick, tf /* 0..1 into the current tick */ }
{ t: 'kick', reason }                  // then close with 4001 idle, 4002 malformed, 4003 unknown,
                                       // 4004 flood, 4005 protocol, 4006 bad hello, 4007 replaced, 4008 shutdown
// The heartbeat timeout is not a kick: no `kick` message, close code 4100 (`NET.timeoutClose`).
roster = { id, name, color, score, deaths, away /* disconnected, inside the grace period */ }
```

Events are the sim's `spawn`, `hit`, `kill`, `item` and `pickup` (shapes above), relayed unchanged. `kill.seed` lets every client
render identical gore. There are also:

```js
{ type: 'join',  tick, id, name, color }
{ type: 'leave', tick, id, reason: 'timeout'|'kick' }
{ type: 'score', tick, id, score, deaths }   // after every kill, for the killer and the victim
```

If a player leaves within `creditTicks` of being hit, it is first killed with `move: 'leave'`, so
the hitter gets the point.

## server/server.js

- `loadConfig(vars)` reads `HOST`, `PORT`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `MAX_PER_IP`,
  `MAX_CONN`, `DEBUG_DIR`, `DEBUG_PORT`, `NET_SIM` (SPEC §10) and two more test-only knobs:
  `ITEM_SECS=min,max` (the pickup countdown in seconds, passed to the arena as a `cfg` copy) and
  `ITEM_POINTS=i,j,…` (pickups only at those `LEVEL.items` indexes, passed as a `level` copy). It
  throws on any of the three with `NODE_ENV=production`, and the entry point then exits 2.
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

`new Arena({cfg, level, now, log, event, maxPlayers, graceMs, idleMs, heartbeatMs, maxPerIp, seed})`. It has no sockets: tests
drive it with fake connections and call `tick()` themselves, and `start()` runs the real loop.

- **Records.** `hello` creates a record `{id, name, color, token, conn, state: 'play'|'queue',
  ip, inputs, lastSeq, lastKeys, lastActive, discAt}`. Ids count up from 1 and are never reused.
  Names are de-duplicated case-insensitively with `#2`, `#3`, and so on. The token is 16 random
  bytes in hex. One address may hold at most `maxPerIp` records (the server passes `MAX_PER_IP`;
  the class default is unlimited): a new `hello` past that releases the address's oldest
  *disconnected* record (`leave` with reason `replaced`), so churning connect + hello + close
  cannot fill the slots with records waiting out their grace period.
- **Slots and queue.** Up to `maxPlayers` records play. The rest wait in a FIFO queue and receive
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
  `net.leave()` and reopens the lobby. In `?offline` it reloads to the lobby.
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
  1. grace expiry and idle kicks,
  2. input selection,
  3. `Sim.step(state, inputs, {rewind})` and `recordHistory`,
  4. events, with `score` events added,
  5. a snapshot every 2nd tick,
  6. the coalesced `lobby` broadcast,
  7. tick-time statistics. A tick over 16.7 ms is an `overrun` event.
- **Lag compensation.** `rewind(attacker)` returns `positionsAt(hist, tick − d)`, with
  `d = min(150 ms, interpMs 100 + attacker RTT/2)` in ticks. It uses the server-measured RTT.
- **Loop.** A `setTimeout` scheduler on a fixed 16.67 ms grid. It catches up at most 5 ticks at
  once and resets the grid if it falls more than 100 ms behind.
- **Debug views.** `adminState()` returns players (with `long`), the lying pickups (`items`), the
  seconds until the next may appear (`itemInS`), queue, tick time and connections. `tools/debug.js
  state` prints a `long-sword pickups` line and marks holders `LONG`.
  `viewByToken(token)` returns the server's view of one connection for a report. Neither contains
  a token.

## server/debug.js

- `createEventRing(2000)`: `push(type, conn, data)` adds `{n, ts, type, conn, …data}`. The arena
  and server push `connect`, `close`, `join`, `promote`, `queue`, `resume`, `resume-refused`,
  `drop`, `timeout` (heartbeat, with `player` and `silentMs`), `leave`, `kick` (with `reason`), `ratelimit`, `overrun`, `refused` (upgrade refusals,
  with `why`), `report` and `report-rejected`.
- `validateReport(body)` returns `{report, token}`, with the token removed from the report. Rules:
  - top-level keys must be among `v, kind, reason, ts, env, net, player, entries, token, reportId`,
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
    `/state`, `/events?n=`, `/reports?n=` (summaries, newest first) and `/reports/<id>`.

## tools/debug.js

`node tools/debug.js [--port N] state | events [n] | reports [n] | report <id> | tail`. The port is
`--port` or `DEBUG_PORT`. It prints `# UNTRUSTED INPUT: …` above report listings and bodies.
Every line it prints has C0 (except newline), DEL, C1 and bidi control characters replaced with
U+FFFD, so a stored report cannot drive the terminal even if intake cleaning were bypassed.
`tail` polls every 2 s.

## public/net.js

`createNet({onLobby, onStatus})` returns `net`:

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
  - `connect()` opens `ws(s)://<page host>/ws`. The page loads as a viewer, so the lobby is live.
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
  - Physics always use `DEFAULTS`.
- **Interpolation (§6.3).** `view(now)` gives `{tick, players, fx, items}`. Snapshots are unpacked
  with `long` (flag bit 8) and `items` (from `it`; a snapshot without it, e.g. from a pre-M5 server,
  means none). `items` are those of the newest snapshot at or before the render tick, minus pickups
  we took ourselves (our `pickup` event is released at once and hides it before the timeline
  catches up).
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
| `fadeOf(G, t)` | 1 → 0 over the last 90 s of the 4 min life |

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

**Persistence and caps** (`GORE`): decals, pools and stains live 4 min (fading over the last 90 s).
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
  - the debug panel (`DBG_SPEC`, `buildDebug`, `toggleDebug`, `saveCfg`).
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
  - Keyboard: arrows to move, Up or Z to jump, Shift or X to run, Space to slash, Tab for the
    scoreboard, D for the debug panel, M to mute.
  - Touch (NinjaRunner's `TOUCH_BTN`, `btnAt`, `fingerOn`, `syncTouch`): ◀ ▶ bottom left, » ⚔ ⤒
    bottom right, plus a small ♪ (mute) and ⛶ (full screen) bar. Every finger is tracked by pointer
    id and can slide between buttons; jump and slash presses are latched like keys. **Run is the »
    toggle** (as in NinjaRunner), so one thumb stays on ◀ ▶ and the other on ⤒ ⚔. The bits are OR-ed
    into the tick mask (`touchBits()`) and log `device touch`. Buttons show when `pointer: coarse`
    (or `?touch`), hide while the lobby is open, and live in `#stage`, so they turn with it.
    Fight calls `goLandscape()` (full screen + orientation lock where allowed), as NinjaRunner's
    start does; a phone held upright still gets the rotated stage.
  - Gamepad: stick or d-pad to move, A or d-pad up to jump, X or B to slash, bumpers or triggers
    to run.

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
  - Blood is **red**: `BLOOD` (arterial to dark crimson) for drops and decals, the darker `POOL`
    for pools; the spike stains use `BLOOD` too. Player colours still tint headbands and glows.
- **Music.** `initAudio` (on the first key, pointer or Fight) creates `music` unless `?nomusic`.
  M toggles `muted`, which silences both the SFX and the music. A hidden tab suspends the context.
- **Lobby (§9).** An overlay over the live arena. It has:
  - the logo,
  - a name field (`cleanName`) and 8 swatches,
  - the live player list with scores, the slot count and the queue length,
  - **Fight**,
  - a "Report a problem" link that shows the report id.

  The name and colour are saved in `localStorage` (`multisplat-name`, `multisplat-color`).
  After a kick the lobby comes back and shows the reason.
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
  times, the **Gore** toggle (`CFG.gore`, on by default), and a **Music volume** slider
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
- `items.test.js`: the spawn window (40 seeds, gaps within 20–40 s and spread over it) and the max-2
  rule; the countdown holding while full; free-point selection away from players and pickups (and
  retrying when none is free); determinism with pickups (6 players, serialized state and events, and
  resuming from a deserialized state); pickup on contact, the lower-id tie, a holder leaving a second
  one, dead players; reach (a target just past standard reach is hit only by a holder, chop and sweep,
  both facings), the box anchoring, unchanged damage, knockback and timing; `slashHits` and a rewound
  `step` using the longer box; loss on a sword kill, spikes and leave, standard reach after respawn,
  and the `long`/`held` kill flags.
- `server.test.js`: traversal, MIME types, HEAD, 404, 405.
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
  - long swords: `item`/`pickup` relayed to players and viewers, `it` and the flag bit in snapshots,
    `me.long`, a mid-game joiner's first snapshot, admin state, the flag gone after death,
  - leave credit and `score` events,
  - `viewByToken` / admin state without tokens,
  - `loadConfig` (defaults, `NET_SIM`, `ITEM_SECS` and `ITEM_POINTS` refused in production),
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
  - `NET_SIM`, `ITEM_SECS` and `ITEM_POINTS` refused in production,
  - `test/smoke.js` against the server.
- `npm run test:multi` (`test/multiclient.js`) uses headless Chromium through playwright-core.
  Chromium comes from `PLAYWRIGHT_CHROMIUM`, playwright's own lookup, or the newest build in its
  cache. The test:
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
    everywhere (and that over 100 landings went into it),
  - drops the killer's socket and asserts the resume keeps id and score on every page,
  - sends a manual debug report and reads it back with `tools/debug.js report <id>`: the
    untrusted-input line, the server's view of that player, and no token in the files,
  - runs `tools/debug.js state`,
  - on a second server with `NET_SIM=120,2`, has two players pace for 8 s and asserts a
    prediction-error RMS under 3 units,
  - on a third server with `ITEM_SECS=1,2 ITEM_POINTS=0,1` (floor pickups only), with two players and
    a lobby viewer: a `fetch` bot walks onto a pickup; every page sees the `pickup` event and the
    holder's flag (and draws its reach ×1.6); the other player is parked by the left wall and a `spar`
    bot slashes only from 31 units (beyond standard reach) and hits, then kills, and every feed shows
    `Hold ⚔ Opp`; the respawned opponent then comes down in `fight` mode and kills the standing holder
    with its sword (`kill.held`, killer and move checked), and after the respawn every page has it back
    to the standard sword; `tools/debug.js state` lists the pickups,
  - heartbeat, on a fourth server: two players and a lobby viewer stay connected through 7 s of
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
