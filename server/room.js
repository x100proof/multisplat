// One room (SPEC §17): a world of its own with up to NET.maxPlayers (8) slots, AI players included,
// its own FIFO queue, scores, pickups, stars, bots, chat and events. It owns the per-world half of
// what used to be the single global arena: records, slots, the queue, names (de-duplicated per room),
// colours (unique per room), promotion, release, the sim step with lag compensation, snapshots and
// the room's admin. The connection half (protocol, buckets, heartbeat, resume tokens, the list of
// rooms, the one timer that steps every room) stays in server/arena.js, which owns every Room.
// Every room steps once per server tick, so all rooms share one tick number (`arena.tickNo`): a
// lobby visitor switching rooms keeps one continuous timeline and clock sync.
import * as Sim from '../shared/sim.js';
import { NET, TICK_MS, COLORS, KEY, BOT, FX, VIEW_DEFAULTS, cleanSetting, cfgDiff } from '../shared/constants.js';
import { newBrain, botKeys } from './ai.js';
import { randomBytes } from 'node:crypto';
import { r2, packPlayer, packItem, packFlying } from '../shared/protocol.js';

const SNAP_DIV = Math.round(60 / NET.snapshotHz);   // a snapshot every 2nd tick
const STARVE_ZERO_TICKS = 8;                        // repeat the last input this long, then use 0
const DRAIN_WINDOW = 30;                            // ticks over which a standing input backlog is measured
const PRESS_BITS = KEY.JUMP | KEY.SLASH | KEY.THROW; // edge-triggered keys a skipped input must not lose
// A rescued throw or slash press (from skipped inputs) that lands while its cooldown still runs (the
// skip squeezed it closer to the previous one than the player pressed it) is retried when the
// cooldown ends, up to RETRY_MAX times; plain presses on cooldown are still ignored, as the client
// expects. Without this a quick second throw played its swish on the client but never flew.
const RETRY_MAX = 3;
const SAME = (a, b) => { for (const k in a) if (a[k] !== b[k]) return false; return true; };
export { r2 };

export class Room {
  // arena: the owning Arena (config, clock, logs, the global record and token maps).
  constructor(arena, { id, name, seed, creatorIp = null }) {
    this.arena = arena; this.id = id; this.name = name; this.creatorIp = creatorIp;
    // The room's own settings (SPEC §17.1): the server's cfg plus the room-wide display switches,
    // edited by the admin. A new frozen object per change (never mutated), so anything keyed on the
    // object sees the change. They die with the room: a new room starts from the defaults again.
    this.baseCfg = Object.freeze({ ...VIEW_DEFAULTS, ...arena.cfg });
    this.cfg = this.baseCfg; this.level = arena.level; this.maxPlayers = arena.maxPlayers;
    this.adminId = null;          // the record id of the admin (a human in this room) — SPEC §17
    this.adminConn = null;        // or the pending admin: a connection with no record (created the room, or
                                  // was handed it while looking at it, and is not fighting)
    this.adminActAt = 0;          // the pending admin's last action (a room held only by it closes after ROOM.pendingMs)
    // The pending admin's seat (SPEC §17): a secret only its page holds (like a resume token), so a
    // page that reloads or drops, or a server restart (SPEC §18), doesn't lose the room. While the
    // page is away (seatAt: since when) the seat is held for the grace period, then the role moves on.
    this.seat = null; this.seatAt = null;
    this.state = Sim.createWorld({ seed });
    this.state.tick = arena.tickNo;   // lockstep with every other room (see above)
    this.hist = Sim.createHistory();
    this.recs = new Map();        // player id -> record of this room (playing, queued or waiting for a resume)
    this.queue = [];              // queued records, FIFO
    this.bots = [];               // bot records in the order they were added (SPEC §15)
    this.viewers = new Set();     // connections that get this room's snapshots and events: its members
                                  // and every lobby visitor who selected it (watchers)
    this.pendingEvents = [];
    this.createdAt = arena.now();
    this.stepMs = 0; this.stepMax = 0;   // this room's share of the tick (EMA and max), for adminState
  }

