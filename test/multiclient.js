// Headless multi-client test (SPEC §12): three browsers in one arena, a scripted fight to the death,
// kill/score/respawn seen on every page, a drop and resume that keeps the score, a manual debug
// report read back through tools/debug.js, prediction error under NET_SIM=120,2, and a long-sword
// pickup (ITEM_SECS / ITEM_POINTS shorten the spawn timer and keep pickups on the floor) that
// every page sees, that lengthens the holder's reach in a scripted check and is lost on death.
//
//   node test/multiclient.js            (Chromium from $PLAYWRIGHT_CHROMIUM or playwright's cache)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launchChromium, waitFor, sleep, tempDir, removeDir, ROOT } from './lib.js';
import { installBot, stopBot } from './bot.js';

const log = (...a) => console.log('multiclient:', ...a);
const errors = [];
let browser, servers = [], dirs = [];

async function openPlayer(srv, name, color) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  await page.fill('#lName', name);
  await page.click(`#lColors .sw:nth-child(${color + 1})`);
  await page.click('#lFight');
  await page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive, null, { timeout: 10000 });
  const id = await page.evaluate(() => __mp.net.id);
  return { page, name, id };
}

const pageState = (p, ids) => p.page.evaluate(ids => ({
  kills: __mp.events.filter(e => e.type === 'kill'),
  spawns: __mp.events.filter(e => e.type === 'spawn'),
  meta: ids.map(id => __mp.net.meta.get(id) || null),
  alive: ids.map(id => { const q = __mp.state.players.find(p => p.id === id); return !!(q && q.alive); }),
}), ids);

async function fightTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  log(`server on port ${srv.port}, admin on ${srv.adminPort}`);
  const A = await openPlayer(srv, 'Ash', 0), B = await openPlayer(srv, 'Bea', 1), C = await openPlayer(srv, 'Cy', 2);
  const all = [A, B, C], ids = all.map(p => p.id);
  assert.equal(new Set(ids).size, 3);
  // every page sees all three names
  for (const p of all) await waitFor(() => p.page.evaluate(ids => ids.every(id => __mp.net.meta.get(id)), ids), { what: 'names on ' + p.name });
  log(`joined: ${all.map(p => `${p.name}=${p.id}`).join(' ')}`);

  // blood style (SPEC §7): neon by default; Cy watches in real gore, which must not change the
  // simulation (the gore fingerprint below is compared across both styles)
  for (const p of [A, B]) assert.equal(await p.page.evaluate(() => __mp.gore.style), 'neon', 'neon blood by default');
  assert.equal(await C.page.evaluate(() => __mp.gore.setStyle('real')), 'real');

  // --- fight: A and B meet on the floor and slash until one dies; C parks out of the way
  await installBot(A.page, { mode: 'fight', target: B.id });
  await installBot(B.page, { mode: 'fight', target: A.id });
  await installBot(C.page, { mode: 'park' });
  const t0 = Date.now();
  // A trace of every bot's own view, printed if the fight never ends (to see where they got stuck).
  const trace = [];
  let traceAt = 0;
  const botView = p => p.page.evaluate(() => {
    const m = __mp.net.me, r = v => Math.round(v);
    return m ? `${m.id}:${m.alive ? 'alive' : 'dead'} x${r(m.x)} y${r(m.y)} hp${m.hp} gnd${+m.onGround} face${m.face} stand${m.standOn} keys${window.__botState ? window.__botState.k : '-'}` : 'no me';
  });
  const kill = await waitFor(async () => {
    const s = await pageState(A, ids);
    if (Date.now() - traceAt > 2000) {
      traceAt = Date.now();
      trace.push(`${((traceAt - t0) / 1000).toFixed(0)}s ` + (await Promise.all(all.map(botView))).join(' | ') +
        ` | kills ${JSON.stringify(s.kills.map(k => [k.killer, k.victim, k.move]))}`);
    }
    return s.kills.find(k => (k.killer === A.id && k.victim === B.id) || (k.killer === B.id && k.victim === A.id));
  }, { timeout: 120000, every: 250, what: 'a kill between the two fighters' }).catch(e => {
    log('fight trace (own view of each bot, every 2 s):\n  ' + trace.slice(-15).join('\n  '));
    throw e;
  });
  log(`kill after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${kill.killer} killed ${kill.victim} (${kill.move}), seed ${kill.seed}`);
  for (const p of all) await stopBot(p.page);
  const killer = all.find(p => p.id === kill.killer), victim = all.find(p => p.id === kill.victim);
  const ki = ids.indexOf(killer.id), vi = ids.indexOf(victim.id);

  // the kill feed shows "killer ✂ victim" on every page (it fades after ~6 s, so check it first).
  // A fighter may have walked over a long-sword pickup on the way (they spawn in this test too):
  // a long-sword kill is marked ⚔ instead.
  const sym = kill.long ? '⚔' : '✂';
  for (const p of all) {
    await waitFor(() => p.page.evaluate(([k, v, sym]) => __mp.feed.some(t => t.includes(k) && t.includes(sym) && t.includes(v)), [killer.name, victim.name, sym]),
      { timeout: 3000, what: `kill feed on ${p.name}` });
  }
  log(`kill feed "${killer.name} ${sym} ${victim.name}" on all 3 pages`);

  // kill event, score increment and respawn on every page
  await sleep(2600);   // respawn delay is 2 s, plus the 100 ms interpolation delay
  for (const p of all) {
    const s = await waitFor(async () => {
      const s = await pageState(p, ids);
      const sp = s.spawns.find(e => e.id === victim.id && e.tick > kill.tick);
      return sp && s.alive[vi] ? s : null;
    }, { timeout: 5000, what: `respawn of ${victim.name} on ${p.name}` });
    const k = s.kills.find(e => e.tick === kill.tick && e.victim === kill.victim);
    assert.ok(k, `${p.name} saw the kill`);
    assert.equal(k.killer, kill.killer); assert.equal(k.seed, kill.seed, 'same gore seed everywhere');
    assert.ok(s.meta[ki].score >= 1, `${p.name} sees the killer's score`);
    assert.ok(s.meta[vi].deaths >= 1, `${p.name} sees the victim's death`);
  }
  log('kill, score and respawn seen on all 3 pages');

  // the score strip along the top: every player, the killer first with its point, our own chip
  // highlighted, visible below nothing, and rebuilt only when the data changes
  for (const p of all) {
    const st = await waitFor(async () => {
      const st = await p.page.evaluate(() => ({ ...__mp.strip, shown: getComputedStyle(document.getElementById('strip')).display !== 'none' }));
      return st.chips.length === 3 && st.chips[0].id === killer.id && st.chips[0].text.endsWith('1') ? st : null;
    }, { timeout: 3000, what: `score strip on ${p.name}` });
    assert.ok(st.shown, 'strip visible');
    assert.deepEqual(st.chips.filter(c => c.me).map(c => c.id), [p.id], 'own chip highlighted');
    assert.deepEqual(new Set(st.chips.map(c => c.id)), new Set(ids));
    assert.ok(st.chips[0].text.startsWith(killer.name));
    const html = await p.page.evaluate(() => document.getElementById('strip').innerHTML);
    assert.ok(!/<script|<img|on\w+=/i.test(html), 'names are text only');
  }
  const lay = await A.page.evaluate(() => Object.fromEntries(['strip', 'hHp', 'hScore', 'feed'].map(id => {
    const r = document.getElementById(id).getBoundingClientRect(); return [id, { top: r.top, bottom: r.bottom }];
  })));
  for (const id of ['hHp', 'hScore', 'feed']) assert.ok(lay.strip.bottom <= lay[id].top + 0.5, `the strip does not cover ${id}: ${JSON.stringify(lay)}`);
  const b0 = await A.page.evaluate(() => __mp.strip.builds);
  await sleep(1500);
  const b1 = await A.page.evaluate(() => __mp.strip.builds);
  assert.ok(b1 - b0 <= 3, `the strip is rebuilt on changes only, not every frame (${b1 - b0} builds in 1.5 s)`);
  log(`score strip: ${(await A.page.evaluate(() => __mp.strip.chips.map(c => c.text).join(' | ')))} on all 3 pages`);

  // gore: every page simulated the same spatter from the kill seed (same fingerprint once settled)
  const key = `${kill.tick}:${kill.victim}`;
  const fps = [];
  for (const p of all) {
    await waitFor(() => p.page.evaluate(k => __mp.gore.settled(k), key), { timeout: 8000, what: `gore settled on ${p.name}` });
    fps.push(await p.page.evaluate(k => ({ fp: __mp.gore.fingerprint(k), c: __mp.gore.counts }), key));
  }
  log(`gore fingerprints for kill ${key}: ${fps.map(f => f.fp).join(' ')} (decals ${fps[0].c.decals}, pools ${fps[0].c.pools})`);
  assert.ok(fps[0].fp && +fps[0].fp.split(':')[0] > 100, 'plenty of blood landed');
  for (const f of fps) assert.equal(f.fp, fps[0].fp, 'same gore on every page (neon and real-gore pages alike)');
  // switching style repaints the blood already there (the baked layer is rebuilt) and changes nothing
  // in the simulation; the choice is saved in localStorage
  const sw = await A.page.evaluate(k => {
    const before = __mp.gore.counts.layerRebuilds;
    __mp.gore.setStyle('real');
    const mid = { fp: __mp.gore.fingerprint(k), rebuilt: __mp.gore.counts.layerRebuilds > before, saved: JSON.parse(localStorage.getItem('multisplat-cfg') || '{}').realGore };
    __mp.gore.setStyle('neon');
    return { ...mid, back: __mp.gore.style, fp2: __mp.gore.fingerprint(k) };
  }, key);
  assert.ok(sw.rebuilt, 'switching style rebuilds the baked blood layer');
  assert.equal(sw.saved, true, 'the style is saved');
  assert.equal(sw.fp, fps[0].fp); assert.equal(sw.fp2, fps[0].fp); assert.equal(sw.back, 'neon');
  assert.equal(await C.page.evaluate(() => __mp.gore.style), 'real');
  log('blood styles: real-gore page has the same fingerprint as the neon pages; switching repaints');

  // --- drop and reconnect within 5 s keeps the score
  const score = await killer.page.evaluate(id => __mp.net.meta.get(id).score, killer.id);
  const tDrop = Date.now();
  await killer.page.evaluate(() => __mp.net.drop());
  await waitFor(() => killer.page.evaluate(() => __mp.net.state !== 'open'), { what: 'drop' });
  await waitFor(() => killer.page.evaluate(() => __mp.net.state === 'open' && __mp.net.mode === 'play' && !!__mp.net.me), { timeout: 5000, what: 'resume' });
  const after = await killer.page.evaluate(() => ({ id: __mp.net.id, score: __mp.net.meta.get(__mp.net.id).score,
    resumed: __mp.debug.entries().some(e => e.msg === 'resume accepted') }));
  log(`reconnected in ${((Date.now() - tDrop) / 1000).toFixed(1)} s`);
  assert.equal(after.id, killer.id, 'same player id after resume');
  assert.equal(after.score, score, 'score kept after resume');
  assert.ok(after.resumed, 'resume accepted');
  for (const p of all) {
    const m = await p.page.evaluate(id => __mp.net.meta.get(id), killer.id);
    assert.equal(m.score, score); assert.ok(!m.gone);
  }
  log(`drop + resume kept score ${score}`);

  // --- manual debug report: stored with the server's view, readable through tools/debug.js
  const id = await A.page.evaluate(() => __mp.debug.send('manual', 'multiclient test'));
  assert.match(id || '', /^[a-z0-9]{8}$/, 'report id');
  const out = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), 'report', id],
    { env: { ...process.env, DEBUG_PORT: String(srv.adminPort) } }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
  assert.match(out.split('\n')[0], /UNTRUSTED INPUT/);
  const rec = JSON.parse(out.slice(out.indexOf('\n') + 1));
  assert.equal(rec.meta.id, id);
  assert.equal(rec.meta.server.player.id, A.id);
  assert.equal(rec.meta.server.player.name, 'Ash');
  assert.ok(rec.meta.server.conn && Number.isFinite(rec.meta.server.conn.rttMs));
  assert.equal(rec.report.kind, 'manual');
  assert.ok(rec.report.entries.length > 5 && rec.report.entries.some(e => e.cat === 'net'));
  const token = await A.page.evaluate(() => __mp.net.token);
  const stored = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('');
  assert.ok(!stored.includes(token), 'resume token never stored');
  const st = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), 'state'],
    (e, so) => (e ? rej(e) : res(so))));
  assert.match(st, /players \(3\)/);
  log(`debug report ${id} stored with the server view; tools/debug.js state ok`);
  log('tick time: ' + st.split('\n')[0]);

  for (const p of all) await p.page.context().close();
  await srv.stop();
}

