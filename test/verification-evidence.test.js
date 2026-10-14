import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceWriter } from '../src/patronus/verification-evidence.js';
test('unique crops are saved only for verified challenge panels', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'huck-evidence-test-'));
  try {
    let encodes = 0;
    const save = createEvidenceWriter({ directory, attemptId: 'fixture_test', utc: () => '2026-10-14T00:00:00Z',
      encodeCrop: async () => { encodes++; return Buffer.from('mock image bytes'); } });
    const f = { panelPresent: true, anchorVerified: true, session: 'S', controlLabel: 'Skip',
      panelRectangle: { x: 464, y: 198, width: 344, height: 380 },
      controlRectangle: { x: 736, y: 535, width: 72, height: 44 } };
    await save(f, 'before'); await save(f, 'after');
    await save({ ...f, panelPresent: false }, 'absent');
    await save({ ...f, anchorVerified: false }, 'unknown');
    assert.equal(encodes, 4); assert.equal(readdirSync(directory).filter(x => x.endsWith('.jpg')).length, 4);
    const absent = readdirSync(directory).find(x => x.includes('absent'));
    assert.ok(!readFileSync(join(directory, absent), 'utf8').includes('panelFile'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
