// Abuse test (SPEC §10, §12, §13.2): every limit the server promises, against a real server process.
//
//   node test/abuse.js
//
// The server runs with TRUST_PROXY so each case can use its own client IP (X-Real-IP), the way a
// reverse proxy would supply it. The IPs are IPv6 unique-local addresses. Rooms (SPEC §17) are limited to
// 2 open per address, 10 in all, and a room closes when its admin goes (5 s after the socket drops), so
// each case that makes rooms uses its own address and ends with its sockets closed.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, tempDir, removeDir, ROOT, sleep, waitFor } from './lib.js';

const log = (...a) => console.log('abuse:', ...a);
let srv, dir, ipN = 0;
const nextIp = () => `fd00::${(++ipN).toString(16)}`;

// Open a WebSocket; resolves to { ws, msgs, closed: Promise<{code, reason}> } or rejects with the HTTP status.
function open({ ip = nextIp(), origin = srv.origin, path = '/ws' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'X-Real-IP': ip };
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${path}`, { ...(origin ? { origin } : {}), headers });
    const msgs = [];
    let closeRes;
    const closed = new Promise(r => { closeRes = r; });
    ws.on('message', d => msgs.push(JSON.parse(d)));
    ws.on('close', (code, reason) => closeRes({ code, reason: String(reason) }));
    ws.on('open', () => resolve({ ws, msgs, closed, kick: () => msgs.find(m => m.t === 'kick'), refused: () => msgs.filter(m => m.t === 'refused') }));
    ws.on('unexpected-response', (req, res) => { reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })); });
    ws.on('error', e => reject(e));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
// Create a room as a new admin: resolves to { c, room, id } once welcomed. `keep` pings every 0.5 s so the
// 5 s heartbeat leaves a long-running case alone.
async function mkRoom({ ip = nextIp(), name = 'abuser', room = '', keep = false } = {}) {
  const c = await open({ ip });
  send(c, { t: 'create', name, color: 0, room });
  const w = await waitFor(() => c.msgs.find(m => m.t === 'welcome' && m.id), { timeout: 3000, what: 'a welcome after create' });
  if (keep) { const t = setInterval(() => { if (c.ws.readyState === WebSocket.OPEN) send(c, { t: 'ping', id: 0, ct: 0 }); }, 500); c.ws.on('close', () => clearInterval(t)); }
  return { c, room: w.room, id: w.id };
}
// A second human in room `room` (a hello with its id).
async function joinRoom(room, { ip = nextIp(), name = 'joiner' } = {}) {
  const c = await open({ ip });
  send(c, { t: 'hello', name, color: 1, room });
  const w = await waitFor(() => c.msgs.find(m => m.t === 'welcome' && m.id), { timeout: 3000, what: 'a welcome after hello' });
  return { c, room, id: w.id };
}
// An admin alone leaves (its room closes at once, freeing the address's quota), then the socket closes.
async function leaveClose(c) { send(c, { t: 'leave' }); await sleep(60); c.ws.close(); await c.closed; }
const roomsOpen = async () => (await admin('/state')).rooms.length;
const status = p => p.then(() => 101, e => e.status || e.message);

function post(body, { ip = nextIp(), origin = srv.origin, type = 'application/json', method = 'POST' } = {}) {
  return fetch(`http://127.0.0.1:${srv.port}/debug/report`, {
    method, headers: { 'Content-Type': type, 'X-Real-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}
const admin = path => fetch(`http://127.0.0.1:${srv.adminPort}${path}`).then(r => r.json());

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------- WebSocket ----------
test('oversize message (> 1 KB) closes the connection', async () => {
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'ping', pad: 'x'.repeat(2000) }));
  const { code } = await c.closed;
  assert.equal(code, 1009);
});

test('bad or missing Origin is refused at the upgrade', async () => {
  assert.equal(await status(open({ origin: 'http://example.com' })), 403);
  assert.equal(await status(open({ origin: `http://127.0.0.1:${srv.port + 1}` })), 403);
  assert.equal(await status(open({ origin: null })), 403);
  assert.equal(await status(open({ path: '/other' })), 404);
});

test('input flood is dropped and then kicked', async () => {
  const { c } = await mkRoom({ name: 'flood' });
  await sleep(100);
  for (let i = 1; i <= 400; i++) c.ws.send(JSON.stringify({ t: 'input', seq: i, keys: 0 }));
  const { code } = await c.closed;
  assert.equal(c.kick()?.reason, 'flood');
  assert.equal(code, 4004);
});

