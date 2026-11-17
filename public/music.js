// Music (SPEC §8): an original combat score in NinjaRunner's synth palette (detuned saws through
// low-pass filters, neon sine bells, a convolution reverb), but fast: 156 BPM in E minor, a
// 16th-note bass ostinato, four-on-the-floor kick, snare on 2 and 4, offbeat hats and a stabbing
// saw lead riff over an 8-bar sequence (Em Em C D Em Em C B) whose second half varies the first.
//
// Two loops of the same length are pre-rendered with an OfflineAudioContext and played in sync:
//  - base: the whole groove,
//  - intensity: extra percussion (16th hats, claps, ghost kicks, toms, crash, a riser) and the
//    lead an octave up through an open filter.
// After any kill the intensity loop fades in and a low-pass on the base opens up, for about 8 s.
//
// This file has two halves. The score as data (scoreEvents) and the loop analysis (analyze) are
// pure and tested in node. renderLoop/createMusic need WebAudio.

export const BPM = 156, BARS = 8, STEPS = 16;               // 16 sixteenth-note steps per 4/4 bar
export const STEP_S = 60 / BPM / 4;
export const LOOP_S = BARS * STEPS * STEP_S;                // 12.31 s
export const KEY_PCS = [4, 6, 7, 9, 11, 0, 2, 3];          // E natural minor + D# (harmonic minor, for the B chord)
const ROOTS = [40, 40, 36, 38, 40, 40, 36, 35];             // E2 E2 C2 D2 E2 E2 C2 B1
const CHORD = [[64, 67, 71], [64, 67, 71], [60, 64, 67], [62, 66, 69], [64, 67, 71], [64, 67, 71], [60, 64, 67], [59, 63, 66]];
// 16th bass ostinato, semitones over the bar's root. Bars 4 and 8 run a fill up the scale.
const BASS = [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 7, 0, 12, 10];
const BASS_FILL = [0, 12, 0, 12, 7, 12, 7, 12, 0, 3, 5, 7, 10, 12, 15, 12];
const BASS_FILL_B = [0, 12, 0, 12, 0, 12, 4, 12, 0, 4, 7, 9, 12, 9, 7, 4];   // over B: D# instead of D
// The lead riff: [step, midi, length in steps] per bar.
const RIFF = [
  [[0, 76, 1], [3, 76, 1], [6, 79, 1], [8, 76, 1], [10, 83, 2], [13, 81, 1], [14, 79, 1]],
  [[0, 76, 1], [3, 76, 1], [6, 79, 1], [8, 81, 1], [10, 79, 1], [12, 78, 2], [14, 74, 2]],
  [[0, 72, 1], [3, 72, 1], [6, 76, 1], [8, 79, 2], [11, 76, 1], [12, 74, 1], [14, 72, 2]],
  [[0, 74, 1], [3, 74, 1], [6, 78, 1], [8, 81, 2], [11, 78, 1], [12, 81, 1], [13, 83, 1], [14, 86, 2]],
  [[0, 88, 1], [3, 88, 1], [6, 86, 1], [8, 83, 1], [10, 86, 2], [13, 83, 1], [14, 81, 1]],
  [[0, 79, 1], [2, 79, 1], [4, 81, 1], [6, 83, 1], [8, 86, 2], [11, 83, 1], [12, 81, 1], [14, 79, 2]],
  [[0, 84, 1], [3, 84, 1], [6, 83, 1], [8, 79, 1], [10, 76, 2], [12, 79, 1], [14, 84, 2]],
  [[0, 83, 1], [3, 83, 1], [6, 87, 1], [8, 83, 1], [10, 78, 1], [11, 81, 1], [12, 83, 1], [13, 87, 1], [14, 90, 1], [15, 87, 1]],
];

