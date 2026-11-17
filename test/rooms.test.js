// Rooms (SPEC §17) on the socket-less arena: create and its limits, the admin role (transfer, leave,
// grace-expiry hand-over), closing, renaming, isolation between rooms and per-room names and colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, KICK, PROTOCOL } from '../server/arena.js';
import { createEventRing } from '../server/debug.js';
import { NET, TICK_MS, ROOM, cleanRoomName, defaultRoomName } from '../shared/constants.js';

function setup(opts = {}) {
  let t = 1000;
  const events = createEventRing(2000), logs = [];
  const arena = new Arena({ now: () => t, seed: 5, heartbeatMs: 0, event: events.push, log: s => logs.push(s), ...opts });
  const conn = (ip = 'test') => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, typeof m === 'string' ? m : JSON.stringify(m));
    c.last = ty => [...c.msgs].reverse().find(m => m.t === ty);
    c.all = ty => c.msgs.filter(m => m.t === ty);
    c.events = () => c.msgs.filter(m => m.t === 'event').flatMap(m => m.ev);
    c.id = () => c.last('welcome')?.id;
    return c;
  };
  // a connection that creates a room (from its own address unless given), its pending admin, then
  // presses FIGHT (a hello into it) and is its admin as a player
  const maker = (name, room = '', ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'create', name, room }); return c; };
  const creator = (name, room = '', ip = 'ip-' + name) => {
    const c = maker(name, room, ip), l = c.last('lobby');
    if (l && l.mine) c.say({ t: 'hello', name, color: 0, room: l.room });
    return c;
  };
  const joiner = (name, room, color = 1, ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'hello', name, color, room }); return c; };
  const advance = ms => { t += ms; };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { t += TICK_MS; arena.tick(); } };
  return { arena, conn, maker, creator, joiner, advance, tick, events, logs };
}

test('rooms: protocol 5; a new connection sees an empty room list', () => {
  const { conn } = setup();
  const c = conn();
  assert.equal(PROTOCOL, 5); assert.equal(c.msgs[0].v, 5);
  const l = c.last('lobby');
  assert.deepEqual(l.rooms, []); assert.equal(l.maxRooms, ROOM.max); assert.equal(l.room, null);
  assert.equal(l.cap, 8); assert.equal(NET.maxPlayers, 8);
});

test('rooms: create makes the creating connection the pending admin, without joining', () => {
  const { arena, conn, maker, tick } = setup();
  const v = conn();
  const p = maker('Ann');
  assert.equal(p.last('welcome').id, undefined, 'no player record: create does not join');
  let l = p.last('lobby');
  assert.equal(l.room, 1); assert.equal(l.mine, true); assert.equal(l.admin, null); assert.deepEqual(l.players, []);
  assert.equal(l.rname, "Ann's room");
  assert.deepEqual(l.rooms, [{ id: 1, name: "Ann's room", admin: 'Ann', n: 0, cap: 8, bots: 0, q: 0, watch: 1 }]);
  tick(40); assert.equal(v.last('lobby').mine, false); assert.equal(v.last('lobby').rooms[0].admin, 'Ann');
  // without a player name the room is "Room <id>" and the list shows no admin name
  const q = conn('q'); q.say({ t: 'create' });
  assert.equal(q.last('lobby').rname, 'Room 2'); assert.equal(q.last('lobby').rooms[1].admin, null);
  // the pending admin sets AI players and renames before fighting
  p.say({ t: 'bots', n: 2 }); assert.equal(arena.rooms.get(1).bots.length, 2);
  p.say({ t: 'rename', name: 'Dojo' }); assert.equal(arena.rooms.get(1).name, 'Dojo');
  // FIGHT: a hello into the room joins as a normal player and stays admin
  p.say({ t: 'hello', name: 'Ann', color: 0, room: 1 });
  const w = p.last('welcome');
  assert.equal(w.state, 'play'); assert.equal(w.admin, w.id); assert.equal(arena.rooms.get(1).adminId, w.id);
  assert.equal(arena.rooms.get(1).adminConn, null); assert.equal(p.last('lobby').mine, true);
  q.say({ t: 'view', room: 0 }); void q;
});

