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

test('build id: stamped into index.html; ETag revalidation gives 304', async () => {
  const { BUILD } = await import('../server/server.js');
  assert.match(BUILD, /^[0-9a-f]{10}$/);
  const srv = createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(base + '/');
    const html = await r.text();
    assert.ok(html.includes(`<meta name="build" content="${BUILD}">`)); assert.ok(html.includes(`game.js?v=${BUILD}`));
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    for (const path of ['/', '/game.js', '/shared/sim.js']) {
      r = await fetch(base + path); await r.arrayBuffer();
      const etag = r.headers.get('etag'); assert.ok(etag, path);
      const r2 = await fetch(base + path, { headers: { 'If-None-Match': etag } });
      assert.equal(r2.status, 304, path); assert.equal((await r2.arrayBuffer()).byteLength, 0);
      const r3 = await fetch(base + path, { headers: { 'If-None-Match': '"other"' } });
      assert.equal(r3.status, 200, path); await r3.arrayBuffer();
    }
  } finally { srv.close(); }
});
