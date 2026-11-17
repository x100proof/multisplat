// multisplat client. Renders the shared simulation with NinjaRunner's art, theme and sound, online
// (the default) or as the offline sandbox (?offline) with a dummy player. Gore lives in gore.js and
// the music in music.js; this file draws them.
// The game simulates in world units (the view is 320x192 units, tiles are 16) but draws at the
// screen's full resolution. All art is vector-drawn: paths, gradients and glows.
import * as Sim from '/shared/sim.js';
import { VW, VH, T, KEY, FX, ATK_LEN, DEFAULTS, VIEW_DEFAULTS, SETTINGS, SETTING_TOGGLES, cfgDiff, NET, COLORS, PALETTE, LONG_REACH, ITEM_W, ITEM_H, cleanName, cleanChat, cleanRoomName, CHAT, ROOM } from '/shared/constants.js';
import { LEVEL } from '/shared/level.js';
import { PICK_TOL, pickAt, followTarget, cycleTarget } from '/shared/spectate.js';
import { createNet } from './net.js';
import { createGore, clearGore, goreKill, goreHit, stepGore, fadeOf, fingerprint, settled, killKey, GORE } from './gore.js';
import { createMusic, analyze as analyzeLoop } from './music.js';
import { dbg, setTickSource, setReportSource, sendReport, installErrorHandlers, entries as dbgEntries } from './debug.js';
const { swordBoxOf } = Sim;

const QS = new URLSearchParams(location.search);
// Online (the default) talks to the server; ?offline runs M1's local sandbox with a dummy.
const ONLINE = !QS.has('offline');
installErrorHandlers();
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
let SCALE = 1;   // device pixels per world unit

// ---------- tunables (edited live by the debug panel, D) ----------
// Sim tunables come from shared/constants.js; the rest are client-only view and dummy switches.
// Offline, the panel edits CFG (saved in this browser). Online the sim constants and the room-wide
// display switches (gore, blood style) are the room's settings (SPEC §17.1), which only the room's
// admin edits and every page in the room applies (net.cfg); hitboxes and music volume stay local.
const CLIENT_DEFAULTS = { gameSpeed: 1, gore: true, realGore: false, musicVol: .5, hitboxes: false, dummyWander: true, dummySlash: false, invincible: false };
const ALL_DEFAULTS = { ...DEFAULTS, ...CLIENT_DEFAULTS };
const CFG = { ...ALL_DEFAULTS };
const CFG_KEY = 'multisplat-cfg';
try {
  const saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
  for (const k in saved) if (k in ALL_DEFAULTS && typeof saved[k] === typeof ALL_DEFAULTS[k]) CFG[k] = saved[k];
} catch (e) { /* ignore */ }

// ---------- drawing helpers (NinjaRunner) ----------
const TAU = Math.PI * 2;
function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
const NEON = { pink: '#ff2a6d', cyan: '#05d9e8', yellow: '#f9f871', purple: '#b026ff', green: '#39ff14', magenta: '#ff6ec7' };
const NEON_LIST = Object.values(NEON);
// Two blood styles (SPEC §7), a per-client look only. gore.js stores a colour index (0-5) with every
// drop, decal and pool, drawn from the kill's seed, and each style maps the index to its own colour,
// so the same kill paints the same spatter in either style and switching repaints it.
// - neon (the default): NinjaRunner's multi-colour neon blood (BLOOD = NEON_LIST), glowing with the
//   'lighter' blend, for flying drops and for the baked layer of decals and pools;
// - real: reds, arterial to dark crimson, with darker pools; flying drops still add up ('lighter'),
//   which keeps stacked red red; the baked layer is drawn normally.
const BLOOD_STYLES = {
  neon: { drops: NEON_LIST, pools: ['#c8205a', '#04a8b4', '#c4c25a', '#8a1ec8', '#2cc810', '#c8579c'],
    layerBlend: 'lighter', layerAlpha: .85, cut: ['#4a0a3a', '#ff2a6d', '#ffd1e6'] },
  real: { drops: ['#ff1f1f', '#e8100c', '#ff2a22', '#c40a0a', '#9c0410', '#6e0008'],
    pools: ['#b30a0a', '#a0060b', '#b00c08', '#8e0508', '#760309', '#5a0006'],   // darker, as blood that has gathered
    layerBlend: 'source-over', layerAlpha: .96, cut: ['#5a0006', '#e8100c', '#ff6a5a'] },
};
// The room-wide display switches online (net.cfg, copied here by onRoomCfg: net is created further
// down), CFG offline. styleOverride: a page-local blood style set by the __mp.gore.setStyle test hook.
let roomView = { ...VIEW_DEFAULTS }, styleOverride = null;
const viewCfg = () => (ONLINE ? roomView : CFG);
const goreOn = () => !!viewCfg().gore;
const bloodStyleName = () => styleOverride || (viewCfg().realGore ? 'real' : 'neon');
let BSTYLE = BLOOD_STYLES[bloodStyleName()], BLOOD = BSTYLE.drops, POOL = BSTYLE.pools;
// Switch the palette and repaint: the baked decal/pool layer is rebuilt from G (and the stained
// spike tile, for levels that have spikes); nothing in the gore simulation changes.
function applyBloodStyle() {
  BSTYLE = BLOOD_STYLES[bloodStyleName()]; BLOOD = BSTYLE.drops; POOL = BSTYLE.pools;
  if (TILE.spikeBloody) TILE.spikeBloody = tileCanvas(drawSpikesBloody);
  if (GL.c) rebuildGoreLayer();
  dbg('perf', 'gore: blood style', { style: bloodStyleName() });
}
function rrect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function oval(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }
function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
let noGlow = false;            // set while drawing body pieces: dozens of blurred shadows are too slow
const blur = b => (noGlow ? 0 : b * SCALE);   // shadowBlur is in device pixels, so scale it with the view
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16), f = v => Math.min(255, Math.round(v * k));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// ---------- tiles: vector-drawn once per resize at native resolution ----------
const TILE = {};
function tileCanvas(draw) {
  const n = Math.ceil(T * SCALE), c = mk(n, n), g = c.getContext('2d');
  g.scale(n / T, n / T); draw(g); return c;
}
function drawSpikes(g) {
  for (let i = 0; i < 4; i++) {
    const bx = i * 4, grd = g.createLinearGradient(bx, 0, bx + 4, 0);
    grd.addColorStop(0, '#f4f6ff'); grd.addColorStop(.5, '#b4bce0'); grd.addColorStop(1, '#5a6088');
    g.fillStyle = grd; g.beginPath(); g.moveTo(bx + .25, 15.2); g.lineTo(bx + 2, 8.2); g.lineTo(bx + 3.75, 15.2); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(20,16,40,.6)'; g.lineWidth = .3; g.stroke();
  }
  g.fillStyle = '#2a2440'; g.fillRect(0, 15, T, 1);
  g.fillStyle = '#4a4468'; g.fillRect(0, 15, T, .3);
}
function buildTiles() {
  TILE.dirt = tileCanvas(g => {
    g.fillStyle = '#0f0c18'; g.fillRect(0, 0, T, T);
    const grd = g.createLinearGradient(0, 0, 0, T); grd.addColorStop(0, '#241d3c'); grd.addColorStop(1, '#16112a');
    g.fillStyle = grd; rrect(g, .6, .6, T - 1.2, T - 1.2, 1.6); g.fill();
    g.strokeStyle = 'rgba(120,100,200,.2)'; g.lineWidth = .4;
    g.beginPath(); g.moveTo(1.6, 8); g.lineTo(14.4, 8); g.moveTo(8, 1.6); g.lineTo(8, 8); g.stroke();
    g.fillStyle = '#3a3058';
    for (const [a, b] of [[2.4, 2.4], [13.6, 2.4], [2.4, 13.6], [13.6, 13.6]]) { g.beginPath(); g.arc(a, b, .55, 0, TAU); g.fill(); }
  });
  TILE.top = tileCanvas(g => {
    g.drawImage(TILE.dirt, 0, 0, T, T);
    const grd = g.createLinearGradient(0, 0, 0, 3.6); grd.addColorStop(0, '#4c4474'); grd.addColorStop(1, '#241e3c');
    g.fillStyle = grd; g.fillRect(0, 0, T, 3.6);
    g.fillStyle = 'rgba(249,248,113,.85)';
    for (const sx of [2, 10]) { g.beginPath(); g.moveTo(sx, 3); g.lineTo(sx + 1.2, 1.4); g.lineTo(sx + 4, 1.4); g.lineTo(sx + 2.8, 3); g.closePath(); g.fill(); }
  });
  TILE.block = tileCanvas(g => {
    const grd = g.createLinearGradient(0, 0, T, T); grd.addColorStop(0, '#2c1b4c'); grd.addColorStop(1, '#120b22');
    g.fillStyle = grd; rrect(g, .4, .4, T - .8, T - .8, 2.2); g.fill();
    g.strokeStyle = '#3a2668'; g.lineWidth = .8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(3.4, 3.4); g.lineTo(12.6, 12.6); g.moveTo(12.6, 3.4); g.lineTo(3.4, 12.6); g.stroke();
    g.shadowColor = NEON.pink; g.shadowBlur = blur(3);
    g.strokeStyle = NEON.pink; g.lineWidth = .7; rrect(g, 1.3, 1.3, T - 2.6, T - 2.6, 1.6); g.stroke();
    g.shadowBlur = 0;
  });
  TILE.plank = tileCanvas(g => {
    const grd = g.createLinearGradient(0, 0, 0, 3.4);
    grd.addColorStop(0, '#9a94c8'); grd.addColorStop(.3, '#4a4470'); grd.addColorStop(1, '#2a2444');
    g.fillStyle = grd; g.fillRect(0, 0, T, 3.4);
    g.fillStyle = '#120e1e'; for (let i = 2; i < T; i += 4) oval(g, i, 1.9, 1, .5);
    g.shadowColor = NEON.cyan; g.shadowBlur = blur(3);
    g.fillStyle = NEON.cyan; g.fillRect(0, 3.4, T, .6);
    g.shadowBlur = 0;
  });
  TILE.spike = tileCanvas(drawSpikes);
  TILE.spikeBloody = tileCanvas(drawSpikesBloody);
}
function drawSpikesBloody(g) {
  {
    drawSpikes(g);
    g.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const tx = i * 4 + 2, c1 = BLOOD[(i * 2) % 6], c2 = BLOOD[(i * 2 + 3) % 6];
      g.shadowBlur = blur(2.5);
      g.shadowColor = g.fillStyle = g.strokeStyle = c1;
      oval(g, tx, 9.5, .9, 1.4);
      g.lineWidth = .55; g.beginPath(); g.moveTo(tx - .2, 9.6); g.quadraticCurveTo(tx - 1, 12, tx - .5, 12.6 + (i % 3)); g.stroke();
      g.shadowColor = g.fillStyle = g.strokeStyle = c2;
      g.beginPath(); g.moveTo(tx + .3, 10.5); g.quadraticCurveTo(tx + 1.2, 12.5, tx + .9, 13.8 + (i % 2)); g.stroke();
      g.beginPath(); g.arc(tx + .9, 14 + (i % 2), .45, 0, TAU); g.fill();
    }
    g.shadowBlur = 0;
    g.globalAlpha = .7; g.fillStyle = NEON.purple; g.fillRect(0, 15, T, 1); g.globalAlpha = 1;
  }
}

// ---------- background: night city (vector, cached; capped resolution for memory) ----------
// Each skyline layer is one cached canvas. For speed, the sky is baked into the far layer
// (its horizontal scroll is invisible apart from the slow drift of moon and stars), the purple
// haze is baked into the layers instead of drawn over the screen each frame, and each layer

let BG_S = 1, CITY = [];
const CITY_W = 960;
function paintSky(g) {
  const grd = g.createLinearGradient(0, 0, 0, VH);
  grd.addColorStop(0, '#04020a'); grd.addColorStop(.5, '#140a26'); grd.addColorStop(.8, '#2e0c3c'); grd.addColorStop(1, '#4a0f4a');
  g.fillStyle = grd; g.fillRect(0, 0, CITY_W, VH);
  const r = rng(5);
  for (let i = 0; i < 135; i++) { g.fillStyle = `rgba(255,255,255,${.15 + r() * .4})`; g.beginPath(); g.arc(r() * CITY_W, r() * 75, .25 + r() * .35, 0, TAU); g.fill(); }
  g.shadowColor = '#ffb8f0'; g.shadowBlur = 30 * BG_S; g.fillStyle = 'rgba(255,214,250,.22)';   // hazy moon
  g.beginPath(); g.arc(250, 40, 13, 0, TAU); g.fill();
  g.shadowBlur = 0; g.fillStyle = 'rgba(255,230,255,.12)'; g.beginPath(); g.arc(247, 37, 9, 0, TAU); g.fill();
}
function cityLayer(o) {
  const c = mk(Math.ceil(CITY_W * BG_S), Math.ceil(VH * BG_S)), x = c.getContext('2d'), r = rng(o.seed), signs = [];
  x.scale(BG_S, BG_S); x.lineCap = 'round';
  if (o.sky) paintSky(x);
  const pick = a => a[(r() * a.length) | 0];
  const glow = (col, b) => { x.shadowColor = col; x.shadowBlur = b * BG_S; };
  let bx = 0, minTop = VH;
  while (bx < CITY_W) {
    let w = (o.minW + r() * (o.maxW - o.minW)) | 0;
    w = CITY_W - bx < o.minW * 1.5 ? CITY_W - bx : Math.min(w, CITY_W - bx);
    const h = (o.minH + r() * (o.maxH - o.minH)) | 0, top = o.base - h, body = pick(o.body);
    minTop = Math.min(minTop, top);
    // facade, lit slightly from above, with a crown on top
    const grd = x.createLinearGradient(0, top, 0, VH); grd.addColorStop(0, shade(body, 1.5)); grd.addColorStop(.4, body); grd.addColorStop(1, shade(body, .7));
    x.fillStyle = grd; x.fillRect(bx, top, w, VH - top);
    const roof = r();
    if (roof < .3 && w > 10) { x.fillRect(bx + w * .18, top - 6, w * .64, 6.2); x.fillRect(bx + w * .35, top - 10, w * .3, 4.2); }
    else if (roof < .55) { x.beginPath(); x.moveTo(bx, top + .2); x.lineTo(bx + w, top - Math.min(12, w * .4)); x.lineTo(bx + w, top + .2); x.closePath(); x.fill(); }
    else if (roof < .7 && w > 12) { x.beginPath(); x.moveTo(bx + 2, top + .2); x.lineTo(bx + w / 2, top - 9); x.lineTo(bx + w - 2, top + .2); x.closePath(); x.fill(); }
    x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(bx, top, .8, VH - top);   // edge highlight
    if (r() < .45) {                                                                // antenna + beacon
      const ah = 8 + r() * 14, ax = bx + w / 2;
      x.strokeStyle = shade(body, 1.6); x.lineWidth = .5; line(x, ax, top - 8, ax, top - 8 - ah);
      glow('#ff3040', 4); x.fillStyle = '#ff3040'; x.beginPath(); x.arc(ax, top - 8 - ah, .7, 0, TAU); x.fill(); x.shadowBlur = 0;
    }
    const wc = pick(o.win);                                                         // window grid
    for (let wy = top + 4; wy < VH - 2; wy += o.wy) for (let wx = bx + 2; wx < bx + w - 2; wx += o.wx) if (r() < o.density) {
      x.globalAlpha = .3 + r() * .55; x.fillStyle = r() < .85 ? wc : pick(o.win);
      x.fillRect(wx, wy, o.ww * .85, .9);
    }
    x.globalAlpha = 1;
    if (o.neon) {
      if (r() < .7) {                                                               // neon trim
        const nc = pick(NEON_LIST); glow(nc, o.glow); x.strokeStyle = nc; x.lineWidth = .7;
        if (r() < .5) line(x, bx + .5, top + .4, bx + w - .5, top + .4);
        else { const ex = bx + (r() < .5 ? .5 : w - .5); line(x, ex, top + .5, ex, VH); }
        x.shadowBlur = 0;
      }
      if (w >= 10 && r() < .65) {                                                   // vertical sign
        const sw = 5 + r() * 4, sh = 14 + r() * 22, sx = bx + 2 + r() * Math.max(1, w - sw - 4), sy = top + 6 + r() * 20, nc = pick(NEON_LIST);
        x.fillStyle = '#07040c'; rrect(x, sx, sy, sw, sh, 1.2); x.fill();
        glow(nc, o.glow); x.strokeStyle = nc; x.lineWidth = .6; rrect(x, sx + .4, sy + .4, sw - .8, sh - .8, 1); x.stroke();
        x.lineWidth = .45; x.beginPath();
        for (let gy = sy + 3; gy < sy + sh - 3; gy += 3.6) {                        // made-up glyphs
          const gx = sx + 1.6, gw = sw - 3.2;
          x.moveTo(gx + r() * gw * .3, gy); x.lineTo(gx + gw * (.6 + r() * .4), gy + r() * .8);
          x.moveTo(gx + gw * (.3 + r() * .4), gy - .6); x.lineTo(gx + gw * (.3 + r() * .4), gy + 1.4);
        }
        x.stroke(); x.shadowBlur = 0;
        signs.push({ x: sx - 1, y: sy - 1, w: sw + 2, h: sh + 2, seed: r() * 1000 | 0 });
      }
      if (w >= 26 && r() < .4) {                                                    // billboard
        const bw = w - 8, bh = 9, bxx = bx + 4, by = top + 30 + r() * 24, nc = pick(NEON_LIST), nc2 = pick(NEON_LIST);
        x.fillStyle = '#0a0612'; rrect(x, bxx, by, bw, bh, 1.5); x.fill();
        glow(nc, o.glow); x.strokeStyle = nc; x.lineWidth = .6; rrect(x, bxx + .4, by + .4, bw - .8, bh - .8, 1.2); x.stroke();
        glow(nc2, o.glow * .6); x.strokeStyle = nc2; x.lineWidth = .8; x.beginPath();
        for (let i = bxx + 2.5; i < bxx + bw - 3; i += 3 + r() * 3) { const y0 = by + 2.5 + r() * 2; x.moveTo(i, y0); x.lineTo(i + 1.2 + r(), y0 + r() * 2.5); }
        x.stroke(); x.shadowBlur = 0;
        signs.push({ x: bxx - 1, y: by - 1, w: bw + 2, h: bh + 2, seed: r() * 1000 | 0 });
      }
    }
    bx += w + (r() * 3 | 0);
  }
  // bake in the atmospheric haze (only over what this layer has drawn)
  x.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < o.haze; i++) {
    const hz = x.createLinearGradient(0, 40, 0, VH);
    hz.addColorStop(0, 'rgba(60,10,70,0)'); hz.addColorStop(1, 'rgba(90,15,90,.45)');
    x.fillStyle = hz; x.fillRect(0, 0, CITY_W, VH);
  }
  x.globalCompositeOperation = 'source-over';
  return { c, signs, k: o.k, top: o.sky ? 0 : Math.max(0, Math.floor(minTop - 34)) };
}
function buildCity() {
  CITY = [
    cityLayer({ seed: 3, base: VH, minH: 80, maxH: 160, minW: 12, maxW: 26, body: ['#0e0a1c', '#110c22', '#0c0d20'],
                win: ['#05d9e8', '#ff6ec7', '#7a6cff'], density: .1, wx: 3, wy: 3, ww: 1, neon: false, glow: 0, k: .08, sky: true, haze: 2 }),
    cityLayer({ seed: 9, base: VH, minH: 70, maxH: 145, minW: 18, maxW: 38, body: ['#170f2c', '#1a1030', '#10142c', '#1e0d2a'],
                win: ['#05d9e8', '#f9f871', '#ff2a6d', '#b026ff'], density: .16, wx: 4, wy: 4, ww: 2, neon: true, glow: 4, k: .2, haze: 1 }),
    cityLayer({ seed: 21, base: VH, minH: 45, maxH: 115, minW: 24, maxW: 48, body: ['#0a0614', '#0d0818', '#100a1c'],
                win: ['#05d9e8', '#ff2a6d', '#f9f871'], density: .12, wx: 5, wy: 5, ww: 2, neon: true, glow: 6, k: .38, haze: 0 }),
  ];
}
const RAIN = (() => { const r = rng(4242); for (let i = 0; i < 10; i++) r(); return Array.from({ length: 110 }, () => ({ x: r() * (VW + 40), y: r() * VH, s: 3 + r() * 2 })); })();
const CARS = [{ y: 34, v: .5, o: 0 }, { y: 58, v: -.35, o: 400 }, { y: 22, v: .8, o: 700 }, { y: 75, v: -.6, o: 150 }];

