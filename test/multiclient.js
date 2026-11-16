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
  for (const f of fps) assert.equal(f.fp, fps[0].fp, 'same gore on every page');

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
      { timeout: 3000, what: `long-sword kill feed on ${p.name}` });
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

async function main() {
  browser = await launchChromium();
  try {
    await fightTest();
    await predictionTest();
    await longSwordTest();
    await leaveTest();
    await heartbeatTest();
    assert.deepEqual(errors, [], 'no page errors');
    log('PASS');
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) await s.stop();
    for (const d of dirs) removeDir(d);
  }
}

main().catch(e => { console.error('multiclient: FAIL:', e.message); if (errors.length) console.error(errors.slice(0, 10)); process.exitCode = 1; });
