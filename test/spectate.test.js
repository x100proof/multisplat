// Spectator mode (SPEC §16): the camera-target rules in shared/spectate.js, and the server facts a
// watcher relies on (a lobby viewer gets every snapshot and event, takes no slot, and its input is
// ignored), checked on the socket-less Arena with fake connections and a fake clock.
import test from 'node:test';
import { roomOf, withRoom } from './lib.js';
import assert from 'node:assert/strict';
import { Arena } from '../server/arena.js';
import { KEY, TICK_MS, PW, PH } from '../shared/constants.js';
import { PICK_TOL, pickAt, leaderOf, followTarget, cycleTarget } from '../shared/spectate.js';

const P = (id, x, y, alive = true) => ({ id, x, y, w: PW, h: PH, alive });
const R = (id, score, deaths = 0) => ({ id, score, deaths });

test('pickAt: the nearest living ninja within the tolerance, name tag included', () => {
  const ps = [P(1, 100, 100), P(2, 130, 100), P(3, 200, 100, false)];
  assert.equal(pickAt(ps, 105, 106), 1, 'inside the body');
  assert.equal(pickAt(ps, 105, 92), 1, 'on the name tag above the head');
  assert.equal(pickAt(ps, 113, 106, PICK_TOL.mouse), 1, '3 units right of the body: a mouse still hits');
  assert.equal(pickAt(ps, 121, 106, PICK_TOL.touch), 2, 'both within reach: the nearer (2, 9 units off) wins over 1 (11 units)');
  assert.equal(pickAt(ps, 160, 106, PICK_TOL.mouse), null, 'empty space');
  assert.equal(pickAt(ps, 152, 106, PICK_TOL.touch), 2, 'a fingertip reaches further');
  assert.equal(pickAt(ps, 205, 106, PICK_TOL.touch), null, 'the dead are not drawn whole, so not picked');
  assert.equal(pickAt([], 0, 0), null);
});

test('the default target is the leader, followed through death; a chosen ninja is kept until it leaves', () => {
  const ps = [P(1, 0, 0), P(2, 50, 0, false), P(3, 90, 0)];
  const rows = [R(1, 2), R(2, 5), R(3, 5, 1)];
  assert.equal(leaderOf(ps, rows), 2, 'top score (ties: fewer deaths), even while dead');
  assert.equal(leaderOf(ps, [R(9, 99), ...rows]), 2, 'someone on the roster but not in the view is skipped');
  assert.equal(leaderOf(ps, []), 1, 'no roster yet: the lowest id in view');
  assert.equal(leaderOf([], rows), null, 'nobody there: the centre');
  assert.deepEqual(followTarget(ps, rows, null), { chosen: null, id: 2 });
  assert.deepEqual(followTarget(ps, rows, 3), { chosen: 3, id: 3 });
  assert.deepEqual(followTarget([P(1, 0, 0), P(2, 0, 0)], rows, 3), { chosen: null, id: 2 }, 'the chosen one left: back to the leader for good');
});

test('cycleTarget walks the score order and wraps', () => {
  const ps = [P(1, 0, 0), P(2, 0, 0), P(3, 0, 0)];
  const rows = [R(1, 0), R(2, 3), R(3, 1)];   // order: 2, 3, 1
  assert.equal(cycleTarget(ps, rows, 2, 1), 3);
  assert.equal(cycleTarget(ps, rows, 1, 1), 2, 'wraps');
  assert.equal(cycleTarget(ps, rows, 2, -1), 1, 'wraps backwards');
  assert.equal(cycleTarget(ps, rows, 7, 1), 3, 'unknown current: from the top');
  assert.equal(cycleTarget([...ps, P(4, 0, 0)], rows, 1, 1), 4, 'a ninja in view before the roster lists it is reachable');
  assert.equal(cycleTarget([], rows, 1, 1), null);
});

test('a watcher (lobby viewer) gets snapshots and events with a full arena, takes no slot, and cannot steer', () => {
  let t = 1000;
  const arena = new Arena({ now: () => t, seed: 3, maxPlayers: 2, heartbeatMs: 0 });
  const conn = () => {
    const c = { msgs: [] };
    c.conn = arena.connect({ ip: 'test', send: s => c.msgs.push(JSON.parse(s)), close: (code) => { c.closed = code; } });
    c.say = m => arena.onMessage(c.conn, JSON.stringify(withRoom(arena, m)));
    return c;
  };
  const tick = n => { for (let i = 0; i < n; i++) { t += TICK_MS; arena.tick(); } };
  const a = conn(), b = conn(), q = conn();
  a.say({ t: 'hello', name: 'Ann', color: 0 });
  const w = conn();                                   // pressed Watch: no hello at all,
  w.say({ t: 'view', room: 1 });                      // only the room selected (SPEC §17)
  b.say({ t: 'hello', name: 'Bo', color: 1 });
  q.say({ t: 'hello', name: 'Cy', color: 2 });
  assert.equal([...q.msgs].reverse().find(m => m.t === 'welcome').state, 'queue', 'the arena is full: a queue');
  tick(60);
  const snaps = w.msgs.filter(m => m.t === 'snapshot');
  assert.ok(snaps.length >= 25, 'snapshots at 30 Hz');
  assert.equal(snaps.at(-1).seq, -1); assert.equal(snaps.at(-1).me, undefined, 'no own player');
  assert.deepEqual(snaps.at(-1).p.map(p => p[0]).sort(), [1, 2], 'every fighter, positions included');
  assert.ok(w.msgs.some(m => m.t === 'event' && m.ev.some(e => e.type === 'spawn')), 'events too');
  assert.equal(roomOf(arena).activeCount(), 2);
  const lob = [...w.msgs].reverse().find(m => m.t === 'lobby');
  assert.equal(lob.players.length, 2); assert.equal(lob.queue.length, 1, 'the watcher is in neither list');
  assert.equal(lob.rooms[0].watch, 1, 'the room list counts the watcher');
  // input from a watcher is ignored (not a kick: a well-formed message), and moves nobody
  const before = roomOf(arena).state.players.map(p => [p.id, p.x]);
  for (let s = 1; s <= 30; s++) { w.say({ t: 'input', seq: s, keys: KEY.RIGHT | KEY.RUN }); tick(1); }
  assert.equal(w.closed, undefined, 'still connected');
  assert.deepEqual(roomOf(arena).state.players.map(p => [p.id, p.x]), before, 'nobody moved');
  assert.equal(roomOf(arena).activeCount(), 2);
  // chat from a watcher is ignored too
  const chats = () => [a, b, q, w].flatMap(c => c.msgs).filter(m => m.t === 'event' && m.ev.some(e => e.type === 'chat')).length;
  const n = chats(); w.say({ t: 'chat', text: 'hi' }); tick(1);
  assert.equal(chats(), n);
  // from watching, Fight still works: the hello queues behind Cy
  w.say({ t: 'hello', name: 'Di', color: 3 });
  const wel = [...w.msgs].reverse().find(m => m.t === 'welcome' && m.id);
  assert.equal(wel.state, 'queue'); assert.equal(wel.queuePos, 2);
});
