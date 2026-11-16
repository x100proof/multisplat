#!/usr/bin/env node
// Smoke test for a running server: connect to its WebSocket, expect a `welcome`, exit 0 (ok) or 1.
//
//   node test/smoke.js wss://your.domain/ws
//   node test/smoke.js ws://127.0.0.1:3008/ws --origin http://localhost:3008
//
// The Origin header is derived from the URL (wss -> https, ws -> http, same host and port) unless
// --origin is given. It must be one of the server's ALLOWED_ORIGINS. Nothing joins the arena.
import WebSocket from 'ws';

const args = process.argv.slice(2);
const oi = args.indexOf('--origin');
let origin = null;
if (oi >= 0) { origin = args[oi + 1]; args.splice(oi, 2); }
const url = args[0];
if (!url || !/^wss?:\/\//.test(url)) {
  console.error('usage: node test/smoke.js <ws-url> [--origin <origin>]');
  process.exit(1);
}
if (!origin) {
  const u = new URL(url);
  origin = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
}

const fail = msg => { console.error(`smoke: FAIL: ${msg}`); process.exit(1); };
const timer = setTimeout(() => fail('no welcome within 5 s'), 5000);
const ws = new WebSocket(url, { origin, handshakeTimeout: 5000 });
ws.on('unexpected-response', (req, res) => fail(`HTTP ${res.statusCode} (is ${origin} in ALLOWED_ORIGINS?)`));
ws.on('error', e => fail(e.message));
let done = false;
ws.on('message', data => {
  if (done) return;
  let m;
  try { m = JSON.parse(data); } catch { fail('non-JSON message'); }
  if (m.t !== 'welcome') fail(`expected welcome, got ${String(m.t).slice(0, 20)}`);
  clearTimeout(timer);
  done = true;
  console.log(`smoke: ok: welcome (protocol ${m.v}, tick ${m.tick}, ${m.cap} slots)`);
  ws.close(1000);
  setTimeout(() => process.exit(0), 50);
});
