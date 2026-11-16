// Spectator mode (SPEC §16): which ninja a watcher's camera follows. Pure functions over the drawn
// players (`state.players`: {id, x, y, w, h, alive}) and the score order, so the browser and the
// unit tests (test/spectate.test.js) run the same code. Nothing here touches the network: a watcher
// is an ordinary lobby viewer and the choice of camera target never leaves the page.
import { PW, PH } from './constants.js';

// How far (world units) from a drawn ninja a click or tap still picks it. The view is 320 units
// wide, so on a phone 14 units is about a fingertip (≈ 35–45 CSS px); a mouse is precise.
export const PICK_TOL = Object.freeze({ mouse: 6, touch: 14 });
// The name tag and HP bar float up to about this far above the body; a click on them counts too.
const TAG_H = 12;

// The living ninja nearest to world point (x, y), within `tol` of its body (or its name tag), or
// null. Dead ninjas are not drawn whole, so they cannot be picked.
export function pickAt(players, x, y, tol = PICK_TOL.mouse) {
  let best = null, bestD = Infinity;
  for (const p of players || []) {
    if (!p || !p.alive) continue;
    const w = p.w ?? PW, h = p.h ?? PH;
    const dx = Math.max(p.x - x, 0, x - (p.x + w)), dy = Math.max(p.y - TAG_H - y, 0, y - (p.y + h));
    const d = Math.hypot(dx, dy);
    if (d <= tol && d < bestD) { best = p.id; bestD = d; }
  }
  return best;
}

// The score order shared with the strip and scoreboard: score, then fewer deaths, then id.
export const byScore = (a, b) => b.score - a.score || (a.deaths ?? 0) - (b.deaths ?? 0) || a.id - b.id;

// The default target (no ninja chosen): the leader, i.e. the first in score order who is in the
// arena view. Followed through death and respawn like a chosen one, so the camera does not swing
// away for the 2 s a leader lies dead. null (a centred camera) when nobody is in the arena.
export function leaderOf(players, rows) {
  const here = new Set((players || []).map(p => p.id));
  const first = [...(rows || [])].sort(byScore).find(r => here.has(r.id));
  return first ? first.id : (players && players.length ? Math.min(...players.map(p => p.id)) : null);
}

// The camera target this frame: the chosen ninja while it is still in the arena (dead or alive: it
// respawns), else the leader. `chosen` is reported back as null once that ninja has left, so the
// watcher falls back to the default for good and a later player with no relation is never followed.
export function followTarget(players, rows, chosen) {
  const here = chosen != null && (players || []).some(p => p.id === chosen);
  return { chosen: here ? chosen : null, id: here ? chosen : leaderOf(players, rows) };
}

// ← / → while watching: the next or previous ninja in score order (the strip's order), wrapping.
// From the default (nobody chosen) → starts at the leader's neighbour.
export function cycleTarget(players, rows, current, dir) {
  const here = new Set((players || []).map(p => p.id));
  const ids = [...(rows || [])].sort(byScore).map(r => r.id).filter(id => here.has(id));
  for (const p of players || []) if (!ids.includes(p.id)) ids.push(p.id);   // in the view before the roster says so
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  return ids[((i < 0 ? 0 : i) + (dir < 0 ? -1 : 1) + ids.length) % ids.length];
}
