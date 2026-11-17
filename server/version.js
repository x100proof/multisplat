// The files the server serves, read once at start, and the two ids computed from them (SPEC §18):
//
// - the build id (SPEC §10): a short hash of every byte under public/ and shared/. Any change at all,
//   a CSS tweak included, gives a new one. It is for diagnostics and for the quiet reload of a page
//   whose UI is older than the server's.
// - the rules hash: a hash of the code that client and server must agree on to share a game, i.e.
//   every file under shared/: the deterministic sim, constants and level the page predicts with, and
//   shared/protocol.js, every message and field on the wire. Each is normalized first (comments
//   dropped, whitespace runs collapsed: see normalizeJs), so editing a comment or re-indenting does
//   not count as a change. public/net.js is not in it: a page that is already running keeps its own
//   net.js, so a new one only matters to new pages; what a running page and a new server must agree
//   on is the protocol, and both ends are held to protocol.js (see there).
//
// Nobody maintains either by hand: both are computed from the code the server is about to serve.
// The files are kept in memory and served from there (server/server.js), so the page a browser
// loads is always exactly the code these hashes were taken of, even though the service runs from a
// working tree that a deploy rewrites underneath it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Every regular file under each dir: [{rel: 'shared/sim.js', full, buf}], sorted by path (byte order).
export function readTree(root, dirs) {
  const out = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out.push({ rel: relative(root, f).split(sep).join('/'), full: f, buf: readFileSync(f) });
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// The build id: as before this file existed (name + bytes of every file, per directory in name
// order), so its value is unchanged.
export function buildId(files) {
  const h = createHash('sha256');
  for (const f of files) { h.update(f.rel.slice(f.rel.lastIndexOf('/') + 1)); h.update(f.buf); }
  return h.digest('hex').slice(0, 10);
}

// The files the rules hash covers: everything under shared/ (protocol.js included).
export const isRulesFile = rel => rel.startsWith('shared/');

// The rules hash: sha256 over "<path>\0<normalized text>\0" of each rules file in path order; 16 hex.
export function rulesHash(files) {
  const h = createHash('sha256');
  for (const f of files) if (isRulesFile(f.rel)) { h.update(f.rel + '\0'); h.update(normalizeJs(f.buf.toString('utf8')) + '\0'); }
  return h.digest('hex').slice(0, 16);
}

// JavaScript with its comments removed and its whitespace collapsed, for the rules hash. The only
// promise is the safe one: two sources that differ in anything but comments and the amount of
// whitespace give different results. Strings ('', "", template literals with their ${} parts nested
// to any depth) and regular-expression literals are copied byte for byte, so a "//" or "/*" inside
// them is never taken for a comment. Whether a / starts a regex or is a division is decided the
// usual way, from the previous token (after an operator, an opening bracket, a comma, a keyword
// such as return, or at the start: a regex; after a name, a number or a closing bracket: division).
// A whitespace run becomes one "\n" if it held a line break (line breaks matter in JS: return\nx is
// not return x) and one space otherwise; a comment counts as whitespace (a block comment holding a
// line break as a line break). Leading and trailing whitespace is dropped.
const KW_BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
export function normalizeJs(src) {
  let out = '', i = 0, ws = '';                 // ws: pending whitespace ('' | ' ' | '\n')
  let last = '';                                 // the previous significant token's last char ('' at start)
  let word = '';                                 // the previous token if it was a name
  const stack = [];                              // open template literals: brace depth of each ${ … }
  let depth = 0;                                 // braces open in the current ${ … }
  const n = src.length;
  const flush = () => { if (ws && out) out += ws; ws = ''; };
  const space = c => { if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') ws = '\n'; else if (ws !== '\n') ws = ' '; };
  // copy a template literal's text from i (just after ` or }) up to and including its closing ` or ${
  const template = () => {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; last = '`'; word = ''; return; }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; stack.push(depth); depth = 0; last = '{'; word = ''; return; }
      out += c; i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029') { space(c); i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2), stop = end < 0 ? n : end + 2;
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, stop))) ws = '\n'; else if (ws !== '\n') ws = ' ';
      i = stop; continue;
    }
    flush();
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; last = c; word = ''; continue;
    }
    if (c === '`') { out += c; i++; template(); continue; }
    if (c === '}' && stack.length && depth === 0) { out += c; i++; depth = stack.pop(); template(); continue; }
    if (c === '/') {
      const regex = last === '' || (word ? KW_BEFORE_EXPR.has(word) : !/[\w$)\]'"`]/.test(last));
      if (regex) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;   // flags
        out += src.slice(i, j); i = j; last = 'r'; word = ''; continue;   // a regex ends like a name: / after it divides
      }
    }
    if (/[\w$]/.test(c) || c > '\u007f') {
      let j = i; while (j < n && (/[\w$]/.test(src[j]) || src[j] > '\u007f') && !/[\u00a0\ufeff\u2028\u2029]/.test(src[j])) j++;
      const tok = src.slice(i, j);
      out += tok; i = j; last = tok[tok.length - 1]; word = /^[A-Za-z_$]/.test(tok) ? tok : ''; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    out += c; i++; last = c; word = '';
  }
  return out;
}
