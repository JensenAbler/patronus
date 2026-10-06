import { setTimeout as sleep } from 'node:timers/promises';
import { fault } from './network.js';
import { solverTransport } from './solver.js';

// Callers must provide a CAPTCHA-only crop, with dimensions in image pixels.
// Config comes from the existing readSolverConfig; never read credentials here.
export const coordinateLimits = Object.freeze({
  maxImageBytes: 100000, // Exclusive, below the provider's 100 kB limit.
  maxDimension: 600,
  maxPoints: 25,
  maxInstructionCharacters: 140
});

const knownErrors = new Set([
  'ERROR_WRONG_USER_KEY', 'ERROR_KEY_DOES_NOT_EXIST', 'ERROR_ZERO_BALANCE',
  'ERROR_NO_SLOT_AVAILABLE', 'ERROR_CAPTCHA_UNSOLVABLE', 'ERROR_WRONG_CAPTCHA_ID',
  'ERROR_BAD_PARAMETERS', 'ERROR_IP_NOT_ALLOWED', 'ERROR_METHOD_NOT_SUPPORTED',
  'ERROR_BAD_METHOD', 'ERROR_TOO_BIG_CAPTCHA_FILESIZE',
  'ERROR_IMAGE_TYPE_NOT_SUPPORTED', 'ERROR_ZERO_CAPTCHA_FILESIZE'
]);
const transportErrors = new Set([
  'SOLVER_ENDPOINT_POLICY', 'SOLVER_HTTP_ERROR', 'SOLVER_RESPONSE_LIMIT',
  'SOLVER_NETWORK_ERROR', 'SOLVER_RESPONSE_INVALID'
]);

function validDimensions(width, height) {
  return [width, height].every(n => Number.isInteger(n) && n > 0 && n <= coordinateLimits.maxDimension);
}

function cancelled(signal) {
  // Abort reasons can contain arbitrary text. Never expose them through this API.
  if (signal?.aborted) throw fault('CANCELLED');
}

export function parseCoordinates(answer, width, height) {
  if (!validDimensions(width, height)) throw fault('SOLVER_CHALLENGE_UNSUPPORTED');
  // Match the entire provider answer, not just coordinates embedded in junk.
  if (typeof answer !== 'string' || answer.length > 1024 || answer.trim() !== answer ||
      !/^coordinate:x=\d{1,3},y=\d{1,3}(?:;x=\d{1,3},y=\d{1,3})*$/.test(answer)) {
    throw fault('SOLVER_RESPONSE_INVALID');
  }
  const parts = answer.slice('coordinate:'.length).split(';');
  if (parts.length > coordinateLimits.maxPoints) throw fault('SOLVER_RESPONSE_INVALID');
  return parts.map(part => {
    const [, xText, yText] = /^x=(\d{1,3}),y=(\d{1,3})$/.exec(part);
    const x = Number(xText), y = Number(yText);
    if (x >= width || y >= height) throw fault('SOLVER_RESPONSE_INVALID');
    return { x, y };
  });
}

export async function solveCoordinates({
  config, image, width, height, instructions, signal, record,
  transport = solverTransport,
  wait = (ms, s) => sleep(ms, undefined, { signal: s }),
  maxPolls = 24
}) {
  if (!config || typeof config.apiKey !== 'string' || config.apiKey.length !== 32 || !/^[a-fA-F0-9]{32}$/.test(config.apiKey)) {
    throw fault('SOLVER_CONFIG_INVALID');
  }
  if (!Buffer.isBuffer(image) || image.length === 0 ||
      image.length >= coordinateLimits.maxImageBytes || !validDimensions(width, height)) {
    throw fault('SOLVER_CHALLENGE_UNSUPPORTED');
  }
  if (instructions !== undefined && (typeof instructions !== 'string' ||
      !instructions.isWellFormed() ||
      [...instructions].length > coordinateLimits.maxInstructionCharacters ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(instructions))) {
    throw fault('SOLVER_CHALLENGE_UNSUPPORTED');
  }
  if (typeof record !== 'function' || typeof transport !== 'function' ||
      typeof wait !== 'function' || !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 120) {
    throw fault('SOLVER_OPTIONS_INVALID');
  }
  const persist = async value => {
    try { await record(value); } catch { throw fault('SOLVER_RECORD_ERROR'); }
  };
  const call = async (path, params) => {
    try { return await transport(path, params, signal); }
    catch (error) {
      cancelled(signal);
      throw fault(transportErrors.has(error?.code) ? error.code : 'SOLVER_NETWORK_ERROR');
    }
  };
  const providerError = result => {
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        result.status !== 0 || typeof result.request !== 'string') {
      return fault('SOLVER_RESPONSE_INVALID');
    }
    return fault(knownErrors.has(result.request) ? 'SOLVER_' + result.request : 'SOLVER_PROVIDER_ERROR');
  };
  const params = { key: config.apiKey, method: 'base64', body: image.toString('base64'), coordinatescaptcha: '1' };
  if (instructions) params.textinstructions = instructions;

  cancelled(signal);
  // Await a durable receipt before the paid POST, including asynchronous stores.
  // A failure or ambiguous response leaves this receipt: never resubmit it.
  await persist({ state: 'submitting', type: 'coordinates' });
  cancelled(signal);
  const task = await call('/in.php', params);
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.status !== 1) throw providerError(task);
  if (typeof task.request !== 'string' || task.request.trim() !== task.request || !/^\d{1,40}$/.test(task.request) ||
      task.request.includes(config.apiKey)) throw fault('SOLVER_RESPONSE_INVALID');
  const taskId = task.request;
  // Preserve a known task ID even if cancellation raced with submission.
  await persist({ state: 'polling', taskId, type: 'coordinates' });
  cancelled(signal);

  for (let n = 0; n < maxPolls; n++) {
    try { await wait(5000, signal); }
    catch { cancelled(signal); throw fault('SOLVER_WAIT_ERROR'); }
    cancelled(signal);
    const result = await call('/res.php', { key: config.apiKey, action: 'get', id: taskId });
    cancelled(signal);
    if (result && typeof result === 'object' && !Array.isArray(result) && result.status === 1) {
      const points = parseCoordinates(result.request, width, height);
      await persist({ state: 'solved', taskId, type: 'coordinates' });
      cancelled(signal);
      return points;
    }
    if (result?.status !== 0 || result.request !== 'CAPCHA_NOT_READY') throw providerError(result);
  }
  throw fault('SOLVER_TIMEOUT');
}