async function predictionTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir, NET_SIM: '120,2' }); servers.push(srv);
  const P = await openPlayer(srv, 'Walker', 4);
  const Q = await openPlayer(srv, 'Other', 5);       // a second player, so there is a remote to interpolate
  await installBot(P.page, { mode: 'pace' });
  await installBot(Q.page, { mode: 'pace' });
  await sleep(2500);
  await P.page.evaluate(() => __mp.net.resetPredErr());
  await sleep(8000);
  const r = await P.page.evaluate(() => ({ rms: __mp.net.predErrRms(), n: __mp.net.stats.predErrN, max: Math.max(0, ...__mp.net.stats.predErr),
    rtt: __mp.net.stats.rttAvg, snaps: __mp.net.stats.snapsSnapped, jitter: __mp.net.stats.jitter }));
  log(`NET_SIM=120,2: prediction error RMS ${r.rms.toFixed(3)} units over ${r.n} snapshots (max ${r.max.toFixed(2)}, snaps ${r.snaps}), RTT ${r.rtt.toFixed(0)} ms, jitter ${r.jitter.toFixed(1)} ms`);
  assert.ok(r.n > 150, 'enough samples');
  assert.ok(r.rtt > 200, 'NET_SIM delay is in effect');
  assert.ok(r.rms < 3, `prediction error RMS ${r.rms} < 3`);
  // A resume under latency: inputs sent between the socket opening and the welcome must not leave
  // the server ignoring the restarted seq numbers (the player would freeze for a long time).
  await sleep(3000);                                  // let seq grow well past what a few ticks cover
  await P.page.evaluate(() => __mp.net.drop());
  await waitFor(() => P.page.evaluate(() => __mp.net.state === 'open' && __mp.net.mode === 'play' && !!__mp.net.me), { timeout: 15000, what: 'resume under NET_SIM' });
  await sleep(1000);
  const xs = [];
  for (let i = 0; i < 6; i++) { xs.push(await P.page.evaluate(() => __mp.net.me && __mp.net.me.x)); await sleep(300); }
  const moved = Math.max(...xs) - Math.min(...xs);
  log(`after a resume under NET_SIM the pacing player moved ${moved.toFixed(1)} units in 1.5 s`);
  assert.ok(moved > 10, `server applies inputs after a resume (moved ${moved})`);
  await P.page.context().close(); await Q.page.context().close();
  await srv.stop();
}

