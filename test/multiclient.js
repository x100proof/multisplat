// Headless multi-client test (SPEC §12): three browsers in one arena, a scripted fight to the death,
// kill/score/respawn seen on every page, a drop and resume that keeps the score, a manual debug
// report read back through tools/debug.js, prediction error under NET_SIM=120,2, and a long-sword
// pickup (ITEM_SECS / ITEM_POINTS shorten the spawn timer and keep pickups on the floor) that
// every page sees, that lengthens the holder's reach in a scripted check and is lost on death.
// Also AI players, and spectator mode (watchTest, SPEC §16), and rooms (SPEC §17: create, join, admin
// transfer, leaving as admin, renames, the 10-room limit), and restarts (restartTest, SPEC §18: a saved
// game resumed in place across a server restart, and the update message under other rules). Every section runs in a room: its first
// player creates one (openPlayer opts.create), later ones tap it in the list (opts.room). The lobby has
// two screens: the room list (Create a room under it) and one room's screen (name, colour, FIGHT).
//
//   node test/multiclient.js            (Chromium from $PLAYWRIGHT_CHROMIUM or playwright's cache)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launchChromium, waitFor, sleep, tempDir, removeDir, ROOT } from './lib.js';
import WebSocket from 'ws';
import { installBot, stopBot } from './bot.js';

const log = (...a) => console.log('multiclient:', ...a);
const errors = [];
let browser, servers = [], dirs = [];

// A fresh browser context and page on the lobby, connected. Resolves to { page, name }.
async function openPage(srv, name, viewport = { width: 960, height: 576 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: console: ${m.text()}`); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__mp && window.__mp.net && window.__mp.net.state === 'open');
  return { page, name };
}
// Tap room `id` in the room list and wait for the server to say we look at it (its screen opens).
async function selectRoom(p, id) {
  await p.page.click(`#lRoomList button[data-room="${id}"]`);
  await p.page.waitForFunction(id => __mp.net.lobby.room === id, id, { timeout: 5000 });
}
// Name and colour on a room's screen.
async function pickYou(p, name, color) {
  await p.page.fill('#lName', name);
  await p.page.click(`#lColors .sw:nth-child(${color + 1})`);
}
// Create a room from the room list (`rname`: its name or '' for the default): the creator is its admin
// (pending: not in the arena) and lands on its screen, where it then sets name and colour. Resolves to
// the room id.
async function createRoom(p, name, color, rname = '') {
  if (rname) await p.page.fill('#lRoomName', rname);
  await p.page.click('#lCreate');
  await p.page.waitForFunction(() => __mp.net.lobby.mine && __mp.net.lobby.room && !document.getElementById('scrRoom').classList.contains('hidden'), null, { timeout: 10000 });
  assert.equal(await p.page.evaluate(() => __mp.net.mode), 'viewer', 'create does not join');
  await pickYou(p, name, color);
  return p.page.evaluate(() => __mp.net.lobby.room);
}
// opts.create (true, or the room's name): this page creates a room, then FIGHT;
// opts.room (an id): tap that room, then FIGHT. Returns { page, name, id, room }.
async function openPlayer(srv, name, color, opts = {}) {
  const p = await openPage(srv, name);
  if (opts.room) { await selectRoom(p, opts.room); await pickYou(p, name, color); p.room = opts.room; }
  else p.room = await createRoom(p, name, color, typeof opts.create === 'string' ? opts.create : '');
  await p.page.click('#lFight');
  await p.page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive && !__mp.lobbyOpen, null, { timeout: 10000 });
  p.id = await p.page.evaluate(() => __mp.net.id);
  return p;
}
// A lobby viewer looking at room `id` (snapshots and events, no slot).
async function openViewer(srv, name, id) {
  const p = await openPage(srv, name);
  await selectRoom(p, id);
  return p;
}
// Rooms the server has open (admin /state), and a wait for the old ones to go: a room closes when
// its admin leaves or its record's 5 s grace runs out, and at most 2 rooms per address may be open.
const stateOf = async srv => (await fetch(`http://127.0.0.1:${srv.adminPort}/state`)).json();
const roomsOpen = async srv => (await stateOf(srv)).rooms.length;
const noRooms = srv => waitFor(async () => (await roomsOpen(srv)) === 0, { timeout: 12000, what: 'every room closed' });
const debugCli = (srv, ...args) => new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), ...args],
  (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));

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
  const A = await openPlayer(srv, 'Ash', 0, { create: 'Dojo' }), B = await openPlayer(srv, 'Bea', 1, { room: A.room }), C = await openPlayer(srv, 'Cy', 2, { room: A.room });
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
  // in the simulation (online the style is a room setting, SPEC §17.1: setStyle is a page-local test override)
  const sw = await A.page.evaluate(k => {
    const before = __mp.gore.counts.layerRebuilds;
    __mp.gore.setStyle('real');
    const mid = { fp: __mp.gore.fingerprint(k), rebuilt: __mp.gore.counts.layerRebuilds > before };
    __mp.gore.setStyle('neon');
    return { ...mid, back: __mp.gore.style, fp2: __mp.gore.fingerprint(k) };
  }, key);
  assert.ok(sw.rebuilt, 'switching style rebuilds the baked blood layer');
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
  assert.match(st, /rooms \(1\/10\):/); assert.match(st, /room \d+ "Dojo" admin=\d+ "Ash" players=3 bots=0 queue=0/);
  log(`debug report ${id} stored with the server view; tools/debug.js state ok`);

  // --- streamed client log (SPEC §13.5): the word id is in the lobby footer and in reports, and
  // tools/debug.js log <word> prints that page's entries (streamed every LOG.flushMs = 4 s)
  const word = await A.page.evaluate(() => __mp.net.word);
  assert.match(word || '', /^[a-z]+-[a-z]+$/, 'word id');
  assert.equal(await A.page.evaluate(() => document.getElementById('lId').textContent), ` · id: ${word}`);
  assert.equal(await A.page.evaluate(() => localStorage.getItem('multisplat-id')), word);
  assert.equal(rec.report.w, word, 'the report carries the word id');
  assert.notEqual(await B.page.evaluate(() => __mp.net.word), word, 'another browser, another id');
  const logOut = await waitFor(async () => {
    const o = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), 'log', word],
      (e, so) => (e ? rej(e) : res(so))));
    return o.includes('[net] connect') && (o.includes('[life] join') || o.includes('[life] create room')) ? o : null;   // a room's creator logs create, not join
  }, { timeout: 10000, what: 'streamed log entries' });
  assert.match(logOut.split('\n')[0], /UNTRUSTED INPUT/);
  assert.match(logOut, new RegExp(`== ${word} names=\\["Ash"\\] ip=127\\.0\\.0\\.1`));
  const idList = await new Promise((res, rej) => execFile(process.execPath, [join(ROOT, 'tools/debug.js'), '--port', String(srv.adminPort), 'logs'],
    (e, so) => (e ? rej(e) : res(so))));
  assert.ok(idList.includes(word) && idList.includes('name="Ash"'), 'tools/debug.js logs lists the identity');
  log(`streamed log for ${word} readable through tools/debug.js log`);
  log('tick time: ' + st.split('\n')[0]);

  for (const p of all) await p.page.context().close();
  await srv.stop();
}