// ---------- sizing: canvas matches the screen's real pixels ----------
const stage = document.getElementById('stage');
// Touch UI: on when the browser says its main pointer is coarse (or ?touch), and also the moment a
// finger really touches the page (tablets with a mouse, Android "desktop site" mode, some browsers
// that report a fine pointer). It only adds buttons; keys and gamepad keep working.
let TOUCH_UI = matchMedia('(pointer: coarse)').matches || QS.has('touch');
function enableTouchUI() {
  if (TOUCH_UI) return;
  TOUCH_UI = true;
  document.body.classList.add('touchui');
  noteDevice('touch'); resize();
}
function resize() {
  // Phones held upright get the whole game turned sideways, so it is always played in landscape.
  const rot = TOUCH_UI && innerHeight > innerWidth;
  const W = rot ? innerHeight : innerWidth, H = rot ? innerWidth : innerHeight;
  stage.classList.toggle('rot', rot);
  document.body.classList.toggle('rot', rot);
  Object.assign(stage.style, rot ? { width: W + 'px', height: H + 'px', left: innerWidth + 'px' } : { width: '', height: '', left: '' });
  const s = Math.min(W / VW, H / VH), dpr = QS.has('lowdpr') ? 1 : Math.min(window.devicePixelRatio || 1, 2.5);
  cv.style.width = VW * s + 'px'; cv.style.height = VH * s + 'px';
  cv.width = Math.round(VW * s * dpr); cv.height = Math.round(VH * s * dpr);
  SCALE = cv.width / VW;
  BG_S = Math.min(SCALE, 3);
  buildTiles(); buildCity();
}
let resizeTimer = 0;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
addEventListener('orientationchange', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 250); });
resize();

// ---------- audio: NinjaRunner's synthesised SFX, and the music (music.js) ----------
let AC = null, muted = false, musicOff = false;   // muted: all sound; musicOff: just the music
// Touch devices get a bigger audio buffer ('playback' latency), as in NinjaRunner.
// ?full forces the desktop version, ?lite the phone version, ?latency= overrides the buffer.
const LITE_AUDIO = QS.has('lite') || (!QS.has('full') && matchMedia('(pointer: coarse)').matches);
function initAudio() {
  if (!AC) {
    const opts = {};
    opts.latencyHint = QS.get('latency') || (LITE_AUDIO ? 'playback' : 'interactive');
    if (+QS.get('rate')) opts.sampleRate = +QS.get('rate');
    try { AC = new (window.AudioContext || window.webkitAudioContext)(opts); } catch (e) { dbg('audio', 'no audio context', { err: String(e.message) }); }
    if (AC) {
      dbg('audio', 'context created', { mode: LITE_AUDIO ? 'lite' : 'full', rate: AC.sampleRate, state: AC.state });
      AC.onstatechange = () => dbg('audio', 'context ' + AC.state);
    }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  if (AC && !music && !QS.has('nomusic')) {
    music = createMusic({ ac: AC, out: audioOut(), lite: LITE_AUDIO, log: (m, d) => dbg('audio', m, d) });
    music.target = CFG.musicVol; music.muted = muted || musicOff;
    music.start();   // renders in the background; plays when ready
  }
}
let music = null;
// Sound, music and full screen survive a reload (per browser, localStorage). Full screen can only be
// asked for from a tap or a key, so a page that was full screen goes back to it on the first one.
const LS_PREFS = 'multisplat-prefs';
function prefsGet() { try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch (e) { return {}; } }
function prefsSet(k, v) { try { localStorage.setItem(LS_PREFS, JSON.stringify({ ...prefsGet(), [k]: v })); } catch (e) { /* private mode */ } }
function setMuted(m) {
  prefsSet('muted', !!m);
  muted = m; if (music) { music.muted = muted || musicOff; music.apply(); } dbg('audio', m ? 'muted' : 'unmuted');
  soundBtn('muteBtn', m, m ? 'Sound on (M)' : 'Mute all sound (M)');
  document.getElementById('musicBtn')?.classList.toggle('dim', !!m);   // all sound off: the music can't play either
}
// The ♫ button and N: the music alone (sound effects carry on).
function setMusicOff(m) {
  prefsSet('musicOff', !!m);
  musicOff = m; if (music) { music.muted = muted || musicOff; music.apply(); } dbg('audio', m ? 'music off' : 'music on');
  soundBtn('musicBtn', m, m ? 'Music on (N)' : 'Music off (N)');
}
function soundBtn(id, on, label) {
  const b = document.getElementById(id);
  if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.title = label; b.setAttribute('aria-label', label); }
}
document.addEventListener('visibilitychange', () => { if (AC) { if (document.hidden) AC.suspend(); else AC.resume(); } });
// Everything plays through one master gain.
let MASTER = null;
function audioOut() {
  if (!MASTER) { MASTER = AC.createGain(); MASTER.connect(AC.destination); }
  return MASTER;
}
function tone(f, d, type = 'square', f2 = null, v = .06, delay = 0) {
  if (!AC || muted || QS.has('nosfx')) return;
  const t = AC.currentTime + delay, o = AC.createOscillator(), gn = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  gn.gain.setValueAtTime(v, t); gn.gain.exponentialRampToValueAtTime(.001, t + d);
  o.connect(gn).connect(audioOut()); o.start(t); o.stop(t + d + .02);
}
function noise(d, v = .15, delay = 0, freq = 1200) {
  if (!AC || muted || QS.has('nosfx')) return;
  const t = AC.currentTime + delay, n = AC.sampleRate * d | 0, buf = AC.createBuffer(1, n, AC.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const src = AC.createBufferSource(), f = AC.createBiquadFilter(), gn = AC.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; gn.gain.value = v;
  src.connect(f).connect(gn).connect(audioOut()); src.start(t);
}
const sfx = {
  // glass smash: a bright crack, a burst of high noise, then tinkling shards
  smash: (v = 1) => {
    noise(.05, .5 * v, 0, 9000); noise(.28, .3 * v, .01, 6500); noise(.5, .1 * v, .08, 11000);
    [2900, 4100, 3400, 5200, 2500, 4700, 3800].forEach((f, i) => tone(f, .07 + (i % 3) * .03, 'triangle', f * .82, .035 * v, .03 + i * .045));
  },
  slash: () => { noise(.12, .12, 0, 5000); tone(1200, .09, 'sawtooth', 300, .02); },
  slice: () => { noise(.15, .25, 0, 3000); tone(300, .15, 'square', 70, .07); },
  gush: () => { noise(1.2, .12, .05, 700); noise(.6, .08, .3, 400); },
  impale: () => { noise(.18, .35, 0, 2500); tone(120, .35, 'square', 35, .09); noise(.5, .15, .1, 500); },
  jump: () => tone(320, .16, 'square', 640, .05),
  stomp: () => tone(260, .12, 'square', 80, .07),
  bonk: () => tone(140, .08, 'triangle', 90, .1),
  chat: () => { tone(880, .07, 'sine', 1180, .035); tone(1320, .08, 'sine', null, .02, .06); },   // a soft blip for a chat line
  die: () => [523, 392, 330, 262].forEach((f, i) => tone(f, .16, 'square', null, .05, i * .15)),
  check: () => { tone(660, .1, 'triangle', null, .08); tone(880, .2, 'triangle', null, .08, .1); },
  // long sword taken: a metallic draw (bright noise sweep) and a rising neon-bell arpeggio.
  // v scales it: 1 for the one who took it, quieter for players nearby.
  pickup: (v = 1) => {
    noise(.35, .1 * v, 0, 6500); tone(1800, .3, 'sawtooth', 2600, .025 * v);
    [659, 988, 1319, 1976].forEach((f, i) => tone(f, .22, 'triangle', null, .07 * v, .05 + i * .07));
  },
  // a long sword appeared: a soft, high shimmer
  item: (v = 1) => { tone(1568, .5, 'sine', 2093, .035 * v); tone(2349, .4, 'sine', null, .02 * v, .12); },
  // ninja stars (SPEC §5.2). Throw: a short airy whip with a rising whistle; hit: a hard metallic
  // tick and a dull thud; pickup: three quick bright clinks (steel on steel)
  // a ninja star leaving the hand: a "swish" of air, band-passed noise sweeping up and back down
  throw: (v = 1) => {
    if (!AC || muted || QS.has('nosfx')) return;
    const d = .24, t = AC.currentTime, n = AC.sampleRate * d | 0, buf = AC.createBuffer(1, n, AC.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = Math.random() * 2 - 1;
    const src = AC.createBufferSource(), f = AC.createBiquadFilter(), gn = AC.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.Q.value = 1.6;
    f.frequency.setValueAtTime(700, t); f.frequency.exponentialRampToValueAtTime(5200, t + .09); f.frequency.exponentialRampToValueAtTime(1400, t + d);
    gn.gain.setValueAtTime(.0001, t); gn.gain.exponentialRampToValueAtTime(.55 * v, t + .05); gn.gain.exponentialRampToValueAtTime(.0001, t + d);
    src.connect(f).connect(gn).connect(audioOut()); src.start(t);
    tone(1500, .12, 'triangle', 3200, .03 * v);
  },
  starHit: (v = 1) => { tone(2600, .05, 'square', 1200, .05 * v); noise(.08, .22 * v, 0, 4500); tone(180, .1, 'square', 60, .06 * v, .01); },
  starPickup: (v = 1) => { [2093, 2637, 3136].forEach((f, i) => { tone(f, .09, 'square', null, .025 * v, i * .05); tone(f * 1.5, .07, 'sine', null, .03 * v, i * .05 + .01); }); noise(.06, .06 * v, 0, 8000); },
  starWall: (v = 1) => { tone(3200, .04, 'square', 1800, .025 * v); noise(.04, .08 * v, 0, 6000); },
};

// ---------- input: keyboard and gamepad -> one bitmask per tick ----------
// Keys are level-triggered bits. A press that starts and ends between two ticks is latched so it
// still reaches the sim for one tick (NinjaRunner queued jump and slash presses the same way).
const keys = {};
let latch = 0;
const JUMP_KEYS = ['ArrowUp', 'KeyZ'];
const KEYMAP = {
  ArrowLeft: KEY.LEFT, ArrowRight: KEY.RIGHT, ArrowUp: KEY.JUMP, KeyZ: KEY.JUMP,
  ShiftLeft: KEY.RUN, ShiftRight: KEY.RUN, Space: KEY.SLASH, KeyX: KEY.THROW,   // X throws a ninja star (run is Shift only)
};
let lastDevice = null;
function noteDevice(d) { if (d !== lastDevice) { lastDevice = d; dbg('input', 'device ' + d); } }
addEventListener('gamepadconnected', e => dbg('input', 'gamepad connected', { id: String(e.gamepad.id).slice(0, 60) }));
addEventListener('gamepaddisconnected', () => dbg('input', 'gamepad disconnected'));
addEventListener('orientationchange', () => dbg('input', 'orientation', { type: screen.orientation ? screen.orientation.type : String(window.orientation) }));
function padBits() {
  let b = 0;
  for (const gp of (navigator.getGamepads ? navigator.getGamepads() : [])) {
    if (!gp) continue;
    const btn = i => gp.buttons[i] && gp.buttons[i].pressed, ax = gp.axes[0] || 0;
    if (ax < -.4 || btn(14)) b |= KEY.LEFT;
    if (ax > .4 || btn(15)) b |= KEY.RIGHT;
    if (btn(0) || btn(12)) b |= KEY.JUMP;               // A / d-pad up
    if (btn(2) || btn(1)) b |= KEY.SLASH;               // X / B
    if (btn(3)) b |= KEY.THROW;                         // Y: throw a ninja star
    if (btn(4) || btn(5) || btn(6) || btn(7)) b |= KEY.RUN;   // bumpers / triggers
  }
  if (b) noteDevice('gamepad');
  return b;
}
function heldBits() {
  let b = 0;
  for (const code in KEYMAP) if (keys[code]) b |= KEYMAP[code];
  return b | padBits();
}
addEventListener('keydown', e => {
  if (chatKey(e)) return;   // the chat box owns the keyboard while open; C opens it
  if (updOpen) { if (e.code === 'Enter' || e.code === 'Space') location.reload(); e.preventDefault(); return; }   // the update dialog (SPEC §18): only OK
  if (admOpen) { if (e.code === 'Escape') { e.preventDefault(); admDialog(null); } return; }
  if (rnmOpen) { if (e.code === 'Escape') { e.preventDefault(); renameDialog(false); } else if (e.code === 'Enter' && e.target.id === 'lRenameIn') renameRoom('lRenameIn'); return; }   // the confirm dialog: Enter presses the focused button (Cancel by default)
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') {   // Enter in a lobby or menu field does that field's job
    if (e.code === 'Enter') ({ lRoomName: createRoom }[e.target.id] || fight)();
    else if (e.code === 'Escape' && leaveOpen) leaveMenu(false);
    return;
  }
  if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { toggleFullscreen(); return; }
  if (e.code === 'KeyH' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !leaveOpen) { helpScreen(!helpOpen); return; }
  if (helpOpen) { if (e.code === 'Escape' || e.code === 'Enter') helpScreen(false); if (e.code === 'Tab') e.preventDefault(); return; }
  if (lobbyOpen && e.code === 'Enter' && !(e.target.closest && e.target.closest('button'))) { fight(); return; }   // Enter on a focused button presses that
  if (e.code === 'Escape' && watching) { if (!e.repeat && !lobbyOpen && !escLeavesFullscreen()) watch(false); return; }   // SPEC §16: nothing to lose, no menu
  if (e.code === 'Escape') { if (!e.repeat && !lobbyOpen && !(escLeavesFullscreen() && !leaveOpen)) leaveMenu(!leaveOpen); return; }
  if (watching && !lobbyOpen && watchKey(e)) return;   // ← → switch the followed ninja, ↓ back to the leader
  if (leaveOpen) return;   // the menu owns the keyboard (Enter presses the focused button, Tab moves between them)
  if (e.code === 'KeyD' && !e.repeat) { toggleDebug(); return; }
  noteDevice('keyboard');
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') e.target.blur(); // keep keys driving the game
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
  initAudio();
  if (!keys[e.code] && KEYMAP[e.code]) latch |= KEYMAP[e.code];
  keys[e.code] = true;
  if (e.code === 'KeyM' && !e.repeat) setMuted(!muted);
  if (e.code === 'KeyN' && !e.repeat) setMusicOff(!musicOff);
  if (e.code === 'Tab') { e.preventDefault(); board(true); }
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'Tab') board(false); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; board(false); fingers.clear(); syncTouch(); });
addEventListener('pointerdown', () => initAudio());
// iOS Safari only unlocks audio from a finished touch or a click, not from pointerdown
addEventListener('touchend', () => initAudio(), { capture: true, passive: true });
addEventListener('click', () => initAudio(), true);

// ---------- touch (NinjaRunner): big round buttons, every finger tracked on its own ----------
// A finger can slide from button to button (◀ to ▶, or ▶ onto ⤒ to jump mid-run). Run (») is an
// on/off toggle, as in NinjaRunner, so one thumb is free for ◀ ▶ and the other for jump and slash.
// The bits are OR-ed into the same per-tick mask as the keyboard; presses are latched like keys.
const TOUCH_BTN = { tL: KEY.LEFT, tR: KEY.RIGHT, tJ: KEY.JUMP, tS: KEY.SLASH, tT: KEY.THROW };
const THROW_SYMBOL = '✦';     // the touch throw button's label, also used in the "to throw" reminder
const fingers = new Map();   // pointerId -> id of the button under that finger (or null)
let touchRun = false, touchHeld = 0;
const pad = document.getElementById('touch');
if (TOUCH_UI) document.body.classList.add('touchui');
addEventListener('pointerdown', e => { if (e.pointerType === 'touch') enableTouchUI(); }, true);
// No zoom, ever: two fingers must not pinch the page (iOS Safari ignores user-scalable=no and
// max-scale). Two fingers on two buttons are still two pointers, so presses are unaffected.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
addEventListener('touchstart', enableTouchUI, { capture: true, passive: true });
function btnAt(x, y) {
  const b = document.elementFromPoint(x, y)?.closest?.('#touch button');
  return b && TOUCH_BTN[b.id] ? b.id : null;
}
function fingerOn(pid, id) {
  if (fingers.get(pid) === id) return;
  fingers.set(pid, id);
  if (id) latch |= TOUCH_BTN[id];
  syncTouch();
}
function syncTouch() {
  const held = new Set(fingers.values());
  touchHeld = 0;
  for (const [id, bit] of Object.entries(TOUCH_BTN)) {
    if (held.has(id)) touchHeld |= bit;
    document.getElementById(id).classList.toggle('on', held.has(id));
  }
}
const touchBits = () => touchHeld | (touchRun ? KEY.RUN : 0);
pad.addEventListener('pointerdown', e => {
  noteDevice('touch'); initAudio();
  if (e.target.id === 'tRun') { e.preventDefault(); touchRun = !touchRun; e.target.classList.toggle('on', touchRun); return; }
  const id = btnAt(e.clientX, e.clientY); if (!id) return;
  e.preventDefault(); fingerOn(e.pointerId, id);
});
pad.addEventListener('pointermove', e => { if (fingers.has(e.pointerId)) fingerOn(e.pointerId, btnAt(e.clientX, e.clientY)); });
for (const ev of ['pointerup', 'pointercancel']) pad.addEventListener(ev, e => { if (fingers.delete(e.pointerId)) syncTouch(); });
addEventListener('contextmenu', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
// the small top bar on touch screens: sound and full screen
const tapBtn = (id, fn) => document.getElementById(id).addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); initAudio(); fn(); });
tapBtn('tLeave', () => (watching ? watch(false) : leaveMenu(true)));   // a watcher goes straight back (SPEC §16)
tapBtn('tHelp', () => helpScreen(true));
// On phones that allow it (Android), joining the fight goes full screen and locks landscape.
let triedLandscape = false;
// ---------- full screen (SPEC §9): a button top right on desktop and touch, in game and lobby ----------
// It toggles full screen (Fullscreen API, webkit fallback), shows the current state and follows
// changes made elsewhere (Escape, the browser's own UI). F toggles it too (not while typing a name).
// On touch, entering also asks for landscape, as the old ⛶ button did (goLandscape).
// Escape in full screen: the browser takes that press to leave full screen. Some browsers still pass
// the key on, so an Escape while in full screen, or within 500 ms of leaving it, does not open the
// leave menu; the next Escape does.
const fsBtn = document.getElementById('fsBtn');
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
let fsLeftAt = -1e9, fsWas = false;
if (!FS_OK) document.body.classList.add('nofs');
function syncFullscreen() {
  const on = !!fsEl();
  fsBtn.classList.toggle('on', on);
  fsBtn.setAttribute('aria-pressed', String(on));
  const label = on ? 'Leave full screen (F)' : 'Full screen (F)';
  fsBtn.title = label; fsBtn.setAttribute('aria-label', label);
  if (fsWas && !on) fsLeftAt = performance.now();
  if (fsWas !== on) dbg('input', on ? 'full screen on' : 'full screen off');
  fsWas = on;
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, syncFullscreen);
function toggleFullscreen() {
  if (!FS_OK) return;
  if (fsEl()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve().then(() => exit.call(document)).catch(() => {});
    return;
  }
  if (TOUCH_UI) { triedLandscape = false; goLandscape(true); return; }
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  Promise.resolve().then(() => req.call(el)).catch(e => dbg('input', 'full screen refused', { e: String(e && e.name) }));
}
fsBtn.addEventListener('click', e => { e.preventDefault(); initAudio(); toggleFullscreen(); fsBtn.blur(); });
fsBtn.addEventListener('pointerdown', e => e.stopPropagation());
const muteBtn = document.getElementById('muteBtn');
muteBtn.addEventListener('click', e => { e.preventDefault(); initAudio(); setMuted(!muted); muteBtn.blur(); });
muteBtn.addEventListener('pointerdown', e => e.stopPropagation());
const musicBtn = document.getElementById('musicBtn');
musicBtn.addEventListener('click', e => { e.preventDefault(); initAudio(); setMusicOff(!musicOff); musicBtn.blur(); });
musicBtn.addEventListener('pointerdown', e => e.stopPropagation());
// Escape that only took us out of full screen must not also open the leave menu
const escLeavesFullscreen = () => !!fsEl() || performance.now() - fsLeftAt < 500;
syncFullscreen();
// remember full screen as the player leaves it (button, F or Esc), and bring the saved choices back
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => prefsSet('fullscreen', !!fsEl()));
{
  const p = prefsGet();
  if (p.muted) setMuted(true);
  if (p.musicOff) setMusicOff(true);
  if (p.fullscreen && FS_OK && !fsEl()) {
    const again = e => {
      if (e.target && e.target.closest && e.target.closest('#fsBtn')) return;   // that tap toggles it itself
      for (const t of ['click', 'keydown', 'touchend']) document.removeEventListener(t, again, true);
      if (!fsEl()) toggleFullscreen();
    };
    for (const t of ['click', 'keydown', 'touchend']) document.addEventListener(t, again, true);
  }
}

