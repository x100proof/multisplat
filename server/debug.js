// Remote debugging, server side (SPEC §13): the server event ring, player report intake
// (POST /debug/report) and the read-only admin listener (DEBUG_PORT, always 127.0.0.1).
//
// Report bodies are untrusted input from anonymous clients. They are validated, truncated and
// stored as data; nothing here ever interprets them.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, appendFile, readdir, stat, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REPORT_MAX_BYTES = 16 * 1024;
const MAX_ENTRIES = 300, MAX_STR = 300, MAX_DEPTH = 5, MAX_KEYS = 60, MAX_ARRAY = 300;
const PER_IP_PER_MIN = 6, TOTAL_PER_MIN = 120;
const KEEP_DAYS = 14, KEEP_BYTES = 50 * 1024 * 1024;
// Top-level keys a report may carry. Anything else is a 400. `meta` is what the server adds, so a
// client can never supply it.
const REPORT_KEYS = new Set(['v', 'kind', 'reason', 'ts', 'env', 'net', 'player', 'entries', 'token', 'reportId']);
const FILE_RE = /^reports-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID_RE = /^[a-z0-9]{8}$/;

// ---------- server event ring ----------
export function createEventRing(size = 2000) {
  const ring = [];
  let seq = 0;
  const push = (type, conn, data = {}) => {
    ring.push({ n: ++seq, ts: new Date().toISOString(), type, conn: conn ?? null, ...data });
    if (ring.length > size) ring.shift();
  };
  return { push, list: (n = 100) => ring.slice(-Math.max(1, Math.min(size, n | 0 || 100))), all: () => ring };
}

// ---------- validation ----------
// Strip control characters, truncate strings, bound depth/keys/array sizes. Returns the cleaned
// value, or throws on something that is not plain JSON data.
// eslint-disable-next-line no-control-regex
const CTRL = new RegExp('[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const SPACE = /[\t\n\v\f\r]+/g;   // line breaks and tabs become one space
function clean(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('number'); return v; }
  if (typeof v === 'string') return v.replace(SPACE, ' ').replace(CTRL, '').slice(0, MAX_STR);
  if (depth >= MAX_DEPTH) throw new Error('too deep');
  if (Array.isArray(v)) { if (v.length > MAX_ARRAY) throw new Error('array'); return v.map(x => clean(x, depth + 1)); }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > MAX_KEYS) throw new Error('keys');
    const out = {};
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k.replace(CTRL, '').slice(0, 64)] = clean(v[k], depth + 1);
    }
    return out;
  }
  throw new Error('type');
}

// Returns {report, token} or throws with a short reason.
export function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  for (const k of Object.keys(body)) if (!REPORT_KEYS.has(k)) throw new Error('unknown key');
  if (body.entries !== undefined && (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES)) throw new Error('entries');
  const token = typeof body.token === 'string' ? body.token : null;
  const { token: _drop, ...rest } = body;
  return { report: clean(rest), token };
}

