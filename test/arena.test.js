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
import { KEY, TICK_MS, DEFAULTS, NET } from '../shared/constants.js';

// The heartbeat (SPEC §6.4) stays on in every test: like the real client, each fake connection
// pings every NET.pingMs of fake time while the clock advances (its pongs are kept out of `msgs`),
// unless the test silences it (`c.silent = true`) or connects it with `conn({silent: true})`.
// `setup({pings: false})` stops the automatic pings for every connection.
const HB_PING_ID = 2 ** 30;
function setup(opts = {}) {
  const { pings = true, ...arenaOpts } = opts;
  let t = 1000;
  const fakes = [];
  const heartbeat = () => {
    if (!pings) return;
    for (const c of fakes) if (!c.silent && !c.conn.closed && t - c.pingAt >= NET.pingMs) {
      c.pingAt = t; arena.onMessage(c.conn, JSON.stringify({ t: 'ping', id: HB_PING_ID }));
    }
  };
  // advance in steps no longer than a ping interval, pinging as the real client would
  const clock = { now: () => t, advance: ms => { while (ms > 0) { const d = Math.min(ms, NET.pingMs); t += d; ms -= d; heartbeat(); } } };
  const events = createEventRing(2000);
  const arena = new Arena({ now: clock.now, seed: 7, event: events.push, ...arenaOpts });
  const conn = ({ silent = false } = {}) => {
    const c = { msgs: [], closed: null, silent, pingAt: t };
    c.conn = arena.connect({ ip: 'test', send: s => { const m = JSON.parse(s); if (!(m.t === 'pong' && m.id === HB_PING_ID)) c.msgs.push(m); },
      close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, typeof m === 'string' ? m : JSON.stringify(m));
    c.last = t => [...c.msgs].reverse().find(m => m.t === t);
    c.all = t => c.msgs.filter(m => m.t === t);
    c.events = () => c.msgs.filter(m => m.t === 'event').flatMap(m => m.ev);
    fakes.push(c);
    return c;
  };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { clock.advance(TICK_MS); arena.tick(); } };
  return { arena, clock, conn, tick, events };
}

