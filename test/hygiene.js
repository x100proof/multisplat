#!/usr/bin/env node
// Repo hygiene (SPEC §12): no tracked file may name a real deployment. Fails on
//  - an IPv4 address other than loopback and the any-address,
//  - a home-directory path,
//  - a domain other than the example domains and localhost (a short allowlist covers doc links),
//  - the current machine's user or host name (read at run time, never committed).
// Scans `git ls-files` plus untracked, non-ignored files, so it also checks work about to be
// committed. Run alone (`node test/hygiene.js`) or as part of `npm test`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pattern literals are assembled from pieces so this file does not match itself.
const SLASH = '/';
const HOME_DIR = SLASH + 'home' + SLASH;
const TILDE_DIR = '~' + SLASH;
const OK_IPS = new Set(['127.0.0.1', '0.0.0.0']);
const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.]*\d)/g;
// Only names ending in a real top-level domain count, so code such as `state.players` is not a hit.
const TLDS = ['com', 'net', 'org', 'io', 'xyz', 'dev', 'app', 'ai', 'cloud', 'info', 'biz', 'tv', 'gg',
  'uk', 'de', 'fr', 'nl', 'eu', 'us', 'ca', 'au', 'jp', 'ru', 'cn', 'lan', 'internal', 'home', 'arpa'];
const DOMAIN = new RegExp(String.raw`\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:` + TLDS.join('|') + String.raw`))\b`, 'gi');
// Allowed: placeholder domains, and documentation / package-registry hosts.
const OK_DOMAINS = ['example.com', 'example.org', 'example.net', 'npmjs.org', 'npmjs.com',
  'nodejs.org', 'developer.mozilla.org', 'w3.org', 'playwright.dev'];
const domainOk = d => { d = d.toLowerCase(); return OK_DOMAINS.some(a => d === a || d.endsWith('.' + a)); };

// Narrow exemptions: exact text that states a hygiene rule rather than breaking it. Each entry is
// removed from that file's lines before scanning, so anything else on the line is still checked.
const EXEMPT = {
  'SPEC.md': ['a home path (`' + HOME_DIR + '`, `' + TILDE_DIR + '`)'],
};

// The machine's own names, if distinctive enough to search for without false hits.
const GENERIC = new Set(['root', 'node', 'runner', 'user', 'ubuntu', 'admin', 'debian', 'localhost', 'docker', 'build']);
const local = [];
try { local.push(userInfo().username); } catch { /* no user info */ }
local.push(hostname().split('.')[0]);
const LOCAL_NAMES = [...new Set(local)].filter(n => n && n.length >= 5 && !GENERIC.has(n.toLowerCase()));

function files() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  return out.toString('utf8').split('\0').filter(Boolean);
}

export function scan() {
  const problems = [];
  for (const f of files()) {
    let buf;
    try { buf = readFileSync(join(ROOT, f)); } catch { continue; }   // deleted but still tracked
    if (buf.includes(0)) continue;                                      // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((raw, i) => {
      let line = raw;
      for (const t of EXEMPT[f] || []) line = line.split(t).join('');
      const bad = what => problems.push(`${f}:${i + 1}: ${what}`);
      for (const m of line.matchAll(IPV4)) {
        if (m.slice(1).every(n => +n <= 255) && !OK_IPS.has(m[0])) bad('IPv4 address ' + m[0]);
      }
      if (line.includes(HOME_DIR)) bad('home path');
      if (line.includes(TILDE_DIR)) bad('home path (tilde)');
      for (const m of line.matchAll(DOMAIN)) if (!domainOk(m[1])) bad('domain ' + m[1]);
      for (const n of LOCAL_NAMES) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line)) bad('local user/host name');
    });
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = scan();
  if (problems.length) {
    console.error('hygiene: FAIL\n' + problems.map(p => '  ' + p).join('\n'));
    process.exit(1);
  }
  console.log(`hygiene: ok (${files().length} files)`);
}
