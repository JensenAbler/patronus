import { spawn } from 'node:child_process';
import { fault } from './network.js';
import { DESKTOP_SCREEN } from './desktop.js';

// Native input and screenshots for the persistent desktop browser.
// Frames use X11 capture and bounded deterministic commands use xdotool.
// This does not change browser identity or bypass site or browser restrictions.

export const VIEW = Object.freeze({ width: 1280, height: 720 });
const clamp = (v, max) => Math.max(0, Math.min(max, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Seeded fixture utility, retained for compatibility. Native dispatch is deterministic.
export function makeRandom(seed = Date.now() >>> 0) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function runDesktopInput(cmd, args, { display, input, timeout = 15000, signal, spawnInput = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fault('DESKTOP_CONTROL_RELEASED'));
    const child = spawnInput(cmd, args, { env: { PATH: '/usr/bin:/bin', DISPLAY: display } });
    let out = '', err = '', timedOut = false, failed = false;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout?.on('data', d => { out += d; });
    child.stderr?.on('data', d => { err += d; });
    child.on('error', () => { failed = true; });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); signal?.aborted ? reject(fault('DESKTOP_CONTROL_RELEASED')) : timedOut ? reject(fault('DESKTOP_INPUT_TIMEOUT')) : !failed && code === 0 ? resolve(out) : reject(fault('DESKTOP_INPUT_FAILED', err.slice(0, 200))); });
    child.stdin?.on('error', () => { failed = true; child.kill('SIGKILL'); });
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
  constructor(desktop, { screen = DESKTOP_SCREEN, view = VIEW, now = Date.now, random = makeRandom(), captureCmd = 'ffmpeg', inputCmd = 'xdotool', runInput = runDesktopInput, pause = sleep, capture = captureFrame } = {}) {
    Object.assign(this, { desktop, screen, view, now, random, captureCmd, inputCmd, runInput, pause, capture });
    this.cursor = { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
  }

  // An action pins the original desktop and deadline. Recheck immediately before
  // every native command, including the final click after pointer movement.
  assertInputAllowed() {
    const context = this.inputContext;
    if (!context) return;
    context.assertActive?.();
    if (!this.desktop?.healthy?.()) throw fault('DESKTOP_NOT_RUNNING');
    const session = this.desktop.status?.().startedAt ?? this.desktop.startedAt;
    if (session !== context.session || this.desktop.display !== context.display)
      throw fault('DESKTOP_SESSION_CHANGED');
    if (this.now() >= context.deadline) throw fault('DESKTOP_INPUT_EXPIRED');
  }

  sendInput(args, options = {}) {
    this.assertInputAllowed();
    const remaining = this.inputContext ? this.inputContext.deadline - this.now() : 15000;
    return this.runInput(this.inputCmd, args, {
      display: this.display, signal: this.inputContext?.signal, ...options, timeout: Math.max(1, Math.min(options.timeout ?? 15000, remaining))
    });
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

  async screenshot({ comparisonOnly = false } = {}) {
    if (typeof comparisonOnly !== 'boolean') throw fault('DESKTOP_CAPTURE_MODE_POLICY');
    this.assertInputAllowed();
    const frame = await this.capture({ display: this.display, screen: this.screen, view: this.view, captureCmd: this.captureCmd, drawMouse: !comparisonOnly });
    this.assertInputAllowed();
    return frame;
  }

  // Bounded deterministic movement, with an action guard before every command.
  async moveTo(sx, sy) {
    const steps = 12;
    const from = { ...this.cursor };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = clamp(Math.round(from.x + (sx - from.x) * ease ), this.screen.width - 1);
      const y = clamp(Math.round(from.y + (sy - from.y) * ease ), this.screen.height - 1);
      await this.sendInput(['mousemove', String(x), String(y)], { display: this.display });
      await this.pause(10);
    }
    this.cursor = { x: sx, y: sy };
  }

  async click({ x, y, button = 'left', count = 1 }) {
    const b = { left: '1', middle: '2', right: '3' }[button];
    if (!b) throw fault('DESKTOP_BUTTON_POLICY');
    const p = this.toScreen(x, y);
    await this.moveTo(p.x, p.y);
    await this.pause(40);
    for (let i = 0; i < count; i++) { if (i) await this.pause(60); await this.sendInput(['click', b], { display: this.display }); }
    return { clicked: { button, count } };
  }

  // One bounded left-button gesture in screenshot coordinates. Validate the whole
  // path before any input and always release on the ORIGINAL display, even if
  // desktop health changes or a movement command fails after button-down.
  async drag({ x, y, toX, toY, points = [], durationMs = 800, button = 'left' }) {
    if (button !== 'left') throw fault('DESKTOP_BUTTON_POLICY');
    if (!Array.isArray(points) || points.length > 32 ||
        !Number.isInteger(durationMs) || durationMs < 200 || durationMs > 5000)
      throw fault('DESKTOP_DRAG_POLICY');
    const path = [{ x, y }, ...points, { x: toX, y: toY }].map(p => {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y))
        throw fault('DESKTOP_COORDINATE_POLICY');
      return this.toScreen(p.x, p.y);
    });
    const display = this.display, started = this.now(), session = this.desktop.startedAt;
    const send = args => {
      if (!this.desktop.healthy()) throw fault('DESKTOP_NOT_RUNNING');
      if (this.desktop.display !== display || this.desktop.startedAt !== session) throw fault('DESKTOP_SESSION_CHANGED');
      const remaining = durationMs + 5000 - (this.now() - started);
      if (remaining <= 0) throw fault('DESKTOP_INPUT_TIMEOUT');
      this.assertInputAllowed();
      return this.runInput(this.inputCmd, args, { display, signal: this.inputContext?.signal, timeout: Math.min(2000, remaining, this.inputContext ? this.inputContext.deadline - this.now() : 2000) });
    };
    await send(['mousemove', String(path[0].x), String(path[0].y)]);
    this.cursor = { ...path[0] };
    const steps = Math.max(1, Math.ceil(durationMs / 20 / (path.length - 1)));
    const stepMs = durationMs / (steps * (path.length - 1));
    let failure;
    try {
      // Button-down may have taken effect even if its command reports failure.
      await send(['mousedown', '1']);
      for (let segment = 1; segment < path.length; segment++) {
        const from = path[segment - 1], to = path[segment];
        for (let step = 1; step <= steps; step++) {
          await this.pause(stepMs);
          const t = step / steps;
          const p = { x: Math.round(from.x + (to.x - from.x) * t),
            y: Math.round(from.y + (to.y - from.y) * t) };
          await send(['mousemove', String(p.x), String(p.y)]);
          this.cursor = p;
        }
      }
    } catch (error) { failure = error; }
    finally {
      try { await this.runInput(this.inputCmd, ['mouseup', '1'], { display, timeout: 2000 }); }
      catch { throw fault('DESKTOP_DRAG_RELEASE_FAILED'); }
    }
    if (failure) throw failure;
    return { dragged: { from: { x, y }, to: { x: toX, y: toY }, points: points.length, durationMs, button: 'left' } };
  }

  async scroll({ x, y, dy = 0, dx = 0 }) {
    const p = this.toScreen(x ?? this.view.width / 2, y ?? this.view.height / 2);
    await this.moveTo(p.x, p.y);
    const tick = async b => { await this.sendInput(['click', b], { display: this.display }); await this.pause(20); };
    for (let i = 0; i < Math.min(50, Math.abs(dy)); i++) await tick(dy > 0 ? '5' : '4');
    for (let i = 0; i < Math.min(50, Math.abs(dx)); i++) await tick(dx > 0 ? '7' : '6');
    return { scrolled: { dx, dy } };
  }

  async type(text) {
    if (typeof text !== 'string' || text.length > 2000 || !TYPEABLE.test(text)) throw fault('DESKTOP_TYPE_POLICY');
    await this.sendInput(['type', '--clearmodifiers', '--delay', String(55), '--', text], { display: this.display });
    return { typed: text.length };
  }

  // Type a saved secret into the focused field. The value is passed to xdotool on
  // stdin via `type --file -`, so it never appears in argv (invisible to ps) and no
  // caller ever receives it back.
  async typeSecret(secret) {
    if (typeof secret !== 'string' || !secret.length || secret.length > 2000 || !TYPEABLE.test(secret)) throw fault('DESKTOP_CREDENTIAL_INVALID');
    await this.sendInput(['type', '--clearmodifiers', '--delay', '70', '--file', '-'], { display: this.display, input: secret });
    return { typed: 'credential' };
  }

  async pressKey(key) {
    const mapped = KEYMAP[key];
    if (!mapped) throw fault('DESKTOP_KEY_POLICY');
    await this.sendInput(['key', '--clearmodifiers', mapped], { display: this.display });
    return { pressed: key };
  }

  // Navigation uses the omnibox: focus, select, type, then Enter.
  async navigate(url) {
    let target;
    try { target = new URL(url); } catch { throw fault('DESKTOP_NAVIGATE_POLICY'); }
    if (!['http:', 'https:'].includes(target.protocol)) throw fault('DESKTOP_NAVIGATE_POLICY');
    await this.sendInput(['key', '--clearmodifiers', 'ctrl+l'], { display: this.display });
    await this.pause(120);
    await this.sendInput(['type', '--clearmodifiers', '--delay', '30', '--', target.href], { display: this.display });
    await this.pause(80);
    await this.sendInput(['key', '--clearmodifiers', 'Return'], { display: this.display });
    return { navigated: target.href };
  }
}

// Buffer-returning variant: image data is binary, so screenshots bypass the string path above.
export function captureFrame({ display, screen = DESKTOP_SCREEN, view = VIEW, captureCmd = 'ffmpeg', drawMouse = true, spawnCapture = spawn } = {}) {
  if (typeof drawMouse !== 'boolean') throw fault('DESKTOP_CAPTURE_MODE_POLICY');
  return new Promise((resolve, reject) => {
    const child = spawnCapture(captureCmd,
      ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', drawMouse ? '1' : '0', '-video_size', `${screen.width}x${screen.height}`,
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