  // Logs and ring events of this room carry its id (SPEC §13.3).
  log(s) { this.arena.log(`${s} room=${this.id}`); }
  event(type, connId, data = {}) { this.arena.event(type, connId, { room: this.id, ...data }); }

  // ---------- roster ----------
  activeCount() { let n = 0; for (const r of this.recs.values()) if (r.state === 'play') n++; return n; }
  humans() { return [...this.recs.values()].filter(r => !r.bot); }
  watchers() { let n = 0; for (const c of this.viewers) if (!c.rec || c.rec.room !== this) n++; return n; }
  // The lobby visitors of this room (SPEC §17): connections looking at it without a record (on its
  // screen or watching), the longest-looking first. Its pending admin is one of them.
  visitors() { return [...this.viewers].filter(c => !c.rec && !c.closed).sort((a, b) => (a.viewAt - b.viewAt) || (a.id - b.id)); }
  admin() { return this.adminId != null ? this.recs.get(this.adminId) || null : null; }
  maxBots() { return Math.max(0, this.maxPlayers - 1); }

  // Names are de-duplicated per room (SPEC §9, §17), case-insensitively, with #2, #3, …
  uniqueName(name) {
    const taken = new Set([...this.recs.values()].map(r => r.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name}#${i}`.toLowerCase())) return `${name}#${i}`;
  }

  // `gone` was released, freeing its name (SPEC §9): the holder of the lowest-numbered variant of
  // it in this room ("Sean#2" when "Sean" goes) takes the bare name. Nobody else is renumbered, and a
  // freed "Sean#2" is not passed on. `#` is outside the name allowlist, so only uniqueName ever puts
  // one in a name. Returns the `rename` event, or null.
  reclaimName(gone) {
    const freed = gone.name.toLowerCase();
    let best = null, bestN = Infinity;
    for (const r of this.recs.values()) {
      const m = /^(.*)#(\d+)$/.exec(r.name);
      if (m && m[1].toLowerCase() === freed && +m[2] < bestN) { best = r; bestN = +m[2]; }
    }
    if (!best) return null;
    const from = best.name;
    best.name = from.slice(0, from.lastIndexOf('#'));
    this.log(`rename id=${best.id} from=${from} to=${best.name}`);
    this.event('rename', best.conn ? best.conn.id : null, { player: best.id, from, to: best.name });
    return { type: 'rename', tick: this.state.tick, id: best.id, name: best.name };
  }

  // Put a new record (human or bot) in this room: a free slot, else the queue (humans only).
  add(rec, by = null) {
    rec.room = this;
    this.recs.set(rec.id, rec);
    this.arena.recs.set(rec.id, rec);
    if (rec.token) this.arena.tokens.set(rec.token, rec);
    if (rec.bot) this.bots.push(rec);
    if (this.activeCount() < this.maxPlayers) {
      const saved = this.pendingEvents;
      this.pendingEvents = [];
      this.activate(rec, false, by);
      this.broadcastEvents([this.joinEvent(rec), ...this.pendingEvents]);
      this.pendingEvents = saved;
    } else {
      this.queue.push(rec);
      this.log(`queue conn=${rec.conn ? rec.conn.id : '-'} id=${rec.id} pos=${this.queue.length}`);
      this.event('queue', rec.conn ? rec.conn.id : null, { player: rec.id, pos: this.queue.length });
    }
    this.arena.lobbyDirty = true;
  }

  // by: the connection that asked for a bot (for the logs only)
  activate(rec, promoted, by = null) {
    if (!rec.bot) rec.color = this.freeColor(rec);
    rec.state = 'play'; rec.lastActive = this.arena.now(); rec.inputs.length = 0;
    const evs = Sim.addPlayer(this.state, rec.id, { cfg: this.cfg, level: this.level });
    const cid = rec.conn ? rec.conn.id : by ? by.id : null;
    this.log(`${promoted ? 'promote' : rec.bot ? 'bot-add' : 'join'} conn=${cid ?? '-'} id=${rec.id} name=${rec.name}`);
    this.event(promoted ? 'promote' : rec.bot ? 'bot-add' : 'join', cid, { player: rec.id });
    this.pendingEvents.push(...evs.map(e => ({ ...e })));
  }

  joinEvent(rec) { return { type: 'join', tick: this.state.tick, id: rec.id, name: rec.name, color: rec.color, ...(rec.bot ? { bot: true } : {}) }; }

  // The player is gone for good: free its slot and name, invalidate its token, promote from the
  // queue. Then the room rules (SPEC §17): a departed admin's role passes to the longest-present
  // human, and a room left with no human at all closes (its bots go with it).
  release(rec, reason, by = null) {
    if (!this.recs.has(rec.id)) return;
    this.recs.delete(rec.id);
    this.arena.recs.delete(rec.id);
    if (rec.token) this.arena.tokens.delete(rec.token);
    if (rec.bot) { const bi = this.bots.indexOf(rec); if (bi >= 0) this.bots.splice(bi, 1); }
    const qi = this.queue.indexOf(rec);
    if (qi >= 0) this.queue.splice(qi, 1);
    const evs = [];
    if (rec.state === 'play') {
      const p = Sim.getPlayer(this.state, rec.id);
      // a player who leaves while recently hit is a kill for the hitter (SPEC §5 credit rule)
      if (p && p.alive && p.lastHitBy != null && this.state.tick - p.lastHitTick <= this.cfg.creditTicks)
        evs.push(...this.withScores(Sim.killPlayer(this.state, rec.id, 'leave', this.cfg)));
      Sim.removePlayer(this.state, rec.id);
      evs.push({ type: 'leave', tick: this.state.tick, id: rec.id, reason });
    }
    this.log(`leave id=${rec.id} reason=${reason}`);
    this.event('leave', rec.conn ? rec.conn.id : by ? by.id : null, { player: rec.id, reason });
    rec.state = 'gone';
    const rn = this.reclaimName(rec);
    if (rn) evs.push(rn);
    this.arena.lobbyDirty = true;
    if (this.closing) return;   // closeRoom is removing the bots: nobody is left to tell
    if (rec.id === this.adminId) {
      // the admin is gone for good: a human takes over, else a lobby visitor (pending), else it closes
      const why = reason === 'left' ? 'left' : 'empty';
      if (!this.humans().length && !this.visitors().length) { this.arena.closeRoom(this, why); return; }
      evs.push(this.handOn(why, false));
    } else if (!this.humans().length && !this.adminConn && !this.seat && this.adminId == null) { this.arena.closeRoom(this, reason === 'left' ? 'left' : 'empty'); return; }
    if (evs.length) this.broadcastEvents(evs);
    this.promote();
  }

  // The human who has been in the room longest (connected ones first), to take over as admin.
  successor() {
    const hs = this.humans().sort((a, b) => (!a.conn - !b.conn) || (a.joinedAt - b.joinedAt) || (a.id - b.id));
    return hs[0] || null;
  }

  // The admin is gone (SPEC §17): the role passes to the longest-present human, else to the lobby
  // visitor who has looked at the room longest (as its pending admin); with nobody, the room closes
  // (why: `closeWhy`). Sends the `admin` event itself unless `send` is false (then it returns it).
  handOn(closeWhy, send = true) {
    const rec = this.successor(), vis = rec ? null : this.visitors().find(c => c !== this.adminConn);
    if (!rec && !vis) { this.arena.closeRoom(this, closeWhy); return null; }
    const ev = rec ? this.setAdmin(rec, 'auto') : this.setAdminConn(vis, 'auto');
    if (send) this.broadcastEvents([ev]);
    return ev;
  }

  // Room settings (SPEC §17.1). `set`: {key: value}, already checked by the caller; reset: back to
  // the server's defaults. Returns the `cfg` event for the room's viewers (null: nothing changed):
  // `cfg` is the whole new state (as a diff against ROOM_DEFAULTS), `ch` what this change set.
  applyCfg(set, reset, by = null) {
    const next = { ...(reset ? this.baseCfg : this.cfg) }, ch = {};
    if (!reset) for (const k in set) { const v = cleanSetting(k, set[k]); if (v !== undefined && next[k] !== v) { next[k] = v; ch[k] = v; } }
    if (reset ? SAME(this.cfg, this.baseCfg) : !Object.keys(ch).length) return null;
    this.cfg = reset ? this.baseCfg : Object.freeze(next);
    this.log(`room-cfg conn=${by ? by.id : '-'} ${reset ? 'reset' : Object.entries(ch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    this.event('room-cfg', by ? by.id : null, reset ? { reset: true } : { set: ch });
    return { type: 'cfg', tick: this.state.tick, cfg: cfgDiff(this.cfg), ...(reset ? { reset: true } : { ch }) };
  }

  // Make the lobby visitor on `conn` (no record, looking at this room) the room's pending admin
  // (SPEC §17): like a creator who has not fought, it renames, sets the AI players and the settings,
  // watches, and stays admin when it joins with FIGHT. Returns the `admin` event (id null, `conn`).
  setAdminConn(conn, why, by = null) {
    const from = this.adminId;
    if (this.adminConn && this.adminConn !== conn) this.adminConn.adminOf = null;
    this.adminId = null; this.adminConn = conn; conn.adminOf = this; this.adminActAt = this.arena.now();
    this.seat = randomBytes(16).toString('hex'); this.seatAt = null;
    this.log(`admin from=${from ?? '-'} to=conn:${conn.id} why=${why}`);
    this.event('admin', by ? by.id : conn.id, { from, toConn: conn.id, why });
    this.arena.lobbyDirty = true;
    return { type: 'admin', tick: this.state.tick, id: null, conn: conn.id, from, why };
  }

  // Make `rec` the admin. Returns the `admin` event for the room's viewers (the caller sends it).
  setAdmin(rec, why, by = null) {
    const from = this.adminId;
    this.adminId = rec ? rec.id : null;
    if (this.adminConn) { this.adminConn.adminOf = null; this.adminConn = null; }   // a pending admin handed over
    this.seat = null; this.seatAt = null;
    this.log(`admin from=${from ?? '-'} to=${this.adminId ?? '-'} why=${why}`);
    this.event('admin', by ? by.id : rec && rec.conn ? rec.conn.id : null, { from, to: this.adminId, why });
    this.arena.lobbyDirty = true;
    return { type: 'admin', tick: this.state.tick, id: this.adminId, from, why };
  }

  // No two fighters in a room share a colour (SPEC §9): a player entering the arena keeps the colour
  // it asked for if no other fighter here has it, otherwise takes the next free one.
  freeColor(rec) {
    const used = new Set();
    for (const r of this.recs.values()) if (r !== rec && r.state === 'play') used.add(r.color);
    for (let k = 0; k < COLORS.length; k++) { const c = (rec.color + k) % COLORS.length; if (!used.has(c)) return c; }
    return rec.color;   // more fighters than colours (only with a raised maxPlayers)
  }

  promote() {
    while (this.activeCount() < this.maxPlayers) {
      const i = this.queue.findIndex(r => r.conn);
      if (i < 0) return;
      const [rec] = this.queue.splice(i, 1);
      const saved = this.pendingEvents;
      this.pendingEvents = [];
      this.activate(rec, true);
      this.broadcastEvents([this.joinEvent(rec), ...this.pendingEvents]);
      this.pendingEvents = saved;
    }
  }

  // ---------- AI players (SPEC §15), now per room and asked for by its admin only ----------
  // Add a bot in a free slot. Refused (false) at maxBots or with no free slot: bots never evict and
  // never queue. Name "AI n" with the lowest free n in this room (then the usual #2 de-duplication);
  // the reserved colour BOT.color, which no human can pick, so freeColor() leaves it alone.
  addBot(by = null) {
    if (this.bots.length >= this.maxBots() || this.activeCount() >= this.maxPlayers) return false;
    const used = new Set(this.bots.map(r => r.botNo));
    let no = 1; while (used.has(no)) no++;
    const id = this.arena.nextId++, now = this.arena.now();
    this.add({
      id, name: this.uniqueName(`${BOT.name} ${no}`), color: BOT.color, token: null, bot: true, botNo: no,
      brain: newBrain(this.state.rng ^ (id * 7919)),   // seeded from the room's sim seed, without consuming it
      conn: null, ip: null, state: 'queue', inputs: [], lastSeq: -1, maxSeq: -1, lastKeys: 0, starve: 0, carry: 0, retry: [], tried: 0, minQ: Infinity, qTicks: 0,
      lastActive: now, discAt: null, fx: 0, joinedAt: now,
    }, by);
    return true;
  }
  // Remove the most recently added bot (its slot goes to the first queued human, as any leave does).
  removeBot(by = null) {
    const rec = this.bots[this.bots.length - 1];
    if (!rec) return false;
    this.release(rec, 'bot removed', by);
    return true;
  }

  queuePos(rec) { const i = this.queue.indexOf(rec); return i < 0 ? 0 : i + 1; }
  roster() {
    return [...this.recs.values()].filter(r => r.state === 'play').map(r => {
      const p = Sim.getPlayer(this.state, r.id);
      return { id: r.id, name: r.name, color: r.color, score: p ? p.score : 0, deaths: p ? p.deaths : 0, away: !r.conn && !r.bot, ...(r.bot ? { bot: true } : {}) };
    });
  }
  queueList() { return this.queue.map(r => ({ id: r.id, name: r.name, color: r.color, away: !r.conn })); }
  // The room's half of a lobby message (SPEC §17): what a member or a visitor who selected it sees.
  detail() {
    // lobby: its visitors [{c: connection id, name (null: none typed), w: watching}], longest first
    const lobby = this.visitors().map(c => ({ c: c.id, name: c.vname ?? null, ...(c.vwatch ? { w: true } : {}) }));
    return { room: this.id, rname: this.name, admin: this.adminId, padmin: this.adminConn ? this.adminConn.id : null, ...(this.seat && !this.adminConn ? { held: true } : {}),
      players: this.roster(), queue: this.queueList(), lobby,
      cap: this.maxPlayers, bots: this.bots.length, botMax: this.maxBots(), cfg: cfgDiff(this.cfg) };
  }
  // One row of the room list every lobby visitor sees.
  summary() {
    const a = this.admin();
    const an = a ? a.name : this.adminConn ? this.adminConn.vname ?? null : null;
    return { id: this.id, name: this.name, admin: an, n: this.activeCount(), cap: this.maxPlayers,
      bots: this.bots.length, q: this.queue.length, watch: this.watchers() };
  }

  // Add a 'score' event for the killer and the victim after each kill.
  withScores(evs) {
    const out = [];
    for (const e of evs) {
      out.push(e);
      if (e.type !== 'kill') continue;
      for (const id of [e.killer, e.victim]) {
        const p = id != null && Sim.getPlayer(this.state, id);
        if (p) out.push({ type: 'score', tick: e.tick, id, score: p.score, deaths: p.deaths });
      }
      this.arena.lobbyDirty = true;
    }
    return out;
  }

  // Events go to this room's viewers only (its members and watchers).
  broadcastEvents(evs) {
    if (!evs.length) return;
    const msg = JSON.stringify({ t: 'event', tick: this.state.tick, ev: evs });
    for (const c of this.viewers) this.arena.send(c, msg);
  }

  // ---------- the tick (the server's timer calls Arena.tick, which steps every room) ----------
  step(now) {
    // one input per player per tick; a missing input repeats the last one for a few ticks. A bot's
    // keys come from its brain, which sees the others as they were brain.delay ticks ago (SPEC §15).
    const inputs = new Map();
    for (const rec of this.recs.values()) {
      if (rec.state !== 'play') continue;
      let keys = 0;
      if (rec.bot) {
        const seen = new Map();
        for (const o of Sim.positionsAt(this.hist, this.state.tick - rec.brain.delay) || []) seen.set(o.id, o);
        keys = botKeys(rec.brain, Sim.getPlayer(this.state, rec.id), this.state, seen, { cfg: this.cfg, level: this.level });
      } else if (rec.conn && rec.inputs.length) {
        const inp = rec.inputs.shift();
        const due = takeRetries(rec, this.state.tick);
        keys = inp.keys | rec.carry | due; rec.tried = (rec.carry | due) & (KEY.THROW | KEY.SLASH); rec.carry = 0;
        rec.lastSeq = inp.seq; rec.starve = 0;
        if (inp.keys !== 0) rec.lastActive = now;
      } else if (rec.conn && ++rec.starve <= STARVE_ZERO_TICKS) keys = rec.lastKeys;
      rec.lastKeys = keys;
      if (rec.conn) this.drainBacklog(rec);
      inputs.set(rec.id, keys);
    }
    const st = this.state;
    const rewind = a => {
      const rec = this.recs.get(a.id);
      if (rec && rec.bot) return null;              // a bot sees the present: no lag compensation
      const ms = Math.min(NET.rewindCapMs, NET.interpMs + (rec && rec.conn ? rec.conn.rtt : 0) / 2);
      return Sim.positionsAt(this.hist, st.tick - ms / TICK_MS);
    };
    const evs = [...this.pendingEvents, ...Sim.step(st, inputs, { cfg: this.cfg, level: this.level, rewind })];
    this.pendingEvents = [];
    Sim.recordHistory(this.hist, st);
    for (const p of st.players) {
      const rec = this.recs.get(p.id); if (!rec) continue;
      rec.fx |= p.fx;
      if (rec.tried) { retryRejected(rec, p, st.tick); rec.tried = 0; }
    }
    this.broadcastEvents(this.withScores(evs));
    if (st.tick % SNAP_DIV === 0) this.snapshot();
  }

  // Every starved tick (a repeat or a 0) leaves the late inputs queued one tick further behind, and
  // without this nothing ever took that back: input latency ratcheted up to the worst stall seen
  // (up to the 12-input cap, past which inputs were simply lost). So: if the queue never fell below
  // `min` over the last DRAIN_WINDOW ticks, `min - 1` of its oldest inputs are pure added latency
  // and are skipped, keeping one as a cushion against the next bit of jitter. A fresh jump or
  // slash press in a skipped input is carried into the next tick, so a one-tick tap survives.
  // Batched senders (2-3 inputs a frame) bring the queue to 0 or 1 every frame and are untouched.
  drainBacklog(rec) {
    rec.minQ = Math.min(rec.minQ, rec.inputs.length);
    if (++rec.qTicks < DRAIN_WINDOW) return;
    let prev = rec.lastKeys;
    for (let n = rec.minQ - 1; n > 0; n--) {
      const inp = rec.inputs.shift();
      rec.carry |= inp.keys & ~prev & PRESS_BITS; prev = inp.keys;
      rec.lastSeq = inp.seq;
    }
    rec.minQ = Infinity; rec.qTicks = 0;
  }

  // Snapshot (SPEC §6.1), to this room's viewers only: every player as [id, x, y, vx, vy, face, hp,
  // atk, flags, iframes, stun, fx, stars], flags = alive 1 | onGround 2 | sweep 4 | long sword 8; the
  // lying pickups `it` as [[id, x, y, kind]] (kind 1 = ninja stars, 0 = long sword; a star pickup
  // adds its amount: [id, x, y, 1, n]); the stars in flight `st` as [[id, x, y, vx, owner]]. Each
  // player also gets its own full player state (`me`, with `stars`) and its last processed input
  // `seq`, for reconciliation.
  snapshot() {
    const st = this.state;
    const p = st.players.map(q => {
      const rec = this.recs.get(q.id), fx = rec ? rec.fx : 0;
      if (rec) rec.fx = 0;
      return packPlayer(q, fx);
    });
    const it = (st.items || []).map(packItem), fl = (st.stars || []).map(packFlying);
    const tail = ',"p":' + JSON.stringify(p) + ',"it":' + JSON.stringify(it) + ',"st":' + JSON.stringify(fl) + '}';
    const head = '{"t":"snapshot","tick":' + st.tick;
    for (const c of this.viewers) {
      const rec = c.rec;
      if (rec && rec.room === this && rec.state === 'play') {
        const me = Sim.getPlayer(st, rec.id);
        this.arena.send(c, head + ',"seq":' + rec.lastSeq + ',"me":' + JSON.stringify(me) + tail);
      } else this.arena.send(c, head + ',"seq":-1' + tail);
    }
  }

  // ---------- views for the debug tools (SPEC §13) ----------
  recView(rec) {
    const p = Sim.getPlayer(this.state, rec.id);
    return { id: rec.id, room: this.id, name: rec.name, color: rec.color,
      state: rec.bot ? rec.state + ' (bot)' : rec.conn ? rec.state : rec.state + ' (disconnected)',
      ...(rec.bot ? { bot: true } : {}), ...(rec.id === this.adminId ? { admin: true } : {}),
      queuePos: this.queuePos(rec), conn: rec.conn ? rec.conn.id : null, lastSeq: rec.lastSeq, inputQueue: rec.inputs.length,
      idleS: Math.round((this.arena.now() - rec.lastActive) / 1000),
      ...(p ? { x: r2(p.x), y: r2(p.y), hp: p.hp, alive: p.alive, long: !!p.long, stars: p.stars | 0, score: p.score, deaths: p.deaths } : {}) };
  }
  adminView() {
    const a = this.admin(), st = this.state;
    return { id: this.id, name: this.name, admin: a ? { id: a.id, name: a.name } : this.adminConn ? { pending: true, conn: this.adminConn.id, name: this.adminConn.vname ?? null } : null, creatorIp: this.creatorIp,
      ageS: Math.round((this.arena.now() - this.createdAt) / 1000), bots: this.bots.length, watchers: this.watchers(),
      cfg: cfgDiff(this.cfg),
      stepMs: r2(this.stepMs), stepMaxMs: r2(this.stepMax),
      items: (st.items || []).map(i => ({ ...i, kind: Sim.itemKind(i) })), itemInS: r2(Math.max(0, st.itemT) * TICK_MS / 1000),
      starInS: r2(Math.max(0, st.starT ?? 0) * TICK_MS / 1000),
      stars: (st.stars || []).map(f => ({ id: f.id, owner: f.owner, x: r2(f.x), y: r2(f.y), vx: f.vx, dist: r2(f.dist) })),
      players: [...this.recs.values()].filter(r => r.state === 'play').map(r => this.recView(r)),
      queue: this.queue.map(r => this.recView(r)) };
  }
}

// Rescued presses due by `tick` (SPEC §6.2: see RETRY_MAX), removed from the list.
function takeRetries(rec, tick) {
  let bits = 0;
  if (rec.retry && rec.retry.length) rec.retry = rec.retry.filter(r => (r.at <= tick ? ((bits |= r.bit), false) : true));
  return bits;
}
// After the step: a rescued throw/slash the sim refused because its cooldown was still running is
// tried again on the tick the cooldown ends (key up the tick before, so it is a fresh press).
function retryRejected(rec, p, tick) {
  const tries = r => (rec.tries = rec.tries || {}, rec.tries[r] = (rec.tries[r] || 0) + 1);
  for (const [bit, fx, cd] of [[KEY.THROW, FX.THROW, p.throwCd | 0], [KEY.SLASH, FX.SLASH, Math.max(p.atkCd | 0, p.atk | 0)]]) {
    if (!(rec.tried & bit)) continue;
    if (p.fx & fx || !p.alive) { if (rec.tries) rec.tries[bit] = 0; continue; }
    if (cd > 0 && tries(bit) <= RETRY_MAX) (rec.retry = rec.retry || []).push({ bit, at: tick + cd + 1 });
    else if (rec.tries) rec.tries[bit] = 0;
  }
}