async function predictionTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir, NET_SIM: '120,2' }); servers.push(srv);
  const P = await openPlayer(srv, 'Walker', 4);
  const Q = await openPlayer(srv, 'Other', 5, { room: P.room });       // a second player, so there is a remote to interpolate
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
  const H = await openPlayer(srv, 'Hold', 3), O = await openPlayer(srv, 'Opp', 6, { room: H.room });
  // a third page that only watches the room from the lobby (viewers of a room get the same snapshots and events)
  const W = await openViewer(srv, 'Watch', H.room);
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
    // (the opponent may pick up the second sword these fast pickups put down: its reach must match its own flag)
    assert.ok(Math.abs(o.reach - 18 * (o.long ? 1.6 : 1)) < 1e-9, `${p.name} draws Opp's reach for long=${o.long} (${o.reach})`);
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
  const st = await debugCli(srv, 'state');
  assert.match(st, /^ +long-sword pickups \(\d\): #\d+ at/m);
  log('tools/debug.js state: ' + st.split('\n').find(l => l.trim().startsWith('long-sword')).trim());
  for (const p of all) await p.page.context().close();
  await srv.stop();
}

// Escape opens a confirm menu; Stay keeps playing, Leave frees the slot and returns to the lobby.
async function leaveTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  // Stay creates the room and is its admin (the admin cannot leave while another human is there)
  const B = await openPlayer(srv, 'Stay', 5), A = await openPlayer(srv, 'Quit', 2, { room: B.room });
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
  await waitFor(() => A.page.evaluate(r => __mp.net.lobby.room === r && !document.getElementById('scrRoom').classList.contains('hidden'), B.room), { what: 'the leaver lands on the room\'s screen' });
  await waitFor(async () => { const v = await ui(B); return v.ids.length === 1 && v.ids[0] === B.id; }, { what: 'the leaver vanishes for the other player' });
  await waitFor(async () => (await ui(A)).ids.length === 1, { what: 'the lobby view still follows the arena' });
  await A.page.keyboard.press('Escape');
  assert.ok(!(await ui(A)).menu, 'Escape does nothing in the lobby');
  await A.page.click('#lFight');                    // and the leaver can join again on the same connection
  await waitFor(async () => { const v = await ui(A); return !v.lobby && v.id != null && v.id !== A.id; }, { what: 'rejoin after leaving' });
  log('escape menu: stay keeps the slot, leave frees it and returns to the lobby (still looking at the room), rejoin works');
  for (const p of [A, B]) await p.page.context().close();
  await srv.stop();
}

// Chat (SPEC §9): A presses C, types, presses Enter; every page (a lobby viewer too) shows the line and
// the speaker's bubble; typing "hfmx" into the box toggles nothing and throws nothing; Escape cancels
// without opening the leave menu; a few seconds later the line is gone.
async function chatTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPlayer(srv, 'Talker', 3), B = await openPlayer(srv, 'Listen', 6, { room: A.room });
  const V = await openViewer(srv, 'Viewer', A.room);      // looks at the room from its lobby
  await V.page.waitForFunction(() => __mp.lobbyOpen);
  const ui = p => p.page.evaluate(() => ({ chat: __mp.chat, help: __mp.helpOpen, leave: __mp.leaveOpen, mute: document.getElementById('muteBtn').classList.contains('on'),
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
  const T = await openPlayer(srv, 'Thrower', 4), V = await openPlayer(srv, 'Target', 0, { room: T.room });
  const W = await openViewer(srv, 'Watch', T.room);
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
    return u.me === pick.stars && u.hud === `★ ${pick.stars}` ? u : null;   // the count the pickup gave (5, 10 or 15)
  }, { timeout: 3000, what: 'the star count after the pickup' });
  assert.ok([5, 10, 15].includes(pick.gain) && pick.stars === pick.gain, `a first pickup gives a whole bundle: ${pick.gain}`);
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
  // (up to 8 presses: with bundles of 5-15 and a carry of 30 the thrower may hold many, and may pick
  // more up mid-burst, so compare the swishes with the throws the server made, counted from t0)
  const held = await T.page.evaluate(() => {
    const n = Math.min(8, __mp.net.me.stars), s = window.__burst = { t: 0, left: n, t0: performance.now(), tick0: __mp.state.tick };
    __mp.autopilot = () => (++s.t % 7 === 0 && s.left > 0 ? (s.left--, 32) : 0);
    return n;
  });
  await waitFor(() => T.page.evaluate(() => window.__burst.left === 0), { timeout: 5000, every: 100, what: 'the burst is pressed' });
  await new Promise(r => setTimeout(r, 600));
  await stopBot(T.page);
  const burst = await T.page.evaluate(id => ({
    swishes: __mp.debug.entries().filter(e => e.msg === 'throw swish' && e.ts >= window.__burst.t0).length,
    throws: __mp.events.filter(e => e.type === 'throw' && e.id === id && e.tick >= window.__burst.tick0).length }), T.id);
  assert.equal(burst.throws, held, `the server made all ${held} quick throws (${burst.throws})`);
  assert.equal(burst.swishes, held, `a swish for each of ${held} quick throws (heard ${burst.swishes})`);
  log(`stars: rapid fire of ${held}, ${burst.swishes} swishes, ${burst.throws} throws`);
  // admin state and the CLI list star pickups, stars in flight and counts
  const st = await debugCli(srv, 'state');
  assert.match(st, /star pickups \(\d\)/); assert.match(st, /stars in flight \(\d\)/); assert.match(st, /stars=\d/);
  for (const c of [T.page.context(), V.page.context(), W.page.context()]) await c.close();
  await srv.stop();
}

// Heartbeat (SPEC §6.4): pinging pages (a lobby viewer and an idle player) stay connected; a page
// frozen for a while (like a background tab whose timers stop: `net.freeze`) is closed by the
// server after 5 s with the timeout code, then reconnects and resumes if it wakes within the grace
// period, and otherwise lands in the lobby with a message.
async function heartbeatTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const B = await openPlayer(srv, 'Bee', 4), A = await openPlayer(srv, 'Afk', 3, { room: B.room });   // Bee is the admin; Afk is the one frozen
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
  // (reconnects counts the socket opening; the welcome that confirms the resume comes a moment later)
  await waitFor(async () => { const v = await net(A.page); return v.state === 'open' && v.mode === 'play' && v.reconnects === 1 && v.msgs.includes('resume accepted'); },
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
// leave menu. The score strip stops short of the button. (The game is in a room its page creates.)
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
  // F while typing a room name does nothing
  await page.click('#lRoomName'); await page.keyboard.press('KeyF');
  assert.deepEqual((await fs()).calls, [], 'F in the room name field types');
  await page.fill('#lRoomName', '');
  // the button toggles, and its state follows
  await page.click('#fsBtn');
  await waitFor(async () => (await fs()).on, { what: 'full screen on' });
  f = await fs();
  assert.deepEqual(f.calls, ['request']); assert.equal(f.pressed, 'true');
  await page.click('#fsBtn');
  await waitFor(async () => !(await fs()).on, { what: 'full screen off' });
  // join; in the game the button is still there and the strip stops short of it
  await createRoom({ page }, 'Full', 0);
  await page.click('#lFight');
  await page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive && !__mp.lobbyOpen);
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
    // the room list: CREATE on screen; tap it (not clicks), then on the room's screen type a name, tap FIGHT
    const cr = await centre('lCreate');
    assert.ok(cr.t >= 0 && cr.b <= v.h && cr.l >= 0 && cr.r <= v.w, `${v.name}: CREATE is on screen`);
    await page.tap('#lCreate');                    // a room of its own: its screen opens, with FIGHT
    await page.waitForFunction(() => __mp.net.lobby.mine && __mp.net.lobby.room && !document.getElementById('scrRoom').classList.contains('hidden'), null, { timeout: 10000 });
    await page.tap('#lName'); await page.keyboard.type('Phone');
    const f = await centre('lFight');
    assert.ok(f.t >= 0 && f.b <= v.h, `${v.name}: FIGHT is on screen`);
    assert.ok(await page.evaluate(() => document.getElementById('lobby').scrollTop === 0), `${v.name}: no scrolling needed`);
    await page.touchscreen.tap(f.x, f.y);
    await page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive, null, { timeout: 10000 });
    await sleep(400);
    assert.equal(await page.evaluate(() => document.body.classList.contains('touchui')), true, `${v.name}: touch UI is on`);
    // every button is on screen, at least 44 px each way (hit area), and none overlap
    const ids = ['tL', 'tR', 'tRun', 'tT', 'tS', 'tJ', 'tHelp', 'tLeave'];
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
    await page.evaluate(() => __mp.net.leave());   // the admin alone: the room closes at once (2 rooms per address at most)
    await ctx.close();
    await noRooms(srv);
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
  // pretend this page came from an older build with the same rules (SPEC §18: only the UI changed),
  // then reconnect as after a deploy: it is on the room list, so it reloads itself quietly
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

