// multisplat server: static files for public/ and shared/, the WebSocket game server on /ws,
// player debug-report intake on POST /debug/report, and an optional loopback admin listener.
//
// All site-specific values come from the environment (SPEC §10): HOST, PORT, ALLOWED_ORIGINS,
// TRUST_PROXY, MAX_PER_IP, MAX_CONN, DEBUG_DIR, DEBUG_PORT, NET_SIM, ITEM_SECS, STAR_SECS and ITEM_POINTS (the last four
// for tests only, refused when NODE_ENV=production).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep, extname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { Arena } from './arena.js';
import { DEFAULTS, TICK_HZ } from '../shared/constants.js';
import { LEVEL } from '../shared/level.js';
import { createDebug, createEventRing } from './debug.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SHARED = join(ROOT, 'shared');
const MAX_PAYLOAD = 1024;
const PING_EVERY_MS = 2000, DEAD_AFTER_MS = 30000;

// Read and check the configuration. Throws on a value that must not be used.
export function loadConfig(vars = process.env) {
  const port = vars.PORT === undefined || vars.PORT === '' ? 3008 : +vars.PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number');
  const cfg = {
    host: vars.HOST || '127.0.0.1',
    port,
    allowedOrigins: (vars.ALLOWED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map(s => s.trim()).filter(Boolean),
    trustProxy: !!vars.TRUST_PROXY && vars.TRUST_PROXY !== '0' && vars.TRUST_PROXY !== 'false',
    maxPerIp: +vars.MAX_PER_IP || 4,
    maxConn: +vars.MAX_CONN || 40,
    debugDir: resolve(vars.DEBUG_DIR || join(ROOT, 'debug-reports')),
    debugPort: vars.DEBUG_PORT ? +vars.DEBUG_PORT : null,
    netSim: null,
    itemSecs: null,
    starSecs: null,
    itemPoints: null,
  };
  if (cfg.debugPort !== null && (!Number.isInteger(cfg.debugPort) || cfg.debugPort < 0 || cfg.debugPort > 65535)) throw new Error('DEBUG_PORT must be a port number');
  if (vars.NET_SIM) {
    if (vars.NODE_ENV === 'production') throw new Error('NET_SIM is for testing and is refused when NODE_ENV=production');
    const [d, j = 0] = vars.NET_SIM.split(',').map(Number);
    if (!(d >= 0) || !(j >= 0)) throw new Error('NET_SIM must be delayMs,jitterPct');
    cfg.netSim = { delayMs: d, jitterPct: j };
  }
  // ITEM_SECS=min,max shortens the long-sword spawn timer (SPEC §5.1 says 20-40 s) for tests.
  if (vars.ITEM_SECS) {
    if (vars.NODE_ENV === 'production') throw new Error('ITEM_SECS is for testing and is refused when NODE_ENV=production');
    const [a, b = a] = vars.ITEM_SECS.split(',').map(Number);
    if (!(a > 0) || !(b >= a)) throw new Error('ITEM_SECS must be minS,maxS');
    cfg.itemSecs = { min: a, max: b };
  }
  // STAR_SECS=min,max does the same for the ninja-star pickups (SPEC §5.2 says 5-10 s).
  if (vars.STAR_SECS) {
    if (vars.NODE_ENV === 'production') throw new Error('STAR_SECS is for testing and is refused when NODE_ENV=production');
    const [a, b = a] = vars.STAR_SECS.split(',').map(Number);
    if (!(a > 0) || !(b >= a)) throw new Error('STAR_SECS must be minS,maxS');
    cfg.starSecs = { min: a, max: b };
  }
  // ITEM_POINTS=i,j,... restricts pickups (of both kinds) to those LEVEL.items indexes (so a test bot can reach them).
  if (vars.ITEM_POINTS) {
    if (vars.NODE_ENV === 'production') throw new Error('ITEM_POINTS is for testing and is refused when NODE_ENV=production');
    const idx = vars.ITEM_POINTS.split(',').map(Number);
    if (!idx.every(i => Number.isInteger(i) && i >= 0 && i < LEVEL.items.length)) throw new Error('ITEM_POINTS must be item point indexes');
    cfg.itemPoints = [...new Set(idx)];
  }
  return cfg;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

// Map a URL path to a file under public/ or shared/, or null if it would escape them.
export function resolvePath(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  let base = PUBLIC;
  if (p === '/shared' || p.startsWith('/shared/')) { base = SHARED; p = p.slice('/shared'.length); }
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const full = normalize(join(base, p));
  if (!full.startsWith(base + sep)) return null;
  return full;
}

// Build id (SPEC §10): a short hash of everything under public/ and shared/, taken at start. It is
// stamped into the served index.html and sent in every welcome, so a page left open across a deploy
// can tell it is stale and reload itself.
function hashTree(dirs) {
  const h = createHash('sha256');
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.isFile()) { h.update(e.name); h.update(readFileSync(f)); }
    }
  };
  for (const d of dirs) walk(d);
  return h.digest('hex').slice(0, 10);
}
export const BUILD = hashTree([PUBLIC, SHARED]);
const INDEX = join(PUBLIC, 'index.html');
const stampIndex = buf => Buffer.from(buf.toString('utf8')
  .replace('<head>', `<head>\n<meta name="build" content="${BUILD}">`)
  .replace('src="game.js"', `src="game.js?v=${BUILD}"`));

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };

