// The authoritative arena without sockets: fake connections and a fake clock, tick() by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, KICK } from '../server/arena.js';
import { loadConfig } from '../server/server.js';
import { validateReport, createEventRing, createDebug } from '../server/debug.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Sim from '../shared/sim.js';
import { KEY, TICK_MS } from '../shared/constants.js';

function setup(opts = {}) {
  let t = 1000;
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const events = createEventRing(2000);
  const arena = new Arena({ now: clock.now, seed: 7, event: events.push, ...opts });
  const conn = () => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip: 'test', send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, typeof m === 'string' ? m : JSON.stringify(m));
    c.last = t => [...c.msgs].reverse().find(m => m.t === t);
    c.all = t => c.msgs.filter(m => m.t === t);
    c.events = () => c.msgs.filter(m => m.t === 'event').flatMap(m => m.ev);
    return c;
  };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { clock.advance(TICK_MS); arena.tick(); } };
  return { arena, clock, conn, tick, events };
}

test('connect gets a server welcome and the lobby; hello joins the arena', () => {
  const { conn, tick, arena } = setup();
  const a = conn();
  assert.equal(a.msgs[0].t, 'welcome'); assert.equal(a.msgs[0].id, undefined);
  assert.equal(a.msgs[1].t, 'lobby');
  a.say({ t: 'hello', name: '  Ann  ', color: 3 });
  const w = a.last('welcome');
  assert.equal(w.id, 1); assert.equal(w.name, 'Ann'); assert.equal(w.color, 3); assert.equal(w.state, 'play');
  assert.match(w.token, /^[0-9a-f]{32}$/);
  assert.ok(a.events().some(e => e.type === 'join' && e.id === 1 && e.name === 'Ann'));
  tick(2);
  assert.ok(a.events().some(e => e.type === 'spawn' && e.id === 1));
  const s = a.last('snapshot');
  assert.equal(s.me.id, 1); assert.equal(s.p.length, 1); assert.equal(s.p[0][0], 1);
  assert.equal(arena.activeCount(), 1);
});

test('names are validated and duplicates get #2', () => {
  const { conn } = setup();
  const a = conn(), b = conn(), c = conn();
  a.say({ t: 'hello', name: 'Kit', color: 0 });
  b.say({ t: 'hello', name: 'kit', color: 1 });
  assert.equal(b.last('welcome').name, 'kit#2');
  c.say({ t: 'hello', name: '<script>', color: 1 });
  assert.equal(c.last('kick').reason, 'bad hello'); assert.equal(c.closed.code, KICK['bad hello']);
  for (const bad of [{ name: '', color: 0 }, { name: 'x'.repeat(17), color: 0 }, { name: 'ok', color: 8 }, { name: 'ok', color: '1' }, { name: 'ok', color: 0, token: 'zz' }]) {
    const d = conn(); d.say({ t: 'hello', ...bad }); assert.equal(d.last('kick')?.reason, 'bad hello', JSON.stringify(bad));
  }
});

test('malformed JSON, unknown types and a second hello are kicks', () => {
  const { conn } = setup();
  const a = conn(); a.say('{nope'); assert.equal(a.last('kick').reason, 'malformed');
  const b = conn(); b.say({ t: 'teleport', x: 5 }); assert.equal(b.last('kick').reason, 'unknown');
  const c = conn(); c.say([1, 2]); assert.equal(c.last('kick').reason, 'malformed');
  const d = conn(); d.say({ t: 'hello', name: 'D', color: 0 }); d.say({ t: 'hello', name: 'D', color: 0 }); assert.equal(d.last('kick').reason, 'protocol');
  const e = conn(); e.say({ t: 'hello', name: 'E', color: 0 }); e.say({ t: 'input', seq: 1, keys: 99 }); assert.equal(e.last('kick').reason, 'malformed');
  const f = conn(); f.say({ t: 'hello', name: 'F', color: 0 }); f.say({ t: 'input', seq: 1, keys: [1, 2, 3, 4] }); assert.equal(f.last('kick').reason, 'malformed');
});

