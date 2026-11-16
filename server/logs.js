// The streamed client log (SPEC §13.5): per log identity (a word id like `amber-otter`), the last
// hour of the client's debug entries, kept in memory only (never written to disk).
//
// Entries come from anonymous clients over the game WebSocket, so they are untrusted: each is
// checked against a fixed shape and cleaned like a report (server/debug.js clean()). The receive
// time, connection id, client IP and name are the server's own and are kept outside the entry, so
// a payload can never set them. Hard caps bound memory whatever clients send: entries per identity,
// identities in all and total bytes; past a cap the oldest data goes first.
import { randomInt } from 'node:crypto';
import { clean } from './debug.js';
import { isWordId, randomWordId, LOG } from '../shared/logid.js';

export const LOG_CAPS = Object.freeze({
  maxIds: 2000,                   // identities kept (lobby visitors with no entries are evicted first)
  maxPerId: 4000,                 // entries per identity (a normal client streams under 1/s)
  maxBytes: 32 * 1024 * 1024,     // all entries together, measured as their JSON length
  keepNames: 4, keepIps: 4,       // distinct names and IPs remembered per identity, newest first
});
const ENTRY_KEYS = new Set(['ts', 'tick', 'cat', 'msg', 'data']);
const CAT_RE = /^[a-z]{1,12}$/;
const PRUNE_EVERY_MS = 10000;
const cryptoRand = () => randomInt(0, 1 << 30) / (1 << 30);

// One client entry {ts, tick, cat, msg, data?} → a cleaned copy, or null if it is not that shape.
// Verbose entries (`cat: 'verbose'`) are never streamed by the client and are refused here too.
export function validateEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) return null;
  if (!Number.isFinite(e.ts) || (e.tick != null && !Number.isFinite(e.tick))) return null;
  if (typeof e.cat !== 'string' || !CAT_RE.test(e.cat) || e.cat === 'verbose' || typeof e.msg !== 'string') return null;
  try {
    const out = { ts: Math.round(e.ts), tick: Math.round(e.tick ?? 0), cat: e.cat, msg: clean(e.msg).slice(0, LOG.strMax) };
    if (e.data !== undefined) out.data = clean(e.data);
    return out;
  } catch { return null; }
}

