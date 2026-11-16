// The score as data (public/music.js): tempo, groove, key, loop structure, and the loop analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvents, analyze, BPM, BARS, STEPS, STEP_S, LOOP_S, KEY_PCS } from '../public/music.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;
const stepOf = t => Math.round(t / STEP_S);

test('tempo 150-160 BPM and a 4-8 bar loop', () => {
  assert.ok(BPM >= 150 && BPM <= 160);
  assert.ok(BARS >= 4 && BARS <= 8);
  assert.ok(near(LOOP_S, BARS * 4 * 60 / BPM));
});

test('base: 16th bass ostinato, four-on-the-floor kick, snare on 2 and 4, offbeat hats', () => {
  const ev = scoreEvents('base'), of = v => ev.filter(e => e.v === v).map(e => stepOf(e.t));
  assert.deepEqual(of('bass'), Array.from({ length: BARS * STEPS }, (_, i) => i));
  assert.deepEqual(of('kick'), Array.from({ length: BARS * 4 }, (_, i) => i * 4));
  for (let bar = 0; bar < BARS; bar++) {
    const sn = of('snare').filter(s => Math.floor(s / STEPS) === bar).map(s => s % STEPS);
    assert.ok(sn.includes(4) && sn.includes(12), 'snare on 2 and 4');
    const hats = of('hat').filter(s => Math.floor(s / STEPS) === bar).map(s => s % STEPS);
    assert.deepEqual(hats, [2, 6, 10, 14], 'hats on the offbeat 8ths');
  }
  assert.ok(ev.every(e => e.t >= 0 && e.t < LOOP_S));
});

test('minor key: every pitched note is in E minor (D# allowed over the B chord)', () => {
  for (const layer of ['base', 'intensity']) for (const e of scoreEvents(layer)) {
    if (!['bass', 'lead', 'bell'].includes(e.v)) continue;
    assert.ok(KEY_PCS.includes(((e.m % 12) + 12) % 12), `${layer} ${e.v} midi ${e.m}`);
    if (e.m % 12 === 3) assert.ok(stepOf(e.t) >= 7 * STEPS, 'D# only in the B bar');
  }
});

test('the riff varies: no bar of lead notes repeats the bar before it, and the halves differ', () => {
  const lead = scoreEvents('base').filter(e => e.v === 'lead');
  const bars = Array.from({ length: BARS }, (_, b) => JSON.stringify(lead.filter(e => Math.floor(stepOf(e.t) / STEPS) === b).map(e => [stepOf(e.t) % STEPS, e.m])));
  for (let b = 1; b < BARS; b++) assert.notEqual(bars[b], bars[b - 1]);
  assert.notDeepEqual(bars.slice(0, 4), bars.slice(4));
  assert.ok(lead.every(e => e.d < STEP_S * 2), 'stabs are short');
});

test('the intensity layer adds percussion: 16th hats, claps, crash, toms, a riser and the lead up an octave', () => {
  const ev = scoreEvents('intensity'), vs = new Set(ev.map(e => e.v));
  for (const v of ['hat', 'clap', 'crash', 'tom', 'riser', 'lead']) assert.ok(vs.has(v), v);
  assert.ok(ev.filter(e => e.v === 'hat').length >= BARS * 12);
  assert.ok(!vs.has('bass') && !vs.has('pad'), 'no second bass line');
});

test('analyze: peak, seam and tempo of a synthetic click loop', () => {
  const sr = 8000, n = Math.round(sr * LOOP_S), x = new Float32Array(n);
  const beat = 60 / BPM;
  for (let b = 0; b * beat < LOOP_S - 1e-9; b++) { const i0 = Math.round(b * beat * sr); for (let i = 0; i < 400 && i0 + i < n; i++) x[i0 + i] += .5 * Math.exp(-i / 60) * Math.sin(i * .3); }
  const a = analyze(x, sr);
  assert.ok(a.peak < 1 && a.peak > .3);
  assert.ok(Math.abs(a.bpm - BPM) < 3, `bpm ${a.bpm}`);
  assert.ok(a.seam < 1, 'continuous at the wrap');
});
