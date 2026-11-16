// Gore's seeded simulation (public/gore.js): same seed, same spatter; caps hold; no DOM, no
// Math.random, no engine-dependent trig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.js';
import { createGore, goreKill, goreHit, stepGore, fingerprint, settled, killKey, hitSeed, prng, sinp, fadeOf, GORE } from '../public/gore.js';
import { LEVEL } from '../shared/level.js';

const kill = (o = {}) => ({ type: 'kill', tick: 900, killer: 1, victim: 2, move: 'chop', seed: 123456, x: 100, y: 259, vx: 4.9, vy: -4.2, face: -1, ...o });
function run(e, ticks = 400, opts) {
  const G = createGore(LEVEL, opts);
  goreKill(G, e);
  for (let i = 0; i < ticks; i++) stepGore(G);
  return G;
}
const decalSig = G => JSON.stringify(G.decals.map(d => [d.x, d.y, d.c, d.s, d.d]));
const poolSig = G => JSON.stringify([...G.pools.values()].map(p => [p.x, p.y, +p.h.toFixed(6), p.c]));

test('the source is DOM-free and uses no Math.random or trig', () => {
  const src = readFileSync(join(ROOT, 'public/gore.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['Math.random', 'Math.sin', 'Math.cos', 'Math.atan', 'Math.tan', 'document', 'window', 'performance'])
    assert.ok(!src.includes(bad), `gore.js uses ${bad}`);
});

test('same seed gives identical particles, gibs, decals and pools', () => {
  for (const move of ['chop', 'sweep', 'spikes', 'leave']) {
    const e = kill({ move, x: move === 'spikes' ? 196 : 100, vx: move === 'spikes' ? 0 : 4.9 });
    const a = createGore(LEVEL), b = createGore(LEVEL);
    goreKill(a, e); goreKill(b, e);
    for (let i = 0; i < 300; i++) {
      stepGore(a); stepGore(b);
      if (i % 25 === 0) assert.equal(JSON.stringify(a.parts.map(p => [p.x, p.y, p.c])), JSON.stringify(b.parts.map(p => [p.x, p.y, p.c])), `${move} particles at ${i}`);
    }
    assert.equal(decalSig(a), decalSig(b), move + ' decals');
    assert.equal(poolSig(a), poolSig(b), move + ' pools');
    assert.equal(JSON.stringify(a.gibs.map(g => [g.id, g.x, g.y, g.c, g.s])), JSON.stringify(b.gibs.map(g => [g.id, g.x, g.y, g.c, g.s])), move + ' gibs');
    assert.ok(a.decals.length + a.pools.size > 100, `${move}: plenty of blood lands (${a.decals.length} decals, ${a.pools.size} pools)`);
    assert.equal(fingerprint(a, killKey(e)), fingerprint(b, killKey(e)));
    assert.ok(settled(a, killKey(e)), move + ' settles within 5 s');
  }
});

test('different seeds give different spatter', () => {
  const a = run(kill({ seed: 1 })), b = run(kill({ seed: 2 }));
  assert.notEqual(decalSig(a), decalSig(b));
  assert.notEqual(fingerprint(a, '900:2'), fingerprint(b, '900:2'));
});

test('a kill is cut into the right pieces', () => {
  const ids = move => { const G = createGore(LEVEL); goreKill(G, kill({ move })); return G.gibs.map(g => g.id).sort().join(''); };
  assert.equal(ids('chop'), 'HLRS');        // left and right halves, hood, sword
  assert.equal(ids('sweep'), 'BHST');       // top and bottom halves
  assert.equal(ids('spikes'), 'BHST');
  assert.equal(ids('leave'), 'HQ0Q1Q2Q3S'.match(/Q\d|[A-Z]/g).sort().join(''));
  const G = createGore(LEVEL); goreKill(G, kill({ move: 'spikes', x: 196, vx: 0 }));
  assert.ok(G.gibs.find(g => g.id === 'B').pinned, 'the bottom half stays on the spikes');
  for (let i = 0; i < 120; i++) stepGore(G);
  assert.ok(G.bloody.size >= 1, 'spikes stained');
});

test("a kill's fingerprint does not depend on other gore in flight or on when it started", () => {
  const solo = run(kill());
  const busy = createGore(LEVEL);
  for (let i = 0; i < 37; i++) stepGore(busy);                     // a client whose gore clock is elsewhere
  goreKill(busy, kill({ tick: 800, victim: 3, seed: 999, x: 300, vx: -4.9, move: 'sweep' }));
  goreHit(busy, { tick: 801, attacker: 1, victim: 4, dmg: 34, hp: 66, x: 200, y: 259 }, 1);
  for (let i = 0; i < 20; i++) stepGore(busy);
  goreKill(busy, kill());
  for (let i = 0; i < 400; i++) stepGore(busy);
  assert.equal(fingerprint(busy, '900:2'), fingerprint(solo, '900:2'));
});

test('hit spurts are seeded from the event fields', () => {
  const h = { tick: 50, attacker: 1, victim: 2, dmg: 34, hp: 66, x: 100, y: 259 };
  assert.equal(hitSeed(h), hitSeed({ ...h }));
  assert.notEqual(hitSeed(h), hitSeed({ ...h, tick: 51 }));
  const a = createGore(LEVEL), b = createGore(LEVEL);
  goreHit(a, h, 1); goreHit(b, h, 1);
  assert.ok(a.parts.length >= 16);
  assert.equal(JSON.stringify(a.parts.map(p => [p.x, p.vx, p.vy])), JSON.stringify(b.parts.map(p => [p.x, p.vx, p.vy])));
  assert.ok(a.parts.every(p => p.vx > 0), 'spurt goes the way of the blow');
});

test('caps hold: decals 6000 oldest first, particles, gibs', () => {
  const G = createGore(LEVEL);
  let capped = 0; G.onCap = () => capped++;
  for (let k = 0; k < 40; k++) {
    goreKill(G, kill({ tick: 1000 + k, seed: 1000 + k * 7919, x: 30 + (k * 37) % 340, y: k % 2 ? 259 : 195 }));
    for (let i = 0; i < 30; i++) { stepGore(G); assert.ok(G.parts.length <= GORE.partCap); assert.ok(G.gibs.length <= GORE.gibCap); }
  }
  for (let i = 0; i < 400; i++) stepGore(G);
  assert.ok(G.decals.length <= GORE.decalCap, `decals ${G.decals.length}`);
  assert.ok(G.stats.partsSkipped > 0 || G.stats.gibsEvicted > 0 || G.stats.decalsEvicted > 0, 'some cap was reached');
  assert.ok(capped > 0, 'onCap called');
  // oldest first: a small decal cap keeps only the newest
  const S = createGore(LEVEL, { decalCap: 50 });
  goreKill(S, kill()); for (let i = 0; i < 400; i++) stepGore(S);
  assert.equal(S.decals.length, 50);
  for (let i = 1; i < S.decals.length; i++) assert.ok(S.decals[i].t >= S.decals[i - 1].t);
  assert.ok(S.stats.decalsEvicted > 0);
});

test('decals and pools fade and expire after about 4 minutes', () => {
  const G = createGore(LEVEL, { life: 600, fade: 200 });
  goreKill(G, kill());
  for (let i = 0; i < 300; i++) stepGore(G);
  const d = G.decals[0];
  assert.ok(G.decals.length > 0 && G.pools.size > 0);
  assert.equal(fadeOf(G, d.t), 1);
  for (let i = 0; i < 400; i++) stepGore(G);
  assert.ok(G.decals.length === 0 || G.decals[0].t > d.t, 'old decals gone');
  for (let i = 0; i < 700; i++) stepGore(G);
  assert.equal(G.decals.length, 0); assert.equal(G.pools.size, 0); assert.equal(G.bloody.size, 0);
  assert.equal(GORE.life, 4 * 60 * 60);
});

test('prng and sinp are deterministic helpers', () => {
  const a = prng(42), b = prng(42);
  for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x > 0 && x < 1); }
  for (let x = -20; x < 20; x += .37) assert.ok(Math.abs(sinp(x) - Math.sin(x)) < .002, `sinp(${x})`);
});
