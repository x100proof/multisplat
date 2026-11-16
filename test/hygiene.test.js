// Runs the repo hygiene scan (test/hygiene.js) as part of `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from './hygiene.js';

test('repo hygiene: no hosts, IPs, home paths or local names in tracked files', () => {
  assert.deepEqual(scan(), []);
});
