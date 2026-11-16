// multisplat server. M1: a minimal static file server for public/ and shared/.
// (The WebSocket game server arrives in M2.)
//
// Env: HOST (default 127.0.0.1, so it is meant to sit behind a reverse proxy), PORT (default 3008).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SHARED = join(ROOT, 'shared');
const { HOST = '127.0.0.1', PORT: PORT_ENV } = process.env;
const PORT = +PORT_ENV || 3008;

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

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };

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
      res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(req.method === 'HEAD' ? undefined : buf);
    })
    .catch(() => send(404, 'not found\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer(handler).listen(PORT, HOST, () => console.log(`multisplat listening on http://${HOST}:${PORT}`));
}
