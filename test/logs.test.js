// Streamed client logs and word ids (SPEC §13.5): the word list, id assignment and persistence,
// {t:'log'} validation and rate limits, the one-hour pruning (fake clock), the memory caps, and the
// admin lookup by word, name or IP. The IP is always the server's view, never the payload's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Arena, KICK } from '../server/arena.js';
import { createLogStore, validateEntry } from '../server/logs.js';
import { createDebug, createEventRing, validateReport } from '../server/debug.js';
import { isWordId, randomWordId, WORDS, WORD_ID_COUNT, LOG } from '../shared/logid.js';

// A fake wall clock for the store and a fake monotonic clock for the arena, advanced together.
function setup({ caps = {} } = {}) {
  let t = 1000, wall = 1.7e12;
  const logs = createLogStore({ now: () => wall, ...caps });
  const arena = new Arena({ now: () => t, seed: 7, logs, heartbeatMs: 0 });
  const advance = ms => { t += ms; wall += ms; };
  const conn = (ip = 'ip-a', word) => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, word, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, typeof m === 'string' ? m : JSON.stringify(m));
    c.word = c.msgs.find(m => m.t === 'welcome').w;
    return c;
  };
  return { arena, logs, conn, advance };
}
const entry = (i, extra = {}) => ({ ts: 1000 + i, tick: i, cat: 'net', msg: 'm' + i, ...extra });

test('word ids: 100 x 100 list pairs; validation is exact', () => {
  assert.equal(WORDS.adj.length, 100); assert.equal(WORDS.noun.length, 100); assert.equal(WORD_ID_COUNT, 10000);
  assert.equal(new Set(WORDS.adj).size, 100); assert.equal(new Set(WORDS.noun).size, 100);
  let r = 0;
  for (let i = 0; i < 200; i++) assert.ok(isWordId(randomWordId(() => (r = (r + 0.37) % 1))));
  assert.ok(isWordId('amber-otter'));
  for (const bad of ['Amber-otter', 'amber-otter ', 'amber_otter', 'otter-amber', 'amber-otter-x', 'amber-', '', null, 7, {}, 'amber-otter\n'])
    assert.equal(isWordId(bad), false, JSON.stringify(bad));
});

test('the server assigns a word id on connect and keeps a valid stored one', () => {
  const { conn, logs } = setup();
  const a = conn();
  assert.ok(isWordId(a.word), 'welcome carries a word id');
  const b = conn('ip-b', 'amber-otter');
  assert.equal(b.word, 'amber-otter', 'a valid offered id is kept');
  for (const bad of ['admin-root', 'Amber-Otter', 'x'.repeat(500), '../etc']) {
    const c = conn('ip-c', bad);
    assert.ok(isWordId(c.word) && c.word !== bad, `refused ${bad}`);
  }
  assert.ok(logs.list().some(i => i.w === 'amber-otter' && i.ips[0] === 'ip-b'));
});

test('hello: the typed name tags the identity; an offered w is adopted, a bad one ignored', () => {
  const { conn, logs } = setup();
  const a = conn('ip-a');
  a.say({ t: 'hello', name: 'Kit', color: 1, w: 'not a word' });
  assert.equal(a.closed, null, 'a bad w is not a kick');
  assert.equal(logs.list().find(i => i.w === a.word).name, 'Kit');
  const b = conn('ip-b');
  b.say({ t: 'hello', name: 'Ash', color: 2, w: 'calm-heron', ip: '127.0.0.1' });
  assert.equal(b.conn.word, 'calm-heron');
  const id = logs.list().find(i => i.w === 'calm-heron');
  assert.equal(id.name, 'Ash'); assert.deepEqual(id.ips, ['ip-b'], 'the IP is the server view, not the payload');
});

test('log messages: entries stored with server metadata; bad shapes refused; caps per message', () => {
  const { conn, logs } = setup();
  const a = conn('ip-a');
  a.say({ t: 'log', e: [entry(1), entry(2, { data: { rtt: 40, s: 'x\u0007y‮' } })] });
  let [got] = logs.find(a.word);
  assert.equal(got.entries.length, 2);
  assert.deepEqual(got.ips, ['ip-a']);
  assert.equal(got.entries[1].data.s, 'xy', 'control and bidi characters stripped');
  assert.equal(got.entries[0].conn, a.conn.id);
  assert.match(got.entries[0].at, /^\d{4}-\d\d-\d\dT/);
  // forged metadata, verbose entries and junk are refused one by one, the rest kept
  a.say({ t: 'log', e: [entry(3, { ip: '127.0.0.1' }), entry(4, { at: 'x' }), entry(5, { cat: 'verbose' }), 5, 'x', null,
    { ts: 'no', cat: 'net', msg: 'm' }, entry(6, { msg: 'z'.repeat(1000) })] });
  [got] = logs.find(a.word);
  assert.equal(got.entries.length, 3);
  assert.equal(got.entries[2].msg.length, LOG.strMax);
  assert.ok(got.entries.every(e => e.at !== 'x'));
  assert.equal(got.bad, 7);
  // over LOG.maxEntries in one message: the excess is dropped and counted as lost
  a.say({ t: 'log', e: Array.from({ length: LOG.maxEntries + 5 }, (_, i) => entry(10 + i)), lost: 3 });
  [got] = logs.find(a.word);
  assert.equal(got.entries.length, 3 + LOG.maxEntries);
  assert.equal(got.lost, 8);
  // a non-array e is a malformed kick
  a.say({ t: 'log', e: 'x' });
  assert.equal(a.closed.code, KICK.malformed);
  // validateEntry alone
  assert.equal(validateEntry({ ts: 1, cat: 'net', msg: 'ok', extra: 1 }), null);
  assert.deepEqual(validateEntry({ ts: 1.4, tick: null, cat: 'life', msg: 'ok' }), { ts: 1, tick: 0, cat: 'life', msg: 'ok' });
});