test('inputs are consumed one per tick in seq order; batches and duplicates', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(100);                                       // past spawn
  const p = Sim.getPlayer(arena.state, 1), x0 = p.x;
  a.say({ t: 'input', seq: 1, keys: [KEY.RIGHT, KEY.RIGHT, KEY.RIGHT] });
  a.say({ t: 'input', seq: 2, keys: KEY.LEFT });   // stale, ignored
  a.say({ t: 'input', seq: 4, keys: KEY.RIGHT });
  tick(1); assert.equal(arena.recs.get(1).lastSeq, 1);
  tick(1); tick(1); tick(1);
  assert.equal(arena.recs.get(1).lastSeq, 4);
  assert.ok(p.x > x0);
  tick(1);
  assert.equal(a.last('snapshot').seq, 4);
});

test('a missing input repeats the last one briefly, then counts as no keys', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(100);
  a.say({ t: 'input', seq: 1, keys: KEY.RIGHT });
  tick(1);
  const rec = arena.recs.get(1);
  tick(3); assert.equal(rec.lastKeys, KEY.RIGHT);
  tick(10); assert.equal(rec.lastKeys, 0);
});

test('late input bursts do not leave the player behind for good: the backlog drains to one', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(100);
  const rec = arena.recs.get(1);
  let seq = 0;
  const send = (n, keys = KEY.RIGHT) => { for (let i = 0; i < n; i++) a.say({ t: 'input', seq: ++seq, keys }); };
  for (let i = 0; i < 20; i++) { send(1); tick(1); }
  assert.equal(rec.lastSeq, seq);
  // jitter and stalls: inputs arrive 1 to 15 ticks late, in a burst, then steadily again
  for (const gap of [1, 3, 5, 8, 15]) {
    tick(gap); send(gap + 1); tick(1);
    for (let i = 0; i < 70; i++) { send(1); tick(1); }
    assert.ok(rec.inputs.length <= 1, `gap ${gap}: ${rec.inputs.length} inputs still queued`);
    assert.ok(seq - rec.lastSeq <= 1, `gap ${gap}: acked seq ${rec.lastSeq} vs sent ${seq}`);
    assert.ok(a.last('snapshot').seq >= seq - 2);
  }
  // a client sending 2 inputs every 2nd tick (30 fps) has no standing backlog: nothing is skipped
  const applied = [];
  for (let i = 0; i < 120; i++) { if (i % 2 === 0) send(2); tick(1); applied.push(rec.lastSeq); }
  for (let i = 1; i < applied.length; i++) assert.equal(applied[i] - applied[i - 1], 1, 'one input per tick, none skipped');
});

test('a one-tick slash tap inside a skipped (drained) input still fires', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(100);
  const rec = arena.recs.get(1), p = Sim.getPlayer(arena.state, 1);
  let seq = 0;
  const send = (keys = 0) => a.say({ t: 'input', seq: ++seq, keys });
  for (let i = 0; i < 10; i++) { send(); tick(1); }
  tick(10);                                          // a stall, then a burst of 11
  const s0 = seq;
  for (let i = 1; i <= 11; i++) send(i === 3 ? KEY.SLASH : 0);
  tick(1);                                           // takes s0+1; s0+2..s0+11 wait
  rec.qTicks = 29; rec.minQ = Infinity;              // make the drain window end on the next tick
  const swing = p.swing;
  send(); tick(1);                                   // takes s0+2, skips s0+3..s0+11 (the tap among them)
  assert.equal(rec.lastSeq, s0 + 11); assert.equal(rec.inputs.length, 1);
  send(); tick(1);
  assert.equal(p.swing, swing + 1, 'the skipped tap is carried into the next tick');
});

test('after a long absence inputs are applied again at once', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(100);
  const rec = arena.recs.get(1);
  a.say({ t: 'input', seq: 1, keys: KEY.RIGHT }); tick(1);
  tick(600);                                        // tab hidden for 10 s
  assert.equal(rec.lastKeys, 0);
  for (let s = 2; s <= 40; s++) { a.say({ t: 'input', seq: s, keys: KEY.LEFT }); tick(1); assert.equal(rec.lastSeq, s); }
});