// Restarts without losing games (SPEC §18): two pages fight in a room; the server process is stopped
// (SIGTERM: it saves the rooms to STATE_FILE) and started again on the same port and file. Same rules:
// both pages show the "SERVER UPDATING…" overlay meanwhile, then resume in place (no reload) with the same ids and
// scores and play on. Then a restart under other rules (RULES_HASH, tests only): the new server starts
// empty, both games stop with the update message, and OK reloads into the lobby of the new version.
async function restartTest() {
  const dir = tempDir(); dirs.push(dir);
  const file = join(dir, 'state', 'rooms.json');
  let srv = await startServer({ DEBUG_DIR: dir, STATE_FILE: file }); servers.push(srv);
  const A = await openPlayer(srv, 'Rex', 0, { create: 'Restart' }), B = await openPlayer(srv, 'Ria', 1, { room: A.room });
  const both = [A, B];
  for (const p of both) await p.page.evaluate(() => { window.__marker = 1; });
  await installBot(A.page, { mode: 'fight', target: B.id });
  await installBot(B.page, { mode: 'fight', target: A.id });
  await waitFor(() => A.page.evaluate(() => __mp.events.some(e => e.type === 'kill')), { timeout: 30000, what: 'a kill before the restart' });
  await stopBot(A.page); await stopBot(B.page);
  const scores = p => p.page.evaluate(ids => ids.map(id => { const m = __mp.net.meta.get(id) || {}; return [m.score, m.deaths]; }), [A.id, B.id]);
  await sleep(500);
  const before = await scores(A);
  assert.deepEqual(await scores(B), before);
  assert.ok(before.some(([s]) => s > 0), 'somebody scored');
  await srv.stop();
  for (const p of both) await waitFor(() => p.page.evaluate(() => __mp.net.restarting() && document.getElementById('rov').className === 'up'), { what: `${p.name}: "server updating"` });
  srv = await startServer({ DEBUG_DIR: dir, STATE_FILE: file, PORT: srv.port, DEBUG_PORT: srv.adminPort }); servers.push(srv);
  assert.ok(srv.logs.some(l => /^restore: 1 room/.test(l)), 'the room was restored: ' + srv.logs.join(' | '));
  for (const p of both) await waitFor(() => p.page.evaluate(id => __mp.net.state === 'open' && __mp.net.mode === 'play' && __mp.net.id === id && !!__mp.net.me && !__mp.lobbyOpen, p.id), { timeout: 15000, what: `${p.name} resumed` });
  for (const p of both) {
    assert.equal(await p.page.evaluate(() => window.__marker), 1, `${p.name} did not reload`);
    assert.deepEqual(await scores(p), before, `${p.name}: the same scores`);
  }
  // they play on: the server's ticks come in, and a fight goes on to another kill
  const k0 = await A.page.evaluate(() => __mp.events.filter(e => e.type === 'kill').length);
  await installBot(A.page, { mode: 'fight', target: B.id });
  await installBot(B.page, { mode: 'fight', target: A.id });
  await waitFor(() => A.page.evaluate(k0 => __mp.events.filter(e => e.type === 'kill').length > k0, k0), { timeout: 30000, what: 'a kill after the restart' });
  await stopBot(A.page); await stopBot(B.page);
  log('restart, same rules: both pages resumed in place with their scores and fought on');

  await srv.stop();
  srv = await startServer({ DEBUG_DIR: dir, STATE_FILE: file, PORT: srv.port, DEBUG_PORT: srv.adminPort, RULES_HASH: 'otherrules' }); servers.push(srv);
  assert.ok(srv.logs.some(l => /^restore: none \(rules hash/.test(l)), srv.logs.join(' | '));
  for (const p of both) await waitFor(() => p.page.evaluate(() => !document.getElementById('upd').classList.contains('hidden')), { timeout: 15000, what: `${p.name}: the update message` });
  for (const p of both) {
    assert.match(await p.page.textContent('#updText'), /updated.*can't continue on your version/);
    assert.equal(await p.page.evaluate(() => __mp.net.state), 'outdated');
    assert.equal(await p.page.evaluate(() => window.__marker), 1, `${p.name} waits for OK`);
  }
  await A.page.click('#updOk');
  await A.page.waitForFunction(() => !window.__marker && window.__mp && __mp.net && __mp.net.state === 'open' && __mp.lobbyOpen, null, { timeout: 10000 });
  assert.equal(await A.page.evaluate(() => document.querySelector('meta[name="rules"]').content), 'otherrules');
  await B.page.keyboard.press('Enter');                // Enter is OK too
  await B.page.waitForFunction(() => !window.__marker && window.__mp && __mp.net && __mp.net.state === 'open', null, { timeout: 10000 });
  log('restart, other rules: both games stopped with the update message; OK reloaded into the new version');
  for (const p of both) await p.page.context().close();
  await srv.stop();
}

// AI players (SPEC §15, §17): the admin's − / + change the count live for everyone looking at the room;
// the other page sees the buttons hidden and disabled (no row at all while 0), and a forced bots
// message from it is refused without a kick; bots fight in the room wearing the reserved colour, which
// is not among the swatches; + stops at 7 (8 slots once the admin fights); a human arriving at the full
// room is queued and gets the slot when − (in the admin's Esc menu) frees one, and − removes the newest bot.
async function botTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const V = await openPage(srv, 'V');
  const room = await createRoom(V, 'Boss', 0);           // V is the (pending) admin, on its room's screen
  const W = await openViewer(srv, 'W', room);            // a plain lobby viewer of the room
  const ui = p => p.page.evaluate(() => ({ n: document.getElementById('lBotN').textContent,
    dec: document.getElementById('lBotDec').disabled, inc: document.getElementById('lBotInc').disabled,
    hid: ['lBotDec', 'lBotInc'].map(id => document.getElementById(id).classList.contains('hidden2') && getComputedStyle(document.getElementById(id)).display === 'none'),
    ro: document.getElementById('lBotRO').textContent, err: document.getElementById('lErr').textContent,
    row: !document.getElementById('lBots').classList.contains('hidden2'),
    bots: (__mp.net.lobby.players || []).filter(q => q.bot), botMax: __mp.net.lobby.botMax, swatches: document.querySelectorAll('#lColors .sw').length,
    inArena: __mp.state.players.map(q => q.id) }));
  const both = (n, what) => waitFor(async () => (await ui(V)).n === String(n) && (await ui(W)).n === String(n), { what });
  await both(0, 'count 0 on both pages');
  let u = await ui(V);
  assert.ok(u.dec && !u.inc && !u.hid[0] && !u.hid[1] && u.ro === '', 'the admin has − (nothing to remove) and + shown');
  u = await ui(W);
  assert.ok(u.dec && u.inc && u.hid[0] && u.hid[1], '− / + are hidden and disabled for the other page');
  assert.ok(!u.row, 'no AI row at all for the other page while there are none');
  assert.equal(u.botMax, 7, 'at most 7 AI players (8 slots)');
  // a forced bots message from the non-admin is refused (no kick), nothing changes
  await W.page.evaluate(() => __mp.net.bots(1));
  await waitFor(async () => /admin/.test((await ui(W)).err), { what: 'the refusal text on the non-admin' });
  await sleep(400);
  assert.equal((await ui(V)).n, '0'); assert.equal(await W.page.evaluate(() => __mp.net.state), 'open', 'no kick');
  await V.page.click('#lBotInc'); await V.page.click('#lBotInc');
  await both(2, '+ + shows 2 on both pages');
  await V.page.click('#lBotDec');
  await both(1, '− shows 1 on both');
  await V.page.click('#lBotInc');
  await both(2, 'back to 2');
  // the bots are in the room, in the reserved colour, named AI n, and that colour is not a swatch
  const hex = await V.page.evaluate(async () => (await import('/shared/constants.js')).BOT.hex);
  await waitFor(async () => { const u = await ui(W); return u.bots.length === 2 && u.bots.every(b => u.inArena.includes(b.id)); }, { what: 'bots in the room' });
  u = await ui(W);
  assert.ok(u.row && u.hid[0], 'the other page sees the count read-only');
  assert.equal(u.swatches, 12, 'twelve human swatches, none for bots');
  for (const b of u.bots) { assert.equal(b.color, 12); assert.match(b.name, /^AI \d+$/); }
  const dot = await W.page.evaluate(() => [...document.querySelectorAll('#lPlayers li')].map(li => [li.querySelector('.nm').textContent, getComputedStyle(li.querySelector('.dot')).backgroundColor]).filter(([n]) => n.startsWith('AI')));
  const rgb = `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  assert.ok(dot.length === 2 && dot.every(([, c]) => c === rgb), `bot dots ${JSON.stringify(dot)} in ${rgb}`);
  // up to 7 (rate-limited: a short pause between presses)
  for (let i = 0; i < 8; i++) { if (!(await ui(V)).inc) await V.page.click('#lBotInc'); await sleep(300); }
  await both(7, 'seven bots at most');
  assert.ok((await ui(V)).inc, '+ disabled at the limit');
  await waitFor(async () => (await ui(V)).inArena.length === 7, { what: '7 bots in the room (the pending admin takes no slot)' });
  // the admin presses FIGHT (8 in the room, still admin); a human is queued, and takes the slot freed by −
  // from the admin's Esc menu
  await V.page.click('#lFight');
  await V.page.waitForFunction(() => __mp.net.mode === 'play' && !__mp.lobbyOpen && __mp.net.isAdmin(), null, { timeout: 10000 });
  await waitFor(async () => (await ui(V)).inArena.length === 8, { what: '8 in the room' });
  await W.page.fill('#lName', 'Human');
  await W.page.click('#lFight');
  await W.page.waitForFunction(() => __mp.net.mode === 'queue', null, { timeout: 10000 });
  await V.page.keyboard.press('Escape');
  await waitFor(() => V.page.evaluate(() => __mp.leaveOpen && !document.getElementById('lvBotDec').disabled), { what: 'the Esc menu with −' });
  await V.page.click('#lvBotDec');
  await waitFor(async () => (await ui(V)).n === '6', { what: '− removes one' });
  await W.page.waitForFunction(() => __mp.net.mode === 'play' && __mp.net.me && __mp.net.me.alive, null, { timeout: 10000 });
  // (read on V, which got the lobby at once; other pages get it with the next coalesced broadcast)
  assert.ok(!(await V.page.evaluate(() => __mp.net.lobby.players.some(q => q.name === 'AI 7'))), 'the newest bot went first');
  log('bots: − / + admin-only and live on both pages, refused without a kick for others, reserved colour, at most 7, a queued human gets the freed slot');
  for (const p of [V, W]) await p.page.context().close();
  await srv.stop();
}

// Names (SPEC §9): two "Sean"s in one room; when the first leaves, the second becomes "Sean" for itself
// and others. De-duplication is per room: a "Sean" in another room is not "Sean#2".
async function renameTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  // Other is the admin (so Sean, who leaves, is not); the Seans join in order
  const C = await openPlayer(srv, 'Other', 7), A = await openPlayer(srv, 'Sean', 1, { room: C.room }), B = await openPlayer(srv, 'Sean', 4, { room: C.room });
  const D = await openPlayer(srv, 'Sean', 5);            // creates a room of its own
  const nameIn = (p, id) => p.page.evaluate(id => (__mp.net.meta.get(id) || {}).name, id);
  assert.equal(await nameIn(C, B.id), 'Sean#2');
  assert.equal(await nameIn(D, D.id), 'Sean', 'names are de-duplicated per room');
  await A.page.keyboard.press('Escape');
  await A.page.click('#lvYes');
  await waitFor(async () => await nameIn(B, B.id) === 'Sean' && await nameIn(C, B.id) === 'Sean', { what: 'Sean#2 renamed to Sean everywhere' });
  await waitFor(async () => (await A.page.evaluate(id => (__mp.net.lobby.players.find(p => p.id === id) || {}).name, B.id)) === 'Sean', { what: 'the lobby list shows the new name' });
  log('names: a freed name passes to its #2 holder for everyone, per room');
  for (const p of [A, B, C, D]) await p.page.context().close();
  await srv.stop();
}

// Spectator mode (SPEC §16, §17): with the room full (the admin + 7 bots) and someone queued, Watch on a
// fresh page that selected the room closes the lobby without taking a slot or a queue place, follows
// the leader, follows the ninja clicked on screen, ← → switch, Esc goes back to the lobby, and Fight
// from there still queues.
async function watchTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const H = await openPlayer(srv, 'Host', 0);
  for (let i = 0; i < 7; i++) {   // fill the room with bots (rate-limited: a short pause between presses)
    await H.page.evaluate(() => __mp.net.bots(1)); await sleep(300);
  }
  await waitFor(() => H.page.evaluate(() => __mp.state.players.length === 8), { what: 'a full room' });
  const Q = await openPage(srv, 'Q');
  await selectRoom(Q, H.room); await Q.page.fill('#lName', 'Queued'); await Q.page.click('#lFight');
  await Q.page.waitForFunction(() => __mp.net.mode === 'queue');
  const W = await openPage(srv, 'W');
  const st = () => W.page.evaluate(() => ({ lobby: __mp.lobbyOpen, w: __mp.watching, mode: __mp.net.mode, id: __mp.net.id,
    players: __mp.net.lobby.players.length, queue: __mp.net.lobby.queue.length, ids: __mp.state.players.map(p => p.id),
    bar: document.getElementById('watch').classList.contains('hidden') ? null : document.getElementById('watch').textContent }));
  assert.ok(await W.page.isHidden('#lWatch'), 'no Watch on the room list');
  await selectRoom(W, H.room);
  assert.ok(!(await W.page.isDisabled('#lWatch')), 'Watch is open to a lobby viewer of a full room with a queue');
  await W.page.click('#lWatch');
  await waitFor(async () => (await st()).w.id != null, { what: 'watching follows someone' });
  let s = await st();
  assert.equal(s.lobby, false); assert.equal(s.w.on, true); assert.equal(s.mode, 'viewer'); assert.equal(s.id, null);
  assert.equal(s.players, 8); assert.equal(s.queue, 1, 'the watcher took no slot and no queue place');
  assert.equal(s.w.chosen, null, 'the default is the leader');
  assert.match(s.bar, /WATCHING/); assert.match(s.bar, /Click a ninja to follow them/); assert.match(s.bar, /\(the leader\)/);
  // click a living ninja on screen (not the one followed now) and the camera follows it
  let picked = null;
  await waitFor(async () => {
    const c = await W.page.evaluate(() => {
      const r = document.getElementById('c').getBoundingClientRect(), cur = __mp.watching.id;
      for (const p of __mp.state.players) {
        const q = __mp.screenOf(p.id);
        if (p.alive && p.id !== cur && Math.abs(p.vx) < 2 && q.x > r.left + 20 && q.x < r.right - 20 && q.y > r.top + 60 && q.y < r.bottom - 20) return { id: p.id, ...q };
      }
      return null;
    });
    if (!c) return false;
    await W.page.mouse.click(c.x, c.y);
    if ((await st()).w.chosen === c.id) { picked = c.id; return true; }
    return false;
  }, { timeout: 15000, what: 'a click picks a ninja' });
  await sleep(1500);
  const onScreen = await W.page.evaluate(id => {
    const r = document.getElementById('c').getBoundingClientRect(), q = __mp.screenOf(id);
    return { w: __mp.watching, in: q.x >= r.left && q.x <= r.right && q.y >= r.top && q.y <= r.bottom };
  }, picked);
  assert.equal(onScreen.w.id, picked, 'still following the clicked ninja (through death and respawn too)');
  assert.ok(onScreen.in, 'the camera keeps it on screen');
  assert.ok(!(await st()).bar.includes('(the leader)'));
  // ← → walk through the others; ↓ goes back to the leader
  await W.page.keyboard.press('ArrowRight');
  s = await st(); assert.ok(s.w.chosen != null && s.w.chosen !== picked, '→ switches to another ninja');
  await W.page.keyboard.press('ArrowDown');
  s = await st(); assert.equal(s.w.chosen, null, '↓ back to the leader');
  // input from the watching page reaches nobody: still a viewer with no player
  assert.equal(s.mode, 'viewer'); assert.equal(s.players, 8);
  // Esc: back to the room's screen, and Fight from there still queues
  await W.page.keyboard.press('Escape');
  await waitFor(async () => (await st()).lobby, { what: 'Esc returns to the lobby' });
  s = await st(); assert.equal(s.w.on, false); assert.equal(s.bar, null);
  assert.ok(await W.page.isVisible('#lobby'));
  await W.page.fill('#lName', 'Watcher'); await W.page.click('#lFight');
  await W.page.waitForFunction(() => __mp.net.mode === 'queue' && __mp.net.queuePos === 2, null, { timeout: 5000 });
  log('watch: no slot with a full room and a queue, leader by default, click follows, ← → ↓, Esc to the lobby, Fight still queues');
  for (const p of [H, Q, W]) await p.page.context().close();
  await srv.stop();
}

// ---------- rooms (SPEC §17) ----------
const listOf = p => p.page.evaluate(() => [...document.querySelectorAll('#lRoomList button')].map(b => ({ id: +b.dataset.room, text: b.textContent })));
const onScreen = (p, scr) => p.page.evaluate(id => !document.getElementById(id).classList.contains('hidden'), scr);
const rosterOf = p => p.page.evaluate(() => [...document.querySelectorAll('#lPlayers li')].map(li => ({ name: li.querySelector('.nm').firstChild.textContent, admin: !!li.querySelector('.adm'), mk: !!li.querySelector('button.mkadm') })));

// Create, list, join, isolation: the empty list says so; a created room shows up on another page with
// its name, its admin and 1/8; tapping it opens its screen and ← Rooms goes back; a second page joins
// it (tap + FIGHT) and both see each other; a page in another room never gets this room's players in
// its snapshots.
async function roomsTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const E = await openPage(srv, 'E');
  await waitFor(() => E.page.evaluate(() => document.querySelector('#lRoomList li.empty') && document.querySelector('#lRoomList li.empty').textContent === 'No rooms yet — create one below.'), { what: 'the empty-state text' });
  assert.ok(await onScreen(E, 'scrRooms') && !(await onScreen(E, 'scrRoom')), 'the room list, no room screen');
  assert.ok(await E.page.isHidden('#lName') && await E.page.isHidden('#lFight'), 'no name or FIGHT on the room list');
  const A = await openPlayer(srv, 'Ann', 0, { create: 'Lair' });
  await waitFor(async () => (await listOf(E)).some(r => r.id === A.room), { what: 'the new room in the other page\'s list' });
  let r = (await listOf(E)).find(r => r.id === A.room);
  assert.equal(r.text, 'Lair★ Ann1/8', 'name, admin and 1/8: ' + r.text);
  await selectRoom(E, A.room);
  assert.ok(await onScreen(E, 'scrRoom') && !(await onScreen(E, 'scrRooms')), 'tapping a room opens its screen');
  assert.equal(await E.page.textContent('#lRoomTitle'), 'Lair');
  await E.page.click('#lBack');
  await E.page.waitForFunction(() => __mp.net.lobby.room === null && !document.getElementById('scrRooms').classList.contains('hidden'));
  await selectRoom(E, A.room);
  assert.deepEqual(await rosterOf(E), [{ name: 'Ann', admin: true, mk: false }]);
  const B = await openPlayer(srv, 'Bob', 1, { room: A.room });
  for (const p of [A, B]) await waitFor(async () => (await rosterOf(p)).length === 2, { what: `both in the roster on ${p.name}` });
  assert.deepEqual((await rosterOf(E)).map(x => x.name).sort(), ['Ann', 'Bob']);
  assert.ok((await listOf(E)).find(r => r.id === A.room).text.includes('2/8'));
  // a third page creates another room (2 per address are allowed): its snapshots hold only its own player
  const C = await openPlayer(srv, 'Cat', 2, { create: 'Elsewhere' });
  assert.notEqual(C.room, A.room);
  await waitFor(() => A.page.evaluate(() => __mp.state.players.length === 2), { what: 'two players in Lair' });
  await sleep(600);
  const seen = p => p.page.evaluate(() => ({ ids: __mp.state.players.map(q => q.id), room: __mp.net.lobby.room, names: __mp.net.lobby.players.map(q => q.name) }));
  let s = await seen(C);
  assert.deepEqual(s.ids, [C.id], 'Elsewhere sees only itself');
  assert.deepEqual(s.names, ['Cat']);
  s = await seen(A);
  assert.deepEqual(s.ids.sort(), [A.id, B.id].sort(), 'Lair sees Ann and Bob only');
  assert.ok(!s.ids.includes(C.id));
  await waitFor(async () => (await listOf(E)).length === 2, { what: 'two rooms in the list' });
  log('rooms: empty state, created room listed with name/admin/1 of 8, a joiner in its roster, other rooms isolated');
  for (const p of [E, A, B, C]) await p.page.context().close();
  await srv.stop();
}

// Admin transfer: "Make admin" only next to other humans (not self, not a bot), the confirm dialog
// (right text, Cancel focused, Cancel and Esc do nothing, Confirm transfers); the new admin gets the
// buttons and the enabled AI controls, the old one loses them. The creator here is a pending admin
// (created, not fighting): ← Rooms is refused while Bob is in the room. Then the Esc menu: Leave is
// blocked for the admin with another human present, the transfer works from the menu, the old admin
// leaves; the sole admin leaves the fight onto the room's screen (still admin) and makes Bob, who is
// watching (a lobby visitor of the room), the admin from "In the lobby": he becomes its pending admin,
// FIGHT keeps it, and his going back to the list with nobody else looking closes the room.
async function adminTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPage(srv, 'A');
  A.room = await createRoom(A, 'Ann', 0, 'Keep');        // pending admin, on the room's screen
  const B = await openPlayer(srv, 'Bob', 1, { room: A.room });
  await A.page.click('#lBotInc');
  await waitFor(() => A.page.evaluate(() => __mp.net.lobby.bots === 1), { what: 'one bot' });
  await waitFor(async () => (await rosterOf(A)).length === 2, { what: 'two rows (Bob and the bot; Ann is not fighting)' });
  const rows = await rosterOf(A);
  assert.deepEqual(rows.filter(x => x.mk).map(x => x.name), ['Bob'], 'Make admin next to the joiner only: ' + JSON.stringify(rows));
  assert.ok(!rows.find(x => x.name === 'Bob').admin);
  // the pending admin cannot go back to the list while Bob is in the room
  await A.page.click('#lBack');
  await waitFor(() => A.page.evaluate(() => /Make someone admin first/.test(document.getElementById('lErr').textContent)), { what: 'the hand-over notice' });
  await sleep(300);
  assert.equal(await A.page.evaluate(() => __mp.net.lobby.room), A.room, 'still on the room');
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#lPlayers button.mkadm').length), 0, 'no buttons for a non-admin');
  const adminOf = p => p.page.evaluate(() => __mp.net.lobby.admin);
  const dlg = p => p.page.evaluate(() => ({ open: !document.getElementById('adm').classList.contains('hidden'), text: document.getElementById('admText').textContent,
    focus: document.activeElement && document.activeElement.id, target: __mp.admDialog }));
  const ask = async (p, sel = '#lPlayers button.mkadm') => { await p.page.click(sel); await waitFor(async () => (await dlg(p)).open, { what: 'the confirm dialog' }); };
  await ask(A);
  let d = await dlg(A);
  assert.equal(d.text, 'Make Bob the admin of Keep? You will lose admin.');
  assert.equal(d.focus, 'admNo', 'Cancel has the focus'); assert.deepEqual(d.target, { id: B.id, name: 'Bob' });
  await A.page.click('#admNo');
  assert.ok(!(await dlg(A)).open && (await dlg(A)).target === null);
  await ask(A);
  await A.page.keyboard.press('Escape');
  assert.ok(!(await dlg(A)).open, 'Esc closes the dialog');
  await sleep(700);
  assert.equal(await adminOf(A), null); assert.equal(await adminOf(B), null, 'nothing changed after Cancel and Esc (Ann is admin, pending)');
  assert.ok(await A.page.evaluate(() => __mp.net.isAdmin()));
  await ask(A);
  await A.page.click('#admYes');
  await waitFor(async () => (await adminOf(A)) === B.id && (await adminOf(B)) === B.id, { what: 'admin moved to Bob on both pages' });
  // the new admin has the buttons and the AI controls, the old one has neither
  const ctl = p => p.page.evaluate(() => ({ mk: [...document.querySelectorAll('#lPlayers button.mkadm')].map(b => b.dataset.name),
    hid: ['lBotDec', 'lBotInc'].map(id => document.getElementById(id).classList.contains('hidden2')),
    dis: ['lBotDec', 'lBotInc'].map(id => document.getElementById(id).disabled), rename: !document.getElementById('lRenameRow').classList.contains('hidden2') }));
  // (Ann never pressed FIGHT, so she has no player record and is not in the roster: Bob has nobody to
  // hand admin to yet; the Esc-menu check below has her fight first)
  await waitFor(async () => (await ctl(B)).rename, { what: 'the admin controls on the new admin' });
  assert.deepEqual(await ctl(B), { mk: [], hid: [false, false], dis: [false, false], rename: true });
  await waitFor(async () => (await ctl(A)).mk.length === 0, { what: 'Make admin gone from the old admin' });
  assert.deepEqual(await ctl(A), { mk: [], hid: [true, true], dis: [true, true], rename: false });
  log('admin: Make admin beside humans only, the dialog (Cancel and Esc do nothing, Confirm transfers), controls follow the role');

  // --- Esc menu. Ann (not admin now) fights; Bob is the admin.
  await A.page.click('#lFight');
  await waitFor(() => A.page.evaluate(() => !__mp.lobbyOpen && __mp.net.id != null), { what: 'lobby closed' });
  const aId = await A.page.evaluate(() => __mp.net.id);
  await B.page.keyboard.press('Escape');
  const menu = p => p.page.evaluate(() => ({ open: __mp.leaveOpen, yes: document.getElementById('lvYes').disabled, yesText: document.getElementById('lvYes').textContent,
    note: document.getElementById('lvNote').textContent, mk: document.querySelectorAll('#lvPlayers button.mkadm').length }));
  // (Bob's page hears of Ann fighting with the next lobby broadcast, up to 0.5 s later: the open menu re-renders then)
  // Leave in the Esc menu is never blocked for the admin (it stays the admin, on the room's screen);
  // handing over is only needed to leave the room itself (the room screen's Leave button)
  await waitFor(async () => { const x = await menu(B); return x.open && !x.yes && x.mk === 1; }, { what: 'Esc menu with Leave open and a Make admin' });
  let m = await menu(B);
  assert.match(m.note, /You stay the admin/); assert.equal(m.yesText, 'Leave');
  await B.page.click('#lvPlayers button.mkadm');
  await waitFor(async () => (await dlg(B)).open, { what: 'confirm dialog from the Esc menu' });
  assert.equal((await dlg(B)).text, 'Make Ann the admin of Keep? You will lose admin.');
  await B.page.click('#admYes');
  await waitFor(async () => (await adminOf(B)) === aId && !/You stay the admin/.test((await menu(B)).note), { what: 'the menu after the transfer' });
  await B.page.click('#lvYes');
  await waitFor(() => B.page.evaluate(() => __mp.lobbyOpen && __mp.net.mode === 'viewer' && __mp.net.id == null), { what: 'Bob back in the lobby as a viewer' });
  // --- Ann is the only human and the admin: leaving the fight keeps her admin on the room's screen.
  // Bob watches the room meanwhile (a lobby visitor of it, listed "In the lobby" with 👁).
  await B.page.click('#lWatch');
  await waitFor(() => B.page.evaluate(() => __mp.watching.on), { what: 'Bob watching' });
  await A.page.keyboard.press('Escape');
  await waitFor(async () => (await menu(A)).open, { what: 'Ann\'s Esc menu' });
  await waitFor(async () => /You stay the admin/.test((await menu(A)).note), { what: 'the stay-admin note' });
  m = await menu(A);
  assert.ok(!m.yes); assert.equal(m.yesText, 'Leave');
  await waitFor(() => A.page.evaluate(() => document.querySelectorAll('#lvVisitors button.mkadm').length === 1), { what: 'Bob (watching) in the Esc menu\'s lobby list' });
  await A.page.click('#lvYes');
  await waitFor(() => A.page.evaluate(r => __mp.lobbyOpen && __mp.net.lobby.room === r && __mp.net.isAdmin() && __mp.net.id == null, A.room), { what: 'Ann on the room\'s screen, still admin' });
  assert.equal(await roomsOpen(srv), 1, 'the room stays open');
  // --- Make admin to a lobby visitor: Bob, watching, is listed "In the lobby" with a Make admin button
  const vis = p => p.page.evaluate(() => ({ shown: !document.getElementById('lVisBox').classList.contains('hidden'),
    rows: [...document.querySelectorAll('#lVisitors li')].map(li => ({ name: li.querySelector('.nm').firstChild.textContent, admin: !!li.querySelector('.adm'), mk: !!li.querySelector('button.mkadm') })) }));
  await waitFor(async () => (await vis(A)).rows.some(r => r.mk), { what: 'Bob in Ann\'s lobby list' });
  let vv = await vis(A);
  assert.ok(vv.shown);
  assert.deepEqual(vv.rows.filter(r => r.mk).map(r => r.name), ['👁 Bob'], 'Make admin next to Bob only: ' + JSON.stringify(vv.rows));
  assert.ok(vv.rows.some(r => r.name === 'Ann (you)' && r.admin && !r.mk), 'Ann listed as (you), ADMIN, no button');
  await ask(A, '#lVisitors button.mkadm');
  assert.equal((await dlg(A)).text, 'Make Bob the admin of Keep? You will lose admin.');
  const bConn = await B.page.evaluate(() => __mp.net.lobby.you);
  assert.deepEqual((await dlg(A)).target, { conn: bConn, name: 'Bob' });
  await A.page.click('#admYes');
  await waitFor(() => B.page.evaluate(() => __mp.net.isAdmin() && __mp.net.lobby.padmin === __mp.net.lobby.you), { what: 'Bob (watching) is the pending admin' });
  await waitFor(() => B.page.evaluate(() => /You are now the admin of Keep/.test(document.getElementById('toast').textContent)), { what: 'the new-admin notice' });
  await waitFor(() => A.page.evaluate(() => !__mp.net.isAdmin() && document.querySelectorAll('#lVisitors button.mkadm').length === 0), { what: 'Ann lost admin' });
  await A.page.click('#lBack');                          // Ann is not the admin: back to the list, the room stays
  await waitFor(() => A.page.evaluate(() => __mp.net.lobby.room === null), { what: 'Ann at the list' });
  assert.equal(await roomsOpen(srv), 1);
  // Bob stops watching (his room's screen, with the admin controls) and FIGHT keeps him admin
  await B.page.keyboard.press('Escape');
  await waitFor(() => B.page.evaluate(() => __mp.lobbyOpen && !__mp.watching.on && !document.getElementById('lRenameRow').classList.contains('hidden2')), { what: 'Bob on the room screen with the admin controls' });
  await B.page.click('#lFight');
  await waitFor(() => B.page.evaluate(() => __mp.net.id != null && __mp.net.lobby.admin === __mp.net.id && __mp.net.isAdmin()), { what: 'Bob fighting, still admin' });
  // the sole admin leaves the fight onto the room's screen; ← Rooms with nobody else looking closes it
  await B.page.keyboard.press('Escape');
  await waitFor(async () => (await menu(B)).open && !(await menu(B)).yes, { what: 'Bob\'s Esc menu' });
  await B.page.click('#lvYes');
  await waitFor(() => B.page.evaluate(() => __mp.lobbyOpen && __mp.net.isAdmin() && __mp.net.id == null), { what: 'Bob on the room screen, admin' });
  await B.page.click('#lBack');
  await waitFor(async () => (await roomsOpen(srv)) === 0, { what: 'the room closed' });
  await waitFor(async () => (await listOf(A)).length === 0, { what: 'the room is gone from the list' });
  log('admin: Esc menu Leave is open to the admin (transfer from the menu works), the sole admin leaves to the room screen, Make admin to a watching lobby visitor (pending admin, FIGHT keeps it), ← Rooms with nobody looking closes it');
  for (const p of [A, B]) await p.page.context().close();
  await srv.stop();
}

// Renames: the admin renames from the lobby field and from the Esc menu; the other pages' room title,
// the list and net.lobby.rname follow; the non-admin has no rename row.
async function renameRoomTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPage(srv, 'A');
  A.room = await createRoom(A, 'Ann', 0, 'Old');          // pending admin: renames before fighting
  const B = await openPlayer(srv, 'Bob', 1, { room: A.room });
  const V = await openViewer(srv, 'V', A.room);
  const seen = (p, name) => waitFor(() => p.page.evaluate(n => __mp.net.lobby.rname === n && document.getElementById('lRoomTitle').textContent === n &&
    [...document.querySelectorAll('#lRoomList button .rn')].some(e => e.textContent === n), name), { what: `room named ${name} on ${p.name}` });
  assert.ok(await B.page.evaluate(() => document.getElementById('lRenameRow').classList.contains('hidden2')), 'no rename row for a non-admin');
  await A.page.fill('#lRenameIn', 'New Name'); await A.page.click('#lRenameBtn');
  for (const p of [A, B, V]) await seen(p, 'New Name');
  assert.equal(await A.page.inputValue('#lRenameIn'), '', 'the field is cleared');
  // a second rename, then a bad name is refused with its rule and changes nothing; the Esc menu has
  // no rename (the user asked: renaming is a lobby thing)
  await A.page.fill('#lRenameIn', "Third's-Try"); await A.page.click('#lRenameBtn');
  for (const p of [A, B, V]) await seen(p, "Third's-Try");
  await A.page.fill('#lRenameIn', 'a<b>'); await A.page.click('#lRenameBtn');
  await sleep(300);
  assert.equal(await B.page.evaluate(() => __mp.net.lobby.rname), "Third's-Try");
  assert.equal(await A.page.evaluate(() => document.getElementById('lvRenameIn')), null, 'no rename in the Esc menu');
  log('rooms: renames from the lobby show on every page, list included; none in the Esc menu');
  for (const p of [A, B, V]) await p.page.context().close();
  await srv.stop();
}

// The 10-room limit. Rooms 1-8 come from raw WebSocket clients, each with its own X-Real-IP (the server
// trusts it here: at most 2 rooms per address), kept alive with pings; rooms 9 and 10 from two browser
// pages. A fresh page then has CREATE ROOM disabled with the explanation, a forced create gets the
// refusal, and when a room closes the button comes back.
async function limitTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir, TRUST_PROXY: '1' }); servers.push(srv);
  const raw = [];
  const rawRoom = (n) => new Promise((res, rej) => {
    const ws = new WebSocket(srv.wsUrl, { origin: srv.origin, headers: { 'X-Real-IP': `fd00::${n + 1}` } });
    const timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', id: 0, ct: 0 })); }, 500);
    ws.on('close', () => clearInterval(timer)); ws.on('error', rej);
    ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'lobby' && m.mine) res({ ws, room: m.room }); });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: `Raw${n}`, room: `Raw room ${n}` })));
  });
  try {
    for (let n = 0; n < 8; n++) raw.push(await rawRoom(n));
    const A = await openPlayer(srv, 'Ann', 0, { create: 'Nine' }), B = await openPlayer(srv, 'Bob', 1, { create: 'Ten' });
    assert.equal(await roomsOpen(srv), 10);
    const F = await openPage(srv, 'F');
    await waitFor(async () => (await listOf(F)).length === 10, { what: 'ten rooms in the list' });
    assert.ok(await F.page.isDisabled('#lCreate'), 'CREATE ROOM is disabled at 10 rooms');
    assert.match(await F.page.textContent('#lCreateNote'), /10 rooms are open, the most there can be/);
    await F.page.evaluate(() => __mp.createRoom());          // forced: the server still says no
    await waitFor(() => F.page.evaluate(() => /10 rooms are open/.test(document.getElementById('lErr').textContent)), { what: 'the refusal text' });
    assert.equal(await F.page.evaluate(() => __mp.net.mode), 'viewer'); assert.equal(await roomsOpen(srv), 10);
    // a raw (pending) admin alone looks away: its room closes at once and the button is back
    raw[0].ws.send(JSON.stringify({ t: 'view', room: 0 }));
    await waitFor(async () => !(await F.page.isDisabled('#lCreate')), { what: 'CREATE ROOM enabled again' });
    assert.equal(await F.page.textContent('#lCreateNote'), '');
    log('limit: 10 rooms (8 raw + 2 browser), CREATE ROOM disabled with its note, a forced create refused, back to enabled after one closes');
    for (const p of [A, B, F]) await p.page.context().close();
  } finally {
    for (const r of raw) r.ws.close();
    await srv.stop();
  }
}

// Room settings (SPEC §17.1): only the room's admin gets the D panel (no panel, no D hint for anyone
// else); the admin turning gore off switches it off on every page of that room and not in another
// room; a slider change reaches the others' prediction cfg; Reset to defaults; handing the admin role
// over closes the old admin's panel and gives the new one D.
async function roomSettingsTest() {
  const dir = tempDir(); dirs.push(dir);
  const srv = await startServer({ DEBUG_DIR: dir }); servers.push(srv);
  const A = await openPlayer(srv, 'Ann', 0, { create: 'Cfg' }), B = await openPlayer(srv, 'Bob', 1, { room: A.room });
  const O = await openPlayer(srv, 'Oz', 2, { create: 'Other' });
  const panelOpen = p => p.page.evaluate(() => !document.getElementById('dbg').classList.contains('hidden'));
  const hint = p => p.page.evaluate(() => getComputedStyle(document.getElementById('helpD')).display !== 'none');
  // a non-admin's D opens nothing, and it has no D hint
  await B.page.keyboard.press('KeyD'); await sleep(200);
  assert.equal(await panelOpen(B), false, 'no panel for a non-admin');
  assert.equal(await hint(B), false, 'no D hint for a non-admin');
  assert.equal(await hint(A), true, 'the admin has the D hint');
  // the admin opens it and turns gore off: every page in the room follows, the other room does not
  await A.page.keyboard.press('KeyD');
  await waitFor(() => panelOpen(A), { what: 'the admin\'s panel' });
  assert.match(await A.page.textContent('#dbg h2'), /Room settings/);
  for (const p of [A, B, O]) assert.equal(await p.page.evaluate(() => __mp.net.cfg.gore), true);
  await A.page.evaluate(() => {
    const lab = [...document.querySelectorAll('#dbg label.chk')].find(l => /^Gore/.test(l.textContent));
    lab.querySelector('input').click();
  });
  for (const p of [A, B]) await waitFor(() => p.page.evaluate(() => __mp.net.cfg.gore === false), { what: `gore off on ${p.name}` });
  await waitFor(() => B.page.evaluate(() => __mp.chat.lines.some(l => /Admin set gore off/.test(l))), { what: 'the quiet notice on Bob' });
  await sleep(300);
  assert.equal(await O.page.evaluate(() => __mp.net.cfg.gore), true, 'another room keeps gore on');
  // a slider (let go: sent on change) reaches Bob's prediction cfg
  await A.page.evaluate(() => {
    const lab = [...document.querySelectorAll('#dbg label:not(.chk)')].find(l => /^Gravity/.test(l.textContent));
    const r = lab.querySelector('input'); r.value = '0.4'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
  });
  await waitFor(() => B.page.evaluate(() => __mp.net.cfg.gravity === 0.4), { what: 'gravity 0.4 on Bob' });
  assert.equal(await O.page.evaluate(() => __mp.net.cfg.gravity), 0.27);
  // reset
  await A.page.evaluate(() => [...document.querySelectorAll('#dbg button')].find(b => b.textContent === 'Reset to defaults').click());
  await waitFor(() => B.page.evaluate(() => __mp.net.cfg.gore === true && __mp.net.cfg.gravity === 0.27), { what: 'defaults again on Bob' });
  // the role moves: the old admin's panel closes, the new admin gets D
  await A.page.evaluate(id => __mp.net.makeAdmin(id), B.id);
  await waitFor(async () => !(await panelOpen(A)), { what: 'the old admin\'s panel closed' });
  assert.equal(await hint(A), false);
  await A.page.keyboard.press('KeyD'); await sleep(200);
  assert.equal(await panelOpen(A), false, 'D does nothing for the old admin');
  await waitFor(() => hint(B), { what: 'the D hint for the new admin' });
  await B.page.keyboard.press('KeyD');
  await waitFor(() => panelOpen(B), { what: 'the new admin\'s panel' });
  log('room settings: admin-only panel, gore off on every page of the room only, slider and reset reach the others, hand-over closes the panel');
  for (const p of [A, B, O]) await p.page.context().close();
  await srv.stop();
}

async function main() {
  browser = await launchChromium();
  try {
    await fightTest();
    await predictionTest();
    await longSwordTest();
    await leaveTest();
    await renameTest();
    await chatTest();
    await starTest();
    await heartbeatTest();
    await fullscreenTest();
    await phoneTest();
    await staleBuildTest();
    await restartTest();
    await botTest();
    await watchTest();
    await roomsTest();
    await adminTest();
    await renameRoomTest();
    await roomSettingsTest();
    await limitTest();
    assert.deepEqual(errors, [], 'no page errors');
    log('PASS');
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) await s.stop();
    for (const d of dirs) removeDir(d);
  }
}

main().catch(e => { console.error('multiclient: FAIL:', e.message); if (errors.length) console.error(errors.slice(0, 10)); process.exitCode = 1; });
