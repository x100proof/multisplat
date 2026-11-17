// Restarts without losing games (SPEC §18): the rules-hash normalizer, the shape hash, save and
// restore on the socket-less arena (round trip, mismatches, a stale file, the file deleted after
// loading, a corrupted room dropped by the trial step, pending admins, the extended grace), the
// client's version check (public/net.js in Node over a fake socket), and a real server process
// stopped with SIGTERM and started again on the same state file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Arena } from '../server/arena.js';
import { normalizeJs, rulesHash, readTree, isRulesFile } from '../server/version.js';
import { computeShapeHash, sampleArena, sampleSave, shapeHashOf, snapshotArena, saveState, loadState, checkRoom, RESTORE_GRACE_MS, STATE_MAX_AGE_MS } from '../server/persist.js';
import * as Sim from '../shared/sim.js';
import { TICK_MS, KEY, NET } from '../shared/constants.js';
import { ROOT, tempDir, removeDir, startServer, sleep, waitFor } from './lib.js';

// ---------- the rules hash ----------
const files = (o) => Object.entries(o).map(([rel, text]) => ({ rel, buf: Buffer.from(text) })).sort((a, b) => (a.rel < b.rel ? -1 : 1));

test('normalizer: comments and whitespace do not count, code does, strings and regexes are kept whole', () => {
  const a = 'const a = 1; // one\nlet b = a + 2;\n';
  const same = ['const a = 1;\n\n\n  let b = a + 2;   ', '/* lead */ const a = 1; /** two\n lines */ let b = a + 2;\n// tail',
    'const  a  =  1;\t// x\n\t\tlet b = a + 2; /* y */'];
  for (const s of same) assert.equal(normalizeJs(s), normalizeJs(a), s);
  for (const s of ['const a = 2; let b = a + 2;', 'const a = 1;\nlet b = a - 2;', 'const a = 1; let b = a + 2;'])
    assert.notEqual(normalizeJs(s), normalizeJs(a), s);
  assert.notEqual(normalizeJs('return\nx'), normalizeJs('return x'), 'a line break is kept (ASI)');
  // "//" and "/*" inside strings, templates and regexes are not comments
  for (const s of ["const u = 'http://x/*y*/'; f(u)", 'const u = "a // b"; f(u)', 'const t = `a // ${ "x /* y" + `//${z}` } b`; f(t)',
    'const r = /\\/\\/[/*]/g; f(r)', 'if (x) y = a.replace(/\\/*$/, "") // c', 'return /"\'/.test(s)'])
    assert.ok(normalizeJs(s).includes(s.split(' // c')[0].replace(/^ +/, '')), s + ' → ' + normalizeJs(s));
  assert.notEqual(normalizeJs("f('a // b')"), normalizeJs("f('a // c')"), 'a change inside a string counts');
  assert.notEqual(normalizeJs('x = a / b / c; y = 1'), normalizeJs('x = a / b / c; y = 2'), 'divisions are not regexes');
  assert.equal(normalizeJs('x = a / b; // c / d'), 'x = a / b;');
});

test('rules hash: every served JS file normalizes to code that still parses, and normalizing is idempotent', () => {
  for (const f of readTree(ROOT, ['public', 'shared', 'server']).filter(f => f.rel.endsWith('.js'))) {
    const out = normalizeJs(f.buf.toString('utf8'));
    assert.equal(normalizeJs(out), out, f.rel);
    const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: out });
    assert.equal(r.status, 0, `${f.rel} normalized does not parse: ${r.stderr}`);
  }
});