// Keep the bass in the key: a pattern note outside it moves up a semitone (Bb -> B over C, F -> F# over D).
const inKey = (m, bar) => (KEY_PCS.includes(m % 12) && (m % 12 !== 3 || bar === 7) ? m : m + 1);
// The arrangement as a list of notes: {t (s), v: voice, m: midi, d: duration (s), g: gain}.
export function scoreEvents(layer) {
  const ev = [], at = (bar, step) => (bar * STEPS + step) * STEP_S;
  for (let bar = 0; bar < BARS; bar++) {
    const root = ROOTS[bar], fill = bar === 3 || bar === 7;
    if (layer === 'base') {
      const pat = bar === 7 ? BASS_FILL_B : fill ? BASS_FILL : BASS;
      for (let s = 0; s < STEPS; s++) ev.push({ t: at(bar, s), v: 'bass', m: inKey(root + pat[s], bar), d: STEP_S * .85, g: s % 4 === 0 ? 1 : .78 });
      for (let b = 0; b < 4; b++) ev.push({ t: at(bar, b * 4), v: 'kick', m: 0, d: .3, g: 1 });
      ev.push({ t: at(bar, 4), v: 'snare', m: 0, d: .2, g: 1 }, { t: at(bar, 12), v: 'snare', m: 0, d: .2, g: 1 });
      if (bar === 7) for (const s of [13, 14, 15]) ev.push({ t: at(bar, s), v: 'snare', m: 0, d: .12, g: .45 + (s - 13) * .15 });
      for (const s of [2, 6, 10, 14]) ev.push({ t: at(bar, s), v: 'hat', m: 0, d: s === 14 ? .16 : .06, g: s === 14 ? .9 : .75 });
      for (const [s, m, len] of RIFF[bar]) ev.push({ t: at(bar, s), v: 'lead', m, d: len * STEP_S * .7, g: 1 });
      ev.push({ t: at(bar, 0), v: 'pad', m: 0, chord: CHORD[bar], d: STEPS * STEP_S, g: 1 });
      if (bar === 0 || bar === 4) ev.push({ t: at(bar, 0), v: 'bell', m: CHORD[bar][2] + 12, d: 2, g: 1 }, { t: at(bar, 6), v: 'bell', m: CHORD[bar][0] + 24, d: 2, g: .7 });
    } else {
      for (let s = 0; s < STEPS; s++) if (s % 4 !== 2) ev.push({ t: at(bar, s), v: 'hat', m: 1, d: .035, g: s % 2 ? .5 : .75 });
      ev.push({ t: at(bar, 4), v: 'clap', m: 0, d: .2, g: 1 }, { t: at(bar, 12), v: 'clap', m: 0, d: .2, g: 1 });
      ev.push({ t: at(bar, 14), v: 'kick', m: 0, d: .2, g: .55 }, { t: at(bar, 7), v: 'kick', m: 0, d: .2, g: .4 });
      if (bar === 0 || bar === 4) ev.push({ t: at(bar, 0), v: 'crash', m: 0, d: 1.6, g: 1 });
      if (fill) for (const [s, m] of [[12, 52], [13, 50], [14, 47], [15, 43]]) ev.push({ t: at(bar, s), v: 'tom', m, d: .25, g: 1 });
      if (bar === 7) ev.push({ t: at(bar, 0), v: 'riser', m: 0, d: STEPS * STEP_S, g: 1 });
      for (const [s, m, len] of RIFF[bar]) ev.push({ t: at(bar, s), v: 'lead', m: m + 12, d: len * STEP_S * .6, g: .55 });
    }
  }
  return ev;
}

// ---------- WebAudio rendering (browser only) ----------
const midiHz = n => 440 * 2 ** ((n - 69) / 12);
function noiseBuffer(X, secs, seed) {
  const n = X.sampleRate * secs | 0, b = X.createBuffer(1, n, X.sampleRate), d = b.getChannelData(0);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; }
  return b;
}
function impulse(X, secs) {
  const len = X.sampleRate * secs | 0, b = X.createBuffer(2, len, X.sampleRate);
  let s = 99;
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 1073741823.5 - 1) * (1 - i / len) ** 3; } }
  return b;
}