test('rooms: a created room closes when its pending admin looks away or disconnects with nobody else looking at it', () => {
  const { arena, conn, maker, tick } = setup();
  const a = maker('Ann');
  a.say({ t: 'bots', n: 3 });
  const v = conn();                                      // on the room list: not a visitor of the room
  a.say({ t: 'view', room: 0 });
  assert.equal(arena.rooms.size, 0); assert.equal(arena.recs.size, 0, 'its bots went with it');
  assert.equal(a.last('closed'), undefined, 'the creator went back on its own: no notice');
  assert.equal(a.last('lobby').room, null);
  assert.equal(v.last('closed'), undefined); tick(40); assert.deepEqual(v.last('lobby').rooms, []);
  // disconnecting: the seat is held for the grace period (a reload takes it back), then the room closes
  const b = maker('Bea'); b.say({ t: 'bots', d: 1 });
  arena.disconnect(b.conn);
  assert.equal(arena.rooms.size, 1); assert.ok(arena.rooms.get(2).seat);
  tick(Math.ceil(arena.graceMs / TICK_MS) + 2);
  assert.equal(arena.rooms.size, 0); assert.equal(arena.recs.size, 0);
  // looking at another room
  const c = maker('Cy'), d = maker('Di');
  c.say({ t: 'view', room: 4 });
  assert.deepEqual([...arena.rooms.keys()], [4]); assert.equal(c.last('lobby').room, 4);
  // a create from a pending admin is a protocol kick (admin of one room at most)
  d.say({ t: 'create', name: 'Di' }); assert.equal(d.closed.code, KICK.protocol);
  assert.deepEqual([...arena.rooms.keys()], [4]); assert.equal(arena.rooms.get(4).adminConn, c.conn, 'its visitor took over');
  c.say({ t: 'view', room: 0 }); assert.equal(arena.rooms.size, 0);
  // a room held only by its pending admin closes after ROOM.pendingMs without an admin action
  const e = maker('Ed');
  tick(Math.ceil(ROOM.pendingMs / TICK_MS) + 2);
  assert.equal(arena.rooms.size, 0); assert.equal(e.last('closed').why, 'idle');
});

test('rooms: a pending admin with other humans in the room must hand over; disconnecting hands over at once', () => {
  const { arena, maker, joiner, advance } = setup();
  const a = maker('Ann');
  const b = joiner('Bea', 1); advance(100); const c = joiner('Cy', 1);
  const room = arena.rooms.get(1);
  assert.equal(room.adminId, null, 'a joiner does not take a pending admin\'s role');
  assert.equal(b.last('lobby').mine, false); assert.equal(a.last('lobby').mine, true);
  a.say({ t: 'view', room: 0 });
  assert.deepEqual(a.last('refused'), { t: 'refused', what: 'leave', why: 'admin' });
  assert.equal(a.last('lobby').room, 1, 'still on the room');
  // a pending admin may hand over by hand
  a.say({ t: 'admin', id: c.id() });
  assert.equal(room.adminId, c.id()); assert.equal(room.adminConn, null);
  a.say({ t: 'view', room: 0 }); assert.equal(arena.rooms.size, 1);
  // a pending admin who disconnects: the longest-present human takes over at once
  const d = maker('Di', 'Two'), e = joiner('Ed', 2); advance(100); joiner('Fy', 2);
  arena.disconnect(d.conn);
  assert.equal(arena.rooms.get(2).adminId, e.id());
  assert.ok(e.events().some(ev => ev.type === 'admin' && ev.id === e.id() && ev.why === 'auto'));
  // the last joiner leaving a room whose pending admin is still there keeps it open
  const g = maker('Gi', 'Three'); const h = joiner('Hu', 3);
  h.say({ t: 'leave' });
  assert.ok(arena.rooms.has(3)); assert.equal(arena.rooms.get(3).adminConn, g.conn);
});

