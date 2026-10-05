import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prune-releases.py');
const rev = c => c.repeat(40);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'patronus-prune-'));
  const root = join(base, 'releases'), apparmor = join(base, 'apparmor');
  mkdirSync(root); mkdirSync(apparmor);
  const release = (r, previous) => {
    mkdirSync(join(root, r, 'src'), { recursive: true });
    if (previous) writeFileSync(join(root, r, 'previous-service.unit'), `ExecStart=/usr/bin/node ${root}/${previous}/src/patronus/server.js\n`);
    writeFileSync(join(apparmor, `patronus-${r}`), 'profile x {}\n');
  };
  const run = (...extra) => JSON.parse(execFileSync('python3', [script, '--root', root, '--apparmor-dir', apparmor, '--no-unload', ...extra], { encoding: 'utf8' }));
  return { base, root, apparmor, release, run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('keeps the active release and one rollback target, removes the rest and their profiles', t => {
  const f = fixture(); t.after(f.cleanup);
  f.release(rev('a')); f.release(rev('b'), rev('a')); f.release(rev('c'), rev('b')); f.release(rev('d'), rev('c'));
  writeFileSync(join(f.apparmor, `patronus-${rev('e')}`), 'orphan\n');
  const out = f.run('--current', rev('d'));
  assert.deepEqual(out.kept, [rev('c'), rev('d')]);
  assert.deepEqual(out.removed, [rev('a'), rev('b')]);
  assert.deepEqual(out.profilesRemoved, [rev('a'), rev('b'), rev('e')]);
  assert.ok(existsSync(join(f.root, rev('c'))) && existsSync(join(f.root, rev('d'))));
  assert.ok(!existsSync(join(f.root, rev('a'))) && !existsSync(join(f.root, rev('b'))));
  assert.ok(existsSync(join(f.apparmor, `patronus-${rev('d')}`)));
});

test('keeps a release whose runtime a kept release symlinks into', t => {
  const f = fixture(); t.after(f.cleanup);
  f.release(rev('a')); f.release(rev('b'), rev('a')); f.release(rev('c'), rev('b'));
  mkdirSync(join(f.root, rev('a'), 'node_modules')); mkdirSync(join(f.root, rev('a'), 'browsers'));
  symlinkSync(join(f.root, rev('a'), 'node_modules'), join(f.root, rev('c'), 'node_modules'));
  symlinkSync(join(f.root, rev('a'), 'browsers'), join(f.root, rev('c'), 'browsers'));
  const out = f.run('--current', rev('c'));
  assert.deepEqual(out.kept, [rev('a'), rev('b'), rev('c')]);
  assert.deepEqual(out.removed, []);
});

test('keep-previous 0 keeps only the active release and live unit targets', t => {
  const f = fixture(); t.after(f.cleanup);
  f.release(rev('a')); f.release(rev('b'), rev('a')); f.release(rev('c'), rev('b'));
  const unit = join(f.base, 'gateway.service');
  writeFileSync(unit, `ExecStart=/usr/bin/node ${f.root}/${rev('a')}/src/gateway.js\n`);
  const out = f.run('--current', rev('c'), '--keep-previous', '0', '--unit', unit);
  assert.deepEqual(out.kept, [rev('a'), rev('c')]);
  assert.deepEqual(out.removed, [rev('b')]);
});

test('refuses to prune when the active release is missing', t => {
  const f = fixture(); t.after(f.cleanup);
  f.release(rev('a')); f.release(rev('b'), rev('a'));
  const r = spawnSync('python3', [script, '--root', f.root, '--apparmor-dir', f.apparmor, '--no-unload', '--current', rev('f')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.ok(existsSync(join(f.root, rev('a'))) && existsSync(join(f.root, rev('b'))));
});

test('dry run reports without deleting, and non-commit directories are never touched', t => {
  const f = fixture(); t.after(f.cleanup);
  f.release(rev('a')); f.release(rev('b'), rev('a')); f.release(rev('c'), rev('b'));
  mkdirSync(join(f.root, 'scratch'));
  const out = f.run('--current', rev('c'), '--dry-run');
  assert.deepEqual(out.wouldRemove, [rev('a')]);
  assert.deepEqual(out.removed, []);
  assert.ok(existsSync(join(f.root, rev('a'))) && existsSync(join(f.root, 'scratch')));
  f.run('--current', rev('c'));
  assert.ok(!existsSync(join(f.root, rev('a'))) && existsSync(join(f.root, 'scratch')));
});