// Long swords (SPEC §5.1): pickups every 1-2 s, only at the two floor item points.
async function longSwordTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir, ITEM_SECS: '1,2', ITEM_POINTS: '0,1' }); servers.push(srv);
  const H = await openPlayer(srv, 'Hold', 3), O = await openPlayer(srv, 'Opp', 6);
  // a third page that only watches from the lobby (spectators get the same snapshots and events)
  const wctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const W = { page: await wctx.newPage(), name: 'Watch' };
  W.page.on('pageerror', e => errors.push(`Watch: ${e.message}`));
  await W.page.goto(srv.url);
  await W.page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  const all = [H, O, W];
  const drawn = (p, id) => p.page.evaluate(id => {
    const q = __mp.state.players.find(p => p.id === id);
    return q ? { alive: q.alive, long: !!q.long, reach: __mp.sim.swordBoxOf({ ...q, atkType: 'chop' }).w } : null;
  }, id);

  // the holder fetches a pickup lying on the floor; the other stands still where it spawned
  await waitFor(() => H.page.evaluate(() => (__mp.state.items || []).length > 0), { timeout: 10000, what: 'a pickup appears' });
  await installBot(H.page, { mode: 'fetch' });
  const pick = await waitFor(() => H.page.evaluate(id => __mp.events.find(e => e.type === 'pickup' && e.id === id), H.id),
    { timeout: 30000, every: 200, what: 'Hold picks up a long sword' });
  await stopBot(H.page);
  log(`pickup: ${H.name} took item ${pick.item} at ${pick.x},${pick.y}`);
  for (const p of all) {
    await waitFor(() => p.page.evaluate(([id, item]) => __mp.events.some(e => e.type === 'pickup' && e.id === id && e.item === item), [H.id, pick.item]),
      { timeout: 3000, what: `pickup event on ${p.name}` });
    const h = await waitFor(async () => { const d = await drawn(p, H.id); return d && d.long ? d : null; }, { timeout: 3000, what: `holder flag on ${p.name}` });
    assert.ok(Math.abs(h.reach - 18 * 1.6) < 1e-9, `${p.name} draws the holder's reach x1.6`);
    const o = await drawn(p, O.id);
    assert.equal(o.long, false); assert.equal(o.reach, 18);
  }
  assert.equal(await H.page.evaluate(() => __mp.net.me.long), true, 'the holder\'s own (predicted) player has the flag from `me`');
  assert.ok((await H.page.evaluate(() => __mp.debug.entries())).some(e => e.cat === 'life' && e.msg === 'long sword taken'));
  log('pickup event and holder flag on all 3 pages, reach x1.6');

  // reach: the other player stands on the floor by the left wall (x 36); the holder slashes only from 31 units (centre to centre), beyond standard
  // reach (26) but inside long reach (36.8), and hits
  await installBot(O.page, { mode: 'goto', x: 36 });
  await waitFor(() => O.page.evaluate(() => { const m = __mp.net.me; return m && m.onGround && m.y > 250 && Math.abs(m.x + 5 - 36) < 3; }),
    { timeout: 30000, every: 200, what: 'Opp at x 36 on the floor' });
  await stopBot(O.page);
  await installBot(H.page, { mode: 'spar', target: O.id, dist: 31 });
  const hit = await waitFor(() => H.page.evaluate(([a, v]) => __mp.events.find(e => e.type === 'hit' && e.attacker === a && e.victim === v), [H.id, O.id]),
    { timeout: 30000, every: 100, what: 'a long-reach hit' }).catch(async e => {
    for (const p of [H, O]) log('stuck:', p.name, JSON.stringify(await p.page.evaluate(() => { const m = __mp.net.me; return { x: m.x, y: m.y, face: m.face, vx: m.vx, on: m.onGround, st: window.__botState, cfg: window.__botCfg, ev: __mp.events.slice(-8).map(e => e.type + ':' + (e.attacker || e.id || '') + '>' + (e.victim || '')) }; })));
    throw e;
  });
  const dist = await H.page.evaluate(() => window.__botState.lastSlashDist);
  log(`long-reach hit: slashed from ${dist.toFixed(1)} units (standard reach ends at 26), ${hit.move} for ${hit.dmg}`);
  assert.ok(dist > 27, `the hit came from beyond standard reach (${dist})`);
  // keep sparring to the kill: the feed marks it as a long-sword kill everywhere
  const lk = await waitFor(() => H.page.evaluate(([a, v]) => __mp.events.find(e => e.type === 'kill' && e.killer === a && e.victim === v), [H.id, O.id]),
    { timeout: 30000, every: 100, what: 'a long-sword kill' });
  await stopBot(H.page);
  assert.ok(lk.move === 'chop' || lk.move === 'sweep', 'killed by the sword, not ' + lk.move);
  assert.equal(lk.long, true, 'kill event marked long');
  for (const p of all) {
    await waitFor(() => p.page.evaluate(([k, v]) => __mp.feed.some(t => t.includes(k) && t.includes('⚔') && t.includes(v)), [H.name, O.name]),
      { timeout: 3000, what: `long-sword kill feed on ${p.name}` }).catch(async e => {
      log('feed missing:', p.name, JSON.stringify(await p.page.evaluate(() => ({ feed: __mp.feed, net: __mp.net.state, reconnects: __mp.net.stats.reconnects,
        kills: __mp.events.filter(e => e.type === 'kill'), msgs: __mp.debug.entries().filter(e => e.cat === 'net').map(e => e.msg) }))));
      throw e;
    });
  }
  log(`kill feed "${H.name} ⚔ ${O.name}" on all 3 pages`);

  // the holder dies by the opponent's sword (the arena has no spikes): the holder stands still and
  // the respawned opponent comes down to the floor and fights it; standard sword again everywhere
  await installBot(O.page, { mode: 'fight', target: H.id });
  const death = await waitFor(() => H.page.evaluate(id => __mp.events.find(e => e.type === 'kill' && e.victim === id), H.id),
    { timeout: 40000, every: 100, what: 'the holder dies' });
  await stopBot(O.page);
  assert.equal(death.killer, O.id, 'killed by the opponent');
  assert.ok(death.move === 'chop' || death.move === 'sweep', 'by a sword, not ' + death.move);
  assert.equal(death.held, true, 'kill event says the victim held a long sword');
  for (const p of all) {
    const h = await waitFor(async () => { const d = await drawn(p, H.id); return d && d.alive ? d : null; }, { timeout: 6000, what: `holder respawn on ${p.name}` });
    assert.equal(h.long, false, `${p.name}: no long sword after death`); assert.equal(h.reach, 18);
  }
  const me = await H.page.evaluate(() => ({ long: __mp.net.me.long, w: __mp.sim.swordBoxOf({ ...__mp.net.me, atkType: 'chop' }).w }));
  assert.equal(me.long, false); assert.equal(me.w, 18);
  assert.ok((await H.page.evaluate(() => __mp.debug.entries())).some(e => e.cat === 'life' && e.msg === 'long sword lost'));
  log(`holder died (${death.move}) and is back to the standard sword on all 3 pages`);

  // admin state lists pickups and holders
  const st = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), 'state'],
    (e, so) => (e ? rej(e) : res(so))));
  assert.match(st, /long-sword pickups \(\d\): #\d+ at/);
  log('tools/debug.js state: ' + st.split('\n').find(l => l.startsWith('long-sword')));
  for (const p of all) await p.page.context().close();
  await srv.stop();
}

