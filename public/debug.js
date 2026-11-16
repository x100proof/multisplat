// Client-side remote debugging (SPEC §13.1): a ring buffer of structured log entries that all
// client code writes through dbg(), the debug report sent to POST /debug/report, and the stream
// of the same entries to the server over the game WebSocket (SPEC §13.5), kept there for an hour.
//
// A report holds: the environment, net statistics, the local player's state and the ring. It never
// holds keystrokes. The resume token rides along only so the server can attach its own view of
// this connection; the server drops it before storing anything.
import { LOG } from '/shared/logid.js';

const RING_MAX = 300;
const REPORT_MAX = 16000;                  // bytes; the server refuses over 16 KiB
const AUTO_MIN_GAP_MS = 60000, AUTO_MAX = 5;
const STR_MAX = 300;

export const VERBOSE = new URLSearchParams(location.search).get('debug') === '1';
const ring = [];
let tickOf = () => 0;
let sourceOf = () => ({});
let lastAuto = -Infinity, autoCount = 0;
export let lastReportId = null;
export let wordId = null;                  // the log word id the server gave this browser (§13.5)
export function setWordId(w) { wordId = w; }

const cut = s => (typeof s === 'string' && s.length > STR_MAX ? s.slice(0, STR_MAX) : s);

// dbg(cat, msg, data): cat is one of net, sync, perf, audio, input, life, error (and 'verbose').
export function dbg(cat, msg, data) {
  const e = { ts: Math.round(performance.now()), tick: tickOf(), cat, msg: cut(String(msg)) };
  if (data !== undefined) e.data = data;
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();
  queueForStream(e);
  if (VERBOSE) console.debug(`[${cat}] ${msg}`, data ?? '');
}
// Verbose-only entries (every snapshot, every correction): cheap no-ops otherwise.
export function dbgv(cat, msg, data) { if (VERBOSE) dbg(cat, msg, data); }
export const entries = () => ring.slice();

// The game registers how to read the current tick and the report's environment/net/player parts.
export function setTickSource(fn) { tickOf = fn; }
export function setReportSource(fn) { sourceOf = fn; }

const bytes = s => new TextEncoder().encode(s).length;
function sanitize(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === 'string') return cut(v);
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => sanitize(x, depth + 1));
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = sanitize(v[k], depth + 1); return o; }
  return String(v).slice(0, STR_MAX);
}

// Build a report object no larger than REPORT_MAX bytes, dropping the oldest entries to fit.
export function buildReport(kind, reason) {
  const { env = {}, net = {}, player = null, token = null } = sourceOf() || {};
  const base = { v: 1, kind, reason: cut(reason || ''), ts: new Date().toISOString(),
    env: sanitize(env), net: sanitize(net), player: sanitize(player) };
  if (token) base.token = token;
  if (wordId) base.w = wordId;
  let list = ring.map(e => sanitize(e));
  let body = JSON.stringify({ ...base, entries: list });
  if (bytes(body) > REPORT_MAX) {
    // drop from the front in chunks until it fits
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bytes(JSON.stringify({ ...base, entries: list.slice(mid) })) <= REPORT_MAX) hi = mid; else lo = mid + 1;
    }
    list = list.slice(lo);
    body = JSON.stringify({ ...base, entries: list });
  }
  return body;
}

// Send a report. kind 'manual' always goes; 'auto' is limited to one per minute, five per page.
// Resolves to the server's report id, or null.
export async function sendReport(kind = 'manual', reason = '') {
  if (kind !== 'manual') {
    const now = performance.now();
    if (now - lastAuto < AUTO_MIN_GAP_MS || autoCount >= AUTO_MAX) return null;
    lastAuto = now; autoCount++;
  }
  try {
    const res = await fetch('/debug/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: buildReport(kind, reason), keepalive: kind !== 'manual', credentials: 'omit' });
    if (!res.ok) { dbg('net', 'report refused', { status: res.status }); return null; }
    const { id } = await res.json();
    lastReportId = typeof id === 'string' ? id : null;
    dbg('net', 'report sent', { id: lastReportId, kind });
    return lastReportId;
  } catch (e) {
    dbg('net', 'report failed', { err: String(e && e.message || e) });
    return null;
  }
}

// Uncaught errors go to the ring and trigger an automatic report.
export function installErrorHandlers() {
  addEventListener('error', e => {
    dbg('error', cut(e.message || 'error'), { src: cut(String(e.filename || '').split('/').pop()), line: e.lineno, col: e.colno, stack: cut(e.error && e.error.stack) });
    sendReport('auto', 'error');
  });
  addEventListener('unhandledrejection', e => {
    const r = e.reason;
    dbg('error', 'unhandledrejection: ' + cut(String(r && r.message || r)), { stack: cut(r && r.stack) });
    sendReport('auto', 'unhandledrejection');
  });
  document.addEventListener('visibilitychange', () => dbg('life', document.hidden ? 'tab hidden' : 'tab visible'));
}

// ---------- streaming (SPEC §13.5) ----------
// Every entry except the verbose ones (?debug=1 snapshots and corrections) is also queued for the
// server, which keeps an hour of them per word id. net.js registers the sink (the open game
// socket); the queue is flushed every LOG.flushMs and when the tab is hidden or closed, packed into
// messages of at most LOG.msgBytes / LOG.maxEntries, LOG.perFlush messages per flush. Past
// LOG.queueMax unsent entries the oldest are dropped and reported as `lost` in the next message.
const outq = [];
let lost = 0, sink = null;
const thinAt = new Map();
function queueForStream(e) {
  if (e.cat === 'verbose') return;
  const key = e.cat + ' ' + e.msg, gap = LOG.thin[key];
  if (gap) { const t = thinAt.get(key) ?? -Infinity; if (e.ts - t < gap) return; thinAt.set(key, e.ts); }
  outq.push(e);
  if (outq.length > LOG.queueMax) { outq.shift(); lost++; }
}
// sink(str) sends one message and returns true, or false if it cannot right now.
export function setLogSink(fn) { sink = fn; }
// One entry as it goes on the wire: sanitized, and cut down if it alone would not fit a message.
function wireEntry(e) {
  const o = sanitize(e);
  if (bytes(JSON.stringify(o)) > LOG.msgBytes - 60) { o.msg = String(o.msg).slice(0, 120); if (o.data !== undefined) o.data = JSON.stringify(o.data).slice(0, 200); }
  if (bytes(JSON.stringify(o)) > LOG.msgBytes - 60) delete o.data;
  return o;
}
export function flushLog() {
  if (!sink) return;
  for (let k = 0; k < LOG.perFlush && (outq.length || lost); k++) {
    const batch = [], head = lost ? { t: 'log', lost } : { t: 'log' };
    let size = bytes(JSON.stringify({ ...head, e: [] }));
    let n = 0;
    for (; n < outq.length && batch.length < LOG.maxEntries; n++) {
      const w = wireEntry(outq[n]), b = bytes(JSON.stringify(w)) + 1;
      if (size + b > LOG.msgBytes) break;
      batch.push(w); size += b;
    }
    if (!sink(JSON.stringify({ ...head, e: batch }))) return;
    outq.splice(0, n); lost = 0;
  }
}
if (typeof addEventListener === 'function') {
  setInterval(flushLog, LOG.flushMs);
  addEventListener('pagehide', flushLog);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) flushLog(); });
}