test('connect gets a server welcome and the lobby; hello joins the arena', () => {
  const { conn, tick, arena } = setup({ build: 'abc123' });
  const a = conn();
  assert.equal(a.msgs[0].b, 'abc123', 'every welcome carries the build id');
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

test('resume within the 5 s grace period keeps the slot and score; after it the token is refused', () => {
  const { conn, tick, arena, clock } = setup();
  assert.equal(arena.graceMs, 5000);
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 2 });
  const { token, id } = a.last('welcome');
  tick(5);
  Sim.getPlayer(arena.state, id).score = 3;
  arena.disconnect(a.conn);
  clock.advance(4000); tick(1);
  const a2 = conn(); a2.say({ t: 'hello', name: 'A', color: 2, token });
  const w = a2.last('welcome');
  assert.equal(w.resumed, true); assert.equal(w.id, id);
  assert.equal(w.players.find(p => p.id === id).score, 3);
  arena.disconnect(a2.conn);
  clock.advance(6000); tick(1);
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

test('leave frees the slot at once, keeps the connection as a viewer, and promotes the queue', () => {
  const { conn, tick, arena } = setup({ maxPlayers: 1 });
  const [a, b] = [conn(), conn()];
  a.say({ t: 'hello', name: 'A', color: 0 }); b.say({ t: 'hello', name: 'B', color: 1 });
  assert.equal(b.last('welcome').state, 'queue');
  tick(5);
  const token = a.last('welcome').token;
  a.say({ t: 'leave' });
  assert.equal(a.closed, null, 'the connection stays open');
  assert.equal(arena.recs.has(1), false);
  assert.ok(b.events().some(e => e.type === 'leave' && e.id === 1 && e.reason === 'left'));
  assert.equal(arena.recs.get(2).state, 'play', 'the queued player takes the slot');
  a.msgs.length = 0; tick(4);
  assert.ok(a.last('snapshot'), 'still gets snapshots as a viewer'); assert.equal(a.last('snapshot').me, undefined);
  a.say({ t: 'leave' }); assert.equal(a.closed, null, 'a second leave is harmless');
  a.say({ t: 'hello', name: 'A', color: 0, token });   // the old token is dead: a fresh record, queued behind B
  const w = a.last('welcome');
  assert.equal(w.resumed, false); assert.equal(w.id, 3); assert.equal(w.state, 'queue');
  a.say({ t: 'leave' });
  assert.equal(arena.queue.length, 0, 'leaving the queue gives up the place');
});

test('heartbeat: a silent lobby viewer is closed after 5 s with the timeout code, not a kick', () => {
  const { conn, tick, arena, clock, events } = setup();
  assert.equal(arena.heartbeatMs, 5000);
  const v = conn({ silent: true }), w = conn();          // w pings: kept
  clock.advance(4900); tick(1);
  assert.equal(v.closed, null, 'still open before 5 s');
  clock.advance(200); tick(1);
  assert.deepEqual(v.closed, { code: NET.timeoutClose, reason: 'timeout' });
  assert.ok(NET.timeoutClose >= 4000 && NET.timeoutClose < 5000 && !Object.values(KICK).includes(NET.timeoutClose), 'a distinct code');
  assert.equal(v.last('kick'), undefined, 'no kick message');
  assert.ok(!arena.conns.has(v.conn));
  assert.equal(w.closed, null);
  const ev = events.list(50);
  assert.ok(ev.some(e => e.type === 'timeout' && e.conn === v.conn.id && e.player === null && e.silentMs >= 5000), 'timeout in the event ring');
});

test('heartbeat: any message counts; a silent queued spectator is closed too', () => {
  const { conn, tick, arena, clock } = setup({ maxPlayers: 1 });
  const a = conn(), q = conn({ silent: true });
  a.say({ t: 'hello', name: 'A', color: 0 }); q.say({ t: 'hello', name: 'Q', color: 1 });
  assert.equal(q.last('welcome').state, 'queue');
  clock.advance(3000); tick(1);
  q.say({ t: 'input', seq: 1, keys: 0 });                // an input is a sign of life as well
  clock.advance(3000); tick(1);
  assert.equal(q.closed, null);
  clock.advance(2100); tick(1);
  assert.equal(q.closed.code, NET.timeoutClose);
  assert.equal(arena.recs.get(q.last('welcome').id).conn, null, 'queue record kept for a resume');
});

test('heartbeat: a silent player is dropped, kept for the 5 s grace, then released', () => {
  const { conn, tick, arena, clock, events } = setup();
  const a = conn(), b = conn();
  a.say({ t: 'hello', name: 'A', color: 0 }); b.say({ t: 'hello', name: 'B', color: 1 });
  const id = a.last('welcome').id;
  tick(10);
  a.silent = true;                                       // the tab stops pinging (and sending inputs)
  clock.advance(5000); tick(1);
  assert.equal(a.closed.code, NET.timeoutClose);
  const rec = arena.recs.get(id);
  assert.ok(rec && rec.conn === null && rec.state === 'play', 'record kept, away');
  assert.ok(Sim.getPlayer(arena.state, id), 'still in the world during the grace period');
  const ev = events.list(50);
  assert.ok(ev.some(e => e.type === 'timeout' && e.player === id));
  assert.ok(ev.some(e => e.type === 'drop' && e.player === id), 'the normal drop path');
  tick(30);                                              // ~0.5 s
  assert.equal(b.last('lobby').players.find(p => p.id === id).away, true);
  clock.advance(4200); tick(1);                          // ~4.7 s after the drop
  assert.ok(arena.recs.has(id), 'not released before the grace period ends');
  clock.advance(400); tick(1);
  assert.ok(!arena.recs.has(id), 'released');
  assert.equal(Sim.getPlayer(arena.state, id), null);
  assert.ok(b.events().some(e => e.type === 'leave' && e.id === id && e.reason === 'timeout'));
  assert.equal(b.closed, null, 'the pinging player is untouched');
});

test('heartbeat: a pinging player with no input is kept (until the 120 s idle kick)', () => {
  const { conn, tick, arena, clock } = setup();
  const a = conn(); a.say({ t: 'hello', name: 'A', color: 0 });
  const id = a.last('welcome').id;
  for (let i = 0; i < 60; i++) { clock.advance(1000); tick(1); }
  assert.equal(a.closed, null);
  assert.equal(arena.recs.get(id).conn, a.conn);
  assert.equal(arena.activeCount(), 1);
});

test('heartbeat: a timed-out player resumes inside 5 s; at 6 s an automatic resume is refused', () => {
  const { conn, tick, arena, clock } = setup();
  const a = conn({ silent: true }); a.say({ t: 'hello', name: 'A', color: 2 });
  const { token, id } = a.last('welcome');
  tick(5);
  Sim.getPlayer(arena.state, id).score = 2;
  clock.advance(5000); tick(1);
  assert.equal(a.closed.code, NET.timeoutClose);
  clock.advance(4000); tick(1);
  const a2 = conn({ silent: true }); a2.say({ t: 'hello', name: 'A', color: 2, token, resume: true });
  assert.equal(a2.last('welcome').resumed, true); assert.equal(a2.last('welcome').id, id);
  assert.equal(a2.last('welcome').players.find(p => p.id === id).score, 2, 'score kept');
  clock.advance(5000); tick(1);                          // silent again: timed out again
  assert.equal(a2.closed.code, NET.timeoutClose);
  clock.advance(6000); tick(1);
  assert.ok(!arena.recs.has(id), 'released after the grace period');
  const a3 = conn(); a3.say({ t: 'hello', name: 'A', color: 2, token, resume: true });
  const w = a3.last('welcome');
  assert.equal(w.resumed, false); assert.equal(w.expired, true); assert.equal(w.id, undefined, 'not joined');
  assert.equal(a3.closed, null, 'stays a lobby viewer');
  assert.equal(arena.activeCount(), 0);
  // a manual join with the dead token (no resume flag) joins afresh
  a3.say({ t: 'hello', name: 'A', color: 2, token });
  assert.equal(a3.last('welcome').resumed, false); assert.notEqual(a3.last('welcome').id, id);
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

test('long swords: item/pickup events relayed; snapshots carry pickups and long; a joiner sees them', () => {
  const { conn, tick, arena } = setup({ cfg: { ...DEFAULTS, itemMinTicks: 30, itemMaxTicks: 30 } });
  const a = conn(), b = conn(), viewer = conn();
  a.say({ t: 'hello', name: 'A', color: 0 }); b.say({ t: 'hello', name: 'B', color: 1 });
  tick(80);
  const items = a.events().filter(e => e.type === 'item');
  assert.equal(items.length, 2, 'two appeared (30 ticks apart)');
  assert.ok(viewer.events().some(e => e.type === 'item'), 'viewers get item events too');
  let snap = a.last('snapshot');
  assert.deepEqual(snap.it, arena.state.items.map(i => [i.id, i.x, i.y, 0]), '[id, x, y, kind 0 = long sword]');
  assert.equal(snap.it.length, 2);
  // put A on the first pickup
  const it = arena.state.items[0], pa = Sim.getPlayer(arena.state, 1);
  Object.assign(pa, { x: it.x - 5, y: it.y - 13, px: it.x - 5, py: it.y - 13, vx: 0, vy: 0, iframes: 0 });
  tick(2);
  const pick = a.events().find(e => e.type === 'pickup');
  assert.deepEqual([pick.id, pick.item, pick.x, pick.y], [1, it.id, it.x, it.y]);
  assert.ok(b.events().some(e => e.type === 'pickup' && e.id === 1));
  snap = a.last('snapshot');
  assert.equal(snap.me.long, true, 'the holder learns it from `me`');
  assert.equal(snap.p.find(r => r[0] === 1)[8] & 8, 8, 'long flag bit for the holder');
  assert.equal(snap.p.find(r => r[0] === 2)[8] & 8, 0);
  assert.deepEqual(snap.it.map(r => r[0]), [items[1].id], 'the taken pickup is gone');
  // a mid-game joiner learns pickups and holders from its first snapshot alone
  const c = conn();
  c.say({ t: 'hello', name: 'C', color: 2 });
  tick(2);
  const cs = c.last('snapshot');
  assert.deepEqual(cs.it.map(r => r[0]), [items[1].id]);
  assert.equal(cs.p.find(r => r[0] === 1)[8] & 8, 8);
  assert.ok(JSON.stringify(cs).length < 2000, 'snapshot size stays small');
  // admin state shows pickups and holders
  const adm = arena.adminState();
  assert.deepEqual(adm.items.map(i => i.id), [items[1].id]);
  assert.equal(adm.players.find(p => p.id === 1).long, true);
  assert.equal(adm.players.find(p => p.id === 2).long, false);
  // the holder dies: the flag goes on every client's next snapshot, and the kill says it was held
  const kills = Sim.killPlayer(arena.state, 1, 'self');
  assert.equal(kills[0].held, true);
  tick(2);
  assert.equal(c.last('snapshot').p.find(r => r[0] === 1)[8] & 8, 0);
  assert.equal(a.last('snapshot').me.long, false);
});

test('lag compensation with a long sword: the rewound check uses the longer box', () => {
  for (const long of [false, true]) {
    const { conn, tick, arena } = setup();
    const a = conn(), v = conn();
    a.say({ t: 'hello', name: 'A', color: 0 }); v.say({ t: 'hello', name: 'V', color: 1 });
    tick(100);
    const st = arena.state, pa = Sim.getPlayer(st, 1), pv = Sim.getPlayer(st, 2);
    st.itemT = 1e9;
    Object.assign(pa, { x: 60, y: 259, vx: 0, vy: 0, face: 1, iframes: 0, long });
    Object.assign(pv, { x: 90, y: 259, vx: 0, vy: 0, iframes: 0 });   // beyond standard reach (78), inside long (96.8)
    a.conn.rtt = 60;
    tick(12);
    let seq = 1;
    a.say({ t: 'input', seq: seq++, keys: KEY.SLASH });
    for (let i = 0; i < 8; i++) { pv.x = 300; a.say({ t: 'input', seq: seq++, keys: 0 }); tick(1); }
    assert.equal(a.events().filter(e => e.type === 'hit').length, long ? 1 : 0, 'long ' + long);
  }
});

test('ninja stars: the throw bit passes input validation, bit 64 does not; snapshots carry counts, pickups and stars in flight', () => {
  const { conn, tick, arena } = setup();
  const a = conn(), v = conn(), w = conn();                // w: a lobby viewer
  a.say({ t: 'hello', name: 'A', color: 0 }); v.say({ t: 'hello', name: 'V', color: 1 });
  tick(4);
  const st = arena.state, pa = Sim.getPlayer(st, 1), pv = Sim.getPlayer(st, 2);
  st.itemT = 1e9; st.starT = 1e9;
  Object.assign(pa, { x: 40, y: 259, px: 40, py: 259, vx: 0, vy: 0, face: 1, iframes: 0, stars: 2 });
  Object.assign(pv, { x: 150, y: 259, px: 150, py: 259, vx: 0, vy: 0, iframes: 0 });
  st.items.push({ id: 90, x: 344, y: 272, kind: 'star' }, { id: 91, x: 72, y: 208, kind: 'long' });
  tick(2);
  let snap = w.last('snapshot');
  const row = snap.p.find(r => r[0] === 1);
  assert.equal(row.length, 13); assert.equal(row[12], 2, 'star count per player');
  assert.deepEqual(snap.it.map(i => [i[0], i[3]]), [[90, 1], [91, 0]], 'pickups with their kind');
  assert.deepEqual(snap.st, [], 'no stars in flight');
  assert.equal(a.last('snapshot').me.stars, 2, '`me` carries the count');
  // throw: keys 32 is a valid mask (and 63); the star flies, every connection sees it, then the hit
  a.say({ t: 'input', seq: 1, keys: KEY.THROW | KEY.RIGHT });
  tick(2);
  assert.equal(a.closed, null, 'the throw bit is allowed');
  snap = w.last('snapshot');
  assert.equal(snap.st.length, 1);
  const [sid, sx, sy, svx, owner] = snap.st[0];
  assert.ok(Number.isInteger(sid) && sx > 45 && Math.abs(sy - (pa.y + 6)) < .02 && svx === 6 && owner === 1, JSON.stringify(snap.st));
  assert.equal(snap.p.find(r => r[0] === 1)[12], 1, 'count down by one');
  assert.ok(snap.p.find(r => r[0] === 1)[11] & 16, 'the throw FX bit reaches remote players');
  a.say({ t: 'input', seq: 2, keys: 0 });
  tick(30);
  for (const c of [a, v, w]) {
    assert.ok(c.events().some(e => e.type === 'throw' && e.id === 1 && e.stars === 1), 'throw event');
    assert.ok(c.events().some(e => e.type === 'hit' && e.move === 'star' && e.attacker === 1 && e.victim === 2 && e.dmg === 20), 'star hit event');
  }
  assert.equal(w.last('snapshot').st.length, 0, 'spent');
  assert.equal(pv.hp, 80);
  // admin state lists star pickups, stars in flight and counts
  a.say({ t: 'input', seq: 3, keys: KEY.THROW });
  tick(1);
  const ad = arena.adminState();
  assert.ok(ad.items.some(i => i.id === 90 && i.kind === 'star'));
  assert.equal(ad.stars.length, 1); assert.equal(ad.stars[0].owner, 1);
  assert.equal(ad.players.find(p => p.id === 1).stars, 0);
  assert.ok(typeof ad.starInS === 'number');
  // a mask outside the 6 bits is malformed
  a.say({ t: 'input', seq: 4, keys: 64 });
  assert.equal(a.last('kick').reason, 'malformed');
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
  assert.equal(c.itemSecs, null);
  assert.deepEqual(loadConfig({ ITEM_SECS: '2,3' }).itemSecs, { min: 2, max: 3 });
  assert.throws(() => loadConfig({ ITEM_SECS: '2,3', NODE_ENV: 'production' }), /production/);
  assert.throws(() => loadConfig({ ITEM_SECS: '3,2' }));
  assert.deepEqual(loadConfig({ STAR_SECS: '1,2' }).starSecs, { min: 1, max: 2 });
  assert.throws(() => loadConfig({ STAR_SECS: '1,2', NODE_ENV: 'production' }), /production/);
  assert.throws(() => loadConfig({ STAR_SECS: '0' }));
  assert.deepEqual(loadConfig({ ITEM_POINTS: '0,1' }).itemPoints, [0, 1]);
  assert.throws(() => loadConfig({ ITEM_POINTS: '0', NODE_ENV: 'production' }), /production/);
  assert.throws(() => loadConfig({ ITEM_POINTS: '99' }));
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