test('rooms: create lists the room for everyone; names are checked', () => {
  const { arena, conn, creator, tick } = setup();
  const v = conn();
  const a = creator('Ann');
  const w = a.last('welcome');
  assert.equal(w.state, 'play'); assert.equal(w.room, 1); assert.equal(w.admin, w.id); assert.equal(w.rname, "Ann's room");
  assert.equal(a.last('lobby').room, 1); assert.equal(a.last('lobby').admin, w.id);
  tick(40);
  assert.deepEqual(v.last('lobby').rooms, [{ id: 1, name: "Ann's room", admin: 'Ann', n: 1, cap: 8, bots: 0, q: 0, watch: 0 }]);
  assert.equal(v.last('lobby').room, null, 'nothing selected: no roster');
  // a typed name is cleaned; a bad one is refused (no kick, no room)
  const b = creator('Bea', '  Bea   den ');
  assert.equal(b.last('welcome').rname, 'Bea den');
  const c = creator('Cy', '<b>x</b>');
  assert.deepEqual(c.last('refused'), { t: 'refused', what: 'create', why: 'name' });
  assert.equal(c.closed, null); assert.equal(c.id(), undefined);
  assert.equal(arena.rooms.size, 2);
  // a non-string room or player name is malformed
  const d = conn('d'); d.say({ t: 'create', name: 5 }); assert.equal(d.closed.code, KICK.malformed);
  const e = conn('e'); e.say({ t: 'create', name: 'E', room: 5 }); assert.equal(e.closed.code, KICK.malformed);
});

test('rooms: room names follow the player-name allowlist (plus the apostrophe), up to 20 characters', () => {
  assert.equal(cleanRoomName("  Kit's   dojo "), "Kit's dojo");
  assert.equal(cleanRoomName('x'.repeat(20)), 'x'.repeat(20));
  for (const bad of ['', '   ', 'x'.repeat(21), 'a<b', 'tab\there', 'é', 'a#2', 5, null]) assert.equal(cleanRoomName(bad), null, JSON.stringify(bad));
  assert.equal(defaultRoomName('Kit#2'), "Kit's room");
  assert.equal(defaultRoomName('Abcdefghijklmnop'), "Abcdefghijklm's room");
  assert.ok(cleanRoomName(defaultRoomName('Abcdefghijklmnop')), 'the default is itself a valid name');
});

test('rooms: at most 10 rooms, at most 2 open rooms created per address, creation rate-limited', () => {
  const { arena, creator, conn, advance } = setup();
  const a1 = creator('A1', '', 'ipA'), a2 = creator('A2', '', 'ipA'), a3 = creator('A3', '', 'ipA');
  assert.ok(a1.last('welcome') && a2.last('welcome'));
  assert.deepEqual(a3.last('refused'), { t: 'refused', what: 'create', why: 'ip' });
  for (let i = 0; i < 8; i++) assert.ok(creator('P' + i).last('welcome'), 'room ' + (i + 3));
  assert.equal(arena.rooms.size, 10);
  const late = creator('Late');
  assert.deepEqual(late.last('refused'), { t: 'refused', what: 'create', why: 'full' });
  assert.equal(late.closed, null);
  // once one closes there is room again
  a1.say({ t: 'leave' }); a1.say({ t: 'view', room: 0 });
  assert.equal(arena.rooms.size, 9);
  advance(20000);
  late.say({ t: 'create', name: 'Late', color: 0 });
  assert.equal(late.last('lobby').mine, true);
  // the per-connection create bucket: 2 at once, then one per 15 s
  const { conn: conn2, arena: ar2 } = setup({ maxRooms: 99, roomsPerIp: 99 });
  const r = conn2('r');
  r.say({ t: 'create', name: 'R', color: 0, room: 'bad<' });
  r.say({ t: 'create', name: 'R', color: 0, room: 'bad<' });
  r.say({ t: 'create', name: 'R', color: 0 });
  assert.deepEqual(r.last('refused'), { t: 'refused', what: 'create', why: 'rate' });
  assert.equal(ar2.rooms.size, 0); assert.ok(r.conn.dropCount >= 1);
  void conn;
});

