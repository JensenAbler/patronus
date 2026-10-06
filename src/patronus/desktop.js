import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startProxy as defaultProxy, fault } from './network.js';

// Chrome records an unclean exit in its profile and then shows a "Restore pages?"
// bubble over every page. Marking the last exit clean before launch keeps the
// window as a person would leave it. Failure here never blocks startup.
export function markCleanExit(profile) {
  const path = join(profile, 'Default', 'Preferences');
  try {
    if (!existsSync(path)) return false;
    const prefs = JSON.parse(readFileSync(path, 'utf8'));
    if (prefs?.profile?.exit_type === 'Normal' && prefs.profile.exited_cleanly === true) return false;
    prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true };
    writeFileSync(path + '.patronus-next', JSON.stringify(prefs), { mode: 0o600 });
    renameSync(path + '.patronus-next', path);
    return true;
  } catch { return false; }
}

// A persistent, human-first desktop browser: stock Google Chrome on its own virtual
// display and window manager, with a private profile that keeps logins across restarts.
// No automation interface exists here at all; later layers drive it with ordinary
// X input and screenshots, exactly as a person at a monitor would.
export const DESKTOP_SCREEN = Object.freeze({ width: 1920, height: 1080 });
export const CHROME = '/usr/bin/google-chrome';

// Switches a page could observe as automation, or that weaken the browser. Never used.
export const FORBIDDEN_FLAGS = [/^--enable-automation/, /^--remote-debugging/, /^--headless/, /^--no-sandbox/,
  /^--disable-blink-features/, /^--disable-web-security/];

export function chromeArgs({ profile, proxy, screen = DESKTOP_SCREEN }) {
  const args = ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--start-maximized', '--window-position=0,0', '--window-size=' + screen.width + ',' + screen.height,
    // Alpha has no GPU. Software WebGL is far less suspicious than WebGL being absent.
    '--enable-unsafe-swiftshader',
    // Public-network-only egress, and UDP WebRTC may not route around the proxy.
    '--proxy-server=' + proxy, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    'about:blank'];
  for (const arg of args) if (FORBIDDEN_FLAGS.some(rule => rule.test(arg))) throw fault('DESKTOP_FLAG_POLICY');
  return args;
}

const alive = child => !!child && child.exitCode === null && child.signalCode === null;
const waitExit = (child, ms) => alive(child) ? new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
}) : Promise.resolve(true);

function readDisplay(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = '';
    const done = (settle, value) => { clearTimeout(timer); child.stdout?.off('data', data); child.off('exit', exit); settle(value); };
    const data = chunk => { text += chunk; const m = text.match(/^(\d+)\n/); if (m) done(resolve, ':' + m[1]); };
    const exit = () => done(reject, fault('DESKTOP_DISPLAY_FAILED'));
    const timer = setTimeout(() => done(reject, fault('DESKTOP_DISPLAY_TIMEOUT')), timeoutMs);
    child.stdout.on('data', data);
    child.once('exit', exit);
  });
}

const PROCESSES = ['display', 'windowManager', 'chrome'];

export class Desktop {
  constructor({ root, spawn = nodeSpawn, startProxy = defaultProxy, chrome = CHROME, screen = DESKTOP_SCREEN,
    settleMs = 3000, displayTimeoutMs = 10000, now = Date.now, env = process.env } = {}) {
    Object.assign(this, { spawn, startProxy, chrome, screen, settleMs, displayTimeoutMs, now, env });
    this.profile = join(root, 'desktop-profile');
    this.state = 'stopped'; this.wanted = false; this.starting = null;
    this.children = {}; this.proxy = null; this.display = null;
    this.startedAt = null; this.lastError = null; this.restarts = [];
  }

  status() {
    return { enabled: true, state: this.state, browser: 'google-chrome', automationInterface: 'none',
      screen: { ...this.screen }, display: this.display, startedAt: this.startedAt,
      restartsLastTenMinutes: this.recentRestarts(), ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  recentRestarts() {
    const cutoff = this.now() - 600000;
    this.restarts = this.restarts.filter(at => at > cutoff);
    return this.restarts.length;
  }

  healthy() { return this.state === 'running' && PROCESSES.every(name => alive(this.children[name])); }

  start() {
    this.wanted = true;
    if (!this.starting) this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    if (this.healthy()) return this.status();
    await this.halt();
    this.state = 'starting'; this.lastError = null;
    try {
      mkdirSync(this.profile, { recursive: true, mode: 0o700 });
      const { width, height } = this.screen;
      const display = this.children.display = this.spawn('Xvfb',
        ['-displayfd', '1', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.display = await readDisplay(display, this.displayTimeoutMs);
      const env = { ...this.env, DISPLAY: this.display };
      this.children.windowManager = this.spawn('openbox', ['--sm-disable'], { env, stdio: 'ignore' });
      this.proxy = await this.startProxy({ maxBytes: Infinity, anyPort: true });
      markCleanExit(this.profile);
      this.children.chrome = this.spawn(this.chrome,
        chromeArgs({ profile: this.profile, proxy: this.proxy.url, screen: this.screen }), { env, stdio: 'ignore' });
      for (const [name, child] of Object.entries(this.children))
        child.once('exit', () => { if (this.children[name] === child && this.state === 'running') this.state = 'degraded'; });
      await new Promise(resolve => setTimeout(resolve, this.settleMs));
      if (!PROCESSES.every(name => alive(this.children[name]))) throw fault('DESKTOP_PROCESS_EXITED');
      this.state = 'running'; this.startedAt = new Date(this.now()).toISOString();
      return this.status();
    } catch (error) {
      this.lastError = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'DESKTOP_START_FAILED';
      await this.halt();
      this.state = 'failed';
      throw fault(this.lastError);
    }
  }

  // Periodic supervision: bring a crashed session back, at a bounded rate.
  async ensure() {
    if (!this.wanted || this.starting || this.healthy()) return;
    if (this.recentRestarts() >= 5) { this.state = 'failed'; this.lastError = 'DESKTOP_RESTART_LIMIT'; return; }
    this.restarts.push(this.now());
    try { await this.start(); } catch { /* recorded in status */ }
  }

  // Chrome first, so it shuts down cleanly and flushes cookies to the profile.
  async halt() {
    for (const name of ['chrome', 'windowManager', 'display']) {
      const child = this.children[name];
      if (!alive(child)) continue;
      child.kill('SIGTERM');
      if (!await waitExit(child, 5000)) { child.kill('SIGKILL'); await waitExit(child, 2000); }
    }
    this.children = {};
    this.proxy?.close(); this.proxy = null; this.display = null;
  }

  async stop() {
    this.wanted = false;
    await this.starting?.catch(() => {});
    await this.halt();
    this.state = 'stopped'; this.startedAt = null;
  }
}