// Builds one layer's notes inside context X, into dest.
function buildLayer(X, dest, layer) {
  const bus = X.createGain(); bus.gain.value = layer === 'base' ? 1 : 1.8; bus.connect(dest);
  const rev = X.createConvolver(); rev.buffer = impulse(X, 1.6);
  const wet = X.createGain(); wet.gain.value = .5; rev.connect(wet).connect(bus);
  const send = (node, dry, w) => { const g = X.createGain(); g.gain.value = dry; node.connect(g).connect(bus); if (w) { const s = X.createGain(); s.gain.value = w; node.connect(s).connect(rev); } };
  const NB = noiseBuffer(X, 1, layer === 'base' ? 7 : 11);
  const nz = (t, d, type, f, q, v, wetAmt, off = 0) => {
    const src = X.createBufferSource(), fl = X.createBiquadFilter(), g = X.createGain();
    src.buffer = NB; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0005, t + d);
    src.connect(fl).connect(g); send(g, 1, wetAmt); src.start(t, off % .8); src.stop(t + d + .02);
    return fl;
  };
  const osc = (t, d, type, f, det = 0) => { const o = X.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.start(t); o.stop(t + d); return o; };
  const voices = {
    kick(e) {
      const t = e.t, o = X.createOscillator(), g = X.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + .11);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.55 * e.g, t + .003); g.gain.exponentialRampToValueAtTime(.0005, t + .26);
      o.connect(g); send(g, 1, 0); o.start(t); o.stop(t + .3);
      nz(t, .015, 'highpass', 2500, .7, .12 * e.g, 0);                      // click
    },
    snare(e) {
      nz(e.t, .17, 'bandpass', 3200, .6, .32 * e.g, .25, e.t * 7.3);
      const o = osc(e.t, .12, 'triangle', 185), g = X.createGain();
      g.gain.setValueAtTime(.18 * e.g, e.t); g.gain.exponentialRampToValueAtTime(.0005, e.t + .1);
      o.frequency.exponentialRampToValueAtTime(120, e.t + .1);
      o.connect(g); send(g, 1, .1);
    },
    clap(e) {
      for (const k of [0, .011, .022]) nz(e.t + k, .09 + k * 2, 'bandpass', 1500, 1.4, .22 * e.g, .35, e.t * 3.1 + k);
    },
    hat(e) { nz(e.t, e.d, 'highpass', e.m ? 9000 : 7000, .8, (e.m ? .09 : .12) * e.g, .05, e.t * 5.7); },
    crash(e) { nz(e.t, e.d, 'highpass', 5000, .5, .12 * e.g, .4, e.t); },
    tom(e) {
      const o = osc(e.t, e.d + .02, 'sine', midiHz(e.m)), g = X.createGain();
      o.frequency.exponentialRampToValueAtTime(midiHz(e.m) * .6, e.t + e.d);
      g.gain.setValueAtTime(.32 * e.g, e.t); g.gain.exponentialRampToValueAtTime(.0005, e.t + e.d);
      o.connect(g); send(g, 1, .2);
    },
    riser(e) {
      const src = X.createBufferSource(), fl = X.createBiquadFilter(), g = X.createGain();
      src.buffer = NB; src.loop = true; fl.type = 'bandpass'; fl.Q.value = 2;
      fl.frequency.setValueAtTime(400, e.t); fl.frequency.exponentialRampToValueAtTime(9000, e.t + e.d);
      g.gain.setValueAtTime(.0001, e.t); g.gain.exponentialRampToValueAtTime(.14, e.t + e.d - .02); g.gain.linearRampToValueAtTime(0, e.t + e.d);
      src.connect(fl).connect(g); send(g, 1, .3); src.start(e.t); src.stop(e.t + e.d);
    },
    bass(e) {   // two detuned saws and a square sub through a plucked low-pass
      const t = e.t, f = midiHz(e.m), lp = X.createBiquadFilter(), g = X.createGain();
      lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(2200 * e.g, t); lp.frequency.exponentialRampToValueAtTime(260, t + e.d);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.16 * e.g, t + .004); g.gain.exponentialRampToValueAtTime(.0005, t + e.d);
      for (const [type, mul, det] of [['sawtooth', 1, -8], ['sawtooth', 1, 7], ['square', .5, 0]]) osc(t, e.d + .02, type, f * mul, det).connect(lp);
      lp.connect(g); send(g, 1, .05);
    },
    lead(e) {   // the stab: three detuned saws, filter snapping shut
      const t = e.t, f = midiHz(e.m), lp = X.createBiquadFilter(), g = X.createGain(), open = layer === 'base' ? 3800 : 9000;
      lp.type = 'lowpass'; lp.Q.value = 4;
      lp.frequency.setValueAtTime(open, t); lp.frequency.exponentialRampToValueAtTime(700, t + e.d + .05);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.075 * e.g, t + .004);
      g.gain.setValueAtTime(.075 * e.g, t + e.d * .6); g.gain.exponentialRampToValueAtTime(.0005, t + e.d + .06);
      for (const det of [-11, 0, 10]) osc(t, e.d + .08, 'sawtooth', f, det).connect(lp);
      lp.connect(g); send(g, .9, .3);
    },
    pad(e) {    // a quiet detuned-saw chord under the bar, NinjaRunner's pad in short
      const t = e.t, lp = X.createBiquadFilter(), g = X.createGain();
      lp.type = 'lowpass'; lp.Q.value = 1; lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1300, t + e.d);
      g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.022, t + .08); g.gain.setValueAtTime(.022, t + e.d - .08); g.gain.linearRampToValueAtTime(.0001, t + e.d);
      for (const m of e.chord) for (const det of [-9, 8]) osc(t, e.d + .02, 'sawtooth', midiHz(m - 12), det).connect(lp);
      lp.connect(g); send(g, .8, .4);
    },
    bell(e) {   // NinjaRunner's neon bell
      for (const [mul, v] of [[1, .05], [2.01, .018], [3.02, .008]]) {
        const o = osc(e.t, e.d + .1, 'sine', midiHz(e.m) * mul), g = X.createGain();
        g.gain.setValueAtTime(0, e.t); g.gain.linearRampToValueAtTime(v * e.g, e.t + .01); g.gain.exponentialRampToValueAtTime(.0001, e.t + e.d);
        o.connect(g); send(g, .5, .7);
      }
    },
  };
  for (const e of scoreEvents(layer)) voices[e.v](e);
}