// Escape opens a confirm menu; Stay keeps playing, Leave frees the slot and returns to the lobby.
async function leaveTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPlayer(srv, 'Quit', 2), B = await openPlayer(srv, 'Stay', 5);
  const ui = p => p.page.evaluate(() => ({ menu: __mp.leaveOpen, lobby: __mp.lobbyOpen, id: __mp.net.id, mode: __mp.net.mode,
    ids: __mp.state.players.map(q => q.id), shown: !document.getElementById('leave').classList.contains('hidden') }));
  await waitFor(async () => (await ui(B)).ids.length === 2, { what: 'both players in the arena' });
  await A.page.keyboard.press('Escape');
  let u = await ui(A);
  assert.ok(u.menu && u.shown && !u.lobby, 'Escape opens the leave menu');
  await A.page.keyboard.press('Enter');             // Stay has the focus, so Enter does not quit
  u = await ui(A);
  assert.ok(!u.menu && !u.lobby && u.id === A.id, 'Stay closes the menu and keeps the slot');
  await A.page.keyboard.press('Escape'); await A.page.keyboard.press('Escape');
  assert.ok(!(await ui(A)).menu, 'Escape again closes the menu');
  await A.page.keyboard.press('Escape');
  await A.page.click('#lvYes');
  u = await ui(A);
  assert.ok(u.lobby && !u.menu && u.id == null && u.mode === 'viewer', 'Leave returns to the lobby as a viewer');
  await waitFor(async () => { const v = await ui(B); return v.ids.length === 1 && v.ids[0] === B.id; }, { what: 'the leaver vanishes for the other player' });
  await waitFor(async () => (await ui(A)).ids.length === 1, { what: 'the lobby view still follows the arena' });
  await A.page.keyboard.press('Escape');
  assert.ok(!(await ui(A)).menu, 'Escape does nothing in the lobby');
  await A.page.click('#lFight');                    // and the leaver can join again on the same connection
  await waitFor(async () => { const v = await ui(A); return !v.lobby && v.id != null && v.id !== A.id; }, { what: 'rejoin after leaving' });
  log('escape menu: stay keeps the slot, leave frees it and returns to the lobby, rejoin works');
  for (const p of [A, B]) await p.page.context().close();
  await srv.stop();
}

// Chat (SPEC §9): A presses C, types, presses Enter; every page (a lobby viewer too) shows the line and
// the speaker's bubble; typing "hfmx" into the box toggles nothing and throws nothing; Escape cancels
// without opening the leave menu; a few seconds later the line is gone.
async function chatTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPlayer(srv, 'Talker', 3), B = await openPlayer(srv, 'Listen', 6);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const V = { page: await ctx.newPage(), name: 'Viewer' };
  V.page.on('pageerror', e => errors.push(`Viewer: ${e.message}`));
  await V.page.goto(srv.url);
  await V.page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open' && window.__mp.lobbyOpen);
  const ui = p => p.page.evaluate(() => ({ chat: __mp.chat, help: __mp.helpOpen, leave: __mp.leaveOpen, mute: document.getElementById('tMute').classList.contains('off'),
    fs: !!document.fullscreenElement, debug: !document.getElementById('dbg').classList.contains('hidden'),
    boxShown: !document.getElementById('chatbox').classList.contains('hidden'), val: document.getElementById('chatIn').value }));
  await waitFor(async () => (await A.page.evaluate(() => __mp.state.players.length)) === 2, { what: 'both players in the arena' });
  const before = await ui(A);
  // Escape cancels and does not open the leave menu
  await A.page.keyboard.press('KeyC');
  let u = await ui(A);
  assert.ok(u.chat.open && u.boxShown && u.val === '', 'C opens the box, without typing a "c" into it');
  await A.page.keyboard.type('draft');
  await A.page.keyboard.press('Escape');
  u = await ui(A);
  assert.ok(!u.chat.open && !u.boxShown && !u.leave, 'Escape cancels chat and does not open the leave menu');
  assert.deepEqual((await ui(B)).chat.lines, [], 'a cancelled message is not sent');
  // while open, keys type and trigger nothing else
  await A.page.keyboard.press('KeyC');
  await A.page.keyboard.type('hfmx dD?', { delay: 20 });
  await A.page.keyboard.press('Space'); await A.page.keyboard.press('ArrowLeft'); await A.page.keyboard.press('Tab');
  u = await ui(A);
  assert.ok(u.chat.open && u.val.startsWith('hfmx dD?'), `the box holds what was typed (${u.val})`);
  assert.ok(!u.help && u.mute === before.mute && u.fs === before.fs && u.debug === before.debug, 'h, f, m, x, d did nothing else');
  assert.equal(await A.page.evaluate(() => document.activeElement.id), 'chatIn', 'Tab does not move the focus');
  await A.page.keyboard.press('Control+A'); await A.page.keyboard.press('Backspace');
  const msg = '  Hello  <b>world</b>  ‮!  ';
  await A.page.keyboard.insertText(msg);
  await A.page.keyboard.press('Enter');
  u = await ui(A);
  assert.ok(!u.chat.open && !u.boxShown, 'Enter sends and closes');
  const want = 'Hello <b>world</b> !';
  for (const p of [A, B, V]) {
    await waitFor(async () => (await ui(p)).chat.lines.length === 1, { what: `${p.name} sees the chat line` });
    assert.deepEqual((await ui(p)).chat.lines, ['Talker: ' + want], `${p.name}: "name: text", sanitised`);
  }
  for (const p of [A, B, V]) {
    const b = (await ui(p)).chat.bubbles;
    assert.deepEqual(b, [{ id: A.id, text: want }], `${p.name}: bubble state for the speaker`);
  }
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#chatlist b').length), 1, 'the markup in the text did not become elements');
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#chatlist *').length), 2, 'one row and one name element, nothing else');
  // no text in the debug log
  for (const p of [A, B, V]) {
    const dump = await p.page.evaluate(() => JSON.stringify(__mp.debug.entries()));
    assert.ok(!dump.includes('Hello'), `${p.name}: chat text is not in the debug ring`);
  }
  // it goes away by itself
  await sleep(7000);
  for (const p of [A, B, V]) {
    const c = (await ui(p)).chat;
    assert.deepEqual(c.lines, [], `${p.name}: the line faded out`);
    assert.deepEqual(c.bubbles, [], `${p.name}: the bubble faded out`);
  }
  assert.ok(!(await ui(V)).chat.open);
  // the lobby viewer cannot chat: C does nothing there
  await V.page.keyboard.press('KeyC');
  assert.ok(!(await ui(V)).chat.open, 'no chat box in the lobby');
  log('chat: C, Enter, Escape, bubble and list on every page (viewer too), keys swallowed, text gone after 6 s');
  for (const p of [A, B, V]) await p.page.context().close();
  await srv.stop();
}