test('log rate limit: LOG.burst messages, then LOG.perSec; drops count toward the flood kick', () => {
  const { conn, logs, advance } = setup();
  const a = conn();
  for (let i = 0; i < LOG.burst + 4; i++) a.say({ t: 'log', e: [entry(i)] });
  assert.equal(logs.find(a.word)[0].entries.length, LOG.burst);
  assert.equal(a.conn.logDropped, 4);
  assert.equal(a.closed, null, 'a few drops are no kick');
  advance(1000 / LOG.perSec);
  a.say({ t: 'log', e: [entry(99)] });
  assert.equal(logs.find(a.word)[0].entries.length, LOG.burst + 1);
  // sustained flooding (90 drops within 3 s) is the usual flood kick
  for (let i = 0; i < 200 && !a.closed; i++) { advance(5); a.say({ t: 'log', e: [] }); }
  assert.equal(a.closed.code, KICK.flood);
});

test('pruning: entries older than an hour go, then the identity', () => {
  let wall = 0;
  const logs = createLogStore({ now: () => wall });
  logs.touch('amber-otter', { ip: 'ip-a', name: 'Kit' });
  logs.add('amber-otter', [entry(1)], { ip: 'ip-a' });
  wall += 30 * 60000;
  logs.add('amber-otter', [entry(2)], { ip: 'ip-a' });
  logs.touch('calm-heron', { ip: 'ip-b' });     // a lobby visitor with no entries
  assert.equal(logs.find('amber-otter')[0].entries.length, 2);
  wall += 31 * 60000;
  assert.deepEqual(logs.find('amber-otter')[0].entries.map(e => e.msg), ['m2']);
  assert.ok(logs.find('calm-heron').length, 'seen 31 min ago: kept');
  wall += 30 * 60000;
  assert.equal(logs.find('amber-otter').length, 0);
  assert.equal(logs.find('calm-heron').length, 0);
  assert.deepEqual(logs.stats(), { ids: 0, bytes: 0, entries: 0 });
});

test('memory caps: entries per identity, identities, total bytes', () => {
  let wall = 0;
  const logs = createLogStore({ now: () => wall, maxPerId: 50, maxIds: 3, maxBytes: 20000 });
  logs.add('amber-otter', Array.from({ length: 80 }, (_, i) => entry(i)));
  let e = logs.find('amber-otter')[0].entries;
  assert.equal(e.length, 50); assert.equal(e[0].msg, 'm30', 'oldest dropped first');
  // identity cap: the empty one goes first, then the oldest seen
  wall++; logs.touch('calm-heron');
  wall++; logs.add('bold-crane', [entry(1)]);
  wall++; logs.add('brave-deer', [entry(1)]);
  assert.equal(logs.stats().ids, 3);
  assert.equal(logs.find('calm-heron').length, 0);
  wall++; logs.add('cosmic-dove', [entry(1)]);
  assert.equal(logs.find('amber-otter').length, 0, 'oldest seen evicted');
  // byte cap: the oldest data goes, whoever holds it
  for (let i = 0; i < 200; i++) { wall++; logs.add('zesty-yak', [entry(i, { data: { pad: 'p'.repeat(250) } })]); }
  assert.ok(logs.stats().bytes <= 20000, `bytes ${logs.stats().bytes}`);
  assert.ok(logs.find('zesty-yak')[0].entries.length > 10);
});

test('admin listener: /logs lists identities, /logs/<q> finds by word, name or ip', async () => {
  const { conn, arena } = setup();
  const a = conn('ip-a'), b = conn('ip-b');
  a.say({ t: 'hello', name: 'Kit', color: 1 });
  a.say({ t: 'log', e: [entry(1), entry(2)] });
  b.say({ t: 'log', e: [entry(3)] });
  const debug = createDebug({ dir: '/nonexistent-multisplat-test', allowedOrigins: [], clientIp: () => 'x', arena, events: createEventRing(10) });
  const srv = createServer(debug.adminHandler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const get = async p => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`)).json();
  try {
    const list = await get('/logs');
    assert.deepEqual(list.map(i => i.w).sort(), [a.word, b.word].sort());
    assert.equal(list.find(i => i.w === a.word).entries, 2);
    for (const q of [a.word, 'Kit', 'kit', 'ip-a']) {
      const r = await get('/logs/' + encodeURIComponent(q));
      assert.equal(r.length, 1, q); assert.equal(r[0].w, a.word);
      assert.deepEqual(r[0].entries.map(e => e.msg), ['m1', 'm2'], 'oldest first');
    }
    assert.deepEqual(await get('/logs/nobody'), []);
    assert.equal((await get('/logs/ip-b'))[0].w, b.word);
  } finally { srv.close(); }
});

test('reports may carry the word id; the server view of the connection has it too', () => {
  assert.equal(validateReport({ v: 1, kind: 'manual', w: 'amber-otter' }).report.w, 'amber-otter');
  const { conn, arena } = setup();
  const a = conn('ip-a', 'amber-otter');
  a.say({ t: 'hello', name: 'Kit', color: 1 });
  const token = a.msgs.find(m => m.t === 'welcome' && m.token).token;
  assert.equal(arena.viewByToken(token).conn.word, 'amber-otter');
});