test('12 slots, then a FIFO queue with automatic promotion', () => {
  const { conn, tick, arena, clock } = setup({ maxPlayers: 2, graceMs: 1000 });
  const [a, b, c, d] = [conn(), conn(), conn(), conn()];
  a.say({ t: 'hello', name: 'A', color: 0 }); b.say({ t: 'hello', name: 'B', color: 0 });
  c.say({ t: 'hello', name: 'C', color: 0 }); d.say({ t: 'hello', name: 'D', color: 0 });
  assert.equal(c.last('welcome').state, 'queue'); assert.equal(c.last('welcome').queuePos, 1);
  assert.equal(d.last('welcome').queuePos, 2);
  tick(40);
  assert.deepEqual(a.last('lobby').queue.map(q => q.name), ['C', 'D']);
  arena.disconnect(a.conn);                         // A drops: slot held for the grace period
  tick(10);
  assert.equal(arena.activeCount(), 2);
  clock.advance(1000); tick(1);                     // grace over: C is promoted
  assert.ok(c.events().some(e => e.type === 'leave' && e.id === 1));
  assert.ok(c.events().some(e => e.type === 'join' && e.id === 3));
  assert.equal(arena.recs.get(3).state, 'play');
  assert.equal(arena.queuePos(arena.recs.get(4)), 1);
  tick(2);
  assert.ok(c.last('snapshot').me, 'promoted player gets its own state');
});

test('resume within the grace period keeps the slot and score; after it the token is refused', () => {
  const { conn, tick, arena, clock } = setup({ graceMs: 15000 });
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 2 });
  const { token, id } = a.last('welcome');
  tick(5);
  Sim.getPlayer(arena.state, id).score = 3;
  arena.disconnect(a.conn);
  clock.advance(10000); tick(1);
  const a2 = conn(); a2.say({ t: 'hello', name: 'A', color: 2, token });
  const w = a2.last('welcome');
  assert.equal(w.resumed, true); assert.equal(w.id, id);
  assert.equal(w.players.find(p => p.id === id).score, 3);
  arena.disconnect(a2.conn);
  clock.advance(15001); tick(1);
  const a3 = conn(); a3.say({ t: 'hello', name: 'A', color: 2, token });
  assert.equal(a3.last('welcome').resumed, false);
  assert.notEqual(a3.last('welcome').id, id);
});

test('a queued player who resumes into a free slot is promoted at once', () => {
  const { conn, tick, arena } = setup({ maxPlayers: 1 });
  const a = conn(), b = conn();
  a.say({ t: 'hello', name: 'A', color: 0 }); b.say({ t: 'hello', name: 'B', color: 1 });
  const { token, id } = b.last('welcome');
  assert.equal(b.last('welcome').state, 'queue');
  arena.disconnect(b.conn);                         // B drops while queued
  arena.kick(a.conn, 'idle');                       // the slot frees; B is away, so nobody is promoted
  assert.equal(arena.activeCount(), 0);
  const b2 = conn(); b2.say({ t: 'hello', name: 'B', color: 1, token });
  assert.equal(b2.last('welcome').resumed, true);
  assert.equal(b2.last('welcome').state, 'play');
  assert.equal(arena.recs.get(id).state, 'play');
  tick(2); assert.ok(b2.last('snapshot').me);
});

test('one address churning connect + hello + close cannot hold more than maxPerIp records', () => {
  const { conn, tick, arena } = setup({ maxPlayers: 12, maxPerIp: 3 });
  for (let i = 0; i < 20; i++) { const c = conn(); c.say({ t: 'hello', name: 'X', color: 0 }); arena.disconnect(c.conn); }
  assert.equal(arena.recs.size, 3, 'older away records from the same address are released');
  assert.equal(arena.activeCount(), 3);
  tick(1);
  // connected players from one address are never evicted by this
  const live = [conn(), conn(), conn()];
  for (const c of live) c.say({ t: 'hello', name: 'Y', color: 0 });
  assert.equal(arena.recs.size, 3);
  assert.ok(live.every(c => c.last('welcome').id && arena.recs.get(c.last('welcome').id).conn === c.conn));
  // another address is unaffected
  const other = arena.connect({ ip: 'other', send() {}, close() {} });
  arena.onMessage(other, JSON.stringify({ t: 'hello', name: 'Z', color: 0 }));
  assert.equal(arena.recs.size, 4);
});