export function createLogStore({ now = () => Date.now(), keepMs = LOG.keepMs, rand = cryptoRand, ...caps } = {}) {
  const C = { ...LOG_CAPS, ...caps };
  const ids = new Map();          // word -> {w, names, ips, first, seen, entries: [{at, c, size, e}], bytes, lost, dropped}
  let bytes = 0, prunedAt = -Infinity;

  const remember = (list, v, max) => { if (!v) return; const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); list.unshift(v); if (list.length > max) list.length = max; };
  function dropOldest(id, n) {
    const gone = id.entries.splice(0, n);
    for (const x of gone) { id.bytes -= x.size; bytes -= x.size; }
  }
  function remove(w) { const id = ids.get(w); if (!id) return; bytes -= id.bytes; ids.delete(w); }

  // Drop entries older than keepMs, and identities with nothing left that were last seen before that.
  function prune(force = false) {
    const t = now();
    if (!force && t - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = t;
    const cut = t - keepMs;
    for (const [w, id] of ids) {
      let k = 0;
      while (k < id.entries.length && id.entries[k].at < cut) k++;
      if (k) dropOldest(id, k);
      if (!id.entries.length && id.seen < cut) remove(w);
    }
  }
  // Make room for one more identity: evict the oldest-seen one, preferring those with no entries.
  function evictIdentity() {
    let pick = null;
    for (const id of ids.values()) {
      if (!pick || (!id.entries.length && pick.entries.length) || (!id.entries.length === !pick.entries.length && id.seen < pick.seen)) pick = id;
    }
    if (pick) remove(pick.w);
  }
  // Over the byte cap: take the oldest entries of whichever identity holds the oldest data.
  function shrink() {
    while (bytes > C.maxBytes) {
      let pick = null;
      for (const id of ids.values()) if (id.entries.length && (!pick || id.entries[0].at < pick.entries[0].at)) pick = id;
      if (!pick) break;
      dropOldest(pick, Math.max(1, pick.entries.length >> 3));
    }
  }

  function get(w) {
    let id = ids.get(w);
    if (!id) {
      prune(true);
      while (ids.size >= C.maxIds) evictIdentity();
      id = { w, names: [], ips: [], first: now(), seen: now(), entries: [], bytes: 0, lost: 0, dropped: 0 };
      ids.set(w, id);
    }
    return id;
  }

  return {
    caps: C,
    // The id for a new connection: the one the browser offers if it is a valid list pair, else a
    // fresh random one (avoiding ids already held here when it can).
    assign(offered) {
      if (isWordId(offered)) return offered;
      let w = randomWordId(rand);
      for (let i = 0; i < 20 && ids.has(w); i++) w = randomWordId(rand);
      return w;
    },
    // Note what the server knows about an identity: its IP (always the server's view of the
    // connection) and the latest typed name. Also marks it as seen now.
    touch(w, { ip, name } = {}) {
      if (!isWordId(w)) return;
      prune();
      const id = get(w);
      id.seen = now();
      remember(id.ips, typeof ip === 'string' ? ip.slice(0, 64) : null, C.keepIps);
      remember(id.names, typeof name === 'string' ? name.slice(0, 32) : null, C.keepNames);
    },
    // Store a batch of raw client entries for w. Returns {kept, bad}. `lost` is the client's own
    // count of entries it dropped before sending (its queue overflowed). `room` is the server's own
    // note of the room the connection was looking at (SPEC §17), stored as `r` (null: the room list).
    add(w, list, { ip, conn = null, lost = 0, room = null } = {}) {
      if (!isWordId(w) || !Array.isArray(list)) return { kept: 0, bad: 0 };
      prune();
      const id = get(w), t = now();
      id.seen = t;
      remember(id.ips, typeof ip === 'string' ? ip.slice(0, 64) : null, C.keepIps);
      if (Number.isInteger(lost) && lost > 0) id.lost += Math.min(lost, 1e6);
      let kept = 0, bad = 0;
      for (const raw of list) {
        const e = validateEntry(raw);
        if (!e) { bad++; continue; }
        const size = JSON.stringify(e).length + 32;
        id.entries.push({ at: t, c: conn, r: Number.isInteger(room) ? room : null, size, e });
        id.bytes += size; bytes += size; kept++;
      }
      id.dropped += bad;
      if (id.entries.length > C.maxPerId) dropOldest(id, id.entries.length - C.maxPerId);
      shrink();
      return { kept, bad };
    },
    // Identities, most recently seen first: {w, name, names, ips, entries, bytes, lost, bad, first, seen}.
    list() {
      prune(true);
      return [...ids.values()].sort((a, b) => b.seen - a.seen).map(id => ({
        w: id.w, name: id.names[0] ?? null, names: id.names.slice(), ips: id.ips.slice(), entries: id.entries.length,
        bytes: id.bytes, lost: id.lost, bad: id.dropped, first: new Date(id.first).toISOString(), seen: new Date(id.seen).toISOString() }));
    },
    // Identities matching q exactly by word, by any remembered name (case-insensitive) or by any
    // remembered IP, each with its entries oldest first.
    find(q) {
      prune(true);
      if (typeof q !== 'string' || !q || q.length > 64) return [];
      const lq = q.toLowerCase();
      return [...ids.values()]
        .filter(id => id.w === lq || id.ips.includes(q) || id.names.some(n => n.toLowerCase() === lq))
        .sort((a, b) => a.first - b.first)
        .map(id => ({ w: id.w, names: id.names.slice(), ips: id.ips.slice(), lost: id.lost, bad: id.dropped,
          seen: new Date(id.seen).toISOString(),
          entries: id.entries.map(x => ({ at: new Date(x.at).toISOString(), conn: x.c, room: x.r ?? null, ...x.e })) }));
    },
    stats: () => ({ ids: ids.size, bytes, entries: [...ids.values()].reduce((a, id) => a + id.entries.length, 0) }),
    prune: () => prune(true),
  };
}