// Ninja stars (SPEC §5.2): STAR_SECS=1,1 and ITEM_POINTS=0,1 put star pickups on the floor quickly
// (ITEM_SECS keeps long swords away). A bot grabs stars: the "X to throw" reminder and the status
// bar's count show; it throws at the opponent standing on the same floor; every page sees the
// throw and the star hit; the count goes down.
async function starTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir, STAR_SECS: '1,1', ITEM_SECS: '900,900', ITEM_POINTS: '0,1' }); servers.push(srv);
  const T = await openPlayer(srv, 'Thrower', 4), V = await openPlayer(srv, 'Target', 0);
  const wctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const W = { page: await wctx.newPage(), name: 'Watch' };
  W.page.on('pageerror', e => errors.push(`Watch: ${e.message}`));
  await W.page.goto(srv.url);
  await W.page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  const all = [T, V, W];
  // the target waits on the left half of the floor, out of the way
  await installBot(V.page, { mode: 'goto', x: 40 });
  await waitFor(() => T.page.evaluate(() => (__mp.state.items || []).some(i => i.kind === 'star')), { timeout: 10000, what: 'a star pickup appears' });
  const hud0 = await T.page.evaluate(() => document.getElementById('hStars').textContent);
  assert.equal(hud0, '★ 0', 'the status bar shows the (empty) star count');
  await installBot(T.page, { mode: 'fetch' });
  const pick = await waitFor(() => T.page.evaluate(id => __mp.events.find(e => e.type === 'pickup' && e.id === id && e.kind === 'star'), T.id),
    { timeout: 30000, every: 100, what: 'Thrower picks up stars' });
  await stopBot(T.page);
  const ui = await waitFor(async () => {
    const u = await T.page.evaluate(() => ({ hint: __mp.throwHint, hud: document.getElementById('hStars').textContent,
      shown: getComputedStyle(document.getElementById('hStars')).display !== 'none', me: __mp.net.me && __mp.net.me.stars,
      life: __mp.debug.entries().filter(e => e.cat === 'life').map(e => e.msg) }));
    return u.me === 3 && u.hud === '★ 3' ? u : null;
  }, { timeout: 3000, what: 'the star count after the pickup' });
  assert.equal(ui.hint, 'X to throw', 'the reminder above our Kanbei');
  assert.ok(ui.shown); assert.ok(ui.life.includes('stars gained'));
  for (const p of all) await waitFor(() => p.page.evaluate(([id, item]) => __mp.events.some(e => e.type === 'pickup' && e.id === id && e.item === item && e.kind === 'star'), [T.id, pick.item]),
    { timeout: 3000, what: `star pickup on ${p.name}` });
  log(`stars: ${T.name} took ${pick.item} at ${pick.x},${pick.y}; reminder "${ui.hint}", status bar "${ui.hud}"`);
  // both on the left half of the floor (the low centre block would stop the star): target at 40,
  // thrower at 140, then throw until a star hits
  await waitFor(() => V.page.evaluate(() => { const m = __mp.net.me; return m && m.onGround && m.y > 250 && Math.abs(m.x + 5 - 40) < 3; }), { timeout: 30000, every: 200, what: 'Target at x 40' });
  await stopBot(V.page);
  await installBot(T.page, { mode: 'goto', x: 140 });
  await waitFor(() => T.page.evaluate(() => { const m = __mp.net.me; return m && m.onGround && m.y > 250 && Math.abs(m.x + 5 - 140) < 3; }), { timeout: 30000, every: 200, what: 'Thrower at x 140' });
  const before = await T.page.evaluate(() => __mp.net.me.stars);   // (it may have picked up more on the way)
  await installBot(T.page, { mode: 'throw', target: V.id });
  const hit = await waitFor(() => T.page.evaluate(([a, v]) => __mp.events.find(e => e.type === 'hit' && e.move === 'star' && e.attacker === a && e.victim === v), [T.id, V.id]),
    { timeout: 15000, every: 100, what: 'a star hit' });
  await stopBot(T.page);
  for (const p of all) {
    await waitFor(() => p.page.evaluate(([a, v, t]) => __mp.events.some(e => e.type === 'hit' && e.move === 'star' && e.attacker === a && e.victim === v && e.tick === t) &&
      __mp.events.some(e => e.type === 'throw' && e.id === a), [T.id, V.id, hit.tick]), { timeout: 3000, what: `star hit on ${p.name}` });
  }
  const after = await waitFor(async () => {
    const u = await T.page.evaluate(() => ({ me: __mp.net.me.stars, hud: document.getElementById('hStars').textContent, throws: window.__botState.throws,
      life: __mp.debug.entries().filter(e => e.cat === 'life').map(e => e.msg) }));
    return u.me < before && u.hud === `★ ${u.me}` ? u : null;
  }, { timeout: 3000, what: 'the count goes down' });
  assert.ok(after.life.includes('star thrown'));
  assert.equal(hit.dmg, 20);
  log(`stars: ${after.throws} thrown, hit for ${hit.dmg} seen on all 3 pages, count ${before} -> ${after.me} ("${after.hud}")`);
  // Rapid fire: every star held, one press each 7 ticks (just past the cooldown), gives one swish
  // per throw. The local count once took off throws the server count already showed, so the last
  // throws of a quick burst stayed silent.
  await installBot(T.page, { mode: 'fetch' });
  await waitFor(() => T.page.evaluate(() => (__mp.net.me && __mp.net.me.stars) >= 3), { timeout: 30000, every: 100, what: 'Thrower restocks stars' });
  await stopBot(T.page);
  const held = await T.page.evaluate(() => {
    const n = __mp.net.me.stars, s = { t: 0, left: n };
    window.__swish0 = __mp.debug.entries().filter(e => e.msg === 'throw swish').length;
    __mp.autopilot = () => (++s.t % 7 === 0 && s.left > 0 ? (s.left--, 32) : 0);
    return n;
  });
  const burst = await waitFor(async () => {
    const u = await T.page.evaluate(() => ({ me: __mp.net.me.stars, swishes: __mp.debug.entries().filter(e => e.msg === 'throw swish').length - window.__swish0 }));
    return u.me === 0 ? u : null;
  }, { timeout: 5000, every: 100, what: 'the burst empties the stars' });
  await new Promise(r => setTimeout(r, 300));
  const swishes = await T.page.evaluate(() => __mp.debug.entries().filter(e => e.msg === 'throw swish').length - window.__swish0);
  await stopBot(T.page);
  assert.equal(swishes, held, `a swish for each of ${held} quick throws (heard ${swishes})`);
  log(`stars: rapid fire of ${held}, ${swishes} swishes (count ${burst.me})`);
  // admin state and the CLI list star pickups, stars in flight and counts
  const st = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), 'state'],
    (e, so) => (e ? rej(e) : res(so))));
  assert.match(st, /star pickups \(\d\)/); assert.match(st, /stars in flight \(\d\)/); assert.match(st, /stars=\d/);
  for (const c of [T.page.context(), V.page.context(), wctx]) await c.close();
  await srv.stop();
}