test('rules hash: covers shared/ and public/net.js only, ignores their comments', () => {
  const base = { 'public/game.js': 'draw();', 'public/net.js': 'send(1); // proto', 'public/index.html': '<p>', 'shared/sim.js': 'step(); /* sim */' };
  const h = rulesHash(files(base));
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(rulesHash(files({ ...base, 'public/game.js': 'drawMore();' })), h, 'UI code is not in it');
  assert.equal(rulesHash(files({ ...base, 'public/index.html': '<div>' })), h);
  assert.equal(rulesHash(files({ ...base, 'shared/sim.js': '// new comment\nstep();' })), h, 'a comment is not a change');
  assert.notEqual(rulesHash(files({ ...base, 'shared/sim.js': 'step(2);' })), h);
  assert.notEqual(rulesHash(files({ ...base, 'public/net.js': 'send(2);' })), h);
  assert.notEqual(rulesHash(files({ ...base, 'shared/new.js': 'x();' })), h, 'a new shared file counts');
  assert.ok(isRulesFile('shared/level.js') && isRulesFile('public/net.js') && !isRulesFile('public/game.js') && !isRulesFile('server/room.js'));
});

test('rules hash: served in index.html and in every welcome', async () => {
  const { RULES, BUILD, makeHandler } = await import('../server/server.js');
  assert.match(RULES, /^[0-9a-f]{16}$/);
  const { createServer } = await import('node:http');
  const srv = createServer(makeHandler({ rules: 'abc' }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text();
    assert.ok(html.includes('<meta name="rules" content="abc">') && html.includes(`<meta name="build" content="${BUILD}">`));
  } finally { srv.close(); }
  const msgs = [];
  const arena = new Arena({ rules: 'r1', build: 'b1', heartbeatMs: 0 });
  arena.connect({ ip: 'x', send: s => msgs.push(JSON.parse(s)), close() {} });
  assert.equal(msgs[0].t, 'welcome'); assert.equal(msgs[0].r, 'r1'); assert.equal(msgs[0].b, 'b1');
});

// ---------- the shape hash ----------
test('shape hash: stable across runs and processes, changes with a record field', () => {
  const h = computeShapeHash();
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(computeShapeHash(), h);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { computeShapeHash } from ${JSON.stringify(new URL('../server/persist.js', import.meta.url).href)}; console.log(computeShapeHash())`]);
  assert.equal(String(r.stdout).trim(), h, 'another process computes the same');
  // the sample covers what a save must: both admin kinds, bot and brain, queue, settings, pickups, stars, drops, chat
  const s = sampleSave(), r1 = s.rooms[0];
  assert.ok(r1.$pending && !s.rooms[1].$pending && r1.$queue.length && r1.$bots.length && r1.cfg.gore === false);
  assert.ok(r1.state.items.length && r1.state.stars.length && r1.state.drops.length);
  assert.ok(r1.$recs.some(x => x.brain) && r1.$recs.some(x => x.chat) && r1.$recs.some(x => x.discAt != null));
  // a field added to a record (here: to the saved data, and to a live record) changes it
  s.rooms[0].$recs[0].extra = 1;
  assert.notEqual(shapeHashOf(s), h);
  const arena = sampleArena();
  [...arena.recs.values()][0].newField = 'x';
  assert.notEqual(shapeHashOf(snapshotArena(arena, { rulesHash: '0', shapeHash: '0', wallNow: 0 })), h);
  // a field that is not plain data can't be saved: loud, not silently lost
  const bad = sampleArena();
  [...bad.rooms.values()][0].cache = new Map();
  assert.equal(snapshotArena(bad).failed.length, 1);
  delete [...bad.rooms.values()][0].cache;
  [...bad.recs.values()][0].when = Infinity;
  assert.match(snapshotArena(bad).failed.map(f => f.err).join(), /finite/);
});

// ---------- save and restore (socket-less arena) ----------
function world(opts = {}) {
  const clock = { t: 1000 };
  const arena = new Arena({ now: () => clock.t, seed: 5, heartbeatMs: 0, rules: 'R', ...opts });
  const conn = (ip = 'test') => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, JSON.stringify(m));
    c.last = ty => [...c.msgs].reverse().find(m => m.t === ty);
    return c;
  };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { clock.t += TICK_MS; arena.tick(); } };
  return { arena, conn, tick, clock };
}
const HASHES = { rulesHash: 'R', shapeHash: 'S' };

// Room 1: Ann (admin, fighting), Bob, an AI player, settings changed, scores; room 2: a pending admin and Cy.
function populated() {
  const w = world();
  const ann = w.conn('ip-a'); ann.say({ t: 'create', room: 'Dojo', name: 'Ann' }); ann.say({ t: 'hello', name: 'Ann', color: 0, room: 1 });
  const bob = w.conn('ip-b'); bob.say({ t: 'hello', name: 'Bob', color: 1, room: 1 });
  ann.say({ t: 'bots', d: 1 });
  ann.say({ t: 'cfg', set: { gravity: .4, gore: false } });
  const pen = w.conn('ip-p'); pen.say({ t: 'create', room: 'Two', name: 'Pen' });
  const cy = w.conn('ip-c'); cy.say({ t: 'hello', name: 'Cy', color: 2, room: 2 });
  w.tick(30);
  const r1 = w.arena.rooms.get(1);
  Sim.getPlayer(r1.state, ann.last('welcome').id).score = 3;
  Sim.getPlayer(r1.state, bob.last('welcome').id).deaths = 2;
  return { ...w, ann, bob, pen, cy };
}

test('save → restore: rooms, records, scores, bots, settings and admins come back; players resume and play on', () => {
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const A = populated();
    const before = [...A.arena.rooms.values()].map(r => ({ id: r.id, name: r.name, admin: r.adminId, roster: r.roster().map(p => ({ ...p, away: undefined })), cfg: r.cfg, bots: r.bots.length, tick: r.state.tick }));
    const tokens = { ann: A.ann.last('welcome').token, bob: A.bob.last('welcome').token, cy: A.cy.last('welcome').token };
    const saved = saveState(A.arena, file, HASHES);
    assert.equal(saved.rooms, 2);
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the file holds tokens: owner only');
    assert.equal(statSync(dir).mode & 0o077, 0, 'its directory is private too');
    A.arena.stop({ restart: true });
    assert.deepEqual(A.ann.closed, { code: NET.restartClose, reason: 'restart' });
    assert.equal(A.ann.last('restart').t, 'restart');

    const B = world();
    const r = loadState(B.arena, file, HASHES);
    assert.deepEqual(r, { loaded: 2, dropped: [], why: null });
    assert.equal(existsSync(file), false, 'deleted after loading');
    assert.equal(B.arena.tickNo, before[0].tick);
    const after = [...B.arena.rooms.values()];
    assert.deepEqual(after.map(r => r.id), [1, 2]);
    const r1 = after[0], r2 = after[1];
    assert.equal(r1.name, 'Dojo'); assert.equal(r1.adminId, before[0].admin); assert.equal(r1.bots.length, 1);
    assert.deepEqual(r1.cfg, before[0].cfg); assert.equal(r1.cfg.gravity, .4);
    assert.deepEqual(r1.roster().map(p => ({ ...p, away: undefined })), before[0].roster);
    assert.ok(r1.roster().filter(p => !p.bot).every(p => p.away), 'restored humans start away');
    // room 2's admin was pending (a connection, gone): the role passed to its human
    assert.equal(r2.adminId, A.cy.last('welcome').id); assert.equal(r2.adminConn, null);
    assert.deepEqual(checkRoom(r1), []); assert.deepEqual(checkRoom(r2), []);
    // a new room or player gets a fresh id
    assert.ok(B.arena.nextRoom >= 3 && B.arena.nextId > Math.max(...B.arena.recs.keys()));

    // the players resume with their tokens and carry on
    const ann = B.conn('ip-a'); ann.say({ t: 'hello', name: 'Ann', color: 0, token: tokens.ann, resume: true });
    const bob = B.conn('ip-b'); bob.say({ t: 'hello', name: 'Bob', color: 1, token: tokens.bob, resume: true });
    const wa = ann.last('welcome');
    assert.equal(wa.resumed, true); assert.equal(wa.id, A.ann.last('welcome').id); assert.equal(wa.room, 1); assert.equal(wa.admin, wa.id);
    assert.equal(wa.r, 'R'); assert.deepEqual(wa.cfg, { gravity: .4, gore: false });
    assert.equal(bob.last('welcome').resumed, true);
    const bot = r1.bots[0], botAt = { ...Sim.getPlayer(r1.state, bot.id) };
    const me0 = { ...Sim.getPlayer(r1.state, wa.id) };
    for (let s = 1; s <= 60; s++) { ann.say({ t: 'input', seq: s, keys: KEY.RIGHT | KEY.RUN }); B.tick(); }
    const me1 = Sim.getPlayer(r1.state, wa.id), b1 = Sim.getPlayer(r1.state, bot.id);
    assert.ok(me1.x !== me0.x || !me0.alive, 'Ann moves on the restored server');
    assert.ok(b1.x !== botAt.x || b1.y !== botAt.y || b1.alive !== botAt.alive, 'the bot plays on');
    assert.equal(me1.score, 3); assert.equal(Sim.getPlayer(r1.state, bob.last('welcome').id).deaths, 2);
    assert.ok(ann.msgs.some(m => m.t === 'snapshot' && m.tick > before[0].tick), 'snapshots continue from the saved tick');
    // admin powers survive: Ann can rename her room
    ann.say({ t: 'rename', name: 'Dojo Two' }); assert.equal(r1.name, 'Dojo Two');
  } finally { removeDir(dir); }
});

test('restore: restored humans get the extended grace, then the usual expiry closes the room', () => {
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const A = populated();
    saveState(A.arena, file, HASHES);
    const B = world();
    loadState(B.arena, file, HASHES);
    B.clock.t += RESTORE_GRACE_MS - 2000; B.tick();
    assert.equal(B.arena.rooms.size, 2, 'still there inside the grace (well past the usual 5 s)');
    B.clock.t += 3000; B.tick();
    assert.equal(B.arena.rooms.size, 0, 'nobody resumed: released, the rooms closed');
    assert.equal(B.arena.tokens.size, 0);
  } finally { removeDir(dir); }
});

test('restore: refused for other rules, another shape, a stale or malformed file; the file is deleted anyway', () => {
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const cases = [
      [{ rulesHash: 'other', shapeHash: 'S' }, {}, /rules hash/],
      [{ rulesHash: 'R', shapeHash: 'other' }, {}, /shape hash/],
      [HASHES, { wallNow: Date.now() + STATE_MAX_AGE_MS + 1000 }, /saved \d+ s ago/],
    ];
    for (const [h, extra, why] of cases) {
      saveState(populated().arena, file, HASHES);
      const B = world();
      const r = loadState(B.arena, file, { ...h, ...extra });
      assert.equal(r.loaded, 0); assert.match(r.why, why);
      assert.equal(B.arena.rooms.size, 0, 'an empty start');
      assert.equal(existsSync(file), false);
    }
    writeFileSync(file, '{not json');
    assert.equal(loadState(world().arena, file, HASHES).why, 'not JSON');
    assert.equal(existsSync(file), false);
    assert.equal(loadState(world().arena, file, HASHES).why, 'no save file');
  } finally { removeDir(dir); }
});

test('restore: a room that fails its trial step is dropped, the others come back', () => {
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const A = populated();
    const data = snapshotArena(A.arena, HASHES);
    data.rooms[0].state.players[0].x = 1e9;                 // room 1: a player far outside the level
    const r2 = data.rooms[1];
    r2.state.players.push({ ...r2.state.players[0], id: 999 }); // a sim player without a record
    data.rooms.push({ ...structuredClone(data.rooms[1]), id: 7 });
    data.rooms[2].state.players = 'oops';                   // a step that throws
    data.nextRoom = 8;
    writeFileSync(file, JSON.stringify(data));
    let B = world();
    let r = loadState(B.arena, file, HASHES);
    assert.equal(r.loaded, 0);
    assert.deepEqual(r.dropped.map(d => d.room), [1, 2, 7]);
    assert.match(r.dropped[0].why, /outside the level/); assert.match(r.dropped[1].why, /slots/); assert.match(r.dropped[2].why, /sim state|threw/);
    // only room 1 broken: room 2 is restored
    const ok = snapshotArena(A.arena, HASHES);
    ok.rooms[0].state.players[0].vx = null;                  // a NaN that JSON turned into null
    writeFileSync(file, JSON.stringify(ok));
    B = world();
    r = loadState(B.arena, file, HASHES);
    assert.equal(r.loaded, 1); assert.deepEqual(r.dropped.map(d => d.room), [1]);
    assert.deepEqual([...B.arena.rooms.keys()], [2]);
  } finally { removeDir(dir); }
});

test('restore: a room held only by its pending admin is not restored', () => {
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const w = world();
    const p = w.conn('ip-p'); p.say({ t: 'create', room: 'Lonely', name: 'Pen' });
    w.tick(3);
    saveState(w.arena, file, HASHES);
    const B = world();
    const r = loadState(B.arena, file, HASHES);
    assert.equal(r.loaded, 0); assert.equal(B.arena.rooms.size, 0);
  } finally { removeDir(dir); }
});

// ---------- the client (public/net.js in Node over a fake socket) ----------
test('net.js: compareVersion', async () => {
  const { compareVersion } = await loadNet();
  const page = { rules: 'R', build: 'B' };
  assert.equal(compareVersion(page, { r: 'R', b: 'B' }), 'same');
  assert.equal(compareVersion(page, { r: 'R', b: 'B2' }), 'ui');
  assert.equal(compareVersion(page, { r: 'R2', b: 'B' }), 'outdated');
  assert.equal(compareVersion({ rules: '', build: 'B' }, { r: 'R', b: 'B' }), 'outdated', 'a page without a rules hash can\'t tell: reload');
  assert.equal(compareVersion(page, { b: 'B2' }), 'outdated', 'a server older than SPEC §18: by the build id, as before');
  assert.equal(compareVersion(page, { b: 'B' }), 'same');
});

let netMod = null;
async function loadNet() {
  if (netMod) return netMod;
  const root = new URL('../', import.meta.url).href;
  register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      if (spec.startsWith('/shared/')) return { url: ${JSON.stringify(root)} + spec.slice(1), shortCircuit: true };
      return next(spec, ctx);
    }`));
  globalThis.location ??= { search: '', protocol: 'http:', host: 'test', pathname: '/' };
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true, writable: true });
  const { setInterval: si, setTimeout: st } = globalThis;
  globalThis.setInterval = (...a) => { const h = si(...a); h.unref?.(); return h; };
  globalThis.setTimeout = (...a) => { const h = st(...a); h.unref?.(); return h; };
  netMod = await import('../public/net.js');
  return netMod;
}
// A WebSocket for net.js wired to whatever arena `target.arena` is when it opens; like a browser, the
// open event comes before the first message. `sent` collects what the page sent.
function fakeSockets(target) {
  const sent = [];
  globalThis.WebSocket = class {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        const arena = target.arena;
        if (!arena) { this.readyState = 3; this.onclose && this.onclose({ code: 1006 }); return; }
        let q = [];
        this.c = arena.connect({ ip: 'net', send: s => (q ? q.push(s) : this.onmessage && this.onmessage({ data: s })),
          close: code => { this.readyState = 3; setTimeout(() => this.onclose && this.onclose({ code }), 0); } });
        this.arena = arena; this.readyState = 1;
        this.onopen && this.onopen();
        const qq = q; q = null; for (const s of qq) this.onmessage && this.onmessage({ data: s });
      }, 1);
    }
    send(s) { sent.push(JSON.parse(s)); if (this.readyState === 1) this.arena.onMessage(this.c, s); }
    close() { this.readyState = 3; }
  };
  return sent;
}

