import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markCleanExit } from '../src/patronus/desktop.js';

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), 'patronus-cleanexit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a crashed profile is marked as cleanly exited, keeping every other preference', t => {
  const p = profile(t);
  mkdirSync(join(p, 'Default'));
  writeFileSync(join(p, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'Person 1' }, homepage: 'about:blank' }));
  assert.equal(markCleanExit(p), true);
  const prefs = JSON.parse(readFileSync(join(p, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.profile.exit_type, 'Normal');
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.profile.name, 'Person 1');
  assert.equal(prefs.homepage, 'about:blank');
  assert.equal(statSync(join(p, 'Default', 'Preferences')).mode & 0o777, 0o600);
});

test('an already clean profile is left untouched', t => {
  const p = profile(t);
  mkdirSync(join(p, 'Default'));
  writeFileSync(join(p, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Normal', exited_cleanly: true } }));
  assert.equal(markCleanExit(p), false);
});

test('a brand-new or unreadable profile never blocks startup', t => {
  const p = profile(t);
  assert.equal(markCleanExit(p), false);
  mkdirSync(join(p, 'Default'));
  writeFileSync(join(p, 'Default', 'Preferences'), '{not json');
  assert.equal(markCleanExit(p), false);
});