test('a resume while the old socket is still open replaces it', () => {
  const { conn } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 2 });
  const { token, id } = a.last('welcome');
  const b = conn(); b.say({ t: 'hello', name: 'A', color: 2, token });
  assert.equal(a.last('kick').reason, 'replaced');
  assert.equal(b.last('welcome').id, id); assert.equal(b.last('welcome').resumed, true);
});

test('idle for 120 s goes back to the lobby', () => {
  const { conn, tick, clock, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  tick(10);
  clock.advance(119000); tick(1);
  assert.equal(a.closed, null);
  a.say({ t: 'input', seq: 1, keys: KEY.LEFT }); tick(1);
  clock.advance(119000); tick(1);
  assert.equal(a.closed, null, 'input resets the idle timer');
  clock.advance(2000); tick(1);
  assert.equal(a.last('kick').reason, 'idle'); assert.equal(a.closed.code, KICK.idle);
  assert.equal(arena.activeCount(), 0);
});

test('input flood: excess dropped, sustained flood kicked', () => {
  const { conn, events } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  for (let i = 1; i <= 90; i++) a.say({ t: 'input', seq: i, keys: 0 });
  assert.equal(a.closed, null, '90 in a burst is allowed');
  for (let i = 91; i <= 200; i++) a.say({ t: 'input', seq: i, keys: 0 });
  assert.equal(a.last('kick').reason, 'flood');
  assert.ok(events.all().some(e => e.type === 'ratelimit'));
});

test('lag compensation: a slash is tested against positions rewound by interp delay + RTT/2', () => {
  const { conn, tick, arena } = setup();
  const a = conn(), v = conn();
  a.say({ t: 'hello', name: 'A', color: 0 }); v.say({ t: 'hello', name: 'V', color: 1 });
  tick(100);
  const st = arena.state, pa = Sim.getPlayer(st, 1), pv = Sim.getPlayer(st, 2);
  // stand them side by side on the floor, then let history record it
  Object.assign(pa, { x: 60, y: 259, vx: 0, vy: 0, face: 1, iframes: 0 });
  Object.assign(pv, { x: 72, y: 259, vx: 0, vy: 0, iframes: 0 });
  a.conn.rtt = 60;
  tick(12);
  pv.x = 150;                                     // the victim has "really" moved away by now
  let seq = 1;
  a.say({ t: 'input', seq: seq++, keys: KEY.SLASH });
  for (let i = 0; i < 8; i++) { pv.x = 150; a.say({ t: 'input', seq: seq++, keys: 0 }); tick(1); }
  const hit = a.events().find(e => e.type === 'hit');
  assert.ok(hit, 'rewound target was hit');
  assert.equal(hit.attacker, 1); assert.equal(hit.victim, 2);
});

test('kills send score events and credit survives a leave', () => {
  const { conn, tick, arena } = setup();
  const a = conn(), v = conn();
  a.say({ t: 'hello', name: 'A', color: 0 }); v.say({ t: 'hello', name: 'V', color: 1 });
  tick(100);
  const pv = Sim.getPlayer(arena.state, 2);
  pv.lastHitBy = 1; pv.lastHitTick = arena.state.tick;
  arena.kick(v.conn, 'malformed');                // a kick releases at once: last hitter scores
  const evs = a.events();
  const kill = evs.find(e => e.type === 'kill');
  assert.equal(kill.killer, 1); assert.equal(kill.victim, 2); assert.equal(kill.move, 'leave');
  assert.ok(Number.isInteger(kill.seed));
  assert.ok(evs.some(e => e.type === 'score' && e.id === 1 && e.score === 1));
  assert.ok(evs.some(e => e.type === 'leave' && e.id === 2));
});

test('viewByToken gives the server view without the token; admin state has no tokens', () => {
  const { conn, tick, arena } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  const { token } = a.last('welcome');
  tick(5);
  const v = arena.viewByToken(token);
  assert.equal(v.player.name, 'A'); assert.equal(v.conn.conn, a.conn.id);
  assert.ok(!JSON.stringify(v).includes(token));
  assert.ok(!JSON.stringify(arena.adminState()).includes(token));
  assert.equal(arena.viewByToken('0'.repeat(32)), null);
  assert.ok(arena.tickTimeStats().ticks >= 5);
});

test('config: defaults, origins, NET_SIM refused in production', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 3008); assert.equal(c.maxPerIp, 4); assert.equal(c.maxConn, 40);
  assert.deepEqual(c.allowedOrigins, ['http://localhost:3008', 'http://127.0.0.1:3008']);
  assert.equal(c.debugPort, null); assert.equal(c.trustProxy, false);
  assert.deepEqual(loadConfig({ NET_SIM: '120,2' }).netSim, { delayMs: 120, jitterPct: 2 });
  assert.throws(() => loadConfig({ NET_SIM: '120,2', NODE_ENV: 'production' }), /production/);
  assert.throws(() => loadConfig({ PORT: 'abc' }));
});