// A browser does not leave a page while an OfflineAudioContext is still rendering: a reload in
// the first seconds of a game stalled until both loops were done (seconds on a slow device), long
// enough for the server's grace period to run out and the player to come back as "Name#2". So the
// render runs in RENDER_SLICE_S slices (suspend points), and once the page starts to unload no
// slice is resumed: the render sits suspended and the page goes at once. If the page stays after
// all (a cancelled navigation, or back from the bfcache), the render carries on.
const RENDER_SLICE_S = .5;
let leaving = false;
const held = [];
function carryOn() { leaving = false; held.splice(0).forEach(f => f()); }
if (typeof addEventListener === 'function') {
  addEventListener('beforeunload', () => { leaving = true; setTimeout(carryOn, 2000); });   // timers stop once the page is gone
  addEventListener('pagehide', () => { leaving = true; });
  addEventListener('pageshow', carryOn);
}
function sliceRender(X, seconds) {
  if (typeof X.suspend !== 'function') return;
  const next = () => { if (leaving) held.push(next); else X.resume(); };
  try { for (let t = RENDER_SLICE_S; t < seconds; t += RENDER_SLICE_S) X.suspend(t).then(next); }
  catch { /* suspend points unsupported (or past the end): the render runs in one go */ }
}

// Renders one layer offline and folds the tail past the loop end back onto the start, so the
// buffer loops seamlessly (reverb and note releases carry over the seam). Returns {l, r} arrays.
export async function renderLoop(layer, sr) {
  const Off = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Off) throw new Error('no OfflineAudioContext');
  const n = Math.round(sr * LOOP_S), tail = Math.round(sr * 2);
  const X = new Off(2, n + tail, sr);
  const b0 = performance.now();
  buildLayer(X, X.destination, layer);
  const buildMs = performance.now() - b0;   // main-thread time; the render itself runs off it
  sliceRender(X, (n + tail) / sr);
  const r = await X.startRendering();
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const src = r.getChannelData(ch), dst = new Float32Array(n);
    dst.set(src.subarray(0, n));
    for (let i = n; i < src.length; i++) dst[i - n] += src[i];
    out.push(dst);
  }
  out.buildMs = buildMs;
  return out;
}

