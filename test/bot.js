// A scripted player for the browser tests. Its source is injected into a page and set as
// window.__mp.autopilot, which game.js calls once per tick with (predicted me, drawn players).
// Plan: get down to the floor (walk off the outer edge of each platform, or the inner edge if the
// platform touches a wall), then either fight on the left half of the floor (jumping the centre
// spike strip if needed) or park on the right half.
// Long-sword modes (all on the floor): 'fetch' walks to the nearest pickup lying on the floor,
// 'goto' walks to x, 'spar' keeps `dist` units (centre to centre) from target and slashes only
// from there (beyond standard reach, inside long reach), 'spikes' walks into the floor spikes.
//   window.__botCfg = { mode: 'fight' | 'park' | 'pace' | 'fetch' | 'goto' | 'spar' | 'spikes', target: id, x, dist }
export function bot(me, players) {
  const cfg = window.__botCfg || {}, L = window.__mp.level, T = 16;
  const K = { L: 1, R: 2, J: 4, RUN: 8, S: 16 };
  const st = window.__botState || (window.__botState = { t: 0, airKeys: 0, pace: 1 });
  st.t++;
  if (!me.alive) return 0;
  if (cfg.mode === 'pace') {
    // Walk back and forth, turning every so often (the period depends on the id, so two pacers
    // don't turn in step), at walls, before spikes and before another player: pacing is for
    // measuring walking prediction, not body contact, which prediction cannot know about.
    const ahead = Math.floor((me.x + me.w / 2 + st.pace * 14) / T), row = Math.floor((me.y + me.h - 1) / T);
    const blocked = players.some(o => o.id !== me.id && o.alive && Math.abs(o.y - me.y) < 14 &&
      (o.x - me.x) * st.pace > 0 && Math.abs(o.x - me.x) < 22);
    if (me.standOn != null) {                    // landed on someone's head: walk off the way they aren't going
      const c = players.find(o => o.id === me.standOn);
      st.pace = c && c.face > 0 ? -1 : 1;
    } else if (me.x < 24) st.pace = 1;
    else if (me.x > L.w * T - 34) st.pace = -1;
    else if (st.t % (60 + (me.id % 4) * 17) === 0 || blocked || (me.onGround && L.grid[row] && L.grid[row][ahead] === '^')) st.pace = -st.pace;
    return st.pace < 0 ? K.L : K.R;
  }
  const dirKey = d => (d < 0 ? K.L : K.R);
  const moved = Math.abs(me.x - (st.prevX ?? me.x));
  st.prevX = me.x;
  if (!me.onGround) return st.airKeys;
  st.airKeys = 0;
  // Walking on the ground but not moving: another body is in the way (two bots walking into each
  // other push forever, SPEC §4), so jump over it with the direction held. The wait depends on the
  // id, so two blocked bots don't jump together and collide again in the air.
  const go = k => {
    st.still = moved < 0.2 ? (st.still || 0) + 1 : 0;
    if (st.still < 10 + (me.id % 3) * 14) return k;
    st.still = 0; st.airKeys = k | K.J;
    return k | K.J;
  };
  const feet = me.y + me.h, cx = me.x + me.w / 2, half = cx < 208 ? -1 : 1;
  const floorTop = (L.h - 1) * T;
  if (feet < floorTop - 0.5) {
    const row = Math.floor(feet / T + 0.01), col = Math.floor(cx / T);
    const solid = c => c === '#' || c === 'B' || c === '=';
    let l = col, r = col;
    while (l > 0 && solid(L.grid[row][l - 1])) l--;
    while (r < L.w - 1 && solid(L.grid[row][r + 1])) r++;
    let d = half;
    if (d < 0 && l <= 1) d = 1;
    if (d > 0 && r >= L.w - 2) d = -1;
    return go(dirKey(d));
  }
  if (cfg.mode === 'spikes') return go(dirKey(208 - cx));
  if (cfg.mode === 'fetch' || cfg.mode === 'goto' || cfg.mode === 'spar') {
    let tx = cfg.x ?? cx, tol = 1.5;
    if (cfg.mode === 'fetch') {
      const its = ((window.__mp.state && window.__mp.state.items) || []).filter(i => i.y === floorTop);
      if (!its.length) return 0;
      tx = its.reduce((a, b) => (Math.abs(a.x - cx) <= Math.abs(b.x - cx) ? a : b)).x;
    }
    if (cfg.mode === 'spar') {
      const tgt = players.find(p => p.id === cfg.target && p.alive);
      if (!tgt || Math.abs(tgt.y - me.y) > 3) return 0;
      const tcx = tgt.x + tgt.w / 2, side2 = Math.sign(cx - tcx) || -1, d = Math.abs(cx - tcx);
      tx = tcx + side2 * cfg.dist; tol = 2.5;
      if (Math.abs(cx - tx) <= tol) {
        const toward = dirKey(tcx - cx);
        if (me.face !== Math.sign(tcx - cx)) return toward;
        if (Math.abs(me.vx) < .3 && st.t - (st.slashAt || 0) >= 20) {
          st.slashAt = st.t; st.slashes = (st.slashes || 0) + 1;
          st.lastSlashDist = d;                     // centre-to-centre distance at the press
          return K.S;
        }
        return 0;
      }
    }
    const side2 = tx < 208 ? -1 : 1;
    if (half !== side2) {
      const k = dirKey(side2) | K.RUN;
      const takeoff = side2 < 0 ? me.x > 226 && me.x < 238 : me.x + me.w < 190 && me.x + me.w > 178;
      if (takeoff) { st.airKeys = k | K.J; return k | K.J; }
      return go(k);
    }
    if (Math.abs(cx - tx) <= tol) return 0;
    return Math.abs(cx - tx) < 8 ? (st.t % 4 ? 0 : dirKey(tx - cx)) : go(dirKey(tx - cx));   // ease in with taps
  }
  // on the floor: cross the spike strip (x 192..224) with a running jump if on the wrong side
  const side = cfg.mode === 'park' ? 1 : -1;
  if (half !== side) {
    const k = dirKey(side) | K.RUN;
    const takeoff = side < 0 ? me.x > 226 && me.x < 238 : me.x + me.w < 190 && me.x + me.w > 178;
    if (takeoff) { st.airKeys = k | K.J; return k | K.J; }
    return go(k);
  }
  if (cfg.mode === 'park') return Math.abs(cx - 340) < 6 ? 0 : go(dirKey(340 - cx));
  const tgt = players.find(p => p.id === cfg.target && p.alive);
  const tcx = tgt ? tgt.x + tgt.w / 2 : 0;
  if (!tgt || tgt.y + tgt.h < floorTop - 2 || tcx > 190) return Math.abs(cx - 60) < 8 ? 0 : go(dirKey(60 - cx));
  const dx = tcx - cx;
  if (Math.abs(dx) > 14) return go(dirKey(dx));
  let k = 0;
  if (dx && Math.sign(dx) !== me.face) k |= dirKey(dx);
  if (st.t % 18 === 0) k |= K.S;
  return k;
}

export async function installBot(page, cfg) {
  await page.evaluate(([src, c]) => {
    window.__botCfg = c; window.__botState = null;
    // eslint-disable-next-line no-eval
    const f = (0, eval)('(' + src + ')');
    window.__mp.autopilot = (me, players) => { const k = f(me, players); window.__botState.k = k; return k; };
  }, [bot.toString(), cfg]);
}
export async function stopBot(page) { await page.evaluate(() => { window.__mp.autopilot = null; }); }