// ---------- intake + storage ----------
export function createDebug({ dir, allowedOrigins, clientIp, arena, events, log = () => {}, now = () => Date.now() }) {
  const perIp = new Map();     // ip -> [timestamps]
  let total = [];
  let pruneAt = 0;

  function limited(ip) {
    const t = now(), cut = t - 60000;
    total = total.filter(x => x > cut);
    const mine = (perIp.get(ip) || []).filter(x => x > cut);
    if (mine.length >= PER_IP_PER_MIN || total.length >= TOTAL_PER_MIN) { perIp.set(ip, mine); return true; }
    mine.push(t); total.push(t); perIp.set(ip, mine);
    if (perIp.size > 10000) for (const [k, v] of perIp) if (!v.some(x => x > cut)) perIp.delete(k);
    return false;
  }

  const fileFor = d => join(dir, `reports-${d.toISOString().slice(0, 10)}.jsonl`);

  async function prune() {
    let names;
    try { names = (await readdir(dir)).filter(n => FILE_RE.test(n)).sort(); } catch { return; }
    const today = new Date(now()).toISOString().slice(0, 10);
    const cutoff = new Date(now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    const files = [];
    for (const n of names) {
      const day = n.match(FILE_RE)[1];
      if (day < cutoff) { await unlink(join(dir, n)).catch(() => {}); continue; }
      const s = await stat(join(dir, n)).catch(() => null);
      if (s) files.push({ n, day, size: s.size });
    }
    let sum = files.reduce((a, f) => a + f.size, 0);
    for (const f of files) {
      if (sum <= KEEP_BYTES) break;
      if (f.day === today) break;               // never delete the file being written
      await unlink(join(dir, f.n)).catch(() => {});
      sum -= f.size;
    }
    return sum;
  }

  async function store(record) {
    await mkdir(dir, { recursive: true });
    if (now() - pruneAt > 10 * 60000) {
      pruneAt = now();
      const sum = await prune();
      if (sum > KEEP_BYTES) throw new Error('debug dir full');
    }
    await appendFile(fileFor(new Date(now())), JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  // POST /debug/report
  function handleReport(req, res) {
    const reply = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...(code === 413 ? { Connection: 'close' } : {}) });
      res.end(body);
    };
    const ip = clientIp(req);
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { error: 'method' }); }
    if (!allowedOrigins.includes(req.headers.origin)) { events.push('report-rejected', null, { ip, why: 'origin' }); return reply(403, { error: 'origin' }); }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reply(400, { error: 'content-type' });
    const len = +req.headers['content-length'];
    if (len > REPORT_MAX_BYTES) { events.push('report-rejected', null, { ip, why: 'size' }); req.resume(); return reply(413, { error: 'too large' }); }
    if (limited(ip)) { events.push('report-rejected', null, { ip, why: 'rate' }); req.resume(); return reply(429, { error: 'rate' }); }
    const chunks = []; let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > REPORT_MAX_BYTES) { done = true; events.push('report-rejected', null, { ip, why: 'size' }); reply(413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { done = true; });
    req.on('end', async () => {
      if (done) return;
      done = true;
      let parsed;
      try { parsed = validateReport(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { events.push('report-rejected', null, { ip, why: 'invalid' }); return reply(400, { error: 'invalid' }); }
      // The server's own view of that connection, found through the resume token. The token
      // itself is dropped here and never stored or logged.
      const server = parsed.token && arena ? arena.viewByToken(parsed.token) : null;
      if (server && server.player) {
        const pid = server.player.id, conns = new Set([server.player.conn, server.conn && server.conn.conn].filter(x => x != null));
        server.recentEvents = events.all().filter(e => e.player === pid || (e.conn != null && conns.has(e.conn))).slice(-30);
      }
      const id = randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
      const record = { meta: { id, received: new Date(now()).toISOString(), ip, server }, report: parsed.report };
      try { await store(record); }
      catch (e) { log(`debug report store failed: ${e.code || e.message}`); return reply(503, { error: 'unavailable' }); }
      events.push('report', server && server.conn ? server.conn.conn : null, { id, player: server && server.player ? server.player.id : null, kind: ['manual', 'auto'].includes(parsed.report.kind) ? parsed.report.kind : 'other' });
      log(`report id=${id} ip=${ip}`);
      reply(200, { id });
    });
  }

  // ---------- reading stored reports (admin listener) ----------
  async function reportFiles() {
    try { return (await readdir(dir)).filter(n => FILE_RE.test(n)).sort().reverse(); } catch { return []; }
  }
  async function listReports(n = 20) {
    const out = [];
    for (const f of await reportFiles()) {
      const lines = (await readFile(join(dir, f), 'utf8').catch(() => '')).split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        try {
          const r = JSON.parse(l);
          out.push({ id: r.meta.id, received: r.meta.received, kind: r.report.kind, reason: r.report.reason,
            player: r.meta.server && r.meta.server.player ? r.meta.server.player.name : null });
        } catch { /* skip a damaged line */ }
        if (out.length >= n) return out;
      }
    }
    return out;
  }
  async function getReport(id) {
    if (!ID_RE.test(id)) return null;
    for (const f of await reportFiles()) {
      const text = await readFile(join(dir, f), 'utf8').catch(() => '');
      for (const l of text.split('\n')) {
        if (!l.includes(`"id":"${id}"`)) continue;
        try { const r = JSON.parse(l); if (r.meta.id === id) return r; } catch { /* skip */ }
      }
    }
    return null;
  }

  // Read-only admin listener. Binds 127.0.0.1 only, whatever HOST is.
  function adminHandler(req, res) {
    const json = (code, obj) => {
      const body = JSON.stringify(obj, null, 1);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET') return json(405, { error: 'read-only' });
    const url = new URL(req.url, 'http://admin.invalid');
    const n = Math.max(1, Math.min(2000, parseInt(url.searchParams.get('n'), 10) || 50));
    if (url.pathname === '/state') return json(200, arena.adminState());
    if (url.pathname === '/events') return json(200, events.list(n));
    if (url.pathname === '/reports') return listReports(n).then(r => json(200, r), () => json(500, { error: 'read' }));
    const m = url.pathname.match(/^\/reports\/([^/]+)$/);
    if (m) return getReport(m[1]).then(r => (r ? json(200, r) : json(404, { error: 'not found' })), () => json(500, { error: 'read' }));
    json(404, { error: 'not found' });
  }

  function listenAdmin(port) {
    return new Promise((resolve, reject) => {
      const srv = createServer(adminHandler);
      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
  }

  return { handleReport, adminHandler, listenAdmin, listReports, getReport, prune };
}