test('a steady 60 inputs/s is fine', async () => {
  const { c } = await mkRoom({ name: 'steady' });
  for (let i = 1; i <= 90; i++) { c.ws.send(JSON.stringify({ t: 'input', seq: i, keys: 2 })); await sleep(16); }
  await sleep(200);
  assert.equal(c.kick(), undefined);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  await leaveClose(c);
});

test('chat flood is dropped and then kicked; an oversize chat closes the connection', async () => {
  const { c: a, room } = await mkRoom({ name: 'chatty' }), w = await open();
  send(w, { t: 'view', room });                           // a lobby viewer of the room gets its events
  await sleep(100);
  a.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(900) }));   // under 1 KB: cut to 80 and relayed, even to a viewer
  await sleep(150);
  const got = w.msgs.filter(m => m.t === 'event').flatMap(m => m.ev).filter(e => e.type === 'chat');
  assert.equal(got.length, 1); assert.equal(got[0].text, 'x'.repeat(80));
  for (let i = 0; i < 300; i++) a.ws.send(JSON.stringify({ t: 'chat', text: 'spam ' + i }));
  const { code } = await a.closed;
  assert.equal(a.kick()?.reason, 'flood');
  assert.equal(code, 4004);
  const relayed = w.msgs.filter(m => m.t === 'event').flatMap(m => m.ev).filter(e => e.type === 'chat').length;
  assert.ok(relayed <= 4, `at most the burst got through, saw ${relayed}`);
  const { c: b } = await mkRoom({ name: 'big' });
  await sleep(100);
  b.ws.send(JSON.stringify({ t: 'chat', text: 'y'.repeat(2000) }));
  assert.equal((await b.closed).code, 1009);
  w.ws.close();
});

test(`connections over MAX_PER_IP are refused`, async () => {
  const ip = nextIp(), socks = [];
  for (let i = 0; i < 4; i++) socks.push(await open({ ip }));
  assert.equal(await status(open({ ip })), 429);
  assert.equal(await status(open()), 101, 'another IP still gets in');
  socks[0].ws.close(); await socks[0].closed; await sleep(100);
  const again = await open({ ip });                        // a slot freed up
  for (const s of [...socks.slice(1), again]) s.ws.close();
});

test('malformed JSON, unknown types and binary frames are kicked', async () => {
  for (const [send, reason, code] of [['{oops', 'malformed', 4002], [JSON.stringify({ t: 'godmode' }), 'unknown', 4003],
    [JSON.stringify({ t: 'hello', name: 'a<b>', color: 0, room: 1 }), 'bad hello', 4006], [Buffer.from([1, 2, 3]), 'malformed', 4002],
    [JSON.stringify({ t: 'input', seq: -5, keys: 1 }), 'malformed', 4002],
    // rooms (SPEC §17): a hello needs a room id; view / rename / admin / create need the right types
    [JSON.stringify({ t: 'hello', name: 'ok', color: 0 }), 'bad hello', 4006], [JSON.stringify({ t: 'hello', name: 'ok', color: 0, room: '1' }), 'bad hello', 4006],
    [JSON.stringify({ t: 'hello', name: 'ok', color: 0, room: 0 }), 'bad hello', 4006], [JSON.stringify({ t: 'hello', name: 'ok', color: 0, room: 1.5 }), 'bad hello', 4006],
    [JSON.stringify({ t: 'view', room: '1' }), 'malformed', 4002], [JSON.stringify({ t: 'view', room: -1 }), 'malformed', 4002],
    [JSON.stringify({ t: 'view' }), 'malformed', 4002], [JSON.stringify({ t: 'view', room: 1.5 }), 'malformed', 4002],
    [JSON.stringify({ t: 'rename', name: 5 }), 'malformed', 4002], [JSON.stringify({ t: 'rename' }), 'malformed', 4002],
    [JSON.stringify({ t: 'admin', id: 'x' }), 'malformed', 4002], [JSON.stringify({ t: 'admin', id: 1.5 }), 'malformed', 4002], [JSON.stringify({ t: 'admin' }), 'malformed', 4002],
    [JSON.stringify({ t: 'create', name: 'ok', color: 0, room: 7 }), 'malformed', 4002], [JSON.stringify({ t: 'create', name: 'a<b>', color: 0 }), 'bad hello', 4006],
    [JSON.stringify({ t: 'bots', d: 2 }), 'malformed', 4002], [JSON.stringify({ t: 'bots', n: 8 }), 'malformed', 4002]]) {
    const c = await open();
    c.ws.send(send, { binary: Buffer.isBuffer(send) });
    const r = await c.closed;
    assert.equal(c.kick()?.reason, reason, String(send));
    assert.equal(r.code, code);
  }
});