test('rooms: a connection is in at most one room, so admin of at most one', () => {
  const { creator, arena } = setup();
  const a = creator('Ann');
  a.say({ t: 'create', name: 'Ann', color: 0 });
  assert.equal(a.closed.code, KICK.protocol);
  const b = creator('Bea');
  b.say({ t: 'hello', name: 'Bea', color: 0, room: 2 });
  assert.equal(b.closed.code, KICK.protocol);
  assert.equal(arena.rooms.size, 0, 'both kicked: their rooms closed');
});

test('rooms: hello needs a room id; a closed room is refused without a kick; view picks what a visitor sees', () => {
  const { conn, creator, tick } = setup();
  const x = conn(); x.say({ t: 'hello', name: 'X', color: 0 }); assert.equal(x.closed.code, KICK['bad hello']);
  const y = conn(); y.say({ t: 'hello', name: 'Y', color: 0, room: '1' }); assert.equal(y.closed.code, KICK['bad hello']);
  const z = conn(); z.say({ t: 'hello', name: 'Z', color: 0, room: 9 });
  assert.deepEqual(z.last('refused'), { t: 'refused', what: 'join', why: 'gone' }); assert.equal(z.closed, null);
  const a = creator('Ann');
  const v = conn();
  v.say({ t: 'view', room: 1 });
  const l = v.last('lobby');
  assert.equal(l.room, 1); assert.equal(l.rname, "Ann's room"); assert.equal(l.players.length, 1); assert.equal(l.admin, a.id());
  tick(2); assert.ok(v.last('snapshot'), 'a visitor who selected a room gets its snapshots');
  v.say({ t: 'view', room: 0 });
  assert.equal(v.last('lobby').room, null);
  v.msgs.length = 0; tick(4); assert.equal(v.last('snapshot'), undefined, 'and none with nothing selected');
  v.say({ t: 'view', room: 77 }); assert.equal(v.last('lobby').room, null, 'an unknown room: none');
  a.say({ t: 'view', room: 0 }); assert.equal(a.last('lobby').room, 1, 'a member always looks at its own room');
  for (const bad of [{}, { room: -1 }, { room: 'x' }, { room: 1.5 }]) { const c = conn(); c.say({ t: 'view', ...bad }); assert.equal(c.closed.code, KICK.malformed, JSON.stringify(bad)); }
});

test('rooms: each room has 8 slots and its own queue', () => {
  const { creator, joiner, arena } = setup();
  creator('Ann');
  const js = Array.from({ length: 8 }, (_, i) => joiner('P' + i, 1, i % 12));
  assert.deepEqual(js.map(c => c.last('welcome').state), ['play', 'play', 'play', 'play', 'play', 'play', 'play', 'queue']);
  const b = creator('Bea');   // another room is not affected
  assert.equal(b.last('welcome').state, 'play');
  assert.equal(arena.rooms.get(1).activeCount(), 8); assert.equal(arena.rooms.get(2).activeCount(), 1);
});

test('rooms: snapshots, events and chat stay inside their room', () => {
  const { creator, joiner, conn, tick } = setup();
  const a = creator('Ann'), a2 = joiner('Al', 1);
  const b = creator('Bea'), b2 = joiner('Bo', 2);
  const va = conn(), vb = conn();
  va.say({ t: 'view', room: 1 }); vb.say({ t: 'view', room: 2 });
  tick(10);
  const ids = c => new Set(c.all('snapshot').flatMap(s => s.p.map(p => p[0])));
  const roomA = [a.id(), a2.id()].sort(), roomB = [b.id(), b2.id()].sort();
  for (const c of [a, a2, va]) assert.deepEqual([...ids(c)].sort(), roomA);
  for (const c of [b, b2, vb]) assert.deepEqual([...ids(c)].sort(), roomB);
  for (const c of [a, a2, va]) assert.ok(!c.events().some(e => roomB.includes(e.id)), 'no events about the other room');
  a.say({ t: 'chat', text: 'hi A' });
  for (const c of [a, a2, va]) assert.ok(c.events().some(e => e.type === 'chat' && e.text === 'hi A'));
  for (const c of [b, b2, vb]) assert.ok(!c.events().some(e => e.type === 'chat'));
  assert.equal(a.last('snapshot').tick, b.last('snapshot').tick, 'one shared tick');
});

