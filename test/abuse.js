// Abuse test (SPEC §10, §12, §13.2): every limit the server promises, against a real server process.
//
//   node test/abuse.js
//
// The server runs with TRUST_PROXY so each case can use its own client IP (X-Real-IP), the way a
// reverse proxy would supply it. The IPs are IPv6 unique-local addresses.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer, tempDir, removeDir, ROOT, sleep } from './lib.js';

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
    ws.on('open', () => resolve({ ws, msgs, closed, kick: () => msgs.find(m => m.t === 'kick') }));
    ws.on('unexpected-response', (req, res) => { reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })); });
    ws.on('error', e => reject(e));
  });
}
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
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello', name: 'flood', color: 0 }));
  await sleep(100);
  for (let i = 1; i <= 400; i++) c.ws.send(JSON.stringify({ t: 'input', seq: i, keys: 0 }));
  const { code } = await c.closed;
  assert.equal(c.kick()?.reason, 'flood');
  assert.equal(code, 4004);
});

test('a steady 60 inputs/s is fine', async () => {
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello', name: 'steady', color: 0 }));
  for (let i = 1; i <= 90; i++) { c.ws.send(JSON.stringify({ t: 'input', seq: i, keys: 2 })); await sleep(16); }
  await sleep(200);
  assert.equal(c.kick(), undefined);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
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
    [JSON.stringify({ t: 'hello', name: 'a<b>', color: 0 }), 'bad hello', 4006], [Buffer.from([1, 2, 3]), 'malformed', 4002],
    [JSON.stringify({ t: 'input', seq: -5, keys: 1 }), 'malformed', 4002]]) {
    const c = await open();
    c.ws.send(send, { binary: Buffer.isBuffer(send) });
    const r = await c.closed;
    assert.equal(c.kick()?.reason, reason, String(send));
    assert.equal(r.code, code);
  }
});

test('clients cannot set ids, scores or positions', async () => {
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello', name: 'sneaky', color: 1, id: 99, score: 1000, x: 5, y: 5 }));
  await sleep(150);
  const w = c.msgs.find(m => m.t === 'welcome' && m.id);
  assert.notEqual(w.id, 99);
  assert.equal(w.players.find(p => p.id === w.id).score, 0);
  c.ws.close();
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
