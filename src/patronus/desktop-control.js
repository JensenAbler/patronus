import { spawn } from 'node:child_process';
import { fault } from './network.js';
import { DESKTOP_SCREEN } from './desktop.js';

// Human-first input and vision for the persistent desktop browser. Everything here
// goes through ordinary X11: frames are grabbed from the display with ffmpeg, and
// mouse/keyboard events are injected with xdotool, exactly as a physical device would.
// Chrome has no idea anything but a person is at the keyboard.

export const VIEW = Object.freeze({ width: 1280, height: 720 });
const clamp = (v, max) => Math.max(0, Math.min(max, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Deterministic jitter so runs are reproducible in tests but irregular to a watcher.
export function makeRandom(seed = Date.now() >>> 0) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function run(cmd, args, { display, input, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { PATH: '/usr/bin:/bin', DISPLAY: display } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fault('DESKTOP_INPUT_TIMEOUT')); }, timeout);
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', () => { clearTimeout(timer); reject(fault('DESKTOP_INPUT_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(fault('DESKTOP_INPUT_FAILED', err.slice(0, 200))); });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

// Keys an agent may press by name. Characters are typed separately, never named here.
const KEYMAP = {
  Enter: 'Return', Tab: 'Tab', 'Shift+Tab': 'shift+Tab', Escape: 'Escape', Backspace: 'BackSpace',
  Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next',
  'Control+A': 'ctrl+a', 'Control+C': 'ctrl+c', 'Control+V': 'ctrl+v'
};
export const ALLOWED_KEYS = Object.freeze(Object.keys(KEYMAP));
// xdotool type is shell-safe (argv, not a shell), but control characters never belong in typed text.
const TYPEABLE = /^[\x20-\x7e\u00a0-\uffff]*$/;

export class DesktopControl {
  constructor(desktop, { screen = DESKTOP_SCREEN, view = VIEW, now = Date.now, random = makeRandom(), captureCmd = 'ffmpeg', inputCmd = 'xdotool' } = {}) {
    Object.assign(this, { desktop, screen, view, now, random, captureCmd, inputCmd });
    this.cursor = { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
  }

  get display() {
    if (!this.desktop?.healthy?.()) throw fault('DESKTOP_NOT_RUNNING');
    return this.desktop.display;
  }

  // View coordinates (what the agent clicks on a downscaled frame) -> real screen pixels.
  toScreen(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.view.width || y >= this.view.height)
      throw fault('DESKTOP_COORDINATE_POLICY');
    return { x: clamp(Math.round(x * this.screen.width / this.view.width), this.screen.width - 1),
             y: clamp(Math.round(y * this.screen.height / this.view.height), this.screen.height - 1) };
  }

  async screenshot() {
    return captureFrame({ display: this.display, screen: this.screen, view: this.view, captureCmd: this.captureCmd });
  }