// Heartbeat (SPEC §6.4): pinging pages (a lobby viewer and an idle player) stay connected; a page
// frozen for a while (like a background tab whose timers stop: `net.freeze`) is closed by the
// server after 5 s with the timeout code, then reconnects and resumes if it wakes within the grace
// period, and otherwise lands in the lobby with a message.
async function heartbeatTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPlayer(srv, 'Afk', 3), B = await openPlayer(srv, 'Bee', 4);
  const vctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const V = await vctx.newPage();
  V.on('pageerror', e => errors.push(`viewer: ${e.message}`));
  await V.goto(srv.url);
  await V.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  const ringEvents = async () => (await (await fetch(`http://127.0.0.1:${srv.adminPort}/events?n=500`)).json());
  const timeouts = async () => (await ringEvents()).filter(e => e.type === 'timeout');
  const net = p => p.evaluate(() => ({ state: __mp.net.state, mode: __mp.net.mode, id: __mp.net.id, reconnects: __mp.net.stats.reconnects,
    lobby: __mp.lobbyOpen, err: document.getElementById('lErr').textContent, msgs: __mp.debug.entries().filter(e => e.cat === 'net').map(e => e.msg) }));
  // 7 s of quiet play: nobody is timed out (the viewer and the idle player keep pinging)
  await sleep(7000);
  assert.deepEqual(await timeouts(), [], 'no timeouts while every page pings');
  for (const p of [A.page, B.page, V]) assert.equal((await net(p)).reconnects, 0);
  // frozen 3 s: under the heartbeat, nothing happens
  await A.page.evaluate(() => __mp.net.freeze(3000));
  await sleep(3800);
  let a = await net(A.page);
  assert.equal(a.reconnects, 0); assert.equal(a.mode, 'play');
  assert.deepEqual(await timeouts(), []);
  // frozen 7 s: the server closes it at 5 s (the record is kept, away); on waking the page treats the
  // close as a network drop and resumes with the same id
  await A.page.evaluate(() => __mp.net.freeze(7000));
  await waitFor(async () => (await timeouts()).some(e => e.player === A.id), { timeout: 7000, what: 'heartbeat timeout' });
  await waitFor(() => B.page.evaluate(id => (__mp.net.meta.get(id) || {}).away === true, A.id), { timeout: 3000, what: 'Afk away for Bee' });
  await waitFor(async () => { const v = await net(A.page); return v.state === 'open' && v.mode === 'play' && v.reconnects === 1; },
    { timeout: 6000, what: 'resume after the timeout' });
  a = await net(A.page);
  assert.equal(a.id, A.id, 'same id after the heartbeat resume');
  assert.ok(a.msgs.includes('server closed a silent connection (heartbeat)') && a.msgs.includes('resume accepted'), a.msgs.join(', '));
  assert.ok(!a.lobby);
  log('heartbeat: idle pages kept, a 3 s freeze survives, a 7 s freeze is timed out and resumes');
  // frozen 12 s: timed out at 5 s, released at 10 s; on waking the resume is refused and the page
  // goes back to the lobby with a message
  await A.page.evaluate(() => __mp.net.freeze(12000));
  await waitFor(() => B.page.evaluate(id => __mp.events.some(e => e.type === 'leave' && e.id === id && e.reason === 'timeout'), A.id),
    { timeout: 12000, what: 'Afk released' });
  await waitFor(async () => { const v = await net(A.page); return v.lobby && v.mode === 'viewer' && v.state === 'open'; }, { timeout: 8000, what: 'back to the lobby' });
  a = await net(A.page);
  assert.match(a.err, /Connection lost/);
  assert.ok(a.msgs.includes('resume refused: grace period over'));
  assert.ok((await ringEvents()).some(e => e.type === 'resume-refused'));
  log(`heartbeat: a 12 s freeze ends in the lobby: "${a.err}"`);
  const v = await net(V);
  assert.equal(v.reconnects, 0, 'the lobby viewer was never timed out');
  for (const c of [A.page.context(), B.page.context(), vctx]) await c.close();
  await srv.stop();
}

// Full screen (SPEC §9): the button top right shows in the lobby and in the game, toggles full screen
// (a stubbed Fullscreen API: headless Chromium cannot really go full screen), reacts to F (not while
// typing a name), follows a change made elsewhere (Escape), and that Escape does not also open the
// leave menu. The score strip stops short of the button.
async function fullscreenTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`fs: ${e.message}`));
  // stub: requestFullscreen / exitFullscreen set a fake fullscreenElement and fire fullscreenchange
  await page.addInitScript(() => {
    let el = null;
    window.__fsCalls = [];
    Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => el });
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
    const fire = () => document.dispatchEvent(new Event('fullscreenchange'));
    Element.prototype.requestFullscreen = function () { window.__fsCalls.push('request'); el = this; setTimeout(fire, 0); return Promise.resolve(); };
    Document.prototype.exitFullscreen = function () { window.__fsCalls.push('exit'); el = null; setTimeout(fire, 0); return Promise.resolve(); };
    window.__fsBrowserExit = () => { el = null; fire(); };     // what the browser does on Escape
  });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  const fs = () => page.evaluate(() => {
    const b = document.getElementById('fsBtn'), r = b.getBoundingClientRect(), s = document.getElementById('strip').getBoundingClientRect();
    return { shown: getComputedStyle(b).display !== 'none' && r.width > 0, on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed'),
      calls: [...window.__fsCalls], right: innerWidth - r.right, top: r.top, btnLeft: r.left, stripRight: s.right, menu: __mp.leaveOpen };
  });
  let f = await fs();
  assert.ok(f.shown && f.right < 10 && f.top < 10, 'the button sits top right in the lobby: ' + JSON.stringify(f));
  assert.equal(f.on, false);
  // F while typing a name does nothing
  await page.click('#lName'); await page.keyboard.press('KeyF');
  assert.deepEqual((await fs()).calls, [], 'F in the name field types');
  // the button toggles, and its state follows
  await page.click('#fsBtn');
  await waitFor(async () => (await fs()).on, { what: 'full screen on' });
  f = await fs();
  assert.deepEqual(f.calls, ['request']); assert.equal(f.pressed, 'true');
  await page.click('#fsBtn');
  await waitFor(async () => !(await fs()).on, { what: 'full screen off' });
  // join; in the game the button is still there and the strip stops short of it
  await page.fill('#lName', 'Full'); await page.click('#lFight');
  await page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive);
  await waitFor(async () => (await fs()).stripRight > 0, { what: 'the strip' });
  f = await fs();
  assert.ok(f.shown, 'visible in the game');
  assert.ok(f.stripRight <= f.btnLeft + .5, `the strip ends before the button (${f.stripRight} vs ${f.btnLeft})`);
  // F toggles it in the game
  await page.keyboard.press('KeyF');
  await waitFor(async () => (await fs()).on, { what: 'F: full screen on' });
  // leaving full screen elsewhere (the browser on Escape) updates the button, and that Escape does
  // not also open the leave menu; the next Escape does
  await page.evaluate(() => window.__fsBrowserExit());
  await page.keyboard.press('Escape');
  f = await fs();
  assert.equal(f.on, false, 'the icon follows a change made outside the button');
  assert.equal(f.menu, false, 'the Escape that left full screen does not open the leave menu');
  await sleep(600);
  await page.keyboard.press('Escape');
  assert.equal((await fs()).menu, true, 'the next Escape opens the leave menu');
  await page.keyboard.press('Escape');
  assert.deepEqual((await fs()).calls, ['request', 'exit', 'request']);
  // no full-screen support: no button, and the strip takes the full width
  const ctx2 = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
  });
  await p2.goto(srv.url);
  await p2.waitForFunction(() => window.__mp && window.__mp.net);
  assert.equal(await p2.evaluate(() => getComputedStyle(document.getElementById('fsBtn')).display), 'none', 'hidden without support');
  log('full screen: button in lobby and game, toggles, F (not in the name field), follows Escape, which does not open the leave menu');
  for (const c of [ctx, ctx2]) await c.close();
  await srv.stop();
}