test('report validation: known keys only, truncation, control characters', () => {
  assert.throws(() => validateReport({ v: 1, meta: { id: 'x' } }), /unknown key/);
  assert.throws(() => validateReport([]));
  assert.throws(() => validateReport({ entries: new Array(301).fill({}) }));
  const { report, token } = validateReport({ v: 1, kind: 'manual', token: 'abc', env: { ua: 'a\u0000b' + 'x'.repeat(400) },
    entries: [{ msg: 'line\nbreak\u001b[31m' }] });
  assert.equal(token, 'abc'); assert.equal(report.token, undefined);
  assert.equal(report.env.ua.length, 300); assert.ok(!report.env.ua.includes('\u0000'));
  assert.equal(report.entries[0].msg, 'line break[31m');
});

test('the admin listener binds 127.0.0.1 only and is read-only', async () => {
  const { createDebug } = await import('../server/debug.js');
  const { arena, events } = setup();
  const d = createDebug({ dir: '/nonexistent-multisplat-test', allowedOrigins: [], clientIp: () => 'x', arena, events });
  const srv = await d.listenAdmin(0);
  try {
    assert.equal(srv.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${srv.address().port}`;
    assert.equal((await fetch(base + '/state', { method: 'POST' })).status, 405);
    const st = await (await fetch(base + '/state')).json();
    assert.equal(st.tick, 0);
    assert.deepEqual(await (await fetch(base + '/reports')).json(), []);
    assert.equal((await fetch(base + '/reports/..%2f..%2fetc')).status, 404);
  } finally { srv.close(); }
});

test('report storage stops at the size cap on every append, not only at the periodic prune', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'multisplat-cap-'));
  const origin = 'http://game.invalid';
  let ipN = 0;
  const debug = createDebug({ dir, allowedOrigins: [origin], clientIp: () => 'ip' + ipN++, arena: null,
    events: createEventRing(100), keepBytes: 20000 });
  const srv = createServer(debug.handleReport);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const body = JSON.stringify({ v: 1, kind: 'manual', reason: 'x'.repeat(300), entries: Array.from({ length: 10 }, () => ({ msg: 'y'.repeat(250) })) });
    const codes = [];
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/debug/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body });
      codes.push(r.status); await r.text();
    }
    const bytes = readdirSync(dir).reduce((a, n) => a + statSync(join(dir, n)).size, 0);
    assert.ok(bytes <= 20000, `stored ${bytes} bytes`);
    assert.ok(codes.includes(200) && codes.at(-1) === 503, codes.join(','));
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('report strings lose control and bidi characters', () => {
  const { report } = validateReport({ reason: 'a\u001b[31mb\u202ec\u2066d\u009be' });
  assert.equal(report.reason, 'a[31mbcde');
});

test('tools/debug.js never prints terminal control characters from a report', async () => {
  const { execFile } = await import('node:child_process');
  const evil = { meta: { id: 'abcd1234' }, report: { reason: 'x\u009b31m\u001b]0;pwn\u0007‮ok' } };
  const srv = createServer((req, res) => { const b = JSON.stringify(evil); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(b); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const out = await new Promise((res, rej) => execFile(process.execPath, [new URL('../tools/debug.js', import.meta.url).pathname, '--port', String(srv.address().port), 'report', 'abcd1234'],
      { encoding: 'utf8' }, (e, so) => (e ? rej(e) : res(so))));
    assert.match(out, /UNTRUSTED/);
    // JSON.stringify escapes C0 itself; C1 (0x9b is CSI) and bidi controls must be replaced too
    assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/);
  } finally { srv.close(); }
});
