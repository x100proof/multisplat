// The M1 static server: MIME types, traversal safety, GET/HEAD only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handler, resolvePath } from '../server/server.js';

test('resolvePath stays inside public/ and shared/', () => {
  assert.ok(resolvePath('/').endsWith('index.html'));
  assert.ok(resolvePath('/shared/sim.js').endsWith('sim.js'));
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/shared/../server/server.js',
    '/shared/%2e%2e/server/server.js', '/..%2f..%2fpackage.json', '/a%00b', '/%E0%A4%A', '/..\\package.json']) {
    const r = resolvePath(bad);
    assert.ok(r === null || !/server\.js$|package\.json$/.test(r), bad);
  }
});

test('serves files with the right MIME type and refuses other methods', async () => {
  const srv = createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(base + '/');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
    r = await fetch(base + '/shared/sim.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/javascript/);
    r = await fetch(base + '/game.js', { method: 'HEAD' });
    assert.equal(r.status, 200); assert.equal(await r.text(), '');
    r = await fetch(base + '/nope.js');
    assert.equal(r.status, 404);
    r = await fetch(base + '/', { method: 'POST', body: 'x' });
    assert.equal(r.status, 405);
    r = await fetch(base + '/..%2fpackage.json');
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});
