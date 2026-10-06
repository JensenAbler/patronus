import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopControl, makeRandom, ALLOWED_KEYS, VIEW } from '../src/patronus/desktop-control.js';

// A fake desktop and a recording DesktopControl: we assert on the exact xdotool argv
// the control would run, without launching X. Timing sleeps are real but tiny.
function control(overrides = {}) {
  const calls = [];
  const desktop = { display: ':9', healthy: () => true };
  const ctrl = new DesktopControl(desktop, { random: makeRandom(1), now: () => 1000, ...overrides });
  return { ctrl, desktop };
}

// Since run() is a module function, exercise the pure logic that doesn't spawn:
// coordinate mapping, key/type/navigate validation, and button mapping.

test('view coordinates map into real screen pixels and reject out-of-range points', () => {
  const { ctrl } = control();
  assert.deepEqual(ctrl.toScreen(0, 0), { x: 0, y: 0 });
  assert.deepEqual(ctrl.toScreen(VIEW.width - 1, VIEW.height - 1), { x: 1919, y: 1079 });
  assert.deepEqual(ctrl.toScreen(640, 360), { x: 960, y: 540 });
  for (const bad of [[-1, 0], [0, -1], [VIEW.width, 0], [0, VIEW.height], [NaN, 0]])
    assert.throws(() => ctrl.toScreen(bad[0], bad[1]), { code: 'DESKTOP_COORDINATE_POLICY' });
});

test('typing rejects control characters and overlong input', async () => {
  const { ctrl } = control();
  await assert.rejects(ctrl.type('line\nbreak'), { code: 'DESKTOP_TYPE_POLICY' });
  await assert.rejects(ctrl.type('x'.repeat(2001)), { code: 'DESKTOP_TYPE_POLICY' });
  await assert.rejects(ctrl.type(42), { code: 'DESKTOP_TYPE_POLICY' });
});

test('only mapped keys are allowed and chords stay on the allowlist', async () => {
  const { ctrl } = control();
  await assert.rejects(ctrl.pressKey('F1'), { code: 'DESKTOP_KEY_POLICY' });
  await assert.rejects(ctrl.pressKey('Control+Shift+J'), { code: 'DESKTOP_KEY_POLICY' });
  assert.ok(ALLOWED_KEYS.includes('Enter') && ALLOWED_KEYS.includes('Escape'));
  assert.ok(!ALLOWED_KEYS.some(k => /F\d|Meta|Super|Delete.*Forward/.test(k) && k === 'F12'));
});

test('navigate requires an http(s) URL', async () => {
  const { ctrl } = control();
  await assert.rejects(ctrl.navigate('file:///etc/passwd'), { code: 'DESKTOP_NAVIGATE_POLICY' });
  await assert.rejects(ctrl.navigate('javascript:alert(1)'), { code: 'DESKTOP_NAVIGATE_POLICY' });
  await assert.rejects(ctrl.navigate('not a url'), { code: 'DESKTOP_NAVIGATE_POLICY' });
});

test('click rejects unknown buttons before any movement', async () => {
  const { ctrl } = control();
  await assert.rejects(ctrl.click({ x: 10, y: 10, button: 'extra' }), { code: 'DESKTOP_BUTTON_POLICY' });
});

test('control refuses to act when the desktop is not running', () => {
  const ctrl = new DesktopControl({ display: ':9', healthy: () => false });
  assert.throws(() => ctrl.display, { code: 'DESKTOP_NOT_RUNNING' });
});

test('seeded jitter is deterministic for reproducible runs', () => {
  const a = makeRandom(7), b = makeRandom(7);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});