test('clients cannot set ids, scores or positions', async () => {
  const c = await open();
  send(c, { t: 'create', name: 'sneaky', color: 1, room: 'Mine', id: 99, score: 1000, x: 5, y: 5, admin: 99, adminId: 99, cap: 99, creatorIp: 'forged-ip' });
  await sleep(150);
  const w = c.msgs.find(m => m.t === 'welcome' && m.id);
  assert.notEqual(w.id, 99);
  assert.equal(w.players.find(p => p.id === w.id).score, 0);
  assert.equal(w.admin, w.id, 'the creator is the admin, whatever it claims');
  assert.equal(w.cap, 8);
  const st = (await admin('/state')).rooms.find(r => r.id === w.room);
  assert.notEqual(st.creatorIp, 'forged-ip');
  // a joiner cannot claim the admin role in its hello either
  const j2 = await open();
  send(j2, { t: 'hello', name: 'climber2', color: 3, room: w.room, admin: true, adminId: 0 });
  const w2 = await waitFor(() => j2.msgs.find(m => m.t === 'welcome' && m.id), { what: 'second welcome' });
  assert.equal(w2.admin, w.id, 'still the creator');
  j2.ws.close();
  await leaveClose(c);
});

// ---------- rooms (SPEC §17) ----------
test('a third room from one address is refused (why ip); another address is fine; a closed room frees the quota', async () => {
  const ip = nextIp();
  const a = await mkRoom({ ip, name: 'one' }), b = await mkRoom({ ip, name: 'two' });
  const c = await open({ ip });
  send(c, { t: 'create', name: 'three', color: 2, room: '' });
  await waitFor(() => c.refused().length, { what: 'a refusal' });
  assert.deepEqual(c.refused(), [{ t: 'refused', what: 'create', why: 'ip' }]);
  assert.equal(c.kick(), undefined, 'refused, not kicked');
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  const other = await mkRoom({ name: 'elsewhere' });
  await leaveClose(a.c); await sleep(100);
  send(c, { t: 'create', name: 'three', color: 2, room: 'Third' });
  await waitFor(() => c.msgs.find(m => m.t === 'welcome' && m.id), { what: 'a room after one closed' });
  for (const x of [b.c, c, other.c]) await leaveClose(x);
});

test('create is rate-limited per connection (burst 2: the third is refused why rate)', async () => {
  const c = await open();
  for (let i = 0; i < 3; i++) { send(c, { t: 'create', name: 'quick', color: 0, room: 'bad<name>' }); await sleep(100); }   // each refused (name), each costs a token
  await waitFor(() => c.refused().length === 3, { what: 'three refusals' });
  assert.deepEqual(c.refused().map(r => r.why), ['name', 'name', 'rate']);
  assert.equal(c.kick(), undefined); assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
});

test('at most 10 rooms: the 11th is refused (why full) and a freed place can be taken', async () => {
  await waitFor(async () => (await roomsOpen()) === 0, { timeout: 12000, what: 'earlier rooms to close' });
  const rooms = [];
  for (let i = 0; i < 5; i++) { const ip = nextIp(); rooms.push(await mkRoom({ ip, name: `r${i}a`, keep: true }), await mkRoom({ ip, name: `r${i}b`, keep: true })); }
  assert.equal(await roomsOpen(), 10);
  const c = await open();
  send(c, { t: 'create', name: 'late', color: 0, room: '' });
  await waitFor(() => c.refused().length, { what: 'a refusal' });
  assert.deepEqual(c.refused(), [{ t: 'refused', what: 'create', why: 'full' }]);
  assert.equal(c.kick(), undefined);
  const lobby = c.msgs.filter(m => m.t === 'lobby').at(-1);
  if (lobby) assert.equal(lobby.rooms.length, 10);
  assert.equal(await roomsOpen(), 10, 'no eleventh room');
  // a hello into a full server's room still works; one room closes and the create then succeeds
  await leaveClose(rooms[0].c);
  await sleep(100);
  send(c, { t: 'create', name: 'late', color: 0, room: '' });
  await waitFor(() => c.msgs.find(m => m.t === 'welcome' && m.id), { what: 'a room after one closed' });
  for (const r of [...rooms.slice(1), { c }]) await leaveClose(r.c);
  await waitFor(async () => (await roomsOpen()) === 0, { timeout: 3000, what: 'all rooms closed' });
});