// Static GET/HEAD for public/ and shared/.
export function handler(req, res) {
  const send = (code, body, extra = {}) => {
    res.writeHead(code, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed\n', { Allow: 'GET, HEAD' });
  const file = resolvePath(req.url || '/');
  if (!file) return send(404, 'not found\n');
  stat(file)
    .then(s => { if (!s.isFile()) throw new Error('not a file'); return readFile(file); })
    .then(buf => {
      if (file === INDEX) buf = stampIndex(buf);
      // no-cache + ETag: the browser asks every time and gets the new file or a 304
      const etag = '"' + createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...HEADERS, ETag: etag }); return res.end(); }
      res.writeHead(200, { ...HEADERS, ETag: etag, 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
    })
    .catch(() => send(404, 'not found\n'));
}

// Client IP: the socket address, or X-Real-IP (set by your proxy) when TRUST_PROXY is set.
export function clientIpOf(req, trustProxy) {
  if (trustProxy) {
    const h = req.headers['x-real-ip'];
    if (typeof h === 'string' && h.length <= 64 && /^[0-9a-fA-F.:]+$/.test(h)) return h;
  }
  return req.socket.remoteAddress || '?';
}

// NET_SIM: deliver each message after delayMs ± jitterPct %, keeping order (one queue per direction).
function delayer(sim) {
  let last = 0;
  return fn => {
    const now = performance.now();
    const d = sim.delayMs * (1 + (Math.random() * 2 - 1) * sim.jitterPct / 100);
    const at = Math.max(last, now + d);
    last = at;
    setTimeout(fn, at - now);
  };
}

export async function startServer(cfg = loadConfig(), { log = console.log } = {}) {
  const events = createEventRing(2000);
  const simCfg = cfg.itemSecs || cfg.starSecs ? {
    ...DEFAULTS,
    ...(cfg.itemSecs ? { itemMinTicks: Math.round(cfg.itemSecs.min * TICK_HZ), itemMaxTicks: Math.round(cfg.itemSecs.max * TICK_HZ) } : {}),
    ...(cfg.starSecs ? { starMinTicks: Math.round(cfg.starSecs.min * TICK_HZ), starMaxTicks: Math.round(cfg.starSecs.max * TICK_HZ) } : {}),
  } : DEFAULTS;
  const level = cfg.itemPoints ? { ...LEVEL, items: cfg.itemPoints.map(i => LEVEL.items[i]) } : LEVEL;
  const arena = new Arena({ build: BUILD, log, event: events.push, maxPerIp: cfg.maxPerIp, cfg: simCfg, level });
  const clientIp = req => clientIpOf(req, cfg.trustProxy);
  const debug = createDebug({ dir: cfg.debugDir, allowedOrigins: cfg.allowedOrigins, clientIp, arena, events, log });

  const http = createServer((req, res) => {
    if ((req.url || '/').split('?')[0] === '/debug/report') return debug.handleReport(req, res);
    handler(req, res);
  });
  http.on('clientError', (err, socket) => socket.destroy());

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const perIp = new Map();
  let pendingUpgrades = 0;
  const refuse = (socket, code, text, why, ip) => {
    events.push('refused', null, { ip, why });
    log(`refuse ip=${ip} why=${why}`);
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const ip = clientIp(req);
    if ((req.url || '').split('?')[0] !== '/ws') return refuse(socket, 404, 'Not Found', 'path', ip);
    if (!cfg.allowedOrigins.includes(req.headers.origin)) return refuse(socket, 403, 'Forbidden', 'origin', ip);
    if (arena.conns.size + pendingUpgrades >= cfg.maxConn) return refuse(socket, 503, 'Service Unavailable', 'max-conn', ip);
    if ((perIp.get(ip) || 0) >= cfg.maxPerIp) return refuse(socket, 429, 'Too Many Requests', 'max-per-ip', ip);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    pendingUpgrades++;
    let counted = true, pending = true;
    const uncount = () => {
      if (pending) { pending = false; pendingUpgrades--; }
      if (!counted) return;
      counted = false;
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    };
    socket.once('close', uncount);
    wss.handleUpgrade(req, socket, head, ws => {
      if (pending) { pending = false; pendingUpgrades--; }
      onSocket(ws, ip, uncount);
    });
  });

  function onSocket(ws, ip, uncount) {
    const sim = cfg.netSim;
    const outQ = sim && delayer(sim), inQ = sim && delayer(sim);
    const conn = arena.connect({
      ip,
      send: s => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > 256 * 1024) return ws.terminate();   // a client that stopped reading
        if (outQ) outQ(() => { if (ws.readyState === ws.OPEN) ws.send(s); }); else ws.send(s);
      },
      close: (code, reason) => {
        const go = () => { try { ws.close(code, reason); } catch { ws.terminate(); } setTimeout(() => ws.terminate(), 2000).unref(); };
        if (outQ) outQ(go); else go();
      },
    });
    log(`connect conn=${conn.id} ip=${ip}`);
    events.push('connect', conn.id, { ip });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return arena.kick(conn, 'malformed');
      if (inQ) inQ(() => arena.onMessage(conn, data)); else arena.onMessage(conn, data);
    });
    // Server-measured RTT from protocol-level pings (delayed like everything else under NET_SIM).
    let pingAt = 0, lastPong = performance.now();
    const pinger = setInterval(() => {
      if (performance.now() - lastPong > DEAD_AFTER_MS) return ws.terminate();
      const send = () => { pingAt = performance.now(); try { ws.ping(); } catch { /* closed */ } };
      if (outQ) outQ(send); else send();
    }, PING_EVERY_MS);
    ws.on('pong', () => {
      const got = () => {
        lastPong = performance.now();
        if (pingAt) { const r = lastPong - pingAt; conn.rtt = conn.rtt ? conn.rtt * .7 + r * .3 : r; }
      };
      if (inQ) inQ(got); else got();
    });
    ws.on('close', code => {
      clearInterval(pinger);
      uncount();
      if (!conn.closed) { log(`close conn=${conn.id} code=${code}`); events.push('close', conn.id, { code }); }
      const fin = () => arena.disconnect(conn);
      if (inQ) inQ(fin); else fin();
    });
    ws.on('error', err => { log(`ws error conn=${conn.id}: ${err.code || err.message}`); });
  }

  await new Promise((res, rej) => { http.once('error', rej); http.listen(cfg.port, cfg.host, res); });
  const admin = cfg.debugPort !== null ? await debug.listenAdmin(cfg.debugPort) : null;
  arena.start();
  debug.prune().catch(() => {});
  return {
    http, wss, arena, debug, admin, events, cfg,
    port: http.address().port, adminPort: admin ? admin.address().port : null,
    async close() {
      arena.stop();
      for (const c of wss.clients) c.terminate();
      await Promise.all([new Promise(r => http.close(r)), admin ? new Promise(r => admin.close(r)) : null]);
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { console.error(`multisplat: ${e.message}`); process.exit(2); }
  startServer(cfg).then(s => {
    console.log(`multisplat listening on http://${cfg.host}:${s.port}` + (s.adminPort ? ` (admin on 127.0.0.1:${s.adminPort})` : '') +
      (cfg.netSim ? ` NET_SIM=${cfg.netSim.delayMs},${cfg.netSim.jitterPct}` : '') +
      (cfg.itemSecs ? ` ITEM_SECS=${cfg.itemSecs.min},${cfg.itemSecs.max}` : '') +
      (cfg.itemPoints ? ` ITEM_POINTS=${cfg.itemPoints.join(',')}` : ''));
    const bye = sig => { console.log(`${sig}: shutting down`); s.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
  }, e => { console.error(`multisplat: ${e.message}`); process.exit(1); });
}