function goLandscape(force) {
  if (triedLandscape || (!force && !TOUCH_UI)) return;
  triedLandscape = true;
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement) return;
  Promise.resolve().then(() => req.call(el)).then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  dbg('input', 'fullscreen + landscape requested');
}

// ---------- world ----------
const S = { tick: 0, camX: 0, camY: 0, shake: 0 };   // view state (the sim state is `state`)
const L = { ...LEVEL, bloody: new Set() };          // the arena plus spikes that have drawn blood
let ME = 1;                    // the local player's id (assigned by the server when online)
const DUMMY = 2;
const metaOf = id => (ONLINE ? net.meta.get(id) : null);
const colorOf = id => {
  const m = metaOf(id);
  if (m) return PALETTE[m.color] || COLORS[0];   // PALETTE: COLORS plus the bots' own (SPEC §15)
  return id === ME ? COLORS[0] : COLORS[(id * 3) % COLORS.length];
};
const nameOf = id => { const m = metaOf(id); return m ? m.name : id === ME ? 'you' : 'dummy'; };
const simCfg = () => (ONLINE ? net.cfg : CFG);   // online: the room's settings, as the server steps it
let state = Sim.createWorld({ seed: (Math.random() * 2147483646 | 0) + 1 });
let goreMs = 0, renderMs = 0, feedDirty = true;
const eventLog = [];          // recent sim events, for scripted checks
let corpses = [], popups = [], sparks = [];   // sparks: a star hitting a wall
// Gore (gore.js): simulated here on every client from the server's kill seeds, never on the server.
const G = createGore(L);
const goreLog = { at: {} };   // throttles the cap messages
G.onCap = (what, n) => {
  const now = performance.now();
  if (now - (goreLog.at[what] || -1e9) > 10000) { goreLog.at[what] = now; dbg('perf', 'gore: ' + what + ' cap reached', { n, ...G.stats }); }
};
const feed = [];              // kill feed: {killer, victim, move, t}
const forced = {};            // window.__mp.input: per-id bitmask overrides for scripted checks
let autopilot = null;         // window.__mp.autopilot = (me, players) => bitmask, for scripted play

function onEvents(evs) {
  for (const e of evs) {
    if (e.type === 'chat') { onChatEvent(e); continue; }   // chat text stays out of eventLog
    eventLog.push(e); if (eventLog.length > 200) eventLog.shift();
    const near = e.id === ME || e.attacker === ME || e.victim === ME;
    if (e.type === 'hit') {
      if (e.move === 'star') sfx.starHit(near ? 1 : .7); else sfx.slice();
      popups.push({ x: e.x + 5, y: e.y - 4, t: 40, s: String(e.dmg) });
      if (near) S.shake = Math.max(S.shake, e.move === 'star' ? 3 : 4);
      if (goreOn()) {   // spurt along the blow: away from where we see the attacker (a star: along its flight)
        const a = Sim.getPlayer(state, e.attacker);
        goreHit(G, e, e.move === 'star' ? (e.dir || 0) : a ? (a.x <= e.x ? 1 : -1) : 0);
      }
    } else if (e.type === 'kill') {
      const v = Sim.getPlayer(state, e.victim);
      if (!ONLINE && e.victim === ME && e.held) dbg('life', 'long sword lost', { cause: 'death', move: e.move });
      if (!ONLINE && e.victim === ME && e.stars) dbg('life', 'stars lost', { n: e.stars, cause: 'death' });
      feed.push({ killer: e.killer, victim: e.victim, move: e.move, long: !!e.long, star: e.move === 'star', t: performance.now(), kc: colorOf(e.killer), vc: colorOf(e.victim), kn: e.killer != null ? nameOf(e.killer) : null, vn: nameOf(e.victim) });
      if (feed.length > 5) feed.shift();
      feedDirty = true;
      if (music) music.intensity();
      const f = focus(), dx = f.x - e.x, dy = f.y - e.y;
      if (dx * dx + dy * dy <= 120 * 120) S.shake = Math.max(S.shake, near ? 10 : 7);   // anyone within 120 units feels it
      if (goreOn()) {
        const t0 = performance.now();
        goreKill(G, e, { meta: colorOf(e.victim) });
        // a holder's sword piece is not drawn: the server's real long-sword pickup lies there instead
        // (drawing only: its physics and the fingerprint are unchanged)
        if (e.held) for (const g of G.gibs) if (g.id === 'S' && g.victim === e.victim && g.age === 0) g.hidden = true;
        dbg('perf', 'gore: kill', { kill: killKey(e), move: e.move, parts: G.parts.length, gibs: G.gibs.length, decals: G.decals.length, ms: +(performance.now() - t0).toFixed(2) });
        sfx.gush();
        if (e.move === 'spikes') sfx.impale();
        if (e.victim === ME) sfx.die();
        continue;
      }
      corpses.push({ id: e.victim, x: e.x, y: e.y, vx: e.vx * .5, vy: Math.min(e.vy, -2.5), face: e.face, t: 50, impaled: e.move === 'spikes', w: v ? v.w : 10 });
      if (e.move === 'spikes') {
        sfx.impale();
        const ty = Math.floor((e.y + 13) / T);
        for (let tx = Math.floor(e.x / T); tx <= Math.floor((e.x + 9) / T); tx++) if (L.grid[ty]?.[tx] === '^') L.bloody.add(tx + ',' + ty);
      } else { sfx.gush(); }
      if (e.victim === ME) sfx.die();
    } else if (e.type === 'spawn') {
      if (e.id === ME) { sfx.check(); snapCamera(); }
    } else if (e.type === 'pickup') {
      // the taker hears it fully, players within 160 units fainter with distance
      const f = focus(), d = Math.hypot(f.x + 5 - e.x, f.y + 13 - e.y), star = e.kind === 'star';
      const play = star ? sfx.starPickup : sfx.pickup;
      if (e.id === ME) play(1); else if (d < 160) play(.25 + .35 * (1 - d / 160));
      if (star && e.id === ME) {                    // remind the key above our Kanbei, flash the count
        throwHintUntil = performance.now() + THROW_HINT_MS;
        const el = document.getElementById('hStars'); el.classList.remove('got'); void el.offsetWidth; el.classList.add('got');
      }
      if (!ONLINE && e.id === ME) dbg('life', star ? 'stars gained' : 'long sword taken', { item: e.item, x: e.x, y: e.y, ...(star ? { gain: e.gain, now: e.stars, ...(e.left ? { left: e.left } : {}) } : {}) });
    } else if (e.type === 'throw') {
      if (!ONLINE && e.id === ME) dbg('life', 'star thrown', { star: e.star, left: e.stars });
    } else if (e.type === 'starEnd') {
      const f = focus(), d = Math.hypot(f.x + 5 - e.x, f.y + 13 - e.y);
      if (e.wall && d < 200) { sfx.starWall(.3 + .7 * (1 - d / 200)); sparks.push({ x: e.x, y: e.y, t: 10 }); }
    } else if (e.type === 'break') {
      // a lying long sword was slashed: it shatters like glass
      const f = focus(), d = Math.hypot(f.x + 5 - e.x, f.y + 13 - e.y);
      if (d < 260) sfx.smash(.35 + .65 * (1 - d / 260));
      for (let i = 0; i < 5; i++) sparks.push({ x: e.x - 6 + i * 3, y: e.y - 3 - (i * 5) % 11, t: 10 + i * 2 });
      if (e.id === ME) dbg('life', 'long sword smashed', { item: e.item });
    } else if (e.type === 'item') {
      const f = focus(), d = Math.hypot(f.x + 5 - e.x, f.y + 13 - e.y);
      if (d < 240) sfx.item(.4 + .6 * (1 - d / 240));
    }
    // (kills: the feed, the music's intensity, shake within 120 units and the gore, seeded by e.seed)
  }
}

// The dummy: stands or wanders, and (debug switch) slashes when the local player is close.
const dummyAI = { dir: 0, until: 0, jumpAt: 0, slashAt: 0 };
function dummyKeys(d, me) {
  if (!d || !d.alive) return 0;
  let k = 0;
  if (CFG.dummyWander) {
    if (S.tick >= dummyAI.until) {
      dummyAI.dir = [-1, 0, 1, 1, -1][Math.random() * 5 | 0];
      dummyAI.until = S.tick + 40 + (Math.random() * 100 | 0);
      if (Math.random() < .35) dummyAI.jumpAt = S.tick + (Math.random() * 30 | 0);
    }
    if (d.x < 20) dummyAI.dir = 1; else if (d.x > L.w * T - 30) dummyAI.dir = -1;
    // like NinjaRunner's bugs, turn back before walking into spikes
    const ahead = Math.floor((d.x + 5 + dummyAI.dir * 14) / T), row = Math.floor((d.y + d.h - 1) / T);
    if (dummyAI.dir && d.onGround && L.grid[row]?.[ahead] === '^') dummyAI.dir = -dummyAI.dir;
    if (dummyAI.dir < 0) k |= KEY.LEFT; else if (dummyAI.dir > 0) k |= KEY.RIGHT;
    if (S.tick - dummyAI.jumpAt >= 0 && S.tick - dummyAI.jumpAt < 12) k |= KEY.JUMP;
  }
  if (CFG.dummySlash && me && me.alive) {
    const dx = me.x - d.x;
    if (Math.abs(dx) < 34 && Math.abs(me.y - d.y) < 16) {
      k = (k & ~(KEY.LEFT | KEY.RIGHT)) | (dx < 0 ? KEY.LEFT : KEY.RIGHT);
      if (S.tick >= dummyAI.slashAt) { k |= KEY.SLASH; dummyAI.slashAt = S.tick + 24; }
    }
  }
  return k;
}

function update() {
  S.tick++;
  if (S.shake > 0) S.shake--;
  if (ONLINE) updateOnline(); else updateOffline();
  if (G.parts.length || G.gibs.length || G.decals.length || G.pools.size) {
    const t0 = performance.now();
    stepGore(G);
    goreMs = goreMs * .95 + (performance.now() - t0) * .05;
  }
  corpses = corpses.filter(c => { c.vy += .3; c.x += c.vx; c.y += c.vy; if (c.impaled) c.vx = c.vy = 0; return --c.t > 0; });
  popups = popups.filter(p => (p.y -= .5, --p.t > 0));
  sparks = sparks.filter(k => --k.t > 0);
  followCamera();
}

function playFx(p) {
  if (!p.fx) return;
  if (p.fx & FX.JUMP) sfx.jump();
  if (p.fx & FX.SLASH) sfx.slash();
  if (p.fx & FX.BONK) sfx.bonk();
  if (p.fx & FX.LAND && p.standOn != null) sfx.stomp();
  if (p.fx & FX.THROW) { sfx.throw(p.id === ME ? 1 : .7); throwAnims.set(p.id, S.tick); dbg('audio', 'throw swish', { id: p.id }); }
}

// Online: sample input, predict our player and queue the input for the server (sent per frame).
function updateOnline() {
  ME = net.id ?? -1;
  if (chatOpen && (lobbyOpen || leaveOpen || helpOpen || net.mode === 'viewer')) chatScreen(false);   // another screen took over
  let k = lobbyOpen || leaveOpen || helpOpen || chatOpen ? 0 : heldBits() | touchBits() | latch;
  latch = 0;
  if (forced[ME] !== undefined) k = forced[ME];
  if (autopilot && net.me) { try { k = autopilot(net.me, state.players) | 0; } catch (e) { dbg('error', 'autopilot: ' + e.message); } }
  net.localTick(k);
  if (net.me && net.me.alive) playFx(net.me);
  onEvents(net.dueEvents());
}

function updateOffline() {
  const me = Sim.getPlayer(state, ME), d = Sim.getPlayer(state, DUMMY);
  const inputs = { [ME]: heldBits() | touchBits() | latch, [DUMMY]: dummyKeys(d, me) };
  latch = 0;
  for (const id in forced) inputs[id] = forced[id];
  if (CFG.invincible && me) me.iframes = Math.max(me.iframes, 2);
  onEvents(Sim.step(state, inputs, { cfg: CFG }));
  for (const p of state.players) if (p.alive) playFx(p);
}

// ---------- camera: follows the local player, clamped to the arena ----------
const clampCam = x => Math.max(0, Math.min(L.w * T - VW, x));
const clampCamY = y => Math.max(0, Math.min(L.h * T - VH, y));
// A watcher (SPEC §16) follows the ninja it picked, or by default the leader; nobody there: the centre.
const focus = () => Sim.getPlayer(state, ME) || (watching && Sim.getPlayer(state, watchTarget())) ||
  (ONLINE && !lobbyOpen && !watching && state.players.find(p => p.alive)) || { x: L.w * T / 2, y: L.h * T / 2, w: 10, h: 13 };
const camTargetX = () => focus().x + 5 - VW / 2;
const camTargetY = () => focus().y + focus().h / 2 - VH * .55;
function snapCamera() { S.camX = clampCam(camTargetX()); S.camY = clampCamY(camTargetY()); }
// Follow with easing, but never let the player leave the screen (NinjaRunner followY).
function followCamera() {
  const P = focus();
  S.camX = clampCam(S.camX + (camTargetX() - S.camX) * .15);
  let y = S.camY + (camTargetY() - S.camY) * .12;
  y = Math.min(y, P.y - 24);
  y = Math.max(y, P.y + P.h + 40 - VH);
  S.camY = clampCamY(y);
}

function resetWorld() {
  state = Sim.createWorld({ seed: (Math.random() * 2147483646 | 0) + 1 });
  corpses = []; popups = []; sparks = []; L.bloody.clear(); clearGore(G);
  onEvents(Sim.addPlayer(state, ME, { cfg: CFG }));
  onEvents(Sim.addPlayer(state, DUMMY, { cfg: CFG }));
  snapCamera();
}

// ---------- rendering ----------
let SHX = 0, SHY = 0, CY = 0;
const world = () => ctx.setTransform(SCALE, 0, 0, SCALE, SHX, SHY - CY * SCALE);
const screen = () => ctx.setTransform(SCALE, 0, 0, SCALE, SHX, SHY);
const device = () => ctx.setTransform(1, 0, 0, 1, SHX, SHY);
function blitTile(img, tx, ty, cx) {
  const dx = Math.round((tx * T - cx) * SCALE), dy = Math.round((ty * T - CY) * SCALE);
  ctx.drawImage(img, dx, dy, Math.round(((tx + 1) * T - cx) * SCALE) - dx, Math.round(((ty + 1) * T - CY) * SCALE) - dy);
}
const isWall = c => c === '#' || c === 'B';
const STARS = (() => { const r = rng(77); return Array.from({ length: 90 }, () => ({ x: r() * VW, y: r() * 400, a: .15 + r() * .5, s: .2 + r() * .35 })); })();
const BG_DROP = [.025, .12, .25];   // how fast each skyline layer sinks as you climb

function drawCars(cx) {
  for (const car of CARS) {
    const x = (((S.tick * car.v + car.o - cx * .12) % 1100) + 1100) % 1100 - 100, y = car.y, d = Math.sign(car.v);
    ctx.fillStyle = '#2a2240'; rrect(ctx, x - 2.6, y - .75, 5.2, 1.5, .75); ctx.fill();
    ctx.shadowBlur = blur(4);
    ctx.shadowColor = ctx.fillStyle = '#fff7c0'; ctx.beginPath(); ctx.arc(x + d * 2.7, y, .45, 0, TAU); ctx.fill();
    ctx.shadowColor = ctx.fillStyle = NEON.pink; ctx.beginPath(); ctx.arc(x - d * 2.7, y, .4, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
  }
}

// Kanbei, drawn for player P. The headband, belt, tails and rim glow take the player's colour col.
function drawKanbei(P, x, y, face, opt, col) {
  const air = !P.onGround && !opt.impaled, run = Math.abs(P.vx) > .2 && P.onGround && !opt.impaled, ph = P.walk * .35;
  ctx.save();
  ctx.translate(x + 5, y + 13);
  if (opt.flip) { ctx.translate(0, -6.5); ctx.scale(1, -1); ctx.translate(0, 6.5); }
  if (air && !opt.flip) { const s = Math.max(-.12, Math.min(.12, -P.vy * .02)); ctx.scale(1 - s * .6, 1 + s); }
  drawTails(face, opt.impaled || opt.flip ? 0 : P.vx, opt.impaled ? 0 : P.vy, col);
  ctx.scale(face, 1);
  ctx.lineCap = 'round';
  // feet
  ctx.fillStyle = '#4a4468';
  if (air) { oval(ctx, -2.4, -1.7, 1.7, 1.1); oval(ctx, 2.6, -1.3, 1.7, 1.1); }
  else {
    const step = run ? Math.sin(ph) * 1.6 : 0;
    oval(ctx, -2.4 + step, -1.05 - (run ? Math.max(0, Math.cos(ph)) * .9 : 0), 1.9, 1.15);
    oval(ctx, 2.6 - step, -1.05 - (run ? Math.max(0, -Math.cos(ph)) * .9 : 0), 1.9, 1.15);
  }
  // scabbard and hilt over the shoulder (behind the body)
  if (P.long) drawLongScabbard();
  else {
    ctx.strokeStyle = '#120e1e'; ctx.lineWidth = 1.5; line(ctx, -5.6, -14.2, 3.5, -1.8);
    ctx.strokeStyle = '#d4a84a'; ctx.lineWidth = 1.1; line(ctx, -6.4, -15.3, -4.6, -12.6);
    ctx.lineWidth = .7; line(ctx, -5.8, -12.1, -3.9, -13.3);
  }
  // body with a cyan rim glow
  ctx.shadowColor = col; ctx.shadowBlur = blur(4);
  const g = ctx.createRadialGradient(-2, -10, 1, 0, -6.5, 8);
  g.addColorStop(0, '#6c60aa'); g.addColorStop(.45, '#342c60'); g.addColorStop(1, '#17132c');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, -6.8, 5.4, 6.2, 0, 0, TAU); ctx.fill();
  ctx.shadowBlur = 0; ctx.strokeStyle = '#0b0912'; ctx.lineWidth = .5; ctx.stroke();
  // headband, belt and eye slit, clipped to the body
  ctx.save(); ctx.beginPath(); ctx.ellipse(0, -6.8, 5.4, 6.2, 0, 0, TAU); ctx.clip();
  ctx.fillStyle = col; ctx.fillRect(-6, -10.5, 12, 1.5); ctx.fillRect(-6, -3.7, 12, 1.1);
  ctx.fillStyle = '#f2c79a'; rrect(ctx, -2.2, -8.9, 8, 2.6, 1.3); ctx.fill();
  ctx.restore();
  if (opt.impaled || opt.flip) {
    ctx.strokeStyle = '#1a1020'; ctx.lineWidth = .45;
    for (const ex of [1, 3.4]) { line(ctx, ex - .6, -8.2, ex + .6, -7); line(ctx, ex + .6, -8.2, ex - .6, -7); }
  } else {
    ctx.fillStyle = '#fff'; oval(ctx, .9, -7.6, .95, .8); oval(ctx, 3.35, -7.6, .9, .8);
    ctx.fillStyle = '#1a1020'; oval(ctx, 1.3, -7.5, .45, .55); oval(ctx, 3.7, -7.5, .42, .55);
    ctx.strokeStyle = '#1a1020'; ctx.lineWidth = .5; line(ctx, -.3, -8.75, 2, -8.25); line(ctx, 2.6, -8.25, 4.6, -8.7);
  }
  ctx.strokeStyle = 'rgba(190,180,255,.35)'; ctx.lineWidth = .6;
  ctx.beginPath(); ctx.arc(0, -6.8, 4.4, -2.6, -1.7); ctx.stroke();
  ctx.fillStyle = col; oval(ctx, -5.3, -9.75, .9, .75);   // headband knot
  ctx.restore();
}