test('a non-admin cannot add AI players, rename the room, hand over admin or leave-as-admin; a viewer cannot either; none is kicked', async () => {
  const A = await mkRoom({ name: 'boss', room: 'Mine', keep: true });
  const B = await joinRoom(A.room, { name: 'guest' });
  const V = await open();
  for (const c of [B.c, V]) {
    const n = c.refused().length;
    send(c, { t: 'bots', d: 1 }); await sleep(120); send(c, { t: 'bots', n: 3 }); await sleep(120);
    send(c, { t: 'rename', name: 'Hacked' }); await sleep(120);
    send(c, { t: 'admin', id: A.id }); await sleep(120);
    await waitFor(() => c.refused().length === n + 4, { what: 'four refusals' });
    assert.deepEqual(c.refused().slice(n).map(r => `${r.what}/${r.why}`), ['bots/admin', 'bots/admin', 'rename/admin', 'admin/admin']);
    assert.equal(c.kick(), undefined); assert.equal(c.ws.readyState, WebSocket.OPEN);
  }
  const st = (await admin('/state')).rooms.find(r => r.id === A.room);
  assert.equal(st.name, 'Mine'); assert.equal(st.bots, 0); assert.equal(st.admin.id, A.id);
  // the admin may not leave while another human is in the room
  send(A.c, { t: 'leave' });
  await waitFor(() => A.c.refused().length, { what: 'leave refused' });
  assert.deepEqual(A.c.refused(), [{ t: 'refused', what: 'leave', why: 'admin' }]);
  // an admin handing over to a bot, itself or nobody is refused (target), and to the guest it works
  send(A.c, { t: 'admin', id: A.id }); await sleep(120); send(A.c, { t: 'admin', id: 99999 }); await sleep(120);
  await waitFor(() => A.c.refused().length === 3, { what: 'two target refusals' });
  assert.deepEqual(A.c.refused().slice(1).map(r => `${r.what}/${r.why}`), ['admin/target', 'admin/target']);
  send(A.c, { t: 'admin', id: B.id });
  await waitFor(async () => (await admin('/state')).rooms.find(r => r.id === A.room).admin.id === B.id, { what: 'admin handed over' });
  // and now the old admin is refused like any other, while the new one may add a bot
  send(A.c, { t: 'bots', d: 1 });
  send(B.c, { t: 'bots', d: 1 });
  await waitFor(async () => (await admin('/state')).rooms.find(r => r.id === A.room).bots === 1, { what: 'the new admin adds a bot' });
  assert.equal(A.c.kick(), undefined);
  for (const c of [A.c, B.c, V]) c.ws.close();
});

// ---------- debug report intake ----------
const goodReport = (extra = {}) => ({ v: 1, kind: 'manual', reason: 'test', env: { ua: 'abuse' }, net: {}, player: null,
  entries: [{ ts: 1, tick: 2, cat: 'net', msg: 'hello' }], ...extra });

test('a valid report is stored with server-owned metadata', async () => {
  const ip = nextIp();
  const r = await post(goodReport({ env: { ua: 'x', meta: { id: 'forged', ip: 'forged' } } }), { ip });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[a-z0-9]{8}$/);
  const rec = await admin('/reports/' + r.body.id);
  assert.equal(rec.meta.id, r.body.id); assert.equal(rec.meta.ip, ip); assert.equal(rec.meta.server, null);
  assert.deepEqual(rec.report.env.meta, { id: 'forged', ip: 'forged' }, 'nested look-alikes stay inside the report');
});

test('oversize report → 413', async () => {
  const r = await post(goodReport({ reason: 'x'.repeat(20000) }));
  assert.equal(r.status, 413);
});