test('net.js across a restart: same rules → resumes in place; other rules → the game stops, leave, onOutdated', async () => {
  const { createNet } = await loadNet();
  const dir = tempDir(), file = join(dir, 'rooms.json');
  try {
    const A = world({ build: 'B1' });
    const target = { arena: A.arena };
    const sent = fakeSockets(target);
    const outdated = [], statuses = [];
    const net = createNet({ onStatus: s => statuses.push(s) });
    net.rules = 'R'; net.build = 'B1'; net.onOutdated = o => outdated.push(o);
    const host = A.conn('ip-h'); host.say({ t: 'create', room: 'Dojo', name: 'Hal' }); host.say({ t: 'hello', name: 'Hal', color: 0, room: 1 });
    net.connect();
    await waitFor(() => net.state === 'open');
    net.join('Ann', 1, 1);
    await waitFor(() => net.mode === 'play');
    const id = net.id;
    for (let i = 0; i < 4 && !net.me; i++) A.tick();
    assert.ok(net.me, 'our player from a snapshot');
    Sim.getPlayer(A.arena.rooms.get(1).state, id).score = 4;

    // restart 1: same rules (another build: only the UI changed) → resume in place, no reload
    saveState(A.arena, file, HASHES);
    target.arena = null;
    A.arena.stop({ restart: true });
    await waitFor(() => net.state === 'restarting', { what: 'restarting' });
    assert.ok(net.me, 'the last frame is kept while the server restarts');
    const B = world({ build: 'B2' });
    assert.equal(loadState(B.arena, file, HASHES).loaded, 1);
    target.arena = B.arena;
    await waitFor(() => net.state === 'open' && net.mode === 'play' && net.id === id, { timeout: 5000, what: 'resumed on the new server' });
    assert.deepEqual(outdated, []);
    assert.equal(net.uiStale, 'B2', 'a quiet reload is due (UI only)');
    assert.equal(net.lobby.room, 1);
    assert.equal(net.lobby.players.find(p => p.id === id).score, 4, 'the score survived');
    assert.ok(sent.some(m => m.t === 'hello' && m.resume === true && m.token));
    B.tick(4);
    assert.ok(net.me, 'snapshots again');

    // restart 2: other rules → the game stops: leave is sent, onOutdated says there was a game to lose
    saveState(B.arena, file, HASHES);
    target.arena = null;
    B.arena.stop({ restart: true });
    await waitFor(() => net.state === 'restarting', { what: 'restarting again' });
    const C = world({ build: 'B3', rules: 'R2' });
    assert.match(loadState(C.arena, file, { rulesHash: 'R2', shapeHash: 'S' }).why, /rules hash/);
    const n0 = sent.length;
    target.arena = C.arena;
    await waitFor(() => outdated.length, { timeout: 5000, what: 'onOutdated' });
    assert.deepEqual(outdated[0], { playing: true, server: 'R2' });
    assert.equal(net.state, 'outdated'); assert.equal(net.halted(), true);
    assert.ok(sent.slice(n0).some(m => m.t === 'leave'), 'the page gives up its slot');
    assert.equal(net.mode, 'viewer');
    const n1 = sent.length;
    await sleep(700);
    assert.equal(sent.length, n1, 'nothing more is sent (no pings, no inputs)');
    assert.ok(!statuses.includes('expired'), 'not mistaken for an expired resume');
  } finally { removeDir(dir); delete globalThis.WebSocket; }
});