  // Move along a jittered path with easing, so pointer motion never arrives as one teleport.
  async moveTo(sx, sy) {
    const steps = 12 + Math.floor(this.random() * 8);
    const from = { ...this.cursor };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const jx = i < steps ? (this.random() - 0.5) * 3 : 0, jy = i < steps ? (this.random() - 0.5) * 3 : 0;
      const x = clamp(Math.round(from.x + (sx - from.x) * ease + jx), this.screen.width - 1);
      const y = clamp(Math.round(from.y + (sy - from.y) * ease + jy), this.screen.height - 1);
      await run(this.inputCmd, ['mousemove', String(x), String(y)], { display: this.display });
      await sleep(8 + Math.floor(this.random() * 16));
    }
    this.cursor = { x: sx, y: sy };
  }

  async click({ x, y, button = 'left', count = 1 }) {
    const b = { left: '1', middle: '2', right: '3' }[button];
    if (!b) throw fault('DESKTOP_BUTTON_POLICY');
    const p = this.toScreen(x, y);
    await this.moveTo(p.x, p.y);
    await sleep(40 + Math.floor(this.random() * 90));
    for (let i = 0; i < count; i++) { if (i) await sleep(60 + Math.floor(this.random() * 60)); await run(this.inputCmd, ['click', b], { display: this.display }); }
    return { clicked: { button, count } };
  }

  async scroll({ x, y, dy = 0, dx = 0 }) {
    const p = this.toScreen(x ?? this.view.width / 2, y ?? this.view.height / 2);
    await this.moveTo(p.x, p.y);
    const tick = async b => { await run(this.inputCmd, ['click', b], { display: this.display }); await sleep(20 + Math.floor(this.random() * 30)); };
    for (let i = 0; i < Math.min(50, Math.abs(dy)); i++) await tick(dy > 0 ? '5' : '4');
    for (let i = 0; i < Math.min(50, Math.abs(dx)); i++) await tick(dx > 0 ? '7' : '6');
    return { scrolled: { dx, dy } };
  }

  async type(text) {
    if (typeof text !== 'string' || text.length > 2000 || !TYPEABLE.test(text)) throw fault('DESKTOP_TYPE_POLICY');
    await run(this.inputCmd, ['type', '--clearmodifiers', '--delay', String(55 + Math.floor(this.random() * 45)), '--', text], { display: this.display });
    return { typed: text.length };
  }

  // Type a saved secret into the focused field. The value is passed to xdotool on
  // stdin via `type --file -`, so it never appears in argv (invisible to ps) and no
  // caller ever receives it back.
  async typeSecret(secret) {
    if (typeof secret !== 'string' || !secret.length || secret.length > 2000 || !TYPEABLE.test(secret)) throw fault('DESKTOP_CREDENTIAL_INVALID');
    await run(this.inputCmd, ['type', '--clearmodifiers', '--delay', '70', '--file', '-'], { display: this.display, input: secret });
    return { typed: 'credential' };
  }

  async pressKey(key) {
    const mapped = KEYMAP[key];
    if (!mapped) throw fault('DESKTOP_KEY_POLICY');
    await run(this.inputCmd, ['key', '--clearmodifiers', mapped], { display: this.display });
    return { pressed: key };
  }

  // Navigation by driving the omnibox like a person: focus it, select all, type, Enter.
  async navigate(url) {
    let target;
    try { target = new URL(url); } catch { throw fault('DESKTOP_NAVIGATE_POLICY'); }
    if (!['http:', 'https:'].includes(target.protocol)) throw fault('DESKTOP_NAVIGATE_POLICY');
    await run(this.inputCmd, ['key', '--clearmodifiers', 'ctrl+l'], { display: this.display });
    await sleep(120 + Math.floor(this.random() * 120));
    await run(this.inputCmd, ['type', '--clearmodifiers', '--delay', '30', '--', target.href], { display: this.display });
    await sleep(80 + Math.floor(this.random() * 80));
    await run(this.inputCmd, ['key', '--clearmodifiers', 'Return'], { display: this.display });
    return { navigated: target.href };
  }
}

// Buffer-returning variant: image data is binary, so screenshots bypass the string path above.
export function captureFrame({ display, screen = DESKTOP_SCREEN, view = VIEW, captureCmd = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(captureCmd,
      ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${screen.width}x${screen.height}`,
       '-i', display, '-frames:v', '1', '-vf', `scale=${view.width}:${view.height}`, '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { env: { PATH: '/usr/bin:/bin', DISPLAY: display } });
    const chunks = []; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fault('DESKTOP_SCREENSHOT_FAILED')); }, 20000);
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => { err += c; });
    child.on('error', () => { clearTimeout(timer); reject(fault('DESKTOP_SCREENSHOT_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || !buf.length) return reject(fault('DESKTOP_SCREENSHOT_FAILED', err.slice(0, 200)));
      resolve(buf);
    });
  });
}