test('bad Origin on a report → 403', async () => {
  assert.equal((await post(goodReport(), { origin: 'http://example.com' })).status, 403);
  assert.equal((await post(goodReport(), { origin: null })).status, 403);
});

test('payloads that try to forge server metadata → 400', async () => {
  for (const forged of [{ meta: { id: 'aaaaaaaa' } }, { server: { player: { name: 'admin' } } }, { id: 'aaaaaaaa' }, { ip: '127.0.0.1' }, { received: 'now' }]) {
    const r = await post(goodReport(forged));
    assert.equal(r.status, 400, JSON.stringify(forged));
  }
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post(goodReport(), { type: 'text/plain' })).status, 400);
  assert.equal((await post(goodReport({ entries: new Array(301).fill({ msg: 'x' }) }))).status, 400);
  assert.equal((await post(null, { method: 'GET' })).status, 405);
});

test('report flood: 6 per minute per IP, then 429', async () => {
  const ip = nextIp(), codes = [];
  for (let i = 0; i < 8; i++) codes.push((await post(goodReport(), { ip })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await post(goodReport())).status, 200, 'other IPs are unaffected');
});

test('a forged resume token attaches nothing; the token is never stored', async () => {
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello', name: 'reporter', color: 2 }));
  await sleep(150);
  const { token, id } = c.msgs.find(m => m.t === 'welcome' && m.id);
  const ok = await post(goodReport({ token }));
  const rec = await admin('/reports/' + ok.body.id);
  assert.equal(rec.meta.server.player.id, id);
  assert.ok(!JSON.stringify(rec).includes(token));
  const bad = await post(goodReport({ token: 'f'.repeat(32) }));
  assert.equal((await admin('/reports/' + bad.body.id)).meta.server, null);
  c.ws.close();
});

test('the server event ring saw the refusals and kicks', async () => {
  const ev = await admin('/events?n=2000');
  for (const type of ['refused', 'kick', 'ratelimit', 'report-rejected', 'report']) assert.ok(ev.some(e => e.type === type), type);
  assert.ok(ev.some(e => e.type === 'kick' && e.reason === 'flood'));
});

test('stdout logs carry no message bodies', async () => {
  const text = srv.logs.join('\n');
  assert.ok(!text.includes('godmode') && !text.includes('oops') && !text.includes('forged'), 'no bodies in logs');
  assert.ok(text.includes('kick') && text.includes('refuse'));
});

test('NET_SIM is refused when NODE_ENV=production', async () => {
  const p = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '0', NET_SIM: '100,5', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => p.on('exit', r));
  assert.equal(code, 2); assert.match(err, /NET_SIM/);
});

test('ITEM_SECS, STAR_SECS and ITEM_POINTS (test-only pickup knobs) are refused when NODE_ENV=production', async () => {
  for (const [k, v] of [['ITEM_SECS', '1,2'], ['STAR_SECS', '1,2'], ['ITEM_POINTS', '0,1']]) {
    const p = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: '0', [k]: v, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const code = await new Promise(r => p.on('exit', r));
    assert.equal(code, 2, k); assert.match(err, new RegExp(k));
  }
});

test('smoke test: ok against the server, fails on a bad origin', async () => {
  const run = (...args) => new Promise(r => execFile(process.execPath, [join(ROOT, 'test/smoke.js'), ...args], (e, so, se) => r({ code: e ? e.code : 0, out: so + se })));
  const ok = await run(`ws://127.0.0.1:${srv.port}/ws`);
  assert.equal(ok.code, 0, ok.out);
  const bad = await run(`ws://127.0.0.1:${srv.port}/ws`, '--origin', 'http://example.com');
  assert.equal(bad.code, 1); assert.match(bad.out, /403/);
});

async function main() {
  dir = tempDir();
  srv = await startServer({ DEBUG_DIR: dir, TRUST_PROXY: '1', MAX_PER_IP: '4', MAX_CONN: '40' });
  let failed = 0;
  try {
    for (const [name, fn] of cases) {
      try { await fn(); log(`ok   ${name}`); }
      catch (e) { failed++; log(`FAIL ${name}: ${e.message}`); }
    }
  } finally {
    await srv.stop();
    removeDir(dir);
  }
  log(failed ? `${failed} of ${cases.length} failed` : `PASS (${cases.length} cases)`);
  process.exitCode = failed ? 1 : 0;
}
main();
