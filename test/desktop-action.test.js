import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Patronus } from '../src/patronus/engine.js';

function engine(t) {
  const root = mkdtempSync(join(tmpdir(), 'patronus-desktopaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const e = new Patronus(root);
  // Stand in for the real desktop + control with recording fakes.
  const actions = [];
  e.desktop = { healthy: () => true, status: () => ({ state: 'running', display: ':0' }) };
  const frame = Buffer.from('\xff\xd8\xfffake-jpeg', 'binary');
  e.desktopControl = {
    desktop: e.desktop, view: { width: 1280, height: 720 },
    click: a => { actions.push(['click', a]); return { clicked: a }; },
    scroll: a => { actions.push(['scroll', a]); return { scrolled: a }; },
    type: txt => { actions.push(['type', txt]); return { typed: txt.length }; },
    typeSecret: s => { actions.push(['typeSecret', s]); return { typed: 'credential' }; },
    pressKey: k => { actions.push(['key', k]); return { pressed: k }; },
    navigate: u => { actions.push(['navigate', u]); return { navigated: u }; },
    screenshot: async () => { actions.push(['screenshot']); return frame; }
  };
  e.control = () => e.desktopControl;
  return { root, e, actions, frame };
}

const key = n => 'desktop-action-key-' + n;

test('every desktop action returns a fresh jpeg screenshot', async t => {
  const { e, actions, frame } = engine(t);
  const r = await e.desktopAction({ action: 'click', x: 100, y: 200, idempotencyKey: key(1) });
  assert.equal(r.action, 'click');
  assert.equal(r.screenshotMimeType, 'image/jpeg');
  assert.equal(r.screenshot, frame.toString('base64'));
  assert.deepEqual(r.viewport, { width: 1280, height: 720 });
  assert.deepEqual(actions.at(-1), ['screenshot']);
  assert.deepEqual(actions.find(a => a[0] === 'click')[1], { x: 100, y: 200, button: 'left', count: 1 });
});

test('a bare screenshot action just looks, driving no input', async t => {
  const { e, actions } = engine(t);
  await e.desktopAction({ action: 'screenshot', idempotencyKey: key(2) });
  assert.deepEqual(actions, [['screenshot']]);
});

test('typing a credential reads the saved secret and never exposes it', async t => {
  const { root, e, actions } = engine(t);
  mkdirSync(join(root, 'accounts'), { recursive: true });
  const f = join(root, 'accounts', 'directadmin.json');
  writeFileSync(f, JSON.stringify({ password: 's3cr3t-value' }), { mode: 0o600 });
  chmodSync(f, 0o600);
  const r = await e.desktopAction({ action: 'type', credential: 'directadmin-password', idempotencyKey: key(3) });
  assert.deepEqual(actions.find(a => a[0] === 'typeSecret'), ['typeSecret', 's3cr3t-value']);
  assert.equal(r.typed, 'credential');
  // The secret is not echoed anywhere in the structured result.
  assert.ok(!JSON.stringify(r).includes('s3cr3t-value'));
});

test('an unknown or missing credential reference is refused', async t => {
  const { e } = engine(t);
  await assert.rejects(e.desktopAction({ action: 'type', credential: 'directadmin-password', idempotencyKey: key(4) }), { code: 'CREDENTIAL_MISSING' });
});

test('type requires text or a credential', async t => {
  const { e } = engine(t);
  await assert.rejects(e.desktopAction({ action: 'type', idempotencyKey: key(5) }), { code: 'DESKTOP_TYPE_POLICY' });
});

test('desktop actions are serialized against concurrent use', async t => {
  const { e } = engine(t);
  e.desktopControl.screenshot = () => new Promise(r => setTimeout(() => r(Buffer.from('\xff\xd8\xff', 'binary')), 50));
  const first = e.desktopAction({ action: 'screenshot', idempotencyKey: key(6) });
  await assert.rejects(e.desktopAction({ action: 'screenshot', idempotencyKey: key(7) }), { code: 'DESKTOP_BUSY' });
  await first;
  // Busy clears after completion.
  await e.desktopAction({ action: 'screenshot', idempotencyKey: key(8) });
});

test('a disabled or unhealthy desktop is reported clearly', async t => {
  const { e } = engine(t);
  e.desktop = null; e.control = Patronus.prototype.control.bind(e);
  await assert.rejects(e.desktopAction({ action: 'screenshot', idempotencyKey: key(9) }), { code: 'DESKTOP_DISABLED' });
  e.desktop = { healthy: () => false, status: () => ({ state: 'degraded' }) };
  await assert.rejects(e.desktopAction({ action: 'screenshot', idempotencyKey: key(10) }), { code: 'DESKTOP_NOT_RUNNING' });
});
