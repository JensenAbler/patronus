import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const corpus = JSON.parse(readFileSync(new URL('../eval/corpus.json', import.meta.url), 'utf8'));
const RESULTS = new Set(['pass', 'partial', 'fail', 'not-run']);

test('eval corpus is well formed', () => {
  assert.equal(corpus.version, 1);
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);
  const ids = new Set();
  for (const c of corpus.cases) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `bad id ${c.id}`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    const u = new URL(c.url);
    assert.equal(u.protocol, 'https:', c.id);
    for (const p of u.searchParams.keys()) assert.doesNotMatch(p, /^(utm_|ltsid$|fbclid$|gclid$)/, `${c.id} keeps tracking param ${p}`);
    assert.ok(['content', 'obstacle'].includes(c.expect?.outcome), `${c.id} expect.outcome`);
    if (c.expect.outcome === 'obstacle') assert.ok(c.expect.obstacleCode, `${c.id} needs obstacleCode`);
    assert.ok(Array.isArray(c.observed) && c.observed.length > 0, `${c.id} observed`);
    for (const o of c.observed) {
      assert.match(o.date, /^\d{4}-\d{2}-\d{2}$/, c.id);
      assert.ok(o.route, c.id);
      assert.ok(RESULTS.has(o.result), `${c.id} result ${o.result}`);
    }
  }
});