// A long-sword holder's scabbard (SPEC §5.1): the same line over the back, but LONG_REACH times
// as long (the hilt rides high above the shoulder, the tip reaches past the heel), glowing and
// pulsing in the long sword's electric cyan, so opponents can read the threat before a swing.
// Kanbei's local space, facing +x.
function drawLongScabbard() {
  const ux = 9.1 / 15.39, uy = 12.4 / 15.39, len = 15.39 * LONG_REACH;   // the standard scabbard's direction
  const x1 = 4.6, y1 = -.4, x0 = x1 - ux * len, y0 = y1 - uy * len;      // tip just past the heel, mouth up high
  const pulse = .65 + .35 * Math.sin(S.tick * .12);
  ctx.save(); ctx.lineCap = 'round';
  ctx.shadowColor = NEON.cyan; ctx.shadowBlur = blur(4 + 4 * pulse);
  ctx.strokeStyle = '#0e1a2e'; ctx.lineWidth = 1.9; line(ctx, x0, y0, x1, y1);   // lacquered sheath
  ctx.globalAlpha = .55 + .45 * pulse; ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = .55;
  line(ctx, x0 + ux, y0 + uy, x1, y1);                                           // glowing seam
  ctx.globalAlpha = 1; ctx.shadowBlur = blur(3);
  ctx.strokeStyle = '#aef6ff'; ctx.lineWidth = 1.2; line(ctx, x1 - ux * 1.6, y1 - uy * 1.6, x1, y1);   // bright chape
  ctx.shadowBlur = 0;
  // the hilt: a longer gold grip above the mouth, with a guard across it
  ctx.strokeStyle = '#d4a84a'; ctx.lineWidth = 1.2; line(ctx, x0 - ux * 3.2, y0 - uy * 3.2, x0 + ux * .4, y0 + uy * .4);
  ctx.lineWidth = .8; line(ctx, x0 - uy * 1.6, y0 + ux * 1.6, x0 + uy * 1.6, y0 - ux * 1.6);
  ctx.restore();
}

// A long-sword pickup lying at its item point: a glowing blade standing point-up over a soft light
// pool, bobbing slowly, its glow pulsing. x is the centre, y the surface it lies on (screen units).
function drawItem(it, x, y) {
  const t = S.tick + it.id * 37, bob = Math.sin(t * .05) * 1.4, pulse = .6 + .4 * Math.sin(t * .09);
  const cy = y - ITEM_H / 2 - 1 + bob;
  ctx.save(); ctx.lineCap = 'round';
  // light pool on the surface
  const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
  g.addColorStop(0, `rgba(125,249,255,${.35 * pulse})`); g.addColorStop(1, 'rgba(125,249,255,0)');
  ctx.fillStyle = g; ctx.fillRect(x - 9, y - 5, 18, 6);
  // halo
  const h = ctx.createRadialGradient(x, cy, 0, x, cy, 10);
  h.addColorStop(0, `rgba(5,217,232,${.28 * pulse})`); h.addColorStop(1, 'rgba(5,217,232,0)');
  ctx.fillStyle = h; ctx.beginPath(); ctx.arc(x, cy, 10, 0, TAU); ctx.fill();
  // the sword, tilted a little, point up
  ctx.translate(x, cy); ctx.rotate(.18 * Math.sin(t * .03));
  ctx.strokeStyle = '#d4a84a'; ctx.lineWidth = 1.3; line(ctx, 0, 7, 0, 4);       // grip
  ctx.lineWidth = .9; line(ctx, -2.2, 4, 2.2, 4);                                 // guard
  ctx.shadowColor = NEON.cyan; ctx.shadowBlur = blur(5 + 5 * pulse);
  ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 1.6; line(ctx, 0, 4, 0, -8);       // blade
  ctx.shadowBlur = blur(2); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = .5; line(ctx, 0, 3.5, 0, -8.6);
  // a glint running up the blade
  const k = (t * .02) % 1.6;
  if (k < 1) { ctx.globalAlpha = 1 - k; ctx.fillStyle = '#fff'; oval(ctx, 0, 4 - k * 12, .9, .9); }
  ctx.restore();
}

// ---------- ninja stars (SPEC §5.2) ----------
// A four-pointed shuriken of radius r centred on (0, 0), turned by `spin`, with a hole in the middle.
function shuriken(r, spin, fill, edge) {
  ctx.save(); ctx.rotate(spin);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8, rr = i % 2 ? r * .34 : r;
    i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(rr, 0);
  }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = .35; ctx.strokeStyle = edge; ctx.stroke();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(0, 0, r * .16, 0, TAU); ctx.fill();
  ctx.restore();
}
// A star pickup: a spinning neon shuriken hovering over a magenta light pool, with a spinning
// violet halo ring: clearly not the long sword's upright cyan blade. x centre, y the surface.
// A bigger bundle (SPEC §5.2: 3, 5, 10 or 15 stars) has a slightly bigger, brighter shuriken.
function drawStarItem(it, x, y) {
  const n = Sim.starAmount(it), big = Math.max(0, Math.min(12, n - 3)) / 12;   // 0 for 3, 1 for 15
  const t = S.tick + it.id * 23, bob = Math.sin(t * .07) * 1.2, pulse = .6 + .4 * Math.sin(t * .12) + big * .15;
  const cy = y - 7 + bob;
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
  g.addColorStop(0, `rgba(255,110,199,${.4 * pulse})`); g.addColorStop(1, 'rgba(255,110,199,0)');
  ctx.fillStyle = g; ctx.fillRect(x - 9, y - 5, 18, 6);
  const h = ctx.createRadialGradient(x, cy, 0, x, cy, 10);
  h.addColorStop(0, `rgba(176,38,255,${.32 * pulse})`); h.addColorStop(1, 'rgba(176,38,255,0)');
  ctx.fillStyle = h; ctx.beginPath(); ctx.arc(x, cy, 10, 0, TAU); ctx.fill();
  ctx.translate(x, cy);
  ctx.strokeStyle = `rgba(255,110,199,${.5 + .4 * pulse})`; ctx.lineWidth = .5; ctx.setLineDash([2, 2.2]);
  ctx.lineDashOffset = -t * .2; ctx.beginPath(); ctx.arc(0, 0, 6.3, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  ctx.shadowColor = NEON.magenta; ctx.shadowBlur = blur(4 + 4 * pulse + 3 * big);
  shuriken(4.6 * (1 + .22 * big), t * .12, '#ffd1ec', NEON.magenta);
  ctx.shadowBlur = 0;
  // the count it gives, small, in the status bar's star colours (yellow on a dark outline)
  ctx.font = '800 4.2px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
  const label = '+' + n, ly = -7.4 - 1.2 * big;
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(5,3,10,.9)'; ctx.strokeText(label, 0, ly);
  ctx.shadowColor = '#b026ff'; ctx.shadowBlur = blur(3); ctx.fillStyle = '#f9f871'; ctx.fillText(label, 0, ly);
  ctx.restore();
}
// A star in flight: spinning fast, with a short fading trail behind it (along -vx).
function drawFlyingStar(st, x, y) {
  const dir = st.vx > 0 ? 1 : -1;
  ctx.save(); ctx.lineCap = 'round';
  const tr = ctx.createLinearGradient(x, y, x - dir * 16, y);
  tr.addColorStop(0, 'rgba(255,110,199,.75)'); tr.addColorStop(1, 'rgba(176,38,255,0)');
  ctx.strokeStyle = tr; ctx.lineWidth = 2.2; line(ctx, x, y, x - dir * 16, y);
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = .6; line(ctx, x, y, x - dir * 9, y);
  ctx.translate(x, y);
  ctx.shadowColor = NEON.magenta; ctx.shadowBlur = blur(5);
  shuriken(2.6, S.tick * .7 * dir + st.id, '#ffffff', NEON.magenta);
  ctx.restore();
}
// The throw flick: for a few ticks after a throw (our own at once, others from the snapshot FX
// bit) a small star leaves the hand along the facing direction.
const throwAnims = new Map();   // player id -> S.tick of the throw
function drawThrowFlick(p, px, py) {
  const t0 = throwAnims.get(p.id);
  if (t0 == null) return;
  const k = (S.tick - t0) / 8;
  if (k > 1 || k < 0) { throwAnims.delete(p.id); return; }
  const f = p.face, hx = px + 5 + f * (4 + k * 10), hy = py + 6 - Math.sin(k * Math.PI) * 2;
  ctx.save(); ctx.globalAlpha = 1 - k * .6; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,209,236,.7)'; ctx.lineWidth = .8;
  ctx.beginPath(); ctx.arc(px + 5, py + 7, 7, f > 0 ? -1.4 : Math.PI + .2, f > 0 ? -.2 : Math.PI + 1.4); ctx.stroke();   // arm swing
  ctx.translate(hx, hy); shuriken(2.2, S.tick * .8 * f, '#ffffff', NEON.magenta);
  ctx.restore();
}
// "X to throw" (or the touch button's symbol) above our own Kanbei for a few seconds after we
// grab stars (SPEC §5.2).
let throwHintUntil = 0;
const THROW_HINT_MS = 4000;
function throwHintText() { return (TOUCH_UI ? THROW_SYMBOL : 'X') + ' to throw'; }
// How many ninja stars a player holds, above their head (over the name tag online).
function drawStarCount(p, px, py) {
  ctx.save();
  ctx.font = '800 5px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
  const tx = px + p.w / 2, ty = py - (ONLINE ? 14.5 : 9), label = '★' + p.stars;
  ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(5,3,10,.9)'; ctx.strokeText(label, tx, ty);
  ctx.fillStyle = '#ff9be0'; ctx.fillText(label, tx, ty);
  ctx.restore();
}
function drawThrowHint(p, px, py) {
  const left = throwHintUntil - performance.now();
  if (left <= 0) return;
  const a = Math.min(1, left / 600, (THROW_HINT_MS - left) / 150 + .2);
  ctx.save(); ctx.globalAlpha = Math.max(0, a);
  ctx.font = '800 5.5px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
  const tx = px + p.w / 2, ty = py - (ONLINE ? 21 : 15.5) + Math.sin(S.tick * .15) * .6, label = throwHintText();
  ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(5,3,10,.9)'; ctx.strokeText(label, tx, ty);
  ctx.shadowColor = NEON.magenta; ctx.shadowBlur = blur(4); ctx.fillStyle = '#ffd1ec'; ctx.fillText(label, tx, ty);
  ctx.restore();
}

// Headband tails: two tapered ribbons streaming behind the head. Longer and flatter when
// running, drooping when still, lifting when falling. Drawn in Kanbei's local space.
function drawTails(face, vx, vy, col) {
  const speed = Math.min(1, Math.abs(vx) / 2.4), len = 6 + speed * 5, lift = Math.max(-1.5, Math.min(1.5, vy * .3));
  ctx.save(); ctx.lineCap = 'round'; ctx.shadowColor = col; ctx.shadowBlur = blur(3);
  for (let s = 0; s < 2; s++) {
    ctx.strokeStyle = s ? shade(col, .62) : col;
    let px = -5.1 * face, py = -9.75;
    for (let i = 1; i <= 8; i++) {
      const k = i / 8, d = k * len;
      const wave = Math.sin(S.tick * (.15 + speed * .2) + k * 6 + s * 1.7) * k * (1 + speed);
      const nx = -5.1 * face - face * d, ny = -9.75 + s * .8 + wave + (1 - speed) * d * .55 - lift * k * 2 + s * k;
      ctx.lineWidth = 1.25 * (1 - k * .55);
      line(ctx, px, py, nx, ny);
      px = nx; py = ny;
    }
  }
  ctx.restore();
}

// Sword swing: chop = blade sweeps from up-behind to down-in-front; sweep = flat horizontal swing.
// (swordBoxOf, the hitbox, lives in shared/sim.js.)
// A long sword (P.long) draws blade and arc longer by exactly the hitbox's extra length, so the
// blade ends about where the longer box ends, and its trail is brighter (white core, more glow).
function drawSword(P, px, py) {
  const t = 1 - P.atk / ATK_LEN, e = 1 - (1 - t) ** 3, f = P.face, sweep = P.atkType === 'sweep';
  const ax = px + 5 + f * 3.5, ay = py + 7.5;
  const extra = P.long ? (sweep ? 22 : 18) * (LONG_REACH - 1) : 0;   // the box's added length (swordBoxOf)
  let a, len;
  ctx.save(); ctx.lineCap = 'round';
  ctx.shadowColor = ctx.strokeStyle = NEON.cyan; ctx.shadowBlur = blur(P.long ? 9 : 6);
  const trail = draw => {                       // the arc; a long sword's gets a bright white core
    draw(); ctx.stroke();
    if (!P.long) return;
    ctx.strokeStyle = '#e8fdff'; ctx.lineWidth *= .4; ctx.globalAlpha = Math.min(1, ctx.globalAlpha * 1.4);
    draw(); ctx.stroke();
  };
  if (sweep) {
    const k = 1 + extra / 17;                   // the blade at full stretch is 17 long
    ctx.globalAlpha = (P.long ? .8 : .55) * (1 - t * .5); ctx.lineWidth = P.long ? 2.8 : 2.2;
    trail(() => { ctx.beginPath(); ctx.ellipse(ax + f * 6 * k, ay, 13 * k, 3.2 * (P.long ? 1.25 : 1), 0, f > 0 ? -1.6 : Math.PI - 1.6 * e, f > 0 ? -1.6 + 1.6 * e + .8 : Math.PI + 1.6); });
    a = .25 - e * .45; len = 4 + (13 + extra) * Math.sin(e * Math.PI * .5 + .15);
  } else {
    const a0 = -2, a1 = 1, r = 11.5 + extra; a = a0 + (a1 - a0) * e; len = 14 + extra;
    ctx.globalAlpha = (P.long ? .8 : .55) * (1 - t * .6); ctx.lineWidth = P.long ? 4 : 3.2;
    trail(() => {
      ctx.beginPath();
      if (f > 0) ctx.arc(ax, ay, r, a0 + (a - a0) * .3, a); else ctx.arc(ax, ay, r, Math.PI - a, Math.PI - (a0 + (a - a0) * .3));
    });
  }
  ctx.globalAlpha = 1;
  const dx = Math.cos(a) * f, dy = Math.sin(a), hx = ax + dx * 3, hy = ay + dy * 3;
  ctx.shadowBlur = 0; ctx.strokeStyle = '#d4a84a';
  ctx.lineWidth = 1.3; line(ctx, ax, ay, hx, hy);                                   // grip
  ctx.lineWidth = .8; line(ctx, hx + dy * 1.4, hy - dx * 1.4, hx - dy * 1.4, hy + dx * 1.4);   // guard
  ctx.shadowColor = NEON.cyan; ctx.shadowBlur = blur(6); ctx.strokeStyle = '#aef6ff'; ctx.lineWidth = 1.1;
  line(ctx, hx, hy, ax + dx * len, ay + dy * len);                                  // glowing blade
  ctx.shadowBlur = 0; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = .4;
  line(ctx, hx, hy, ax + dx * len, ay + dy * len);
  ctx.restore();
}


