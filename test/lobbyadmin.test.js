// A room's lobby visitors (SPEC §17): connections looking at a room without playing in it (on its
// screen or watching) are listed by name, and the admin can make one of them the admin: it becomes the
// room's pending admin, exactly like a creator who has not fought. Hand-over order when an admin is
// gone: the longest-present human, then the longest-looking visitor, else the room closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, KICK } from '../server/arena.js';
import { TICK_MS, ROOM } from '../shared/constants.js';

function setup() {
  let t = 1000;
  const arena = new Arena({ now: () => t, seed: 5, heartbeatMs: 0 });
  const conn = (ip = 'test') => {
    const c = { msgs: [], closed: null };
    c.conn = arena.connect({ ip, send: s => c.msgs.push(JSON.parse(s)), close: (code, reason) => { c.closed = { code, reason }; } });
    c.say = m => arena.onMessage(c.conn, JSON.stringify(m));
    c.last = ty => [...c.msgs].reverse().find(m => m.t === ty);
    c.events = () => c.msgs.filter(m => m.t === 'event').flatMap(m => m.ev);
    c.id = () => c.last('welcome')?.id;
    return c;
  };
  const maker = (name, ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'create', name, room: '' }); return c; };
  const creator = name => { const c = maker(name); c.say({ t: 'hello', name, color: 0, room: c.last('lobby').room }); return c; };
  const joiner = (name, room, ip = 'ip-' + name) => { const c = conn(ip); c.say({ t: 'hello', name, color: 1, room }); return c; };
  const visitor = (name, room, ip = 'ip-v-' + name) => { const c = conn(ip); c.say({ t: 'view', room, ...(name != null ? { name } : {}) }); return c; };
  const advance = ms => { t += ms; };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { t += TICK_MS; arena.tick(); } };
  return { arena, conn, maker, creator, joiner, visitor, advance, tick };
}

test('lobby visitors: listed with their names, longest first; watchers marked; members not listed', () => {
  const { arena, maker, joiner, visitor, advance, tick } = setup();
  const a = maker('Ann');
  advance(10); const v = visitor('Vic', 1);
  advance(10); const n = visitor(undefined, 1);
  advance(10); const bad = visitor('no<way>', 1);
  advance(10); const b = joiner('Bea', 1);
  tick(40);
  let l = v.last('lobby');
  assert.equal(l.you, v.conn.id); assert.equal(l.padmin, a.conn.id); assert.equal(l.admin, null);
  assert.deepEqual(l.lobby, [{ c: a.conn.id, name: 'Ann' }, { c: v.conn.id, name: 'Vic' }, { c: n.conn.id, name: null }, { c: bad.conn.id, name: null }]);
  // a re-sent view for the same room changes the name and the watch mark (the room stays the same)
  n.say({ t: 'view', room: 1, name: '  Ned  ', watch: true });
  v.say({ t: 'view', room: 1, name: '' });
  tick(40);
  l = b.last('lobby');
  assert.deepEqual(l.lobby.map(x => [x.name, !!x.w]), [['Ann', false], [null, false], ['Ned', true], [null, false]]);
  assert.equal(arena.rooms.get(1).summary().watch, 4);
  // a player who leaves stays on the room's screen, listed under its player name
  b.say({ t: 'leave' });
  assert.deepEqual(b.last('lobby').lobby.at(-1), { c: b.conn.id, name: 'Bea' });
  // another room's visitors are not listed; a visitor going back to the list drops out
  const o = maker('Oz'); visitor('Ola', o.last('lobby').room);
  n.say({ t: 'view', room: 0 }); tick(40);
  assert.deepEqual(a.last('lobby').lobby.map(x => x.name), ['Ann', null, null, 'Bea']);
  // wrong types are malformed kicks
  for (const m of [{ t: 'view', room: 1, name: 5 }, { t: 'view', room: 1, watch: 'yes' }]) {
    const x = visitor(null, 0, 'x' + JSON.stringify(m)); x.say(m); assert.equal(x.closed.code, KICK.malformed);
  }
});