// Objective checks on a rendered loop (used by the debug log and the tests).
//  peak, rms; seam: |x[0] - x[n-1]| relative to the 99.9th percentile of sample-to-sample steps;
//  bpm: from the autocorrelation of the onset envelope (10 ms frames) over 120-200 BPM;
//  bright: mean squared first difference over mean square (higher = more high-frequency energy).
export function analyze(x, sr) {
  const n = x.length;
  let peak = 0, ss = 0, ds = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; ss += x[i] * x[i]; if (i) ds += (x[i] - x[i - 1]) ** 2; }
  const steps = new Float32Array(n - 1);
  for (let i = 1; i < n; i++) steps[i - 1] = Math.abs(x[i] - x[i - 1]);
  const sorted = Float32Array.from(steps).sort(), p999 = sorted[Math.floor(sorted.length * .999)] || 1e-9;
  const seamJump = Math.abs(x[0] - x[n - 1]);
  // tempo from the low end (kick and bass): one-pole low-pass at ~150 Hz, then 10 ms energy frames
  const a = Math.min(1, 2 * Math.PI * 150 / sr), lo = new Float32Array(n);
  let y = 0;
  for (let k = 0; k < 2; k++) for (let i = 0; i < n; i++) { y += a * (x[i] - y); lo[i] = y; }   // two passes: settle round the wrap
  const hop = Math.round(sr * .01), F = Math.floor(n / hop), env = new Float32Array(F);
  for (let f = 0; f < F; f++) { let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) e += lo[i] * lo[i]; env[f] = e; }
  const on = new Float32Array(F);   // onset strength: positive change in log energy, wrapping round the loop
  for (let f = 0; f < F; f++) on[f] = Math.max(0, Math.log(1e-9 + env[f]) - Math.log(1e-9 + env[(f + F - 1) % F]));
  let best = 0, bestLag = 0;
  for (let lag = Math.floor(60 / 200 * 100); lag <= Math.ceil(60 / 120 * 100); lag++) {
    let s = 0; for (let f = 0; f < F; f++) s += on[f] * on[(f + lag) % F];
    if (s > best) { best = s; bestLag = lag; }
  }
  // refine the lag with a parabola through the neighbours
  const ac = lag => { let s = 0; for (let f = 0; f < F; f++) s += on[f] * on[(f + lag) % F]; return s; };
  const a1 = ac(bestLag - 1), b = best, c = ac(bestLag + 1), d = (a1 - c) / (2 * (a1 - 2 * b + c) || 1);
  // for scale: the same jump at the bar-5 downbeat, the same musical moment inside the loop
  // (the largest step within 2 ms of it, since that downbeat need not fall on a sample boundary)
  const mid = Math.round(n / 2), w = Math.round(sr * .002);
  let midJump = 0;
  for (let i = mid - w; i <= mid + w; i++) midJump = Math.max(midJump, Math.abs(x[i] - x[i - 1]));
  return { peak, rms: Math.sqrt(ss / n), seamJump, midJump, stepP999: p999, seam: seamJump / p999,
    bpm: 6000 / (bestLag + (Number.isFinite(d) ? d : 0)), bright: ds / (ss || 1e-9) };
}