test('net.js: a lobby viewer meeting other rules has nothing to lose', async () => {
  const { createNet } = await loadNet();
  const A = world({ rules: 'R9' });
  fakeSockets({ arena: A.arena });
  const outdated = [];
  const net = createNet();
  net.rules = 'R'; net.build = 'B'; net.onOutdated = o => outdated.push(o);
  net.connect();
  await waitFor(() => outdated.length);
  assert.deepEqual(outdated[0], { playing: false, server: 'R9' });
  delete globalThis.WebSocket;
});

// ---------- a real server process: SIGTERM saves, the next one restores ----------
const wsOpen = (srv) => new Promise((res, rej) => {
  const ws = new WebSocket(srv.wsUrl, { headers: { Origin: srv.origin } });
  ws.msgs = []; ws.closeCode = null;
  ws.on('message', d => ws.msgs.push(JSON.parse(String(d))));
  ws.on('close', code => { ws.closeCode = code; });
  ws.once('open', () => res(ws)); ws.once('error', rej);
});
const said = (ws, m) => ws.send(JSON.stringify(m));
const lastOf = (ws, t) => [...ws.msgs].reverse().find(m => m.t === t);

test('server process: SIGTERM saves within the stop timeout, closes with the restart code, and the next server resumes the game', async () => {
  const dir = tempDir(), file = join(dir, 'state', 'rooms.json');
  let srv = null;
  try {
    srv = await startServer({ STATE_FILE: file, DEBUG_PORT: null });
    const a = await wsOpen(srv), b = await wsOpen(srv);
    said(a, { t: 'create', room: 'Dojo', name: 'Ann' });
    await waitFor(() => lastOf(a, 'lobby') && lastOf(a, 'lobby').room);
    const room = lastOf(a, 'lobby').room;
    said(a, { t: 'hello', name: 'Ann', color: 0, room });
    said(b, { t: 'hello', name: 'Bob', color: 1, room });
    await waitFor(() => lastOf(a, 'welcome')?.id && lastOf(b, 'welcome')?.id);
    said(a, { t: 'bots', d: 1 });
    await waitFor(() => lastOf(a, 'lobby')?.bots === 1);
    const wa = lastOf(a, 'welcome'), rules = a.msgs[0].r;
    assert.match(rules, /^[0-9a-f]{16}$/);
    const t0 = Date.now();
    await srv.stop();
    const took = Date.now() - t0;
    assert.ok(took < 2000, `stopped in ${took} ms`);
    await waitFor(() => a.closeCode != null);
    assert.equal(a.closeCode, NET.restartClose);
    assert.ok(a.msgs.some(m => m.t === 'restart'));
    assert.ok(srv.logs.some(l => /^save: 1 room/.test(l)), srv.logs.join('\n'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rulesHash, rules);

    srv = await startServer({ STATE_FILE: file, DEBUG_PORT: null, PORT: srv.port });
    assert.ok(srv.logs.some(l => /^restore: 1 room/.test(l)), srv.logs.join('\n'));
    assert.equal(existsSync(file), false);
    const a2 = await wsOpen(srv);
    await waitFor(() => a2.msgs.length);
    assert.equal(a2.msgs[0].r, rules, 'the same rules: this page plays on');
    said(a2, { t: 'hello', name: 'Ann', color: 0, token: wa.token, resume: true });
    await waitFor(() => lastOf(a2, 'welcome')?.id);
    const w2 = lastOf(a2, 'welcome');
    assert.equal(w2.resumed, true); assert.equal(w2.id, wa.id); assert.equal(w2.room, room); assert.equal(w2.admin, wa.id);
    await waitFor(() => lastOf(a2, 'lobby')?.bots === 1, { what: 'the bot came back' });
    await waitFor(() => a2.msgs.some(m => m.t === 'snapshot' && m.me), { what: 'snapshots' });
    a2.close();
    await srv.stop();

    // the same file under other rules (RULES_HASH: tests only): not loaded, an empty start
    srv = await startServer({ STATE_FILE: file, DEBUG_PORT: null, RULES_HASH: 'otherrules' });
    assert.ok(srv.logs.some(l => /^restore: none \(rules hash/.test(l)), srv.logs.join('\n'));
    const a3 = await wsOpen(srv);
    await waitFor(() => a3.msgs.length);
    assert.equal(a3.msgs[0].r, 'otherrules');
    a3.close();
  } finally { if (srv) await srv.stop(); removeDir(dir); }
});

test('config: STATE_FILE and RULES_HASH', async () => {
  const { loadConfig } = await import('../server/server.js');
  assert.ok(loadConfig({}).stateFile.endsWith(join('state', 'rooms.json')));
  assert.equal(loadConfig({ STATE_FILE: 'off' }).stateFile, null);
  assert.equal(loadConfig({ RULES_HASH: 'abc' }).rulesHash, 'abc');
  assert.throws(() => loadConfig({ RULES_HASH: 'abc', NODE_ENV: 'production' }), /testing/);
  assert.throws(() => loadConfig({ RULES_HASH: 'a b' }), /RULES_HASH/);
});