test('lobby visitors: the admin makes one the admin; it is validated', () => {
  const { arena, conn, creator, maker, joiner, visitor, advance } = setup();
  const a = creator('Ann'), b = joiner('Bea', 1), v = visitor('Vic', 1);
  const o = maker('Oz'), ov = visitor('Ola', 2);         // another room and its visitor
  const lister = conn('lister');                         // on the room list
  b.say({ t: 'admin', conn: v.conn.id }); assert.equal(b.last('refused').why, 'admin', 'only the admin');
  a.say({ t: 'admin', conn: lister.conn.id }); assert.equal(a.last('refused').why, 'target', 'not someone on the list');
  a.say({ t: 'admin', conn: ov.conn.id }); assert.equal(a.last('refused').why, 'target', 'not a visitor of another room');
  a.say({ t: 'admin', conn: a.conn.id }); assert.equal(a.last('refused').why, 'target', 'not oneself');
  advance(10000);
  a.say({ t: 'admin', conn: b.conn.id }); assert.equal(a.last('refused').why, 'target', 'a player is made admin by player id');
  o.say({ t: 'admin', conn: o.conn.id }); assert.equal(o.last('refused').why, 'target', 'a pending admin: not oneself either');
  for (const bad of [{ id: b.id(), conn: v.conn.id }, { conn: '3' }, { conn: null }]) {
    const x = joiner('X', 1, 'x' + JSON.stringify(bad)); x.say({ t: 'admin', ...bad }); assert.equal(x.closed.code, KICK.malformed, JSON.stringify(bad));
  }
  const room = arena.rooms.get(1);
  assert.equal(room.adminId, a.id());
  advance(10000);
  a.say({ t: 'admin', conn: v.conn.id });
  assert.equal(room.adminId, null); assert.equal(room.adminConn, v.conn); assert.equal(v.conn.adminOf, room);
  for (const x of [a, b, v]) assert.ok(x.events().some(e => e.type === 'admin' && e.id === null && e.conn === v.conn.id && e.from === a.id() && e.why === 'transfer'));
  assert.ok(!ov.events().some(e => e.type === 'admin'));
  a.say({ t: 'rename', name: 'Nope' }); assert.equal(a.last('refused').why, 'admin', 'the old admin lost it');
  assert.equal(room.summary().admin, 'Vic');
  // the rate limit (edit bucket) applies as for any transfer
  for (let i = 0; i < 6; i++) v.say({ t: 'admin', conn: 9999 });
  assert.equal(v.last('refused').why, 'rate');
});

test('lobby visitors: a visitor made admin renames, sets AI players and settings, and FIGHT keeps admin', () => {
  const { arena, creator, visitor, advance, tick } = setup();
  const a = creator('Ann'), v = visitor('Vic', 1);
  a.say({ t: 'admin', conn: v.conn.id });
  tick(40);
  assert.equal(v.last('lobby').mine, true); assert.equal(v.last('lobby').padmin, v.conn.id);
  advance(5000);
  v.say({ t: 'rename', name: 'Vic Dojo' }); assert.equal(arena.rooms.get(1).name, 'Vic Dojo');
  v.say({ t: 'bots', n: 2 }); assert.equal(arena.rooms.get(1).bots.length, 2);
  v.say({ t: 'cfg', set: { gore: false } }); assert.equal(arena.rooms.get(1).cfg.gore, false);
  v.say({ t: 'view', room: 1, watch: true, name: 'Vic' }); assert.equal(arena.rooms.get(1).adminConn, v.conn, 'watching keeps it');
  const w = visitor('Wu', 1);
  a.say({ t: 'admin', conn: w.conn.id }); assert.equal(a.last('refused').why, 'admin');
  // FIGHT: joins the room and stays admin (now as its player)
  const room = arena.rooms.get(1);
  const v2 = visitor('Vi', 1); room.broadcastEvents([room.setAdminConn(v2.conn, 'transfer')]);
  v2.say({ t: 'hello', name: 'Vi', color: 3, room: 1 });
  assert.equal(room.adminId, v2.id()); assert.equal(room.adminConn, null); assert.equal(v2.conn.adminOf, null);
  assert.equal(v2.last('welcome').admin, v2.id()); assert.equal(v2.last('lobby').mine, true);
  // a pending admin made so is admin of one room at most: a create is a protocol kick, as for a creator
  const v3 = visitor('Vo', 1); v2.say({ t: 'admin', conn: v3.conn.id });
  v3.say({ t: 'create', name: 'Vo' }); assert.equal(v3.closed.code, KICK.protocol);
  assert.equal(room.adminId, a.id(), 'its disconnect passed the role to the longest-present human (Ann)');
});