test('rooms: names are de-duplicated and colours kept unique per room only', () => {
  const { creator, joiner } = setup();
  const a = creator('Kit'), a2 = joiner('kit', 1, 0);
  const b = creator('Kit', '', 'ip-other');
  assert.equal(a.last('welcome').name, 'Kit'); assert.equal(a2.last('welcome').name, 'kit#2');
  assert.equal(b.last('welcome').name, 'Kit', 'the same name in another room is fine');
  assert.equal(a2.last('welcome').color, 1, 'colour 0 is worn in room 1');
  assert.equal(b.last('welcome').color, 0, 'but not in room 2');
  // a freed name passes on inside its room only
  const b2 = joiner('Kit', 2, 3, 'ip-b2');
  assert.equal(b2.last('welcome').name, 'Kit#2');
  a.say({ t: 'admin', id: a2.id() }); a.say({ t: 'leave' });
  assert.ok(a2.events().some(e => e.type === 'rename' && e.id === a2.id() && e.name === 'kit'));
  assert.ok(!b2.events().some(e => e.type === 'rename'), 'room 2 is not told and nobody there is renamed');
});

test('rooms: admin transfer is validated: only the admin, only to another human of the same room', () => {
  const { arena, creator, joiner, advance, tick } = setup();
  const a = creator('Ann'), b = joiner('Bea', 1), c = joiner('Cy', 1);
  const o = creator('Oz');                                // another room
  a.say({ t: 'bots', d: 1 });
  const bot = arena.rooms.get(1).bots[0];
  b.say({ t: 'admin', id: c.id() }); assert.deepEqual(b.last('refused'), { t: 'refused', what: 'admin', why: 'admin' });
  a.say({ t: 'admin', id: bot.id }); assert.equal(a.last('refused').why, 'target', 'not a bot');
  a.say({ t: 'admin', id: a.id() }); assert.equal(a.last('refused').why, 'target', 'not oneself');
  a.say({ t: 'admin', id: o.id() }); assert.equal(a.last('refused').why, 'target', 'not someone in another room');
  a.say({ t: 'admin', id: 999 }); assert.equal(a.last('refused').why, 'target');
  assert.equal(arena.rooms.get(1).adminId, a.id());
  for (const bad of [{}, { id: '2' }, { id: 1.5 }, { id: null }]) { const x = joiner('X', 1, 4, 'x' + JSON.stringify(bad)); x.say({ t: 'admin', ...bad }); assert.equal(x.closed.code, KICK.malformed, JSON.stringify(bad)); }
  advance(5000);
  a.say({ t: 'admin', id: b.id() });
  assert.equal(arena.rooms.get(1).adminId, b.id());
  for (const x of [a, b, c]) assert.ok(x.events().some(e => e.type === 'admin' && e.id === b.id() && e.from === a.id() && e.why === 'transfer'), 'everyone in the room is told');
  assert.ok(!o.events().some(e => e.type === 'admin'));
  tick(40);
  assert.equal(c.last('lobby').admin, b.id()); assert.equal(c.last('lobby').rooms[0].admin, 'Bea');
  a.say({ t: 'admin', id: c.id() }); assert.equal(a.last('refused').why, 'admin', 'the old admin has lost it');
  // the edit bucket: 4 at once, then one per 2 s; drops count toward the flood kick
  for (let i = 0; i < 6; i++) b.say({ t: 'admin', id: 999 });
  assert.equal(b.last('refused').why, 'rate');
});