// A page from an older build (SPEC §10) reloads itself when the server's welcome names a newer one,
// and only once per build.
// Phone emulation (real touch input through CDP, mobile contexts): the lobby works with the on-screen
// keyboard's typing and a tap on FIGHT, every touch button is on screen and big enough, holding
// a direction moves, jump and slash fire, a second finger works while the first holds, a finger
// can slide from one button to another, and the touch UI also appears when the browser claims a fine
// pointer but a finger touches.
async function phoneTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
  const variants = [
    { name: 'phone portrait 390x844', w: 390, h: 844, fine: false },
    { name: 'phone landscape 844x390', w: 844, h: 390, fine: false },
    { name: 'phone landscape, fine pointer reported', w: 844, h: 390, fine: true },
  ];
  for (const v of variants) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true, userAgent: UA });
    if (v.fine) await ctx.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /pointer:\s*coarse/.test(q) ? { matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q);
    });
    // let the browser zoom if it wants to (the real page forbids it in its meta tag; the page's own
    // touch-action and gesture handling must hold even where the meta tag is ignored, as on iOS)
    await ctx.addInitScript(() => new MutationObserver(() => {
      const m = document.querySelector('meta[name=viewport]');
      if (m && m.content.includes('maximum-scale')) m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    }).observe(document, { subtree: true, childList: true, attributes: true }));
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${v.name}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${v.name}: console: ${m.text()}`); });
    await page.goto(srv.url);
    await page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const centre = id => page.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, r: r.right, b: r.bottom, l: r.left, t: r.top }; }, id);
    // a two-finger spread must not zoom the page: on the lobby, the arena and the buttons
    const pinch = async (cx, cy, what) => {
      await touch('touchStart', [{ x: cx - 15, y: cy, id: 1 }, { x: cx + 15, y: cy, id: 2 }]);
      for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: cx - 15 - i * 6, y: cy, id: 1 }, { x: cx + 15 + i * 6, y: cy, id: 2 }]); await sleep(16); }
      await touch('touchEnd', []);
      await sleep(250);
      assert.equal(await page.evaluate(() => visualViewport.scale), 1, `${v.name}: pinch on ${what} did not zoom`);
    };
    await pinch(v.w / 2, v.h / 2, 'the lobby');
    assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('lName')).fontSize) >= 16), `${v.name}: the name field is at least 16px (no iOS focus zoom)`);
    assert.equal(await page.evaluate(() => { const e = new Event('gesturestart', { cancelable: true, bubbles: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }), true, `${v.name}: Safari gesture events are cancelled`);
    // lobby: type a name, tap FIGHT (not clicks)
    await page.tap('#lName'); await page.keyboard.type('Phone');
    const f = await centre('lFight');
    assert.ok(f.y > 0 && f.b <= v.h, `${v.name}: FIGHT is on screen`);
    await page.touchscreen.tap(f.x, f.y);
    await page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive, null, { timeout: 10000 });
    await sleep(400);
    assert.equal(await page.evaluate(() => document.body.classList.contains('touchui')), true, `${v.name}: touch UI is on`);
    // every button is on screen, at least 44 px each way (hit area), and none overlap
    const ids = ['tL', 'tR', 'tRun', 'tT', 'tS', 'tJ', 'tMute', 'tHelp', 'tLeave'];
    const rects = {};
    for (const id of ids) {
      const r = rects[id] = await centre(id);
      assert.ok(r.w >= 44 && r.h >= 44, `${v.name}: ${id} is ${r.w}x${r.h}`);
      assert.ok(r.l >= 0 && r.t >= 0 && r.r <= v.w && r.b <= v.h, `${v.name}: ${id} is inside the screen`);
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = rects[ids[i]], b = rects[ids[j]];
      assert.ok(a.r <= b.l + 0.5 || b.r <= a.l + 0.5 || a.b <= b.t + 0.5 || b.b <= a.t + 0.5, `${v.name}: ${ids[i]} and ${ids[j]} do not overlap`);
    }
    await pinch(v.w / 2, v.h / 2, 'the arena');
    // sample the local player every frame: did it jump, did it swing
    await page.evaluate(() => {
      window.__ph = { jump: false, slash: false };
      const loop = () => {
        const p = __mp.state.players.find(q => q.id === __mp.net.id);
        if (p) { if (!p.onGround) __ph.jump = true; if (p.atk > 0) __ph.slash = true; }
        requestAnimationFrame(loop);
      };
      loop();
    });
    const X = () => page.evaluate(() => __mp.net.me.x);
    const grounded = () => waitFor(() => page.evaluate(() => __mp.net.me.onGround), { timeout: 5000, every: 50, what: 'on the ground' });
    await grounded();
    // the spawn can be by the right wall: walk left first so there is room to go right
    if (await X() > 150) {
      await touch('touchStart', [{ x: rects.tL.x, y: rects.tL.y, id: 9 }]);
      await sleep(1500);
      await touch('touchEnd', []); await grounded();
    }
    // hold ▶, the player moves right; release, it stops
    const x0 = await X();
    await touch('touchStart', [{ x: rects.tR.x, y: rects.tR.y, id: 1 }]);
    await sleep(500);
    const x1 = await X();
    assert.ok(x1 > x0 + 15, `${v.name}: holding ▶ moved the player (${x0} to ${x1})`);
    // second finger: ⤒ while ▶ is still held
    await touch('touchStart', [{ x: rects.tR.x, y: rects.tR.y, id: 1 }, { x: rects.tJ.x, y: rects.tJ.y, id: 2 }]);
    await waitFor(() => page.evaluate(() => __ph.jump), { timeout: 3000, every: 30, what: 'jump with a second finger' });
    await sleep(600);
    assert.ok(await X() > x1 + 10, `${v.name}: still moving right while jumping with the second finger`);
    await touch('touchEnd', []);
    await grounded();
    // a finger sliding from ▶ onto ◀ turns around
    await touch('touchStart', [{ x: rects.tR.x, y: rects.tR.y, id: 1 }]);
    await sleep(250);
    const xs = await X();
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: rects.tR.x + (rects.tL.x - rects.tR.x) * i / 8, y: rects.tR.y + (rects.tL.y - rects.tR.y) * i / 8, id: 1 }]); await sleep(20); }
    await sleep(500);
    assert.ok(await X() < xs, `${v.name}: sliding ▶ to ◀ turned the player round`);
    // touchcancel lets go of everything
    await touch('touchCancel', []);
    await sleep(700);
    const xc = await X(); await sleep(400);
    assert.ok(Math.abs(await X() - xc) < 2, `${v.name}: touchcancel stopped the player`);
    // slash
    await touch('touchStart', [{ x: rects.tS.x, y: rects.tS.y, id: 3 }]); await sleep(80); await touch('touchEnd', []);
    await waitFor(() => page.evaluate(() => __ph.slash), { timeout: 3000, every: 30, what: 'slash from the ⚔ button' });
    await pinch(rects.tL.x, rects.tL.y, 'the buttons');
    // ? opens the how-to-play card (a real tap), ✕ opens the leave menu, both close again
    await page.touchscreen.tap(rects.tHelp.x, rects.tHelp.y);
    await waitFor(() => page.evaluate(() => __mp.helpOpen), { timeout: 2000, what: 'help opens' });
    await page.tap('#hwClose');
    await waitFor(() => page.evaluate(() => !__mp.helpOpen), { timeout: 2000, what: 'help closes' });
    await page.touchscreen.tap(rects.tLeave.x, rects.tLeave.y);
    await waitFor(() => page.evaluate(() => __mp.leaveOpen), { timeout: 2000, what: 'leave menu opens' });
    await page.tap('#lvNo');
    await waitFor(() => page.evaluate(() => !__mp.leaveOpen), { timeout: 2000, what: 'leave menu closes' });
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), !v.fine, `${v.name}: pointer media as set up`);
    log(`phone: ${v.name}: buttons in view and >= 44 px, hold, jump, second finger, slide, cancel, slash, ?, x all work`);
    await ctx.close();
  }
}

async function staleBuildTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`Stale: ${e.message}`));
  const ready = () => page.waitForFunction(() => window.__mp && __mp.net && __mp.net.state === 'open' && __mp.net.serverBuild, null, { timeout: 10000 });
  await page.goto(srv.url); await ready();
  const b = await page.evaluate(() => ({ page: __mp.net.build, server: __mp.net.serverBuild, meta: document.querySelector('meta[name="build"]').content }));
  assert.match(b.server, /^[0-9a-f]{10}$/); assert.equal(b.page, b.server); assert.equal(b.meta, b.server);
  // pretend this page came from an older build, then reconnect as after a deploy: it reloads itself
  await page.evaluate(() => { window.__marker = 1; __mp.net.build = 'deadbeef00'; __mp.net.drop(); });
  await page.waitForFunction(() => !window.__marker && window.__mp && __mp.net && __mp.net.state === 'open', null, { timeout: 10000 });
  await ready();
  assert.equal(await page.evaluate(() => __mp.net.build === __mp.net.serverBuild), true, 'after the reload the page matches the server');
  // the same mismatch again for the same server build must not reload a second time (no loops)
  await page.evaluate(() => { window.__marker = 2; __mp.net.build = 'deadbeef00'; __mp.net.drop(); });
  await sleep(3000);
  assert.equal(await page.evaluate(() => window.__marker), 2, 'no second reload for the same build');
  log('stale build: the page reloaded itself once and does not loop');
  await ctx.close(); await srv.stop();
}

// AI players (SPEC §15): two lobby viewers; − / + on one updates the count on both; bots fight in the
// arena wearing the reserved colour, which is not among the swatches; + stops at slots − 1; a human
// still joins the last free slot, after which + is disabled; − then removes the newest bot.
async function botTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const open = async name => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 576 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
    await page.goto(srv.url);
    await page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
    return { page, name };
  };
  const V = await open('V'), W = await open('W');
  const ui = p => p.page.evaluate(() => ({ n: document.getElementById('lBotN').textContent,
    dec: document.getElementById('lBotDec').disabled, inc: document.getElementById('lBotInc').disabled,
    bots: (__mp.net.lobby.players || []).filter(q => q.bot), swatches: document.querySelectorAll('#lColors .sw').length,
    inArena: __mp.state.players.map(q => q.id) }));
  const both = (n, what) => waitFor(async () => (await ui(V)).n === String(n) && (await ui(W)).n === String(n), { what });
  await both(0, 'count 0 on both pages');
  assert.ok((await ui(V)).dec, '− disabled with no bots');
  await V.page.click('#lBotInc'); await V.page.click('#lBotInc');
  await both(2, '+ + shows 2 on both pages');
  await W.page.click('#lBotDec');
  await both(1, '− on the other page shows 1 on both');
  await V.page.click('#lBotInc');
  await both(2, 'back to 2');
  // the bots are in the arena, in the reserved colour, named AI n, and that colour is not a swatch
  const hex = await V.page.evaluate(async () => (await import('/shared/constants.js')).BOT.hex);
  await waitFor(async () => { const u = await ui(W); return u.bots.length === 2 && u.bots.every(b => u.inArena.includes(b.id)); }, { what: 'bots in the arena' });
  const u = await ui(W);
  assert.equal(u.swatches, 12, 'twelve human swatches, none for bots');
  for (const b of u.bots) { assert.equal(b.color, 12); assert.match(b.name, /^AI \d+$/); }
  const dot = await W.page.evaluate(() => [...document.querySelectorAll('#lPlayers li')].map(li => [li.querySelector('.nm').textContent, getComputedStyle(li.querySelector('.dot')).backgroundColor]));
  const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  assert.ok(dot.length === 2 && dot.every(([, c]) => c === rgb), `bot dots ${JSON.stringify(dot)} in ${rgb}`);
  // up to slots − 1 (rate-limited: a short pause between presses)
  for (let i = 0; i < 12; i++) { if (!(await ui(V)).inc) await V.page.click('#lBotInc'); await sleep(300); }
  await both(11, 'eleven bots at most');
  assert.ok((await ui(V)).inc, '+ disabled at the limit');
  // a human still gets the free slot
  await W.page.fill('#lName', 'Human');
  await W.page.click('#lFight');
  await W.page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive, null, { timeout: 10000 });
  await waitFor(async () => (await ui(V)).inArena.length === 12, { what: '12 in the arena' });
  assert.ok((await ui(V)).inc, '+ disabled with the arena full');
  await V.page.click('#lBotDec');
  await waitFor(async () => (await ui(V)).n === '10', { what: '− removes one' });
  assert.ok(!(await W.page.evaluate(() => __mp.net.lobby.players.some(q => q.name === 'AI 11'))), 'the newest bot went first');
  log('bots: − / + live on both lobby pages, reserved colour in the arena, at most 11, a human still joins');
  for (const p of [V, W]) await p.page.context().close();
  await srv.stop();
}

async function main() {
  browser = await launchChromium();
  try {
    await fightTest();
    await predictionTest();
    await longSwordTest();
    await leaveTest();
    await chatTest();
    await starTest();
    await heartbeatTest();
    await fullscreenTest();
    await phoneTest();
    await staleBuildTest();
    await botTest();
    assert.deepEqual(errors, [], 'no page errors');
    log('PASS');
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) await s.stop();
    for (const d of dirs) removeDir(d);
  }
}

main().catch(e => { console.error('multiclient: FAIL:', e.message); if (errors.length) console.error(errors.slice(0, 10)); process.exitCode = 1; });
