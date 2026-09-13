import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './app.js';
test('health endpoint reports readiness', () => {
  let status, body;
  handler({ url: '/healthz' }, { writeHead(code) { status = code; }, end(value) { body = value; } });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { ok: true });
});