test('rooms: the admin may leave the fight (it stays admin, pending, on the room screen) but not the room while humans play', () => {
  const { arena, creator, joiner, conn, tick } = setup();
  const a = creator('Ann'), b = joiner('Bea', 1);
  a.say({ t: 'bots', n: 2 });
  const v = conn(); v.say({ t: 'view', room: 1 });
  const aid = a.id();
  a.say({ t: 'leave' });                                 // the Esc menu's Leave: never refused for the admin
  assert.equal(a.last('refused'), undefined);
  assert.equal(arena.recs.has(aid), false); assert.equal(arena.rooms.get(1).adminConn, a.conn, 'still the admin, pending');
  a.say({ t: 'view', room: 0 });                         // the room screen's Leave while Bea plays: hand over first
  assert.deepEqual(a.last('refused'), { t: 'refused', what: 'leave', why: 'admin' });
  a.say({ t: 'hello', name: 'Ann', color: 0, room: 1 }); // back into the fight, still the admin
  assert.equal(arena.rooms.get(1).adminId, a.id());
  b.say({ t: 'leave' });                                 // anyone else may leave
  assert.equal(arena.recs.has(b.id()), false);
  a.say({ t: 'leave' });                                 // now alone (bots are not humans): back on the room's screen
  assert.equal(arena.rooms.size, 1); assert.equal(arena.recs.has(a.id()), false);
  assert.equal(arena.rooms.get(1).adminConn, a.conn); assert.equal(a.last('lobby').mine, true); assert.equal(a.last('lobby').room, 1);
  v.say({ t: 'view', room: 0 }); b.say({ t: 'view', room: 0 });   // (Bea stayed on the room's screen after leaving)
  a.say({ t: 'view', room: 0 });                         // and looking away, with nobody else looking at it, closes it
  assert.equal(arena.rooms.size, 0);
  assert.equal(arena.recs.size, 0, 'its bots went with it');
  tick(40); assert.deepEqual(v.last('lobby').rooms, []);
  assert.equal(a.closed, null, 'the admin stays connected, back at the room list');
});

test('rooms: a disconnected admin keeps the role inside the grace period; after it the longest-present human takes over', () => {
  const { arena, creator, joiner, conn, advance, tick } = setup();
  const a = creator('Ann');
  advance(100); const b = joiner('Bea', 1);
  advance(100); const c = joiner('Cy', 1);
  const room = arena.rooms.get(1);
  // a short drop: resumed within 5 s, still admin
  const { token } = a.last('welcome');
  arena.disconnect(a.conn);
  advance(4000); tick(1);
  assert.equal(room.adminId, a.id());
  const a2 = conn('ip-Ann'); a2.say({ t: 'hello', name: 'Ann', color: 0, token, resume: true });
  assert.equal(a2.last('welcome').resumed, true); assert.equal(a2.last('welcome').admin, a.id());
  assert.equal(room.adminId, a.id());
  // a long one: at grace expiry the role passes to Bea (in the room before Cy)
  arena.disconnect(a2.conn);
  advance(5100); tick(1);
  assert.equal(room.adminId, b.id());
  assert.ok(c.events().some(e => e.type === 'admin' && e.id === b.id() && e.why === 'auto'));
  // a connected human is preferred to one who is away
  arena.disconnect(b.conn);
  advance(100); const d = joiner('Di', 1);
  void d;
  arena.kick(c.conn, 'idle');                            // c is not admin: nothing changes yet
  assert.equal(room.adminId, b.id());
  advance(5100); tick(1);                                // b's grace ends: Di is the only one left
  assert.equal(room.adminId, d.id());
});

test('rooms: a room closes when its last human is gone for good (kick or grace expiry), bots and all', () => {
  const { arena, creator, conn, advance, tick } = setup();
  const a = creator('Ann');
  a.say({ t: 'bots', n: 3 });
  arena.disconnect(a.conn);                              // nobody else looks at the room
  advance(3000); tick(1);
  assert.equal(arena.rooms.size, 1, 'kept while the human may still resume');
  advance(2100); tick(1);
  assert.equal(arena.rooms.size, 0); assert.equal(arena.recs.size, 0);
  void conn;
  const b = creator('Bea');
  b.say({ t: 'bots', n: 2 });
  arena.kick(b.conn, 'flood');
  assert.equal(arena.rooms.size, 0); assert.equal(arena.recs.size, 0);
});