function render() {
  const cx = Math.round(S.camX * SCALE) / SCALE;
  CY = Math.round(S.camY * SCALE) / SCALE;
  SHX = S.shake > 0 ? (Math.random() - .5) * S.shake * .4 * SCALE : 0;
  SHY = S.shake > 0 ? (Math.random() - .5) * S.shake * .4 * SCALE : 0;
  screen();
  if (SHX || SHY) { ctx.fillStyle = '#04020a'; ctx.fillRect(-4, -4, VW + 8, VH + 8); }   // edges exposed by shake
  // The arena is taller than the view: the skyline sinks as you climb, leaving open night sky above.
  const climb = Math.max(0, L.h * T - VH) - CY;
  if (climb > 0) {
    const top = Math.min(VH, climb * BG_DROP[0] + 1);
    ctx.fillStyle = '#04020a'; ctx.fillRect(-4, -4, VW + 8, top + 4);
    for (const s of STARS) {
      const y = s.y - 400 + climb * .03;
      if (y < top && y > -2) { ctx.fillStyle = `rgba(255,255,255,${s.a})`; ctx.fillRect(s.x, y, s.s * 2, s.s * 2); }
    }
  }
  CITY.forEach((layer, i) => {
    const o = -((cx * layer.k) % CITY_W), sy = layer.top * BG_S, dy = climb * BG_DROP[i];
    if (layer.top + dy < VH) for (const off of [o, o + CITY_W]) {
      if (off > VW || off + CITY_W < 0) continue;
      const sx0 = Math.max(0, -off), sx1 = Math.min(CITY_W, VW - off);
      const vis = Math.min(VH - layer.top, VH - layer.top - dy);
      ctx.drawImage(layer.c, sx0 * BG_S, sy, (sx1 - sx0) * BG_S, vis * BG_S, off + sx0, layer.top + dy, sx1 - sx0, vis);
      for (const s of layer.signs) {                 // some signs flicker and buzz off
        if (s.seed % 3 || off + s.x > VW || off + s.x + s.w < 0) continue;
        const fr = Math.abs(Math.sin(s.seed + Math.floor(S.tick / 5) * 12.9898) * 43758.5453) % 1;
        if (fr > .8) { ctx.fillStyle = 'rgba(5,3,10,.78)'; rrect(ctx, off + s.x, s.y + dy, s.w, s.h, 1.2); ctx.fill(); }
      }
    }
    if (i === 0) drawCars(cx);
  });

  // tiles
  const x0 = Math.max(0, Math.floor(cx / T)), x1 = Math.min(L.w - 1, Math.floor((cx + VW) / T));
  const y0 = Math.max(0, Math.floor(CY / T)), y1 = Math.min(L.h - 1, Math.floor((CY + VH) / T));
  device();
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const c = L.grid[ty][tx];
    if (c === '#') blitTile(ty > 0 && !isWall(L.grid[ty - 1][tx]) ? TILE.top : TILE.dirt, tx, ty, cx);
    else if (c === 'B') blitTile(TILE.block, tx, ty, cx);
    else if (c === '=') blitTile(TILE.plank, tx, ty, cx);
    else if (c === '^') blitTile(L.bloody.has(tx + ',' + ty) || G.bloody.has(tx + ',' + ty) ? TILE.spikeBloody : TILE.spike, tx, ty, cx);
  }
  world();
  // one continuous glowing neon edge along each run of walkable floor
  ctx.save();
  ctx.strokeStyle = NEON.cyan; ctx.lineWidth = .8; ctx.shadowColor = NEON.cyan; ctx.shadowBlur = blur(5);
  ctx.beginPath();
  for (let ty = y0; ty <= y1; ty++) {
    let run = -1;
    for (let tx = x0; tx <= x1 + 1; tx++) {
      const top = tx <= x1 && L.grid[ty][tx] === '#' && !(ty > 0 && isWall(L.grid[ty - 1][tx]));
      if (top && run < 0) run = tx;
      if (!top && run >= 0) { ctx.moveTo(run * T - cx, ty * T + .4); ctx.lineTo(tx * T - cx, ty * T + .4); run = -1; }
    }
  }
  ctx.stroke(); ctx.restore();

  // blood on the walls, floors and ceilings: one baked layer (see goreLayer), one draw per frame
  if (G.decals.length || G.pools.size) {
    updateGoreLayer();
    const sx = Math.max(0, cx), sy = Math.max(0, CY), w = Math.min(VW, L.w * T - sx), h = Math.min(VH, L.h * T - sy);
    ctx.globalAlpha = BSTYLE.layerAlpha; ctx.globalCompositeOperation = BSTYLE.layerBlend;   // neon glows ('lighter')
    ctx.drawImage(GL.c, sx * GL.s, sy * GL.s, w * GL.s, h * GL.s, sx - cx, sy, w, h);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  // the dead: flipped over and falling (impaled ones stay on the spikes), fading out
  for (const c of corpses) {
    ctx.globalAlpha = Math.min(1, c.t / 20);
    drawKanbei({ onGround: false, vx: 0, vy: 0, walk: 0 }, c.x - cx, c.y, c.face, c.impaled ? { impaled: true } : { flip: true }, colorOf(c.id));
    ctx.globalAlpha = 1;
    if (c.impaled) {                     // redraw the bloody spikes on top so the points go through
      const ty = Math.floor((c.y + 13) / T);
      device();
      for (let tx = Math.floor(c.x / T); tx <= Math.floor((c.x + c.w - 1) / T); tx++)
        if (L.grid[ty]?.[tx] === '^') blitTile(TILE.spikeBloody, tx, ty, cx);
      world();
    }
  }

  // the cut-up dead: body pieces, hoods and swords
  for (const g of G.gibs) drawGib(g, cx);

  // pickups, long swords and ninja stars (online: as of the render tick; a snapshot without them means none)
  for (const it of state.items || []) {
    const x = it.x - cx;
    if (x > -16 && x < VW + 16 && it.y > CY - 8 && it.y - 24 < CY + VH) (Sim.itemKind(it) === 'star' ? drawStarItem : drawItem)(it, x, it.y);
  }

  // players: the local one last, so it is drawn on top
  const order = state.players.filter(p => p.alive).sort((a, b) => (a.id === ME) - (b.id === ME));
  for (const p of order) {
    const px = p.x - cx, py = p.y, col = colorOf(p.id);
    if (watching && p.id === watchId) drawWatchRing(p, px, py, col);   // the ninja a watcher follows (SPEC §16)
    if (!(p.iframes > 0 && (p.iframes >> 2) % 2)) {
      if (p.stun > 0 && (p.stun >> 1) % 2) ctx.filter = 'brightness(2.2)';   // hit flash
      drawKanbei(p, px, py, p.face, {}, col);
      ctx.filter = 'none';
      if (p.atk > 0) drawSword(p, px, py);
    }
    drawThrowFlick(p, px, py);
    drawHpBar(p, px, py, col);
    if (ONLINE) drawNameTag(p, px, py, col);
    if (p.stars > 0) drawStarCount(p, px, py);
    if (p.id === ME) drawThrowHint(p, px, py);
  }
  if (ONLINE) for (const p of order) drawChatBubble(p, p.x - cx, p.y);   // over everyone's tags and counts

  // ninja stars in flight (online: interpolated at the render tick like remote players)
  for (const st of state.stars || []) {
    const x = st.x - cx;
    if (x > -20 && x < VW + 20 && st.y > CY - 8 && st.y < CY + VH + 8) drawFlyingStar(st, x, st.y);
  }

  // flying blood: additive blend so it glows (NinjaRunner), batched per colour
  if (G.parts.length) {
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .8;
    for (let c = 0; c < BLOOD.length; c++) {
      ctx.fillStyle = BLOOD[c]; ctx.beginPath();
      for (const b of G.parts) if (b.c === c) {
        const x = b.x - cx; if (x < -2 || x > VW + 2 || b.y < CY - 2 || b.y > CY + VH + 2) continue;
        const r = .7 * b.s; ctx.moveTo(x + r, b.y); ctx.arc(x, b.y, r, 0, TAU);
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }

  if (CFG.hitboxes && (!ONLINE || net.isAdmin())) {   // online: a view for the admin's panel only
    ctx.lineWidth = .5;
    const box = (b, c) => { ctx.strokeStyle = c; ctx.strokeRect(b.x - cx, b.y, b.w, b.h); };
    for (const p of state.players) if (p.alive) {
      box(p, p.id === ME ? '#00ff66' : '#ff3355');
      if (Sim.swordLive(p)) box(swordBoxOf(p), '#ffffff');
      else if (p.atk > 0) { ctx.setLineDash([1, 1]); box(swordBoxOf(p), 'rgba(255,255,255,.5)'); ctx.setLineDash([]); }
    }
    ctx.fillStyle = 'rgba(249,248,113,.8)';
    for (const s of L.spawns) ctx.fillRect(s.x - cx - 1, s.y - 2, 2, 2);
    ctx.fillStyle = 'rgba(125,249,255,.9)';      // item points (cyan) and the lying pickups' boxes
    for (const s of L.items || []) { ctx.beginPath(); ctx.moveTo(s.x - cx, s.y - 3.5); ctx.lineTo(s.x - cx + 1.5, s.y - 2); ctx.lineTo(s.x - cx, s.y - .5); ctx.lineTo(s.x - cx - 1.5, s.y - 2); ctx.fill(); }
    for (const it of state.items || []) box(Sim.itemBox(it), Sim.itemKind(it) === 'star' ? '#ff6ec7' : '#7df9ff');
    for (const st of state.stars || []) box(Sim.starBox(st), '#ffffff');      // stars in flight
  }

  // rain slanting across everything
  screen();
  ctx.strokeStyle = 'rgba(160,210,255,.3)'; ctx.lineWidth = .35; ctx.lineCap = 'round'; ctx.beginPath();
  for (const d of RAIN) {
    const x = (((d.x - S.tick * 1.2 - cx * .7) % (VW + 40)) + VW + 40) % (VW + 40) - 20;
    const y = (d.y + S.tick * d.s) % (VH + 10) - 10;
    ctx.moveTo(x, y); ctx.lineTo(x - 1.3, y + 6);
  }
  ctx.stroke();

  world();
  ctx.font = '800 7px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.shadowColor = NEON.pink; ctx.shadowBlur = blur(4); ctx.fillStyle = NEON.yellow;
  for (const p of popups) ctx.fillText(p.s, p.x - cx, p.y);
  ctx.strokeStyle = '#ffd1ec'; ctx.lineWidth = .5;
  for (const k of sparks) {                       // a star striking a wall: a small burst of sparks
    const r = (10 - k.t) * .5;
    for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + k.x; line(ctx, k.x - cx + Math.cos(a) * r * .4, k.y + Math.sin(a) * r * .4, k.x - cx + Math.cos(a) * r, k.y + Math.sin(a) * r); }
  }
  ctx.shadowBlur = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // HUD (DOM)
  if (ONLINE) hudOnline();
  const me = !ONLINE && Sim.getPlayer(state, ME), d = Sim.getPlayer(state, DUMMY);
  if (me) {
    setText('hHp', `HP ${Math.max(0, me.hp)}`);
    setText('hStars', `★ ${me.stars | 0}`);
    document.getElementById('hHp').classList.toggle('low', me.alive && me.hp <= 34);
    setText('hScore', `SCORE ${me.score}` + (d ? ` · DUMMY ${d.score}` : ''));
    setText('msg', me.alive ? '' : `SPLAT · respawn in ${(me.respawn / 60).toFixed(1)}`);
  }
  hudCommon();
  if (S.tick > 600) document.getElementById('help').classList.add('gone');
}

// ---------- kill feed and scoreboard (both modes) ----------
const FEED_HOLD = 5000, FEED_FADE = 1500;
const feedEl = document.getElementById('feed'), boardEl = document.getElementById('board'), stripEl = document.getElementById('strip');
let boardHeld = false, boardKey = '', stripKey = '', stripBuilds = 0;
function board(on) { if (boardHeld !== on) { boardHeld = on; boardEl.classList.toggle('hidden', !on); boardKey = ''; } }
const span = (text, color, cls) => { const e = document.createElement('span'); e.textContent = text; if (color) e.style.color = color; if (cls) e.className = cls; return e; };
function feedRow(f) {
  const row = document.createElement('div');
  if (f.kn != null && f.killer !== f.victim) row.append(span(f.kn, f.kc, 'nm'), f.star ? span(' ✦ ', null, 'x star') : f.long ? span(' ⚔ ', null, 'x long') : span(' ✂ ', null, 'x'), span(f.vn, f.vc, 'nm'));
  else row.append(span(f.move === 'spikes' ? '▲ ' : f.move === 'leave' ? '✕ ' : '✂ ', null, 'x'), span(f.vn, f.vc, 'nm'));
  if (f.move === 'spikes' || f.move === 'leave') row.append(span(f.move === 'spikes' ? ' (spikes)' : ' (left)', null, 'how'));
  return row;
}
// The standings: online from the roster (scores kept fresh by score events), offline you and the dummy.
function standings() {
  if (ONLINE) return (net.lobby.players || []).map(p => ({ id: p.id, ...p, ...(net.meta.get(p.id) || {}) }));
  return state.players.map(p => ({ id: p.id, name: nameOf(p.id), color: -1, col: colorOf(p.id), score: p.score, deaths: p.deaths }));
}
function boardRows(el, rows, withDeaths) {
  el.textContent = '';
  for (const p of rows) {
    const r = document.createElement('div'); r.className = 'row' + (p.id === ME ? ' me' : '');
    const dot = span('', null, 'dot'); dot.style.background = p.col || PALETTE[p.color] || '#fff';
    r.append(dot, span(p.name + (p.away ? ' (away)' : ''), null, 'nm'), span(String(p.score), null, 'sc'));
    if (withDeaths) r.append(span(String(p.deaths ?? 0), null, 'dt'));
    el.appendChild(r);
  }
}
function hudCommon() {
  const now = performance.now();
  while (feed.length && now - feed[0].t > FEED_HOLD + FEED_FADE) { feed.shift(); feedDirty = true; }
  if (feedDirty) { feedDirty = false; feedEl.textContent = ''; for (const f of feed) feedEl.appendChild(feedRow(f)); }
  feed.forEach((f, i) => { const el = feedEl.children[i]; if (el) el.style.opacity = String(Math.max(0, Math.min(1, 1 - (now - f.t - FEED_HOLD) / FEED_FADE))); });
  if (now - (hudCommon.at || 0) < 100) return;   // standings are checked 10 times a second; the DOM changes only with the data
  hudCommon.at = now;
  const rows = standings().sort((a, b) => b.score - a.score || (a.deaths ?? 0) - (b.deaths ?? 0) || a.id - b.id);
  if (boardHeld) {
    const k = JSON.stringify(rows.map(r => [r.id, r.name, r.score, r.deaths, r.away]));
    if (k !== boardKey) {
      boardKey = k;
      const head = document.createElement('div'); head.className = 'row head';
      head.append(span('', null, 'dot'), span('PLAYER', null, 'nm'), span('KILLS', null, 'sc'), span('DEATHS', null, 'dt'));
      boardRows(boardEl, rows, true); boardEl.prepend(head);
      if (ONLINE && net.lobby.queue && net.lobby.queue.length) boardEl.appendChild(span(`${net.lobby.queue.length} waiting in the queue`, null, 'q'));
    }
  }
  // the strip along the top: rebuilt only when a name, colour, score, order, away flag or our own id changed
  const k = JSON.stringify([ME, watching ? watchTarget() : null, rows.map(r => [r.id, r.name, r.col || r.color, r.score, !!r.away])]);
  if (k !== stripKey) { stripKey = k; stripRows(rows); stripBuilds++; }
}
// Scores for everyone along the top (SPEC §9): one chip per player (colour dot, name, score) in
// score order, our own highlighted. Names go in through textContent only (span()).
function stripRows(rows) {
  stripEl.textContent = '';
  for (const p of rows) {
    const c = document.createElement('div');
    c.className = 'chip' + (p.id === ME ? ' me' : '') + (p.away ? ' away' : '') + (watching && p.id === watchTarget() ? ' watched' : '');
    c.dataset.id = String(p.id);
    const dot = span('', null, 'dot'); dot.style.background = p.col || PALETTE[p.color] || '#fff';
    c.append(dot, span(p.name, null, 'nm'), span(String(p.score), null, 'sc'));
    stripEl.appendChild(c);
  }
}

// ---------- gore drawing ----------
// Decals and pools are painted into one offscreen canvas covering the whole arena, so a frame costs
// one drawImage however much blood there is. New blood is painted in as it lands; the layer is
// rebuilt from scratch only to fade old blood out or drop what a cap or its 15 s life (BLOOD_TTL_TICKS) removed.
const GL = { c: null, g: null, s: 1, built: -1e9, scale: 0, rebuilds: 0, lastMs: 0 };
function goreLayerScale() { return Math.min(SCALE, LITE_AUDIO ? 2 : 3); }
function paintDecal(g, d) {
  const r = .75 * d.s;
  g.moveTo(d.x + r, d.y); g.arc(d.x, d.y, r, 0, TAU);
  if (d.d) g.rect(d.x - r * .45, d.y, r * .9, d.d);             // a drip running down
}
function paintPool(g, p) { const h = Math.min(4, p.h); g.moveTo(p.x + 1.3, p.y - h / 2 + .3); g.ellipse(p.x, p.y - h / 2 + .3, 1.3, h / 2 + .3, 0, 0, TAU); }
function rebuildGoreLayer() {
  const t0 = performance.now(), s = goreLayerScale();
  if (!GL.c || GL.scale !== s) {
    GL.c = mk(Math.ceil(L.w * T * s), Math.ceil(L.h * T * s)); GL.g = GL.c.getContext('2d'); GL.scale = GL.s = s;
  }
  const g = GL.g;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, GL.c.width, GL.c.height); g.setTransform(s, 0, 0, s, 0, 0);
  // batch by colour and fade step (10 steps)
  const buckets = new Map();
  const put = (k, item) => { let a = buckets.get(k); if (!a) buckets.set(k, a = []); a.push(item); };
  for (const p of G.pools.values()) if (p.h >= .25) { const f = Math.ceil(fadeOf(G, p.t) * 10); if (f > 0) put('p' + p.c + ':' + f, p); }
  for (const d of G.decals) { const f = Math.ceil(fadeOf(G, d.t) * 10); if (f > 0) put('d' + d.c + ':' + f, d); }
  for (const [k, items] of buckets) {
    const pool = k[0] === 'p', c = +k.slice(1, k.indexOf(':')), f = +k.slice(k.indexOf(':') + 1);
    g.globalAlpha = f / 10; g.fillStyle = pool ? POOL[c] : BLOOD[c]; g.beginPath();
    for (const it of items) pool ? paintPool(g, it) : paintDecal(g, it);
    g.fill();
  }
  g.globalAlpha = 1;
  G.newDecals.length = 0; G.newPools.clear(); G.dirty = false;
  GL.built = performance.now(); GL.rebuilds++;
  GL.lastMs = GL.built - t0;
  if (GL.lastMs > 8 || GL.rebuilds % 50 === 1) dbg('perf', 'gore: decal layer rebuilt', { ms: +GL.lastMs.toFixed(1), decals: G.decals.length, pools: G.pools.size, n: GL.rebuilds });
}
function updateGoreLayer() {
  const now = performance.now();
  let need = !GL.c || GL.scale !== goreLayerScale() || (G.dirty && now - GL.built > 1000);
  if (!need && now - GL.built > 250) {             // anything old enough to be fading? redraw it fainter (10 steps over the 2 s fade)
    const edge = G.t - (G.cfg.life - G.cfg.fade);
    need = (G.decals.length && G.decals[0].t < edge);
    if (!need) for (const p of G.pools.values()) if (p.t < edge) { need = true; break; }
  }
  if (need) { rebuildGoreLayer(); return; }
  if (!G.newDecals.length && !G.newPools.size) return;
  const g = GL.g;
  for (let c = 0; c < BLOOD.length; c++) {          // new blood, painted in on top
    g.fillStyle = POOL[c]; g.beginPath(); let any = false;
    for (const p of G.newPools) if (p.c === c && p.h >= .25) { paintPool(g, p); any = true; }
    if (any) g.fill();
    g.fillStyle = BLOOD[c]; g.beginPath(); any = false;
    for (const d of G.newDecals) if (d.c === c) { paintDecal(g, d); any = true; }
    if (any) g.fill();
  }
  G.newDecals.length = 0; G.newPools.clear();
}
// One body piece (clipped Kanbei), hood or sword, turned by the piece's unit vector (c, s).
const DEAD_KANBEI = { onGround: true, vx: 0, vy: 0, walk: 0 };
const BODY = new Path2D(); BODY.ellipse(0, -6.8, 5.4, 6.2, 0, 0, TAU);
function drawGib(g, cx) {
  const x = g.x - cx;
  if (g.hidden || x < -24 || x > VW + 24 || g.y < CY - 24 || g.y > CY + VH + 24) return;
  const a = g.age > GORE.gibLife ? Math.max(0, 1 - (g.age - GORE.gibLife) / 60) : 1;
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha = a;
  ctx.transform(g.c, g.s, -g.s, g.c, x, g.y - (g.id === 'S' && g.s === 0 ? .3 : 0));   // a flat sword's guard sits on the surface
  if (g.id === 'S') {                                   // the sword: grip, guard and glowing blade
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#d4a84a'; ctx.lineWidth = 1.3; line(ctx, -7, 0, -4, 0);
    ctx.lineWidth = .8; line(ctx, -4, -1.4, -4, 1.4);
    const tip = 8;
    ctx.shadowColor = NEON.cyan; ctx.shadowBlur = blur(5); ctx.strokeStyle = '#aef6ff'; ctx.lineWidth = 1.1; line(ctx, -4, 0, tip, 0);
    ctx.shadowBlur = 0; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = .4; line(ctx, -4, 0, tip, 0);
    ctx.strokeStyle = BLOOD[0]; ctx.lineWidth = .8; line(ctx, tip - 4, 0, tip, 0);   // blood on the tip
  } else {
    ctx.translate(-g.ox, -g.oy);
    ctx.beginPath();
    g.poly.forEach(([px, py], i) => {
      const X = px <= -5.5 ? -20 : px >= 5.5 ? 20 : px, Y = py <= -13.3 ? -22 : py >= .5 ? 3 : py;
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.clip();
    noGlow = true;
    drawKanbei(DEAD_KANBEI, -5, -13, g.face, { impaled: true }, g.meta || COLORS[0]);
    noGlow = false;
    // the raw cut face: a dark edge with a bright wet line, in the blood style's colours
    const fx = g.cut[0] + g.ox, fy = g.cut[1] + g.oy, dx = -g.cut[3] * 8, dy = g.cut[2] * 8, [c0, c1, c2] = BSTYLE.cut;
    ctx.clip(BODY);
    ctx.lineCap = 'round';
    ctx.strokeStyle = c0; ctx.lineWidth = 2.2; line(ctx, fx - dx, fy - dy, fx + dx, fy + dy);
    ctx.strokeStyle = c1; ctx.lineWidth = 1.1; line(ctx, fx - dx, fy - dy, fx + dx, fy + dy);
    ctx.strokeStyle = c2; ctx.lineWidth = .35; line(ctx, fx - dx, fy - dy, fx + dx, fy + dy);
  }
  ctx.restore();
}

// Online HUD: own HP and score, respawn countdown, queue position, connection state.
// (M3 adds the kill feed and the Tab scoreboard here.)
// The restart overlay (SPEC §18): the screen dims and a box says the server is updating while the
// page waits for it; once the game is back it says so, and it stays up at least ROV_MIN_MS in all
// so a one-second restart is still seen. Returns true while it is up.
const ROV_MIN_MS = 1500, ROV_DONE_MS = 1200;
let rovAt = 0, rovDoneAt = 0;
function restartOverlay() {
  const el = document.getElementById('rov'), now = performance.now();
  if (net.restarting()) {
    if (!rovAt) { rovAt = now; rovDoneAt = 0; dbg('net', 'restart overlay'); }
    el.className = 'up';
    return true;
  }
  if (!rovAt) return false;
  if (!rovDoneAt) rovDoneAt = Math.max(now, rovAt + ROV_MIN_MS - ROV_DONE_MS);
  if (now < rovDoneAt + ROV_DONE_MS) { el.className = net.state === 'open' ? 'up done' : 'up'; return true; }
  el.className = ''; rovAt = 0; rovDoneAt = 0;
  return false;
}
function hudOnline() {
  const me = net.me, m = metaOf(ME);
  setText('hHp', me ? `HP ${Math.max(0, me.hp)}` : '');
  setText('hStars', me && !lobbyOpen ? `★ ${me.stars | 0}` : '');   // our count, always the server's (SPEC §5.2)
  document.getElementById('hHp').classList.toggle('low', !!me && me.alive && me.hp <= 34);
  setText('hScore', m && !lobbyOpen ? `SCORE ${m.score}` : '');
  let msg = '', sub = '';
  if (staleBuild) msg = 'NEW VERSION · RELOADING…';
  else if (updOpen) msg = '';
  else if (restartOverlay()) { /* the restart overlay (#rov) says it */ }
  else if (net.state === 'reconnecting' || (net.state === 'connecting' && !lobbyOpen)) msg = 'RECONNECTING…';
  else if (!lobbyOpen && net.mode === 'queue') {
    msg = `ROOM FULL · QUEUE #${net.queuePos}`;
    sub = `you are #${net.queuePos} of ${(net.lobby.queue || []).length || net.queuePos} waiting · you join as soon as a slot frees`;
  }
  else if (me && !me.alive) msg = `SPLAT · respawn in ${(Math.max(0, me.respawn) / 60).toFixed(1)}`;
  setText('msg', msg);
  setText('msgSub', sub);
  if (watching) watchHud();
}

// The followed ninja while watching (SPEC §16): a pulsing ring of its colour on the ground at its feet,
// under the body, so it never covers the tag, the HP bar or a chat bubble.
function drawWatchRing(p, px, py, col) {
  const a = .55 + .3 * Math.sin(S.tick * .12);
  ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = .9;
  ctx.shadowColor = col; ctx.shadowBlur = blur(5);
  ctx.beginPath(); ctx.ellipse(px + p.w / 2, py + p.h + .3, 9, 2.4, 0, 0, TAU); ctx.stroke();
  ctx.restore();
}

// Name tag above the HP bar. Names come from the server (allowlisted characters only).
function drawNameTag(p, px, py, col) {
  const m = metaOf(p.id);
  if (!m) return;
  ctx.save();
  ctx.font = '700 5px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center';
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(5,3,10,.85)';
  const label = m.away ? m.name + ' (away)' : m.name;
  ctx.strokeText(label, px + p.w / 2, py - 9);
  ctx.fillStyle = p.id === ME ? '#ffffff' : col;
  ctx.fillText(label, px + p.w / 2, py - 9);
  ctx.restore();
}

// HP bar floating above a player's head, in the player's colour, red when low.
function drawHpBar(p, px, py, col) {
  const w = 14, x = px + p.w / 2 - w / 2, y = py - 7, k = Math.max(0, p.hp) / simCfg().maxHp;
  ctx.fillStyle = 'rgba(5,3,10,.75)'; rrect(ctx, x - .5, y - .5, w + 1, 2.6, .8); ctx.fill();
  ctx.save(); ctx.shadowColor = ctx.fillStyle = k > .34 ? col : NEON.pink; ctx.shadowBlur = blur(2);
  if (k > 0) { rrect(ctx, x, y, w * k, 1.6, .6); ctx.fill(); }
  ctx.restore();
}

const hudCache = {};
function setText(id, s) { if (hudCache[id] !== s) { hudCache[id] = s; document.getElementById(id).textContent = s; } }

// ---------- debug panel (D): NinjaRunner's, with combat tunables and dummy switches ----------
// Offline it edits CFG. Online it is the room's settings panel (SPEC §17.1), for the room's admin
// only (pending or playing): every slider and the gore switches change the room for everyone in it.
// The slider table is shared with the server (SETTINGS), which checks every value against it.
const DBG_SPEC = [...SETTINGS, ['World', [['gameSpeed', 'Game speed', .1, 2, .05]]]];   // game speed: offline only
const panel = document.getElementById('dbg');
const panelOk = () => !ONLINE || net.isAdmin();
function saveCfg() {
  const changed = {};
  for (const k in CFG) if (CFG[k] !== ALL_DEFAULTS[k]) changed[k] = CFG[k];
  try { localStorage.setItem(CFG_KEY, JSON.stringify(changed)); } catch (e) { /* ignore */ }
}
function fmt(v, step) { return step >= 1 ? String(v) : (+v).toFixed(step < .1 ? 2 : 1); }
function jumpInfo() {
  const c = simCfg();
  const h = c.jumpVel ** 2 / (2 * c.gravity) / T;
  const air = 2 * c.jumpVel / c.gravity;
  return `Jump height ≈ ${h.toFixed(1)} tiles · walk-jump ≈ ${(air * c.walkSpeed / T).toFixed(1)} tiles · run-jump ≈ ${(air * c.runSpeed / T).toFixed(1)} tiles`;
}
// The value a panel control shows, and setting it: CFG offline; online the room's (sent to the
// server, which echoes it back as a `cfg` event to everyone in the room, us included).
const panelVal = key => (ONLINE && key in net.cfg ? net.cfg[key] : CFG[key]);
function panelSet(key, v) {
  if (ONLINE) { net.setCfg({ [key]: v }); return; }
  CFG[key] = v; saveCfg();
  if (key === 'gore') dbg('perf', 'gore: ' + (v ? 'on' : 'off'));
  if (key === 'realGore') applyBloodStyle();
}
let fpsEl = null, netEl = null, errCv = null, reportEl = null, audioEl = null;
function buildDebug() {
  panel.innerHTML = '';
  const h = document.createElement('h2'); h.innerHTML = `<span>${ONLINE ? 'Room settings' : 'Debug'}</span><span style="color:#bbb;font-weight:400">D to close</span>`;
  panel.appendChild(h);
  fpsEl = document.createElement('div'); fpsEl.className = 'info stat'; fpsEl.style.whiteSpace = 'pre-line'; panel.appendChild(fpsEl);
  if (ONLINE) {
    netEl = document.createElement('div'); netEl.className = 'info stat'; netEl.style.whiteSpace = 'pre-line'; panel.appendChild(netEl);
    const gl = document.createElement('div'); gl.className = 'info'; gl.textContent = 'Prediction error (units, last 6 s; line = 2)'; panel.appendChild(gl);
    errCv = document.createElement('canvas'); errCv.width = 256; errCv.height = 48; errCv.className = 'graph'; panel.appendChild(errCv);
    const note = document.createElement('div'); note.className = 'info'; note.style.color = '#ff6ec7';
    note.textContent = `You are the admin: these settings change ${net.lobby.rname || 'the room'} for everyone in it, until it closes.`; panel.appendChild(note);
  }
  const info = document.createElement('div'); info.className = 'info'; panel.appendChild(info);
  const refresh = () => { info.textContent = jumpInfo(); };
  for (const [group, items] of DBG_SPEC) {
    if (ONLINE && group === 'World') continue;   // game speed: the server's clock is shared by every room
    const g = document.createElement('h3'); g.textContent = group; panel.appendChild(g);
    for (const [key, name, min, max, step] of items) {
      const lab = document.createElement('label');
      const n = document.createElement('span'); n.textContent = name;
      const v = document.createElement('span'); v.className = 'v'; v.textContent = fmt(panelVal(key), step);
      const r = document.createElement('input');
      Object.assign(r, { type: 'range', min, max, step, value: panelVal(key) });
      // offline every move applies at once; online the value goes to the server when the slider is let go
      r.addEventListener('input', () => { v.textContent = fmt(+r.value, step); if (!ONLINE) { panelSet(key, +r.value); refresh(); } });
      r.addEventListener('change', () => { if (ONLINE) panelSet(key, +r.value); });
      r.addEventListener('dblclick', () => { r.value = ALL_DEFAULTS[key]; v.textContent = fmt(ALL_DEFAULTS[key], step); panelSet(key, ALL_DEFAULTS[key]); refresh(); });
      lab.append(n, v, r); panel.appendChild(lab);
    }
  }
  const g = document.createElement('h3'); g.textContent = ONLINE ? 'View' : 'Cheats & view'; panel.appendChild(g);
  // hitboxes are this page's own view; gore and the blood style are the room's online
  const toggles = [['hitboxes', 'Show hitboxes (only you)'], ...SETTING_TOGGLES, ['dummyWander', 'Dummy wanders'], ['dummySlash', 'Dummy slashes'], ['invincible', 'Invincible (not spikes)']];
  for (const [key, name] of ONLINE ? toggles.slice(0, 3) : toggles) {
    const lab = document.createElement('label'); lab.className = 'chk';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!(key === 'hitboxes' ? CFG.hitboxes : panelVal(key));
    c.addEventListener('change', () => { if (key === 'hitboxes') { CFG.hitboxes = c.checked; saveCfg(); } else panelSet(key, c.checked); });
    lab.append(c, document.createTextNode(name)); panel.appendChild(lab);
  }
  // sound: this browser's own
  const sh = document.createElement('h3'); sh.textContent = 'Sound (only you)'; panel.appendChild(sh);
  {
    const lab = document.createElement('label');
    const v = document.createElement('span'); v.className = 'v'; v.textContent = fmt(CFG.musicVol, .05);
    const r = document.createElement('input'); Object.assign(r, { type: 'range', min: 0, max: 1, step: .05, value: CFG.musicVol });
    const set = x => { CFG.musicVol = x; v.textContent = fmt(x, .05); if (music) { music.target = x; music.apply(); } saveCfg(); };
    r.addEventListener('input', () => set(+r.value));
    r.addEventListener('dblclick', () => { r.value = ALL_DEFAULTS.musicVol; set(ALL_DEFAULTS.musicVol); });
    lab.append(document.createTextNode('Music volume'), v, r); panel.appendChild(lab);
    audioEl = document.createElement('div'); audioEl.className = 'info'; panel.appendChild(audioEl);
  }
  const btns = document.createElement('div'); btns.className = 'btns';
  const mkBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); btns.appendChild(b); return b; };
  if (ONLINE) mkBtn('Reset to defaults', () => net.resetCfg());   // the room's settings; the echo rebuilds the panel
  else mkBtn('Reset defaults', () => { Object.assign(CFG, ALL_DEFAULTS); saveCfg(); applyBloodStyle(); buildDebug(); });
  const copy = mkBtn('Copy values', async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(ONLINE ? net.cfg : CFG, null, 2)); copy.textContent = 'Copied!'; }
    catch (e) { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = 'Copy values'; }, 1200);
  });
  if (!ONLINE) mkBtn('Restart', () => resetWorld());
  panel.appendChild(btns);
  const rb = document.createElement('div'); rb.className = 'btns';
  const send = document.createElement('button'); send.textContent = 'Send debug report'; rb.appendChild(send);
  panel.appendChild(rb);
  reportEl = document.createElement('div'); reportEl.className = 'info stat'; panel.appendChild(reportEl);
  send.addEventListener('click', async () => {
    send.disabled = true; reportEl.textContent = 'Sending…';
    const id = await sendReport('manual', 'debug panel');
    reportEl.textContent = id ? `Report id: ${id} (quote this when asking for help)` : 'Report could not be sent.';
    send.disabled = false;
  });
  const tip = document.createElement('div'); tip.className = 'info'; tip.style.marginTop = '6px';
  tip.textContent = ONLINE ? 'Double-click a slider to reset it. Room settings last until the room closes.' : 'Double-click a slider to reset it. Settings are saved in this browser.';
  panel.appendChild(tip);
  refresh();
}
// Net statistics and the prediction-error graph, refreshed twice a second while the panel is open.
function refreshNetDebug() {
  if (!netEl) return;
  const st = net.stats;
  netEl.textContent = `build ${BUILD || '?'}${net.serverBuild && net.serverBuild !== BUILD ? ' (server ' + net.serverBuild + ')' : ''}\n` + `RTT ${st.rtt.toFixed(0)} ms (avg ${st.rttAvg.toFixed(0)}, max ${st.rttMax.toFixed(0)}) · ${net.state}\n` +
    `snapshot jitter ${st.jitter.toFixed(1)} ms · id ${net.id ?? '-'} · ${net.mode}\n` +
    `pred err RMS ${net.predErrRms().toFixed(2)} · snaps ${st.snapsSnapped} · reconnects ${st.reconnects}`;
  const g = errCv.getContext('2d'), W = errCv.width, H = errCv.height, max = 4;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,42,109,.6)'; g.beginPath(); g.moveTo(0, H - 2 / max * H); g.lineTo(W, H - 2 / max * H); g.stroke();
  const e = st.predErr, n = e.length;
  g.strokeStyle = '#39ff14'; g.beginPath();
  for (let i = 0; i < n; i++) { const x = W - (n - i) * W / 180, y = H - Math.min(max, e[i]) / max * H; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}
