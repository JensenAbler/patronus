import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Desktop, chromeArgs, FORBIDDEN_FLAGS } from '../src/patronus/desktop.js';
import { safeURL } from '../src/patronus/network.js';

class Child extends EventEmitter {
  constructor(cmd, args, opts) { super(); Object.assign(this, { cmd, args, opts, exitCode: null, signalCode: null, signals: [], stdout: new PassThrough() }); }
  kill(signal) { this.signals.push(signal); this.exit(null, signal); return true; }
  exit(code, signal) { if (this.exitCode !== null || this.signalCode !== null) return; this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); }
}

function harness(t, { displayOut = '42\n', chromeDies = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'patronus-desktop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spawned = [], proxies = [];
  const spawn = (cmd, args, opts) => {
    const child = new Child(cmd, args, opts); spawned.push(child);
    if (cmd === 'Xvfb' && displayOut) setImmediate(() => child.stdout.write(displayOut));
    if (cmd.endsWith('google-chrome') && chromeDies) setImmediate(() => child.exit(1, null));
    return child;
  };
  const startProxy = async options => { const p = { url: 'http://127.0.0.1:5555', options, closed: false, close() { p.closed = true; } }; proxies.push(p); return p; };
  const desktop = new Desktop({ root, spawn, startProxy, settleMs: 5, displayTimeoutMs: 100, env: { PATH: '/usr/bin' } });
  return { root, desktop, spawned, proxies };
}

test('chrome runs with no automation, debugging, headless or sandbox-disabling switches', () => {
  const args = chromeArgs({ profile: '/p', proxy: 'http://127.0.0.1:1' });
  for (const arg of args) assert.ok(!FORBIDDEN_FLAGS.some(rule => rule.test(arg)), arg);
  assert.ok(args.includes('--user-data-dir=/p'));
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:1'));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(args.includes('--enable-unsafe-swiftshader'));
});

test('starts display, window manager and Chrome on a private persistent profile behind the public-only proxy', async t => {
  const { root, desktop, spawned, proxies } = harness(t);
  const status = await desktop.start();
  assert.equal(status.state, 'running');
  assert.equal(status.display, ':42');
  assert.equal(status.automationInterface, 'none');
  assert.deepEqual(spawned.map(c => c.cmd), ['Xvfb', 'openbox', '/usr/bin/google-chrome']);
  assert.equal(spawned[1].opts.env.DISPLAY, ':42');
  assert.equal(spawned[2].opts.env.DISPLAY, ':42');
  assert.ok(spawned[2].args.includes('--user-data-dir=' + join(root, 'desktop-profile')));
  assert.equal(statSync(join(root, 'desktop-profile')).mode & 0o777, 0o700);
  assert.deepEqual(proxies[0].options, { maxBytes: Infinity, anyPort: true });
  assert.ok(desktop.healthy());
  await desktop.stop();
  assert.deepEqual(spawned.map(c => c.signals[0]), ['SIGTERM', 'SIGTERM', 'SIGTERM']);
  assert.equal(proxies[0].closed, true);
  assert.equal(desktop.status().state, 'stopped');
});

test('a crashed Chrome is restarted by supervision at a bounded rate', async t => {
  const { desktop, spawned } = harness(t);
  await desktop.start();
  spawned[2].exit(1, null);
  assert.equal(desktop.status().state, 'degraded');
  await desktop.ensure();
  assert.equal(desktop.status().state, 'running');
  assert.equal(spawned.filter(c => c.cmd.endsWith('google-chrome')).length, 2);
  assert.equal(desktop.status().restartsLastTenMinutes, 1);
  for (let i = 0; i < 4; i++) { spawned.at(-1).exit(1, null); await desktop.ensure(); }
  spawned.at(-1).exit(1, null);
  await desktop.ensure();
  assert.equal(desktop.status().state, 'failed');
  assert.equal(desktop.status().lastError, 'DESKTOP_RESTART_LIMIT');
  await desktop.stop();
});

test('a display that never reports itself fails cleanly and tears down', async t => {
  const { desktop, spawned } = harness(t, { displayOut: '' });
  await assert.rejects(desktop.start(), { code: 'DESKTOP_DISPLAY_TIMEOUT' });
  assert.equal(desktop.status().state, 'failed');
  assert.equal(spawned[0].signals[0], 'SIGTERM');
});

test('Chrome exiting during startup is reported, not mistaken for a running session', async t => {
  const { desktop, proxies } = harness(t, { chromeDies: true });
  await assert.rejects(desktop.start(), { code: 'DESKTOP_PROCESS_EXITED' });
  assert.equal(desktop.status().state, 'failed');
  assert.equal(proxies[0].closed, true);
});

test('only the desktop proxy policy admits non-default ports; private targets stay blocked by resolution', () => {
  assert.throws(() => safeURL('https://example.com:2222/'), { code: 'URL_POLICY' });
  assert.equal(safeURL('https://example.com:2222/', { anyPort: true }).port, '2222');
  assert.throws(() => safeURL('ftp://example.com/', { anyPort: true }), { code: 'URL_POLICY' });
  assert.throws(() => safeURL('https://u:p@example.com/', { anyPort: true }), { code: 'URL_POLICY' });
});