test('rooms: the admin renames the room; others are refused; names are validated and rate-limited', () => {
  const { arena, creator, joiner, conn, tick } = setup();
  const a = creator('Ann'), b = joiner('Bea', 1);
  const v = conn(); v.say({ t: 'view', room: 1 });
  a.say({ t: 'rename', name: "  Ann's   dojo " });
  assert.equal(arena.rooms.get(1).name, "Ann's dojo");
  for (const c of [a, b, v]) assert.ok(c.events().some(e => e.type === 'room' && e.id === 1 && e.name === "Ann's dojo"));
  tick(40);
  assert.equal(v.last('lobby').rname, "Ann's dojo"); assert.equal(v.last('lobby').rooms[0].name, "Ann's dojo");
  b.say({ t: 'rename', name: 'Mine' }); assert.deepEqual(b.last('refused'), { t: 'refused', what: 'rename', why: 'admin' });
  v.say({ t: 'rename', name: 'Mine' }); assert.equal(v.last('refused').why, 'admin');
  a.say({ t: 'rename', name: 'x'.repeat(21) }); assert.equal(a.last('refused').why, 'name');
  a.say({ t: 'rename', name: '' }); assert.equal(a.last('refused').why, 'name');
  assert.equal(arena.rooms.get(1).name, "Ann's dojo");
  a.say({ t: 'rename', name: 'Again' });   // the 4th: still inside the burst
  a.say({ t: 'rename', name: 'Again 2' }); // the 5th: over it
  assert.equal(a.last('refused').why, 'rate'); assert.equal(arena.rooms.get(1).name, 'Again');
  const m = joiner('M', 1, 2); m.say({ t: 'rename', name: 7 }); assert.equal(m.closed.code, KICK.malformed);
});

test('rooms: admin and debug views list the rooms; events and logs carry room ids', () => {
  const { arena, creator, joiner, conn, events, logs } = setup();
  const a = creator('Ann'), b = joiner('Bea', 1);
  a.say({ t: 'bots', d: 1 });
  const v = conn(); v.say({ t: 'view', room: 1 });
  v.say({ t: 'log', e: [{ ts: 1, tick: 2, cat: 'life', msg: 'hi' }] });
  const s = arena.adminState();
  assert.equal(s.rooms.length, 1);
  const r = s.rooms[0];
  assert.equal(r.id, 1); assert.equal(r.name, "Ann's room"); assert.deepEqual(r.admin, { id: a.id(), name: 'Ann' });
  assert.equal(r.players.length, 3); assert.equal(r.bots, 1); assert.equal(r.watchers, 1); assert.equal(r.queue.length, 0);
  assert.ok(r.players.find(p => p.id === a.id()).admin);
  assert.equal(s.conns.find(c => c.conn === v.conn.id).room, 1);
  assert.ok(!JSON.stringify(s).includes(a.last('welcome').token), 'no tokens');
  assert.ok(events.all().some(e => e.type === 'room-create' && e.room === 1));
  assert.ok(events.all().some(e => e.type === 'join' && e.room === 1 && e.player === b.id()));
  assert.ok(logs.some(l => l.startsWith('room-create') && l.endsWith('room=1')));
  assert.equal(arena.logs.find(v.conn.word)[0].entries[0].room, 1, 'streamed log entries are tagged with the room');
  assert.equal(arena.viewByToken(b.last('welcome').token).player.room, 1);
});

test('an error in one room\'s step closes that room only; the others and the server carry on', () => {
  const { arena, creator, tick, logs } = setup();
  const a = creator('Ann'), b = creator('Bob');
  tick(5);
  const [ra, rb] = [...arena.rooms.values()];
  ra.step = () => { throw new Error('boom'); };
  const t0 = rb.state.tick;
  tick(3);
  assert.ok(!arena.rooms.has(ra.id), 'the broken room is closed');
  assert.ok(arena.rooms.has(rb.id) && rb.state.tick === t0 + 3, 'the other room kept stepping');
  assert.equal(a.last('closed')?.why, 'error');
  assert.ok(logs.some(l => /room-error room=/.test(l)));
  assert.equal(b.last('closed'), undefined);
});
