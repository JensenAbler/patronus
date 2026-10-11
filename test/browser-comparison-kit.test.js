import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('../eval/browser-comparison/', import.meta.url));
const python = spawnSync('python3', ['--version']);
const skip = python.status !== 0 && 'python3 unavailable';
const run = (args) => spawnSync('python3', args, { cwd: kit, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });

test('browser comparison kit unit tests pass', { skip }, () => {
  const r = run(['-m', 'unittest', 'discover', '-s', 'tests']);
  assert.equal(r.status, 0, r.stderr);
});

test('browser comparison schedules validate against the manifest', { skip }, () => {
  for (const file of ['pilot_schedule.jsonl', 'observations.jsonl']) {
    const r = run(['eval.py', 'validate', file]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).valid, true, file);
  }
});

test('every R case points at a corpus entry with the same URL', () => {
  const manifest = JSON.parse(readFileSync(new URL('../eval/browser-comparison/manifest.json', import.meta.url), 'utf8'));
  const corpus = JSON.parse(readFileSync(new URL('../eval/corpus.json', import.meta.url), 'utf8'));
  const byId = new Map(corpus.cases.map((c) => [c.id, c]));
  const rCases = manifest.cases.filter((c) => c.id.startsWith('R'));
  assert.ok(rCases.length >= 10);
  for (const c of rCases) {
    const entry = byId.get(c.corpus_ref);
    assert.ok(entry, `${c.id} corpus_ref ${c.corpus_ref} missing`);
    assert.equal(new URL(entry.url).href, new URL(c.url).href, c.id);
  }
});