// Online only the room's admin has the panel (SPEC §13, §17.1): for anyone else D does nothing.
function toggleDebug() {
  if (!panelOk()) { panel.classList.add('hidden'); return; }
  if (panel.classList.toggle('hidden')) return;
  buildDebug();
}
// The admin role moved, or the room we look at changed: close the panel if it is no longer ours,
// and show the D hint only to the admin.
function syncPanel() {
  if (!ONLINE) return;
  const ok = panelOk();
  if (!ok && !panel.classList.contains('hidden')) { panel.classList.add('hidden'); dbg('life', 'settings panel closed: not admin'); }
  const hd = document.getElementById('helpD');
  hd.textContent = ' · D room settings'; hd.style.display = ok ? '' : 'none';
}
// The room's settings changed (net.cfg; ev: the server's `cfg` event, null from a welcome or lobby).
// Apply the room-wide display switches, refresh an open panel, and tell everyone in a quiet line.
const CFG_NAMES = { ...Object.fromEntries(SETTINGS.flatMap(([, items]) => items.map(([k, n]) => [k, n.replace(/ \(.*\)$/, '').toLowerCase()]))), gore: 'gore', realGore: 'real gore' };
function onRoomCfg(ev) {
  const style = bloodStyleName();
  roomView = { gore: net.cfg.gore, realGore: net.cfg.realGore };
  if (bloodStyleName() !== style) applyBloodStyle();
  if (!panel.classList.contains('hidden') && panelOk()) buildDebug();
  if (!ev) return;
  const ch = ev.ch ? Object.entries(ev.ch) : [];
  const what = ev.reset ? 'reset the room settings'
    : ch.length === 1 ? `set ${CFG_NAMES[ch[0][0]] || ch[0][0]} ${typeof ch[0][1] === 'boolean' ? (ch[0][1] ? 'on' : 'off') : ch[0][1]}`
      : `changed ${ch.length} room settings`;
  sysLine(`Admin ${what}`);
}

// ---------- loop: fixed 60 Hz steps, render every frame ----------
let acc = 0, last = performance.now(), fpsN = 0, fpsT = last, fps = 0;
let paused = false;   // window.__mp.pause() stops the clock so a script can step by hand
let fpsLogT = last;
function frame(t) {
  if (t - last > 50 && !document.hidden && t - last < 5000) dbg('perf', 'slow frame', { ms: Math.round(t - last) });
  if (!paused) {
    acc += Math.min(100, t - last) * (ONLINE ? 1 : CFG.gameSpeed);
    while (acc >= 1000 / 60) { update(); acc -= 1000 / 60; }
  }
  last = t;
  if (ONLINE) {
    net.flush();
    state = net.view(t);
    for (const f of state.fx) { const p = Sim.getPlayer(state, f.id); if (p && p.alive) playFx(f); }
  }
  const r0 = performance.now();
  render();
  const rms = performance.now() - r0;
  renderMs = renderMs * .95 + rms * .05;
  if (rms > 30 && (G.parts.length > 1500 || GL.lastMs > 15)) dbg('perf', 'gore: slow render', { ms: Math.round(rms), parts: G.parts.length, gibs: G.gibs.length, decals: G.decals.length, layerMs: +GL.lastMs.toFixed(1) });
  fpsN++;
  if (t - fpsT >= 500) {
    fps = fpsN * 1000 / (t - fpsT); fpsN = 0; fpsT = t;
    if (fpsEl && !panel.classList.contains('hidden')) {
      const me = Sim.getPlayer(state, ME);
      fpsEl.textContent = `FPS ${fps.toFixed(0)} · tick ${state.tick}` + (me ? ` · x ${me.x.toFixed(1)} y ${me.y.toFixed(1)}` : '') +
        `\ngore: ${G.parts.length} drops · ${G.gibs.length} pieces · ${G.decals.length} decals · ${G.pools.size} pools · step ${goreMs.toFixed(2)} ms · render ${renderMs.toFixed(1)} ms`;
      if (audioEl) audioEl.textContent = `music: ${music ? music.state : 'not started'}${music && music.rendered.ms ? ` (${music.rendered.ms} ms, ${music.rendered.sr} Hz, ${LITE_AUDIO ? 'lite' : 'full'})` : ''}${muted ? ' · muted (M)' : ''}${music && music.level ? ' · intensity' : ''}`;
      if (ONLINE) refreshNetDebug();
    }
  }
  if (t - fpsLogT >= 5000) { fpsLogT = t; if (!document.hidden) dbg('perf', 'fps', { fps: Math.round(fps), renderMs: +renderMs.toFixed(1), goreMs: +goreMs.toFixed(2), decals: G.decals.length }); }
  requestAnimationFrame(frame);
}

// ---------- online: connection, lobby screen ----------
const net = ONLINE ? createNet({ onIdle: () => { leaveMenu(false); backToLobby('You were idle for 2 minutes.'); }, onLobby: () => { renderLobby(); if (leaveOpen) renderLeave(); syncPanel(); }, onStatus: s => onNetStatus(s),
  onRefused: m => onRefused(m), onClosed: m => onRoomClosed(m), onRoom: () => { clearRoomView(); syncPanel(); }, onCfg: ev => onRoomCfg(ev),
  onMadeAdmin: e => toast(`You are now the admin of ${net.lobby.rname || 'this room'}` + (e.why === 'auto' ? '\n(the previous admin left)' : '')) }) : null;
// A short notice over the lobby or the game (#toast), gone after a few seconds.
function toast(text, ms = 5000) {
  const el = document.getElementById('toast');
  el.textContent = text; el.style.whiteSpace = 'pre-line'; el.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms);
}
let lobbyOpen = ONLINE;
const LS_NAME = 'multisplat-name', LS_COLOR = 'multisplat-color';
const lobbyEl = document.getElementById('lobby');
let pickedColor = 0;
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

