// The prediction fingerprint (SPEC §18): what the page's own movement code *does*, as a hash.
//
// During a game the page runs exactly one piece of the shared sim: Sim.predictStep, which moves its
// own player between server snapshots (movement, collisions with walls, platforms and other players,
// spikes). If an open page and a new server disagree about that, the player rubber-bands on every
// jump until the page reloads, so such a deploy must stop the game. Nothing else in the sim runs on
// the page online (combat, pickups, spawning, scoring are the server's), so nothing else can.
//
// So instead of hashing source text, this runs predictStep over a fixed, seeded set of situations
// and hashes every outcome: the same behaviour gives the same hash however the code is written or
// what else changes in the same files, and any change to how a player moves changes some outcome.
//
// The situations: CFG_VARIANTS room settings, each with SITUATIONS starts, each stepped TICKS ticks
// under changing keys. A start is a player somewhere in the level (anywhere, or near a spawn or item
// point, so on floors, platform edges, walls and spikes), with a random velocity, facing, ground
// flag, coyote/jump-buffer counters, stun, attack and long sword, and 0-2 other players close by.
// The settings take random values inside each editable setting's range (SETTINGS) and never the
// defaults: the server sends a room's settings in full (SPEC §17.1), so a page always predicts with
// the server's values and a changed default alone must not count.
import { createHash } from 'node:crypto';

const SEED = 0x5eed1e55, CFG_VARIANTS = 4, SITUATIONS = 500, TICKS = 24;

// a small seeded generator (mulberry32): the same sequence on every server
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a of a setting's name: its own seed
function nameSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// The fingerprint of `Sim.predictStep` (16 hex). `Sim`: the shared sim module; `C`: the shared
// constants module ({ROOM_DEFAULTS, SETTINGS, KEY_MASK, T}); `level`: the level it predicts in.
export function predictionFingerprint(Sim, C, level) {
  const R = rng32(SEED), h = createHash('sha256');
  const pick = a => a[Math.floor(R() * a.length) % a.length];
  const span = (lo, hi) => lo + R() * (hi - lo);
  const T = C.T, W = level.w * T, H = level.h * T;
  const anchors = [...level.spawns, ...level.items].map(p => ({ x: p.x, y: p.y }));
  const num = v => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0);
  for (let v = 0; v < CFG_VARIANTS; v++) {
    // each setting's value from its own generator (seeded by its name and the variant), so adding,
    // removing or reordering other settings can't move it; one predictStep never reads is inert
    const cfg = { ...C.ROOM_DEFAULTS };
    for (const [, items] of C.SETTINGS) for (const [k, , min, max, step] of items)
      cfg[k] = min + step * Math.floor(rng32(nameSeed(k) ^ Math.imul(v + 1, 0x9e3779b1))() * (Math.round((max - min) / step) + 1));
    for (let s = 0; s < SITUATIONS; s++) {
      const st = Sim.createWorld({ seed: 1 + s });
      const n = 1 + Math.floor(R() * 3);
      for (let id = 1; id <= n; id++) Sim.addPlayer(st, id, { cfg, level });
      const me = Sim.getPlayer(st, 1);
      const at = R() < .5 ? { x: span(0, W), y: span(0, H) } : pick(anchors);
      Object.assign(me, {
        x: at.x + span(-12, 12), y: at.y + span(-24, 4), vx: span(-5, 5), vy: span(-9, 9), face: R() < .5 ? -1 : 1,
        onGround: R() < .5, coyote: Math.floor(R() * 8), buf: Math.floor(R() * 8),
        stun: R() < .2 ? Math.floor(R() * 20) : 0, atk: R() < .2 ? Math.floor(R() * 12) : 0, long: R() < .3,
      });
      for (const o of st.players) if (o !== me) Object.assign(o, { x: me.x + span(-14, 14), y: me.y + span(-10, 10), vx: span(-3, 3), vy: span(-3, 3) });
      let keys = Math.floor(R() * (C.KEY_MASK + 1));
      for (let t = 0; t < TICKS; t++) {
        if (R() < .3) keys = Math.floor(R() * (C.KEY_MASK + 1));
        const spikes = Sim.predictStep(st, 1, keys, { cfg, level });
        const row = [num(spikes)];
        for (const p of st.players) row.push(p.x, p.y, p.vx, p.vy, num(p.onGround), p.face, num(p.coyote), num(p.buf));
        h.update(row.join(',') + ';');
      }
    }
  }
  return h.digest('hex').slice(0, 16);
}
