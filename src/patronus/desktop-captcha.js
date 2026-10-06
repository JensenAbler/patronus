import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readSolverConfig } from './solver.js';
import { solveCoordinates } from './coordinate-solver.js';
import { fault } from './network.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const timestamp = () => new Date().toISOString();
const saveResult = (path, value) => { writeFileSync(path + '.next', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.next', path); };
export function validateCrop(crop, view = { width: 1280, height: 720 }) {
  if (!crop || !['x','y','width','height'].every(k => Number.isInteger(crop[k])) ||
      crop.x < 0 || crop.y < 0 || crop.width < 20 || crop.height < 20 ||
      crop.width > 600 || crop.height > 600 ||
      crop.x + crop.width > view.width || crop.y + crop.height > view.height)
    throw fault('DESKTOP_CAPTCHA_CROP_POLICY');
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

// Crop the already-observed frame, never send the surrounding login page.
// ffmpeg receives image bytes through stdin; no file paths or shell interpolation.
export function cropFrame(frame, crop) {
  validateCrop(crop);
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-loglevel','error','-f','image2pipe','-i','pipe:0',
      '-frames:v','1','-vf',`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`,
      '-pix_fmt','yuvj444p','-q:v','3','-f','image2pipe','-c:v','mjpeg','pipe:1'],
      { env: { PATH: '/usr/bin:/bin' } });
    const chunks = []; let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fault('DESKTOP_CAPTCHA_CROP_FAILED')); }, 10000);
    child.on('error', () => finish(fault('DESKTOP_CAPTCHA_CROP_FAILED')));
    child.stdout.on('data', b => {
      bytes += b.length;
      if (bytes >= 100000) { child.kill('SIGKILL'); finish(fault('DESKTOP_CAPTCHA_IMAGE_LIMIT')); }
      else chunks.push(b);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code === 0 && bytes > 0 ? null : fault('DESKTOP_CAPTCHA_CROP_FAILED'), Buffer.concat(chunks)));
    child.stdin.end(frame);
  });
}

export async function startDesktopCaptcha(engine, args, {
  crop = cropFrame, readConfig = readSolverConfig, solve = solveCoordinates, clock = Date.now, persistResult = saveResult
} = {}) {
  const { idempotencyKey, ...request } = args;
  const input = JSON.stringify(request);
  const existing = engine.db.prepare('SELECT * FROM jobs WHERE key=?').get(idempotencyKey);
  if (existing) {
    if (existing.input !== input) throw fault('IDEMPOTENCY_CONFLICT');
    return JSON.parse(existing.data);
  }
  engine.desktopSolves ||= new Map();
  if (engine.desktopSolves.size) throw fault('DESKTOP_SOLVER_BUSY');
  const source = engine.desktopCapture;
  if (!source || source.sha256 !== args.screenshotSha256 || clock() - source.at > 30000 ||
      source.desktopStartedAt !== engine.desktop?.status().startedAt)
    throw fault('DESKTOP_SCREENSHOT_STALE','Inspect a fresh desktop screenshot before selecting a CAPTCHA crop.');
  const rectangle = validateCrop(args.crop, engine.control().view);
  if (typeof args.instructions !== 'string' || !args.instructions.trim() ||
      [...args.instructions].length > 140 || /[\x00-\x1f\x7f]/.test(args.instructions))
    throw fault('DESKTOP_CAPTCHA_INSTRUCTIONS_POLICY');
  const seconds = args.timeoutSeconds ?? 180;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300)
    throw fault('DESKTOP_CAPTCHA_TIMEOUT_POLICY');
  const config = readConfig(engine.root);
  if (!config) throw fault('SOLVER_NOT_CONFIGURED');
  const image = await crop(source.frame, rectangle);
  if (source !== engine.desktopCapture || clock() - source.at > 30000 ||
      !engine.desktop?.healthy() || source.desktopStartedAt !== engine.desktop.status().startedAt)
    throw fault('DESKTOP_SCREENSHOT_STALE');
  if (engine.desktopSolves.size) throw fault('DESKTOP_SOLVER_BUSY');
  if (!Buffer.isBuffer(image) || !image.length || image.length >= 100000)
    throw fault('DESKTOP_CAPTCHA_IMAGE_LIMIT');
  // The body is retained only in this task's memory; the receipt stores hashes.
  const d = {
    jobId: randomUUID(), state: 'running', createdAt: timestamp(), startedAt: timestamp(),
    finishedAt: null, mode: 'desktop-captcha', profile: 'desktop', urls: [], pages: [],
    artifacts: [], obstacles: [], warnings: [], trace: [], bytes: image.length,
    solverAttempts: [],
    desktopCaptcha: { crop: rectangle, screenshotSha256: source.sha256, imageSha256: sha(image),
      instructions: args.instructions, desktopStartedAt: source.desktopStartedAt,
      acceptance: 'unverified', points: [] }
  };
  mkdirSync(join(engine.root,'jobs',d.jobId), { recursive: true, mode: 0o700 });
  engine.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(d.jobId,idempotencyKey,input,JSON.stringify(d));
  const controller = new AbortController();
  const handle = { controller, promise: null };
  engine.desktopSolves.set(d.jobId, handle);
  const timer = setTimeout(() => controller.abort(fault('SOLVER_TIMEOUT')), seconds * 1000);
  handle.promise = (async () => {
    try {
      const points = await solve({ config, image, width: rectangle.width, height: rectangle.height,
        instructions: args.instructions, signal: controller.signal,
        record: receipt => { d.solverAttempts.push({ ...receipt, at: timestamp() }); engine.save(d); } });
      if (controller.signal.aborted) throw controller.signal.reason;
      d.desktopCaptcha.points = points.map(p => ({ x: p.x + rectangle.x, y: p.y + rectangle.y }));
      d.state = 'succeeded';
      d.outcome = { coordinatesReturned: true, websiteAccepted: false,
        scope: 'Only CAPTCHA click coordinates. Compare the current challenge before clicking; no browser input or form submission was performed.' };
    } catch (e) {
      const code = controller.signal.aborted ? controller.signal.reason?.code :
        (/^SOLVER_[A-Z_]+$/.test(e.code || '') ? e.code : 'SOLVER_FAILED');
      d.state = code === 'CANCELLED' ? 'cancelled' : 'failed';
      d.obstacles.push({ code: code || 'SOLVER_FAILED', message: 'CAPTCHA coordinate solving ended without a verified website result.' });
    } finally {
      clearTimeout(timer); d.finishedAt = timestamp();
      try {
        persistResult(join(engine.root,'jobs',d.jobId,'result.json'), d.desktopCaptcha);
        engine.save(d);
      } catch {
        d.state = 'failed'; d.desktopCaptcha.points = [];
        d.outcome = { coordinatesReturned: false, websiteAccepted: false, scope: 'Result persistence failed; recover this job instead of submitting another paid task.' };
        d.obstacles.push({ code: 'SOLVER_PERSISTENCE_ERROR', message: 'The result could not be saved reliably. Do not resubmit this task.' });
        try { engine.save(d); } catch { /* Earlier durable receipt remains; never resubmit. */ }
      } finally { engine.desktopSolves.delete(d.jobId); }
    }
  })();
  return d;
}