test('lobby visitors: a visitor admin must hand over to leave while humans play; disconnecting passes it on', () => {
  const { arena, creator, joiner, visitor, advance } = setup();
  const a = creator('Ann'); advance(10); const b = joiner('Bea', 1); advance(10); const v = visitor('Vic', 1);
  const room = arena.rooms.get(1);
  a.say({ t: 'admin', conn: v.conn.id });
  v.say({ t: 'view', room: 0 });
  assert.deepEqual(v.last('refused'), { t: 'refused', what: 'leave', why: 'admin' });
  assert.equal(v.last('lobby').room, 1); assert.equal(room.adminConn, v.conn);
  // disconnecting: the longest-present human (Ann) takes over at once, before other visitors
  advance(10); visitor('Wu', 1);
  arena.disconnect(v.conn);
  assert.equal(room.adminId, a.id());
  assert.ok(b.events().some(e => e.type === 'admin' && e.id === a.id() && e.why === 'auto'));
});

test('lobby visitors: with no human playing, a pending admin who goes passes the role to the longest-looking visitor', () => {
  const { arena, maker, visitor, advance, tick } = setup();
  const a = maker('Ann'); a.say({ t: 'bots', n: 2 });
  advance(10); const v = visitor('Vic', 1);
  advance(10); const w = visitor('Wu', 1);
  const room = arena.rooms.get(1);
  a.say({ t: 'view', room: 0 });                         // looking away: not refused (nobody plays), passed on
  assert.equal(arena.rooms.size, 1); assert.equal(room.adminConn, v.conn); assert.equal(room.bots.length, 2);
  assert.ok(w.events().some(e => e.type === 'admin' && e.conn === v.conn.id && e.why === 'auto'));
  assert.equal(a.last('lobby').room, null);
  arena.disconnect(v.conn);                              // disconnecting: the same
  assert.equal(room.adminConn, w.conn);
  // the room held only by a visitor admin closes after ROOM.pendingMs without an admin action, telling its visitors
  advance(10); const x = visitor('Xi', 1);
  tick(Math.ceil(ROOM.pendingMs / TICK_MS) + 2);
  assert.equal(arena.rooms.size, 0); assert.equal(x.last('closed').why, 'idle'); assert.equal(w.last('closed').why, 'idle');
});

test('lobby visitors: the admin as the only player leaves the fight and stays admin; grace expiry prefers humans, then visitors', () => {
  const { arena, creator, joiner, visitor, advance, tick } = setup();
  // the only human player with visitors around: Leave is allowed, it stays the (pending) admin
  const a = creator('Ann'); advance(10); const v = visitor('Vic', 1);
  a.say({ t: 'leave' });
  assert.equal(a.last('refused'), undefined); assert.equal(arena.rooms.get(1).adminConn, a.conn);
  // grace expiry of a player admin: another human first
  const b = creator('Bea'); advance(10); visitor('Wu', 2); advance(10); const c = joiner('Cy', 2);
  const room2 = arena.rooms.get(2);
  arena.disconnect(b.conn); advance(5100); tick(1);
  assert.equal(room2.adminId, c.id());
  // with no human left, the longest-looking visitor (not one that came later) becomes the pending admin
  const d = creator('Di'); advance(10); const y = visitor('Yu', 3); advance(10); const z = visitor('Zo', 3);
  const room3 = arena.rooms.get(3);
  arena.disconnect(d.conn); advance(5100); tick(1);
  assert.equal(room3.adminId, null); assert.equal(room3.adminConn, y.conn);
  assert.ok(z.events().some(e => e.type === 'admin' && e.conn === y.conn.id && e.why === 'auto'));
  // a kicked only-player admin: same
  const e = creator('Ed'); advance(10); const q = visitor('Qi', 4);
  arena.kick(e.conn, 'idle');
  assert.equal(arena.rooms.get(4).adminConn, q.conn);
  void v;
});
