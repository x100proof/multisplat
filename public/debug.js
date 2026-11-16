// Client-side remote debugging (SPEC §13.1): a ring buffer of structured log entries that all
// client code writes through dbg(), and the debug report sent to POST /debug/report.
//
// A report holds: the environment, net statistics, the local player's state and the ring. It never
// holds keystrokes. The resume token rides along only so the server can attach its own view of
// this connection; the server drops it before storing anything.
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

const cut = s => (typeof s === 'string' && s.length > STR_MAX ? s.slice(0, STR_MAX) : s);

// dbg(cat, msg, data): cat is one of net, sync, perf, audio, input, life, error (and 'verbose').
export function dbg(cat, msg, data) {
  const e = { ts: Math.round(performance.now()), tick: tickOf(), cat, msg: cut(String(msg)) };
  if (data !== undefined) e.data = data;
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();
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