// The live player: renders both loops after a user gesture (without blocking the game) and plays
// them in sync. intensity() brings the extra layer in after a kill.
export function createMusic({ ac, out, lite, log }) {
  const REST_HZ = 3500, OPEN_HZ = 18000, HOLD_S = 6.5;
  let state = 'idle', vol = null, lp = null, intG = null, decayTimer = 0, level = 0, loops = null, info = {};
  const hold = (p, t) => { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); } };
  async function start() {
    if (state !== 'idle') return;
    state = 'rendering';
    const sr = lite ? 22050 : Math.min(44100, ac.sampleRate), t0 = performance.now();
    try {
      await new Promise(r => setTimeout(r, 0));          // leave the gesture's event handler first
      // both render in parallel off the main thread; a frame goes by between the two graph builds
      const pb = renderLoop('base', sr);
      await new Promise(r => setTimeout(r, 0));
      const [base, intense] = await Promise.all([pb, renderLoop('intensity', sr)]);
      // one gain for both, so base + intensity together peaks at 0.9
      let pk = 0;
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < base[ch].length; i++) pk = Math.max(pk, Math.abs(base[ch][i] + intense[ch][i]));
      const k = pk > 0 ? .9 / pk : 1;
      const mkBuf = data => { const b = ac.createBuffer(2, data[0].length, sr); for (let ch = 0; ch < 2; ch++) { const d = data[ch]; for (let i = 0; i < d.length; i++) d[i] *= k; b.copyToChannel(d, ch); } return b; };
      loops = { base, intense, sr };
      const bb = mkBuf(base), ib = mkBuf(intense);
      info = { ms: Math.round(performance.now() - t0), buildMs: Math.round(base.buildMs + intense.buildMs), sr, lite, seconds: +LOOP_S.toFixed(3), gain: +k.toFixed(3) };
      log('music pre-rendered', info);
      vol = ac.createGain(); vol.gain.value = 0; vol.connect(out);
      lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = .9; lp.frequency.value = REST_HZ; lp.connect(vol);
      intG = ac.createGain(); intG.gain.value = 0; intG.connect(vol);
      const a = ac.createBufferSource(), b = ac.createBufferSource();
      a.buffer = bb; b.buffer = ib; a.loop = b.loop = true;
      a.connect(lp); b.connect(intG);
      const when = ac.currentTime + .1;
      a.start(when); b.start(when);
      state = 'playing';
      api.apply();
    } catch (e) {
      state = 'failed';
      log('music pre-render failed', { err: String(e && e.message || e).slice(0, 200), ms: Math.round(performance.now() - t0) });
    }
  }
  const api = {
    start,
    get state() { return state; },
    get rendered() { return info; },
    get level() { return level; },
    loops: () => loops,
    target: 1,           // music volume (0..1), set from CFG.musicVol
    muted: false,
    apply() { if (vol) vol.gain.setTargetAtTime(api.muted ? 0 : api.target * .8, ac.currentTime, .2); },
    // A kill: intensity in at once, held ~6.5 s, then decays over ~3 s (≈ 8 s in all).
    intensity() {
      if (state !== 'playing') return;
      const t = ac.currentTime;
      hold(intG.gain, t); intG.gain.setTargetAtTime(1, t, .06); intG.gain.setTargetAtTime(0, t + HOLD_S, .9);
      hold(lp.frequency, t); lp.frequency.setTargetAtTime(OPEN_HZ, t, .08); lp.frequency.setTargetAtTime(REST_HZ, t + HOLD_S, .9);
      if (!level) log('music intensity up');
      level = 1;
      clearTimeout(decayTimer);
      decayTimer = setTimeout(() => { level = 0; log('music intensity decaying'); }, HOLD_S * 1000);
    },
  };
  return api;
}
