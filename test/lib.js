// Shared helpers for the integration tests: free ports, spawning a server, finding Chromium.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED = new Set([3008, 3009]);   // the defaults a real instance may be using

export async function freePort() {
  for (;;) {
    const port = await new Promise((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
    if (!RESERVED.has(port)) return port;
  }
}

export function tempDir(prefix = 'multisplat-') { return mkdtempSync(join(tmpdir(), prefix)); }
export function removeDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

// Start server/server.js as a child process. Resolves once it is listening.
// Returns { port, adminPort, origin, url, wsUrl, proc, logs, stop() }. extra.PORT reuses a port (a
// restart, SPEC §18). STATE_FILE is 'off' unless given, so no test server saves rooms for the next.
export async function startServer(extra = {}, { quiet = true } = {}) {
  const port = extra.PORT ? +extra.PORT : await freePort();
  extra = { STATE_FILE: 'off', ...extra };
  const adminPort = extra.DEBUG_PORT === undefined ? await freePort() : extra.DEBUG_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const vars = { ...process.env, HOST: '127.0.0.1', PORT: String(port), ALLOWED_ORIGINS: origin,
    DEBUG_PORT: adminPort === null ? '' : String(adminPort), ...extra };
  for (const k of Object.keys(vars)) if (vars[k] === null) delete vars[k];
  if (adminPort === null) delete vars.DEBUG_PORT;
  const proc = spawn(process.execPath, [join(ROOT, 'server/server.js')], { env: vars, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const onData = d => { for (const l of String(d).split('\n')) if (l) { logs.push(l); if (!quiet) console.log('  [server] ' + l); } };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start: ' + logs.join(' | '))), 8000);
    const check = () => { if (logs.some(l => l.includes('listening'))) { clearTimeout(t); res(); } };
    proc.stdout.on('data', check);
    proc.once('exit', code => { clearTimeout(t); rej(new Error(`server exited ${code}: ${logs.join(' | ')}`)); });
  });
  const stop = () => new Promise(res => {
    if (proc.exitCode !== null) return res();
    proc.once('exit', res);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
  });
  return { port, adminPort, origin, url: origin + '/', wsUrl: `ws://127.0.0.1:${port}/ws`, proc, logs, stop };
}

// Chromium: $PLAYWRIGHT_CHROMIUM, else let playwright use its own cache, else the newest chromium
// build found in playwright's default cache directory.
export function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
  for (const d of dirs) for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
    const p = join(cache, d, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function launchChromium() {
  const { chromium } = await import('playwright-core');
  const args = ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  try { return await chromium.launch({ args }); }
  catch (e) {
    const p = chromiumPath();
    if (!p) throw new Error('No Chromium found: set PLAYWRIGHT_CHROMIUM to a Chromium binary');
    return chromium.launch({ executablePath: p, args });
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 10000, every = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
}

// Unit-test shim for rooms (SPEC §17). The arena tests were written for the single global arena and
// send a bare hello; withRoom() gives such a hello the id of the newest open room, creating one
// ("Test", no admin yet) when none is open, so the first human to join it becomes its admin (as the
// creator would). roomOf(arena) is that newest room.
export const roomOf = arena => [...arena.rooms.values()].at(-1);
export function withRoom(arena, m) {
  if (!m || typeof m !== 'object' || m.t !== 'hello' || 'room' in m) return m;
  const r = roomOf(arena) || arena.createRoom('Test');
  return { ...m, room: r.id };
}