function setupLobby() {
  const nameIn = document.getElementById('lName');
  nameIn.value = lsGet(LS_NAME) || '';
  // the room we look at lists us under what the name field holds (SPEC §17): sent when it settles
  const sendName = () => { if (net) net.setViewInfo({ name: cleanName(nameIn.value) || '' }); };
  sendName();
  nameIn.addEventListener('input', () => { clearTimeout(sendName.t); sendName.t = setTimeout(sendName, 700); });
  pickedColor = Math.max(0, Math.min(COLORS.length - 1, +lsGet(LS_COLOR) || 0));
  const sw = document.getElementById('lColors');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.setProperty('--c', c); b.title = `colour ${i + 1}`; b.dataset.i = i;
    b.addEventListener('click', () => { if (takenColors().has(i)) return; pickedColor = i; lsSet(LS_COLOR, String(i)); markColor(); });
    sw.appendChild(b);
  });
  markColor();
  document.getElementById('lFight').addEventListener('click', fight);
  document.getElementById('lWatch').addEventListener('click', () => watch(true));   // SPEC §16: no name, no slot
  // Rooms (SPEC §17): two screens. Tapping a room in the list opens its screen (the server then sends
  // its roster, snapshots and events); Leave goes back to the list; create one; rename ours (admin).
  document.getElementById('lRoomList').addEventListener('click', e => {
    const b = e.target.closest('button[data-room]');
    if (b && net.mode === 'viewer') { showNotice(''); net.viewRoom(+b.dataset.room); }
  });
  document.getElementById('lBack').addEventListener('click', backToRooms);
  document.getElementById('lCreate').addEventListener('click', createRoom);
  document.getElementById('lRenameBtn').addEventListener('click', () => renameRoom('lRenameIn'));
  // AI players (SPEC §15): − / + ask the server (admin only); the count shown is always the server's
  for (const [id, d] of [['lBotDec', -1], ['lBotInc', 1], ['lvBotDec', -1], ['lvBotInc', 1]]) document.getElementById(id).addEventListener('click', () => net.bots(d));
  // "Make admin" buttons (lobby roster, Esc menu): each opens the confirm dialog
  for (const id of ['lPlayers', 'lQueue', 'lvPlayers', 'lVisitors', 'lvVisitors']) document.getElementById(id).addEventListener('click', e => {
    const b = e.target.closest('button.mkadm');
    if (b) admDialog(b.dataset.conn ? { conn: +b.dataset.conn, name: b.dataset.name } : { id: +b.dataset.id, name: b.dataset.name });
  });
  // The log word id (SPEC §13.5), small in the footer so a player can quote it.
  const idEl = document.getElementById('lId'), showId = w => { idEl.textContent = w ? ` · id: ${w}` : ''; };
  if (net) { showId(net.word); net.onWord = showId; }
}
// Colours already worn by fighters in the room can't be picked (the server would hand out another anyway).
function takenColors() { return new Set(net ? (net.lobby.players || []).filter(p => p.id !== net.id).map(p => p.color) : []); }
function markColor() {
  const taken = takenColors();
  if (lobbyOpen && taken.has(pickedColor)) {   // our remembered colour is in use: move to the next free one
    for (let k = 1; k < COLORS.length; k++) { const c = (pickedColor + k) % COLORS.length; if (!taken.has(c)) { pickedColor = c; break; } }
  }
  for (const b of document.querySelectorAll('#lColors .sw')) {
    const i = +b.dataset.i;
    b.classList.toggle('on', i === pickedColor); b.classList.toggle('taken', taken.has(i));
    b.title = taken.has(i) ? 'taken' : `colour ${i + 1}`;
  }
}
function lobbyName() {
  const name = cleanName(document.getElementById('lName').value);
  document.getElementById('lErr').textContent = name ? '' : 'Name: 1–16 letters, digits, space, _ or -';
  if (name) lsSet(LS_NAME, name);
  return name;
}
function closeLobby() {
  lobbyOpen = false;
  lobbyEl.classList.add('hidden');
  document.body.classList.remove('inlobby');
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  snapCamera();
}

// FIGHT joins the room whose screen is open (SPEC §17); its pending admin (the creator) joins and stays
// admin. A page already in that room just goes back to the fight.
function fight() {
  if (!lobbyOpen) return;
  if (net.mode !== 'viewer') { initAudio(); goLandscape(); closeLobby(); return; }
  const room = net.lobby.room;
  if (!room) return;   // the room list: nothing to fight in
  const name = lobbyName();
  if (!name) return;
  initAudio();
  goLandscape();
  net.join(name, pickedColor, room);
  closeLobby();
}
// Create a room: it does not join. We are its admin and land on its screen (the server's lobby
// message names it), where we can name it and add AI players before FIGHT. The server may refuse
// (10 rooms, 2 per address, rate, a bad name). Our remembered player name, if any, goes along for the
// default room name and the list.
function createRoom() {
  if (!lobbyOpen || net.mode !== 'viewer' || net.lobby.room) return;
  const raw = document.getElementById('lRoomName').value.trim();
  const rname = raw ? cleanRoomName(raw) : '';
  if (rname === null) { showNotice(ROOM_NAME_RULE); return; }
  showNotice('');
  initAudio();
  net.create(rname, cleanName(lsGet(LS_NAME) || '') || undefined);
  document.getElementById('lRoomName').value = '';
}
// Leave (the room screen's top-left button): back to the room list. Leaving the screen of a room we created and nobody has joined
// closes it; with others in it we must make someone admin first (the server refuses too).
function backToRooms() {
  if (!lobbyOpen || net.mode !== 'viewer') return;
  if (net.isAdmin() && otherHumans().length) { showNotice('Make someone admin first.'); return; }
  showNotice('');
  net.viewRoom(0);
}
const ROOM_NAME_RULE = "Room name: 1–20 letters, digits, space, ' _ or -";
function renameRoom(inputId) {
  const el = document.getElementById(inputId);
  const n = cleanRoomName(el.value);
  if (!n) { setText('rnmErr', ROOM_NAME_RULE); el.focus(); return; }
  showNotice('');
  net.rename(n);
  el.value = '';
  renameDialog(false);
}
// The rename dialog (the room screen's Rename, admin only): the current name, selected, to type over.
var rnmOpen = false;   // var: renderLobby may run before this line is reached
function renameDialog(open) {
  rnmOpen = open;
  document.getElementById('rnm').classList.toggle('hidden', !open);
  setText('rnmErr', '');
  if (open) { const el = document.getElementById('lRenameIn'); el.value = net.lobby.rname || ''; el.focus(); el.select(); }
}
document.getElementById('lRenameOpen').addEventListener('click', () => renameDialog(true));
document.getElementById('rnmNo').addEventListener('click', () => renameDialog(false));
document.getElementById('rnm').addEventListener('click', e => { if (e.target.id === 'rnm') renameDialog(false); });
// What the server's `refused` reasons mean to a player (SPEC §17).
const REFUSED = {
  'create full': `${ROOM.max} rooms are open, the most there can be. Join one, or try again later.`,
  'create ip': `You already have ${ROOM.perIp} rooms open.`,
  'create rate': 'Too many new rooms: wait a few seconds.',
  'create name': ROOM_NAME_RULE, 'rename name': ROOM_NAME_RULE,
  'rename rate': 'Too many changes: wait a few seconds.', 'admin rate': 'Too many changes: wait a few seconds.',
  'rename admin': 'Only the admin can rename the room.', 'bots admin': "Only the room's admin can add AI players.",
  'cfg admin': 'Only the admin can change the room settings.', 'cfg value': 'That setting is out of range.',
  'cfg rate': 'Too many changes: wait a few seconds.',
  'admin admin': 'You are not the admin any more.', 'admin target': 'They can’t be made admin (have they left?).',
  'join gone': 'That room has closed.', 'leave admin': 'Make someone admin first.',
};
function showNotice(text) {
  document.getElementById('lErr').textContent = text;
  document.getElementById('lvErr').textContent = text;
}
function onRefused(m) {
  const text = REFUSED[`${m.what} ${m.why}`] || `Refused (${m.what}: ${m.why}).`;
  if (m.what === 'join' && !lobbyOpen) { backToLobby(text); return; }   // FIGHT closed the lobby before the answer
  showNotice(text);
}
function onRoomClosed(m) {
  const text = `The room "${m.name}" has closed.`;
  if (watching || !lobbyOpen) { leaveMenu(false); backToLobby(text); } else showNotice(text);
}
// Another room's world (or none) is coming: forget the blood, bodies, chat and feed of the old one.
function clearRoomView() {
  corpses = []; popups = []; sparks = []; L.bloody.clear(); clearGore(G);
  feed.length = 0; feedDirty = true; chats.clear(); chatListEl.textContent = ''; stripKey = '';
}

