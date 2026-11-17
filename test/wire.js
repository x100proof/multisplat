// Loaded into every unit test file (npm test: node --import): every message the server sends, and
// every message public/net.js sends, is checked against shared/protocol.js. A message type, field or
// event the protocol does not declare (or one of another kind) fails the run, so the protocol file,
// which is what the rules hash covers (SPEC §18), cannot fall behind the code. The server's reading
// side needs no check here: it reads incoming messages only through readUp().
import { checkMessage } from '../shared/protocol.js';
import { Arena } from '../server/arena.js';

const problems = new Map();   // problem → how often
const note = (dir, m) => { for (const p of checkMessage(dir, m)) problems.set(p, (problems.get(p) || 0) + 1); };
globalThis.__wireCheck = note;

const send = Arena.prototype.send;
Arena.prototype.send = function (conn, msg) {
  let m = msg;
  if (typeof msg === 'string') try { m = JSON.parse(msg); } catch { m = null; }
  note('down', m);
  return send.call(this, conn, msg);
};

process.on('exit', () => {
  if (!problems.size) return;
  console.error(`\nwire: messages that shared/protocol.js does not allow (${process.argv[1]}):`);
  for (const [p, n] of problems) console.error(`  ${p}${n > 1 ? ` (${n}×)` : ''}`);
  process.exitCode = 1;
});