// Lists with buttons are rebuilt only when what they show changed: a rebuild between a press and its
// release (lobby updates come twice a second) would swallow the click. True: unchanged, keep it;
// false: the list was emptied, refill it.
function sameList(el, data) {
  const sig = JSON.stringify(data);
  if (el.dataset.sig === sig) return true;
  el.dataset.sig = sig; el.textContent = '';
  return false;
}
// One roster row: colour dot, name (+ "admin"), and for the admin a small "Make admin" button next to
// every other human (SPEC §17). Names go in as text only.
function rosterRow(p, { score = true, me = false, prefix = '' } = {}) {
  const li = document.createElement('li'); if (me) li.className = 'me';
  const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = PALETTE[p.color] || '#fff';
  const nm = document.createElement('span'); nm.className = 'nm';
  nm.textContent = prefix + p.name + (p.id === net.id ? ' (you)' : '') + (p.away ? ' (away)' : '');
  if (p.id === net.lobby.admin) { const a = document.createElement('span'); a.className = 'adm'; a.textContent = 'ADMIN'; nm.appendChild(a); }
  li.append(dot, nm);
  if (net.isAdmin() && !p.bot && p.id !== net.id) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'mkadm'; b.textContent = 'Make admin';
    b.dataset.id = p.id; b.dataset.name = p.name; b.setAttribute('aria-label', `Make ${p.name} admin`);
    li.appendChild(b);
  }
  if (score) { const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = String(p.score); li.appendChild(sc); }
  return li;
}
// The room's lobby visitors (SPEC §17: on its screen, or 👁 watching), longest first, under "In the
// lobby": name (or "(no name)"), ADMIN for its pending admin, and for the admin a "Make admin" button
// next to everyone else. The section is hidden while nobody but ourselves is there.
function renderVisitors(boxId, ulId, hideClass) {
  const { lobby = [], padmin = null, you = null } = net.lobby, admin = net.isAdmin();
  const others = lobby.filter(v => v.c !== you);
  document.getElementById(boxId).classList.toggle(hideClass, !others.length);
  const ul = document.getElementById(ulId);
  if (sameList(ul, [admin, padmin, you, lobby])) return;
  for (const v of lobby) {
    const li = document.createElement('li'); if (v.c === you) li.className = 'me';
    const nm = document.createElement('span'); nm.className = 'nm' + (v.name ? '' : ' none');
    nm.textContent = (v.w ? '👁 ' : '') + (v.name || '(no name)') + (v.c === you ? ' (you)' : '');
    if (v.w) nm.title = 'watching';
    if (v.c === padmin) { const a = document.createElement('span'); a.className = 'adm'; a.textContent = 'ADMIN'; nm.appendChild(a); }
    li.appendChild(nm);
    if (admin && v.c !== you) {
      const label = v.name || 'this visitor';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mkadm'; b.textContent = 'Make admin';
      b.dataset.conn = v.c; b.dataset.name = label; b.setAttribute('aria-label', `Make ${label} admin`);
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}
// The AI row (lobby and Esc menu): − / + for the admin only; everyone else sees the count read-only
// (and no row at all when there are none).
function renderBots(pre) {
  const { bots = 0, botMax = 7, players = [], cap } = net.lobby, admin = net.isAdmin();
  setText(pre + 'BotN', String(bots));
  document.getElementById(pre + 'BotDec').disabled = !admin || bots <= 0;
  document.getElementById(pre + 'BotInc').disabled = !admin || bots >= botMax || players.length >= cap;
  for (const k of ['BotDec', 'BotInc']) document.getElementById(pre + k).classList.toggle('hidden2', !admin);
  document.getElementById(pre + 'Bots').classList.toggle('hidden2', !admin && !bots);
  setText(pre + 'BotRO', '');
}

// Two screens (SPEC §17): the room list with Create a room under it while we look at no room; the
// room's own screen (name, colour, FIGHT / WATCH, its roster, the admin's controls) while we do.
function renderLobby() {
  if (!ONLINE) return;
  markColor();
  const { rooms = [], maxRooms = ROOM.max, room, rname, players, queue, cap } = net.lobby;
  const member = net.mode !== 'viewer';
  document.getElementById('scrRooms').classList.toggle('hidden', !!room);
  document.getElementById('scrRoom').classList.toggle('hidden', !room);
  // one big button per room: its name, its admin, players/slots (kept current behind the room screen too)
  {
    const rl = document.getElementById('lRoomList');
    const rows = rooms.map(r => [r.id, r.name, r.admin, r.n, r.cap]);
    if (!sameList(rl, rows)) for (const r of rooms) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.dataset.room = r.id;
      const nm = document.createElement('span'); nm.className = 'rn'; nm.textContent = r.name;
      const ad = document.createElement('span'); ad.className = 'ra'; ad.textContent = r.admin ? `★ ${r.admin}` : '';
      const ct = document.createElement('span'); ct.className = 'rc'; ct.textContent = `${r.n}/${r.cap}`;
      b.append(nm, ad, ct); li.appendChild(b); rl.appendChild(li);
    }
    if (!rooms.length && !rl.children.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No rooms yet — create one below.'; rl.appendChild(li); }
    const full = rooms.length >= maxRooms;
    document.getElementById('lCreate').disabled = full;
    document.getElementById('lRoomName').disabled = full;
    setText('lCreateNote', full ? `${maxRooms} rooms are open, the most there can be.` : '');
  }
  if (!room) return;
  setText('lRoomTitle', rname || '');
  document.getElementById('lBack').classList.toggle('hidden2', member);
  const list = document.getElementById('lPlayers'), admin = net.isAdmin(), adm = net.lobby.admin;
  document.getElementById('lRenameOpen').classList.toggle('hidden2', !admin);
  if (!admin && rnmOpen) renameDialog(false);   // no longer the admin
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (!sameList(list, [admin, adm, net.id, sorted])) for (const p of sorted) list.appendChild(rosterRow(p, { me: p.id === net.id }));
  if (!players.length && !list.children.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Nobody is fighting yet.'; list.appendChild(li); }
  let info = `${players.length}/${cap} fighting`;
  if (queue.length) info += ` · ${queue.length} waiting`;
  if (players.length >= cap && net.mode !== 'queue' && !member) info += ` · FULL: you will be #${queue.length + 1} in the queue`;
  if (admin) info += ' · you are the admin';
  document.getElementById('lInfo').textContent = info;
  document.getElementById('lInfo').classList.toggle('full', players.length >= cap);
  // the queue, numbered, with our own place marked
  const ql = document.getElementById('lQueue');
  if (!sameList(ql, [admin, adm, net.id, queue])) queue.forEach((q, i) => ql.appendChild(rosterRow(q, { score: false, me: q.id === net.id, prefix: `#${i + 1} ` })));
  document.getElementById('lQueueBox').classList.toggle('hidden', !queue.length);
  renderVisitors('lVisBox', 'lVisitors', 'hidden');
  renderBots('l');
  document.getElementById('lWatch').disabled = member;   // SPEC §16: watching is for lobby viewers
}

// ---------- the admin transfer confirm dialog (SPEC §17): every "Make admin" tap asks first ----------
// Cancel has the focus, so a stray Enter does not hand the room away; Esc or a tap outside cancels.
let admOpen = null;   // {id, name} (a player) or {conn, name} (a lobby visitor) while open
const admEl = document.getElementById('adm');
function admDialog(target) {
  admOpen = target;
  admEl.classList.toggle('hidden', !target);
  if (target) {
    document.getElementById('admWho').textContent = target.name;
    document.getElementById('admRoom').textContent = net.lobby.rname || 'this room';
    document.getElementById('admNo').focus();
  }
  dbg('life', target ? 'make admin: asking' : 'make admin: closed', target ? (target.conn != null ? { conn: target.conn } : { id: target.id }) : {});
}
document.getElementById('admNo').addEventListener('click', () => admDialog(null));
document.getElementById('admYes').addEventListener('click', () => { const t = admOpen; admDialog(null); if (t) net.makeAdmin(t); });
admEl.addEventListener('click', e => { if (e.target === admEl) admDialog(null); });

// ---------- how to play: H (or ? on touch, or the lobby link) opens it; H, Escape, Enter or Close shuts it ----------
let helpOpen = false;
const helpEl = document.getElementById('howto');
function helpScreen(open) {
  if (open === helpOpen) return;
  helpOpen = open;
  helpEl.classList.toggle('hidden', !open);
  for (const k in keys) keys[k] = false;
  latch = 0; fingers.clear(); syncTouch(); board(false);
  if (open) helpEl.querySelector('.box').scrollTop = 0;
  dbg('life', open ? 'help opened' : 'help closed');
}
document.getElementById('hwClose').addEventListener('click', () => helpScreen(false));
helpEl.addEventListener('click', e => { if (e.target === helpEl) helpScreen(false); });
document.getElementById('lHelp').addEventListener('click', e => { e.preventDefault(); helpScreen(true); });

// ---------- leaving: Escape (or ✕ on touch) asks first; the game carries on behind the menu ----------
// The menu also holds the room panel (SPEC §17): its name (the admin can rename it), the AI row (the
// admin's − / +) and its humans, with "Make admin" buttons for the admin. The admin cannot leave while
// another human is in the room: Leave is disabled until someone else is made admin. An admin who is
// the only human stays admin on the room's screen (the room closes if it then goes back to the list).
let leaveOpen = false;
const leaveEl = document.getElementById('leave');
function leaveMenu(open) {
  if (open === leaveOpen || (open && lobbyOpen)) return;
  leaveOpen = open;
  leaveEl.classList.toggle('hidden', !open);
  for (const k in keys) keys[k] = false;
  latch = 0; fingers.clear(); syncTouch(); board(false);
  if (open) {
    document.getElementById('lvErr').textContent = '';
    renderLeave();
    document.getElementById('lvNo').focus();   // Stay is the default, so a stray Enter doesn't quit
  } else document.activeElement && document.activeElement.blur && document.activeElement.blur();
  dbg('life', open ? 'leave menu opened' : 'leave menu closed');
}
// Others in our room who are human (playing or queued): the ones the admin must hand over to.
function otherHumans() {
  const { players = [], queue = [] } = net.lobby;
  return [...players, ...queue].filter(p => !p.bot && p.id !== net.id);
}
function renderLeave() {
  const roomPanel = ONLINE && net.mode !== 'viewer' && net.lobby.room;
  document.getElementById('lvRoom').classList.toggle('hidden2', !roomPanel);
  const yes = document.getElementById('lvYes');
  yes.disabled = false; yes.textContent = 'Leave';
  setText('lvTitle', 'Leave the fight?');
  if (!roomPanel) {
    document.getElementById('lvNote').textContent = 'Back to the lobby.';
    return;
  }
  const m = net.meta.get(net.id), admin = net.isAdmin(), others = otherHumans();
  let note = net.mode === 'queue' ? 'You will lose your place in the queue.' : `Your score${m ? ` of ${m.score}` : ''} will be lost.`;
  if (admin) note += ' You stay the admin, on the room\'s screen.';
  document.getElementById('lvNote').textContent = note;
  setText('lvRName', net.lobby.rname || '');
  renderBots('lv');
  const ul = document.getElementById('lvPlayers');
  const { players = [], queue = [] } = net.lobby;
  if (!sameList(ul, [admin, net.lobby.admin, net.id, players, queue])) for (const p of [...players, ...queue].filter(p => !p.bot)) ul.appendChild(rosterRow(p, { score: false, me: p.id === net.id }));
  renderVisitors('lvVisBox', 'lvVisitors', 'hidden2');
}
function leaveGame() {
  leaveMenu(false);
  if (!ONLINE) { location.href = location.pathname; return; }
  net.leave();
  backToLobby('');
}
function backToLobby(message) {
  if (watching) watchUi(false);
  if (admOpen) admDialog(null);
  if (rnmOpen) renameDialog(false);
  lobbyOpen = true;
  lobbyEl.classList.remove('hidden');
  document.body.classList.add('inlobby');
  document.getElementById('lErr').textContent = message;
  renderLobby();
}
document.getElementById('lvYes').addEventListener('click', leaveGame);
document.getElementById('lvNo').addEventListener('click', () => leaveMenu(false));

// ---------- watching (SPEC §16): Watch in the lobby shows the arena full screen, following a ninja ----------
// A watcher is just a lobby viewer with the lobby closed: no hello, no record, no slot (so it works with
// a full arena or a queue), net.mode stays 'viewer', and the server already sends viewers every
// snapshot and event and ignores their input. Which ninja the camera follows never leaves the page:
// the one clicked or tapped (followed through death and respawn), else the leader (shared/spectate.js).
let watching = false, watchChosen = null, watchId = null;   // chosen: picked by the watcher; id: followed now
const watchEl = document.getElementById('watch');
function watchUi(on) {
  watching = on; watchChosen = null; watchId = null;
  if (net) net.setViewInfo({ watch: on });   // the room's lobby list marks watchers 👁 (SPEC §17)
  document.body.classList.toggle('watching', on);
  watchEl.classList.toggle('hidden', !on);
  for (const k in keys) keys[k] = false;
  latch = 0; fingers.clear(); syncTouch(); board(false); stripKey = '';
}
function watch(on) {
  if (!ONLINE || on === watching) return;
  if (on && (!lobbyOpen || net.mode !== 'viewer' || !net.lobby.room)) return;   // Watch is for the selected room (SPEC §17)
  watchUi(on);
  dbg('life', on ? 'watching' : 'stopped watching');
  if (!on) { backToLobby(''); return; }
  initAudio();
  goLandscape();
  lobbyOpen = false;
  lobbyEl.classList.add('hidden');
  document.body.classList.remove('inlobby');
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  watchTarget(); snapCamera();
}
// The followed ninja this frame (also called by the camera); forgets a chosen one that has left.
function watchTarget() {
  const t = followTarget(state.players, standings(), watchChosen);
  if (watchChosen != null && t.chosen == null) dbg('life', 'watched player left', { id: watchChosen });
  watchChosen = t.chosen; watchId = t.id;
  return t.id;
}
// Client (CSS px) ↔ world units through the drawn canvas. On a phone held upright the stage is
// turned 90° clockwise, so the canvas's x runs down the screen and its y from right to left.
function toWorld(px, py) {
  const r = cv.getBoundingClientRect(), rot = stage.classList.contains('rot');
  const u = rot ? (py - r.top) / r.height : (px - r.left) / r.width, v = rot ? (r.right - px) / r.width : (py - r.top) / r.height;
  return u < 0 || u > 1 || v < 0 || v > 1 ? null : { x: S.camX + u * VW, y: S.camY + v * VH };
}
function toClient(x, y) {
  const r = cv.getBoundingClientRect(), rot = stage.classList.contains('rot'), u = (x - S.camX) / VW, v = (y - S.camY) / VH;
  return rot ? { x: r.right - v * r.width, y: r.top + u * r.height } : { x: r.left + u * r.width, y: r.top + v * r.height };
}
// Click or tap a ninja to follow it; a click on the arena away from everyone changes nothing.
// Hit-tested against the drawn (interpolated) positions, with a fingertip's tolerance on touch.
stage.addEventListener('pointerdown', e => {
  if (!watching || lobbyOpen || helpOpen || e.button > 0 || e.target.closest('button, input, a, #watch')) return;
  const w = toWorld(e.clientX, e.clientY);
  if (!w) return;
  const hit = pickAt(state.players, w.x, w.y, e.pointerType === 'touch' ? PICK_TOL.touch : PICK_TOL.mouse);
  if (hit == null) return;
  watchChosen = hit;
  watchTarget();
  dbg('life', 'watch: follow', { id: watchId });
});
// ← → the next or previous ninja in score order, ↓ back to the leader.
function watchKey(e) {
  if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight' && e.code !== 'ArrowDown') return false;
  e.preventDefault();
  if (!e.repeat) watchChosen = e.code === 'ArrowDown' ? null : cycleTarget(state.players, standings(), watchTarget(), e.code === 'ArrowLeft' ? -1 : 1);
  watchTarget();
  return true;
}
// The bar under the score strip: who is followed (in their colour) and how to change it.
function watchHud() {
  const m = watchId != null ? metaOf(watchId) : null;
  setText('wWho', m ? m.name : 'the arena');
  setText('wWhy', m ? (watchChosen != null ? '' : ' (the leader)') : ' · nobody is fighting yet');
  const col = m ? PALETTE[m.color] || '#fff' : '#d1f7ff';
  if (watchHud.col !== col) { watchHud.col = col; document.getElementById('wWho').style.color = col; }
  const lead = watchChosen != null;                          // the touch LEADER button: only while someone else is chosen
  if (watchHud.lead !== lead) { watchHud.lead = lead; document.getElementById('wLeader').classList.toggle('on', lead); }
}
document.getElementById('wLobby').addEventListener('click', () => watch(false));
document.getElementById('wLeader').addEventListener('click', () => { watchChosen = null; watchTarget(); dbg('life', 'watch: leader', {}); });

// ---------- chat (SPEC §9): C opens a one-line box, Enter sends, Escape cancels ----------
// Incoming lines show as a speech bubble above the speaker (canvas text) and in a small list at the
// bottom left (DOM, textContent only). Text is never HTML and never goes into the debug log.
let chatOpen = false;
const chats = new Map();      // player id -> { text, at, lines } the bubble currently shown
const chatBox = document.getElementById('chatbox'), chatIn = document.getElementById('chatIn'), chatListEl = document.getElementById('chatlist');
function chatScreen(open) {
  if (open === chatOpen) return;
  if (open && (!ONLINE || lobbyOpen || leaveOpen || helpOpen || !net || net.mode === 'viewer')) return;
  chatOpen = open;
  chatBox.classList.toggle('hidden', !open); document.body.classList.toggle('chatting', open);
  for (const k in keys) keys[k] = false;
  latch = 0; fingers.clear(); syncTouch(); board(false);
  if (open) { chatIn.value = ''; chatIn.focus(); } else { chatIn.value = ''; if (document.activeElement === chatIn) chatIn.blur(); }
  dbg('life', open ? 'chat opened' : 'chat closed');
}
function chatSend() {
  const text = cleanChat(chatIn.value);
  chatScreen(false);
  if (text) net.chat(text);
}
// Returns true when the key belongs to chat (the game's key handler then does nothing).
function chatKey(e) {
  if (chatOpen) {
    if (e.isComposing) return true;
    if (e.code === 'Escape' || e['key'] === 'Escape') { e.preventDefault(); chatScreen(false); }
    else if (e.code === 'Enter' || e['key'] === 'Enter') { e.preventDefault(); chatSend(); }
    else if (e.code === 'Tab') e.preventDefault();
    return true;   // anything else types into the box
  }
  if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName !== 'INPUT') {
    if (!ONLINE || lobbyOpen || leaveOpen || helpOpen) return false;
    e.preventDefault();   // the focused box must not receive this very C
    chatScreen(true);
    return chatOpen;
  }
  return false;
}
chatIn.addEventListener('blur', () => chatScreen(false));   // clicking away closes it
tapBtn('tChat', () => chatScreen(!chatOpen));   // focus() runs inside the tap, so a phone's keyboard comes up
document.getElementById('tChat').addEventListener('click', () => { if (chatOpen) chatIn.focus(); });
function onChatEvent(e) {
  if (typeof e.text !== 'string') return;
  const text = e.text, m = metaOf(e.id), now = performance.now();
  dbg('audio', 'chat blip', { id: e.id, len: Array.from(text).length });
  chats.set(e.id, { text, at: now, lines: null });
  sfx.chat();
  const row = document.createElement('div'), nm = document.createElement('b');
  nm.textContent = m ? m.name : '?'; nm.style.color = m ? colorOf(e.id) : '#cfd8e6';
  row.append(nm, ': ' + text);
  chatListEl.appendChild(row);
  while (chatListEl.children.length > 5) chatListEl.firstChild.remove();
  setTimeout(() => row.remove(), CHAT.showMs);
}
// A quiet line in the chat list from the game itself (a room-settings change, SPEC §17.1).
function sysLine(text) {
  const row = document.createElement('div'); row.className = 'sys'; row.textContent = text;
  chatListEl.appendChild(row);
  while (chatListEl.children.length > 5) chatListEl.firstChild.remove();
  setTimeout(() => row.remove(), CHAT.showMs);
}
// Word-wrap into at most 3 short lines (the rest is cut with an ellipsis; the list has it all).
function chatLines(text) {
  const maxW = 80, out = [];
  let cur = '';
  for (const word of text.split(' ')) {
    for (let w = word; w;) {   // a word longer than a line is broken by characters
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width <= maxW) { cur = t; break; }
      if (cur) { out.push(cur); cur = ''; continue; }
      let n = 1; const cs = Array.from(w);
      while (n < cs.length && ctx.measureText(cs.slice(0, n + 1).join('')).width <= maxW) n++;
      out.push(cs.slice(0, n).join('')); w = cs.slice(n).join('');
    }
  }
  if (cur) out.push(cur);
  if (out.length > 3) { out.length = 3; out[2] = Array.from(out[2]).slice(0, -1).join('') + '…'; }
  return out;
}
// The bubble sits above the star count and the throw hint (the highest things over a head).
function drawChatBubble(p, px, py) {
  const c = chats.get(p.id);
  if (!c) return;
  const age = performance.now() - c.at;
  if (age >= CHAT.showMs) { chats.delete(p.id); return; }
  ctx.save();
  ctx.font = '700 5px ui-monospace, Menlo, Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (!c.lines) c.lines = chatLines(c.text);
  const lh = 6, w = Math.max(...c.lines.map(l => ctx.measureText(l).width)) + 6, h = c.lines.length * lh + 3;
  let x = px + p.w / 2 - w / 2; x = Math.max(2, Math.min(VW - w - 2, x));
  const y = Math.max(2, py - 25 - h);   // bottom edge 25 above the feet line: clear of the throw hint (-21)
  ctx.globalAlpha = Math.max(0, Math.min(1, (CHAT.showMs - age) / CHAT.fadeMs));
  ctx.fillStyle = 'rgba(5,3,10,.82)'; ctx.strokeStyle = colorOf(p.id); ctx.lineWidth = .8;
  rrect(ctx, x, y, w, h, 2); ctx.fill(); ctx.stroke();
  const tx = Math.max(x + 3, Math.min(x + w - 3, px + p.w / 2));   // the tail points at the head
  ctx.beginPath(); ctx.moveTo(tx - 2, y + h); ctx.lineTo(tx, y + h + 2.5); ctx.lineTo(tx + 2, y + h); ctx.fillStyle = 'rgba(5,3,10,.82)'; ctx.fill();
  ctx.fillStyle = '#f2fbff'; ctx.textAlign = 'left';
  c.lines.forEach((l, i) => ctx.fillText(l, x + 3, y + 1.5 + (i + 1) * lh - 1.3));
  ctx.restore();
}

// ---------- versions (SPEC §10, §18) ----------
// The page's build id and rules hash come from its index.html (the server stamps both). net.js
// compares them with every welcome (compareVersion): the same rules → the game goes on, even across
// a server restart; other rules → net.onOutdated: a player's game stops with a message and OK reloads
// into the lobby, a lobby viewer just reloads. Only the UI older (other build, same rules) → a quiet
// reload the next time the page is on the room list with nothing typed (quietReload).
const BUILD = (document.querySelector('meta[name="build"]') || {}).content || '';
const RULES = (document.querySelector('meta[name="rules"]') || {}).content || '';
let staleBuild = false, updOpen = false;
if (net) { net.build = BUILD; net.rules = RULES; }
// Reload at most once per server version (`key`), so a mismatch can never loop. false: already tried.
function reloadOnce(key) {
  let done = null;
  try { done = sessionStorage.getItem('mp.reloadedFor'); sessionStorage.setItem('mp.reloadedFor', key); } catch { /* no storage: once per page life */ }
  if (done === key || reloadOnce.fired) return false;
  reloadOnce.fired = true;
  setTimeout(() => location.reload(), 600);
  return true;
}
if (net) net.onOutdated = ({ playing, server }) => {
  leaveMenu(false); if (admOpen) admDialog(null); if (chatOpen) chatScreen(false);
  if (!playing && reloadOnce('r:' + server)) {
    document.getElementById('lStatus').textContent = 'New version, reloading…';
    staleBuild = true;
    return;
  }
  // the game stops where it is (net sends and handles nothing more); the dialog says why
  updOpen = true;
  document.getElementById('upd').classList.remove('hidden');
  document.getElementById('updOk').focus();
};
document.getElementById('updOk').addEventListener('click', () => location.reload());
// A newer UI (build id) with the same rules: reload when nothing is lost by it, i.e. in the lobby (the
// room list or a room's screen), not fighting, watching or in a dialog. The page comes back where it
// was: the room it looked at and the half-typed name fields (this tab only, LS_DRAFT); a pending
// admin's role comes back with its seat (net.resumeSeat).
const LS_DRAFT = 'multisplat-draft', DRAFT_FIELDS = ['lName', 'lRoomName'];
function quietReload() {
  if (!net || !net.uiStale || net.halted() || !lobbyOpen || net.mode !== 'viewer' || watching || updOpen || admOpen || rnmOpen || chatOpen) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') return;   // typing right now
  const draft = { room: net.lobby.room || 0 };
  for (const id of DRAFT_FIELDS) draft[id] = document.getElementById(id).value;
  try { sessionStorage.setItem(LS_DRAFT, JSON.stringify(draft)); } catch { /* no storage: the room list after the reload */ }
  if (reloadOnce('b:' + net.uiStale)) dbg('net', 'quiet reload for a newer UI', { page: BUILD, server: net.uiStale, room: draft.room });
  else net.uiStale = null;
}
// After a quiet reload: back to the room's screen with the fields as they were (once).
function takeDraft() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(LS_DRAFT) || 'null'); sessionStorage.removeItem(LS_DRAFT); } catch { /* none */ }
  if (!d || typeof d !== 'object') return 0;
  for (const id of DRAFT_FIELDS) if (typeof d[id] === 'string' && d[id]) { const el = document.getElementById(id); el.value = d[id].slice(0, 20); el.dispatchEvent(new Event('input')); }
  return Number.isInteger(d.room) && d.room > 0 ? d.room : 0;
}
if (net) setInterval(quietReload, 1000);

function onNetStatus(s) {
  if (s === 'kicked') {
    dbg('life', 'back to lobby', { reason: net.kickReason });
    leaveMenu(false);
    backToLobby(net.kickReason === 'idle' ? 'You were idle for 2 minutes.' : `Disconnected by the server (${net.kickReason || 'kick'}).`);
  }
  if (s === 'expired') {   // reconnected after the 5 s resume window (a long network drop or a background tab)
    dbg('life', 'back to lobby', { reason: 'expired' });
    leaveMenu(false);
    backToLobby(net.lostToRestart ? 'The server was updated and could not keep this game. Press Fight to play again.'
      : `Connection lost for over ${NET.graceMs / 1000} s: your slot and score were released. Press Fight to play again.`);
  }
  document.getElementById('lStatus').textContent = s === 'open' ? '' : net.restarting() ? 'server updating…' : s === 'connecting' ? 'connecting…' : s === 'reconnecting' ? 'reconnecting…'
    : '';
}

setTickSource(() => (ONLINE ? net.serverTick : state.tick));
setReportSource(() => {
  const changed = {};
  for (const k in CFG) if (CFG[k] !== ALL_DEFAULTS[k]) changed[k] = CFG[k];
  const me = ONLINE ? net.me : Sim.getPlayer(state, ME);
  return {
    token: ONLINE ? net.token : null,
    env: { build: BUILD, rules: RULES, ua: navigator.userAgent, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
      touch: TOUCH_UI, audio: AC ? `${LITE_AUDIO ? 'lite' : 'full'} ${AC.state} ${AC.sampleRate}` : 'none',
      online: ONLINE, cfg: changed, ...(ONLINE ? { roomCfg: cfgDiff(net.cfg), admin: net.isAdmin() } : {}), page: location.pathname,
      music: music ? { state: music.state, ...music.rendered, muted, musicOff } : null,
      gore: { on: goreOn(), style: bloodStyleName(), parts: G.parts.length, gibs: G.gibs.length, decals: G.decals.length, pools: G.pools.size, ...G.stats, layerMs: +GL.lastMs.toFixed(1), renderMs: +renderMs.toFixed(1) } },
    net: ONLINE ? { state: net.state, mode: net.mode, id: net.id, rttAvg: net.stats.rttAvg, rttMax: net.stats.rttMax,
      jitterMs: net.stats.jitter, predErrRms: net.predErrRms(), reconnects: net.stats.reconnects, snaps: net.stats.snaps,
      snapCorrections: net.stats.snapsSnapped, pending: net.pending(), queuePos: net.queuePos, fps: Math.round(fps) } : { fps: Math.round(fps) },
    player: me ? { id: me.id, x: me.x, y: me.y, vx: me.vx, vy: me.vy, hp: me.hp, alive: me.alive, onGround: me.onGround,
      atk: me.atk, stun: me.stun, iframes: me.iframes, respawn: me.respawn, score: me.score, deaths: me.deaths } : null,
  };
});

if (ONLINE) {
  setupLobby();
  renderLobby();
  syncPanel();
  document.body.classList.add('inlobby');
  document.getElementById('help').classList.add('gone');
  if (net.resumeSaved()) { goLandscape(); closeLobby(); }   // this tab was playing before a reload: straight back in
  else {
    const back = takeDraft();                               // a quiet reload for a newer UI: where it was
    if (!net.resumeSeat() && back) net.viewRoom(back);      // or held a room as its admin: back on its screen
  }
  net.connect();
} else {
  lobbyEl.classList.add('hidden');
  resetWorld();
}
requestAnimationFrame(frame);

// Scripted checks: state, sim and helpers. input[id] = bitmask overrides that player's keys.
window.__mp = {
  get state() { return state; }, sim: Sim, cfg: CFG, level: L, get localId() { return ME; }, dummyId: DUMMY,
  online: ONLINE, net, get helpOpen() { return helpOpen; }, get lobbyOpen() { return lobbyOpen; }, get leaveOpen() { return leaveOpen; }, fight,
  // rooms (SPEC §17): create(roomName?) as the Create room button, the confirm dialog's target ({id, name} or null)
  createRoom, renameRoom, get admDialog() { return admOpen; },
  debug: { entries: dbgEntries, send: sendReport },
  get autopilot() { return autopilot; }, set autopilot(f) { autopilot = f; },
  events: eventLog, input: forced, get fps() { return fps; },
  // gore: per-kill fingerprints (same on every client), counts, and the layer's state
  gore: {
    G, fingerprint: key => fingerprint(G, key), settled: key => settled(G, key), keys: () => [...G.kills.keys()],
    get counts() { return { parts: G.parts.length, gibs: G.gibs.length, decals: G.decals.length, pools: G.pools.size, bloody: G.bloody.size, ...G.stats, layerRebuilds: GL.rebuilds, layerMs: GL.lastMs }; },
    // the blood style (SPEC §7), as the debug panel's "Real gore" toggle sets it (saved in localStorage)
    get style() { return bloodStyleName(); },
    // offline: as the panel's toggle (saved); online the style is a room setting, so this is a
    // page-local override for tests (not saved, not sent)
    setStyle(st) {
      if (ONLINE) styleOverride = st === 'real' ? 'real' : 'neon';
      else { CFG.realGore = st === 'real'; saveCfg(); }
      applyBloodStyle(); if (!panel.classList.contains('hidden')) buildDebug(); return bloodStyleName();
    },
  },
  get strip() { return { builds: stripBuilds, chips: [...stripEl.children].map(c => ({ id: +c.dataset.id, me: c.classList.contains('me'), text: c.textContent })) }; },
  get throwHint() { return performance.now() < throwHintUntil ? throwHintText() : null; },   // the "X to throw" reminder while shown
  get chat() { return { open: chatOpen, bubbles: [...chats].filter(([, c]) => performance.now() - c.at < CHAT.showMs).map(([id, c]) => ({ id, text: c.text })), lines: [...chatListEl.children].map(e => e.textContent) }; },
  get feed() { return [...feedEl.children].map(e => e.textContent); },
  get perf() { return { renderMs, goreMs, fps }; },
  get music() { return music; }, analyzeLoop, startAudio: initAudio,
  inject: evs => onEvents(evs),   // feed made-up events through the normal path (offline perf checks)
  pause() { paused = true; }, resume() { paused = false; last = performance.now(); acc = 0; },
  step(n = 1) { for (let i = 0; i < n; i++) update(); },
  reset: resetWorld,
  // spectator mode (SPEC §16): watch(on), the state, and where a ninja is on screen (client CSS px) for clicks
  watch, get watching() { return { on: watching, id: watchId, chosen: watchChosen }; },
  screenOf(id) { const p = Sim.getPlayer(state, id); return p ? toClient(p.x + p.w / 2, p.y + p.h / 2) : null; },
};
