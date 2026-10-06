import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateLimits, parseCoordinates, solveCoordinates } from '../src/patronus/coordinate-solver.js';

const apiKey = 'a'.repeat(32);
const image = Buffer.from('isolated CAPTCHA crop fixture');
const config = { apiKey, maxTasksPerJob: 1 };
const success = { status: 1, request: 'coordinate:x=39,y=59;x=252,y=72' };
const task = { status: 1, request: '12345' };
const options = overrides => ({
  config, image, width: 300, height: 200,
  record: () => {}, wait: async () => {},
  transport: async path => path === '/in.php' ? task : success,
  ...overrides
});

test('coordinate submit maps parameters, polls every five seconds, and records no image or key', async () => {
  const calls = [], records = [], delays = [], events = [];
  const responses = [task, { status: 0, request: 'CAPCHA_NOT_READY' }, success];
  const signal = new AbortController().signal;
  const points = await solveCoordinates(options({
    signal, instructions: 'Click on all buses',
    record: async value => { await Promise.resolve(); records.push(value); events.push(value.state); },
    transport: async (path, params, receivedSignal) => {
      assert.equal(receivedSignal, signal);
      calls.push({ path, params }); events.push(path);
      return responses.shift();
    },
    wait: async (ms, receivedSignal) => { assert.equal(receivedSignal, signal); delays.push(ms); }
  }));
  assert.deepEqual(points, [{ x: 39, y: 59 }, { x: 252, y: 72 }]);
  assert.deepEqual(calls.map(c => c.path), ['/in.php', '/res.php', '/res.php']);
  assert.deepEqual(calls[0].params, {
    key: apiKey, method: 'base64', body: image.toString('base64'),
    coordinatescaptcha: '1', textinstructions: 'Click on all buses'
  });
  assert.deepEqual(calls[1].params, { key: apiKey, action: 'get', id: '12345' });
  assert.deepEqual(delays, [5000, 5000]);
  assert.deepEqual(events, ['submitting', '/in.php', 'polling', '/res.php', '/res.php', 'solved']);
  assert.deepEqual(records, [
    { state: 'submitting', type: 'coordinates' },
    { state: 'polling', taskId: '12345', type: 'coordinates' },
    { state: 'solved', taskId: '12345', type: 'coordinates' }
  ]);
  for (const secret of [apiKey, image.toString(), image.toString('base64'), 'Click on all buses', success.request]) {
    assert.equal(JSON.stringify(records).includes(secret), false);
  }
});

test('coordinate instructions are optional, preserve UTF-8, and allow 140 code points', async () => {
  for (const instructions of [undefined, '', '車'.repeat(140), '🚍'.repeat(140), 'Click buses\nThen cars']) {
    await solveCoordinates(options({
      instructions,
      transport: async (path, params) => {
        if (path === '/in.php') {
          assert.equal(params.textinstructions, instructions || undefined);
          return task;
        }
        return success;
      }
    }));
  }
});

test('coordinate parser accepts origin and last image pixel, maintaining click order', () => {
  assert.deepEqual(parseCoordinates('coordinate:x=0,y=0;x=599,y=599;x=1,y=2', 600, 600),
    [{ x: 0, y: 0 }, { x: 599, y: 599 }, { x: 1, y: 2 }]);
  assert.equal(parseCoordinates('coordinate:' + Array(25).fill('x=1,y=2').join(';'), 600, 600).length, 25);
});

test('coordinate parser rejects malformed, partially valid, excessive and out-of-bounds answers', () => {
  for (const answer of [
    undefined, null, [], {}, 12, '', 'coordinate:', 'x=1,y=2', 'OK|coordinate:x=1,y=2',
    'coordinate:x=1,y=2;', ' coordinate:x=1,y=2', 'coordinate:x=1,y=2\n',
    'coordinate:x=-1,y=2', 'coordinate:x=1.5,y=2', 'coordinate:x=1,y=NaN',
    'coordinate:x=1e2,y=2', 'coordinate:x=1,y=2;junk', 'coordinate:x=1,y=2;coordinate:x=3,y=4',
    'coordinate:x=300,y=2', 'coordinate:x=2,y=200', 'coordinate:x=1000,y=2',
    'coordinate:' + Array(26).fill('x=1,y=2').join(';'),
    'coordinate:x=1,y=2' + ' '.repeat(2000)
  ]) {
    assert.throws(() => parseCoordinates(answer, 300, 200), { code: 'SOLVER_RESPONSE_INVALID' });
  }
});

test('input limits and options fail before any receipt or request', async () => {
  let calls = 0;
  const forbidden = () => { calls++; assert.fail('Must fail before external or durable effects'); };
  for (const change of [
    { image: 'base64' }, { image: new Uint8Array(10) }, { image: Buffer.alloc(0) },
    { image: Buffer.alloc(100000) }, { width: 601 }, { height: 601 }, { width: 0 },
    { width: 1.5 }, { height: NaN }, { width: '300' }, { instructions: null },
    { instructions: 'a'.repeat(141) }, { instructions: '車'.repeat(141) },
    { instructions: 'bad\u0000instruction' }, { instructions: '\ud800' }
  ]) {
    await assert.rejects(solveCoordinates(options({ ...change, record: forbidden, transport: forbidden })),
      { code: 'SOLVER_CHALLENGE_UNSUPPORTED' });
  }
  for (const invalidConfig of [null, {}, { apiKey: 'bad-key' }]) {
    await assert.rejects(solveCoordinates(options({ config: invalidConfig, record: forbidden, transport: forbidden })),
      { code: 'SOLVER_CONFIG_INVALID' });
  }
  for (const change of [{ maxPolls: 0 }, { maxPolls: Infinity }, { maxPolls: 1.5 }, { maxPolls: 121 },
    { record: null }, { transport: null }, { wait: null }]) {
    await assert.rejects(solveCoordinates(options(change)), { code: 'SOLVER_OPTIONS_INVALID' });
  }
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(coordinateLimits), true);
});

test('maximum conservative image size and dimensions are accepted', async () => {
  assert.deepEqual(await solveCoordinates(options({ image: Buffer.alloc(99999), width: 600, height: 600 })),
    [{ x: 39, y: 59 }, { x: 252, y: 72 }]);
});

test('durable recording must finish before submit and must succeed', async () => {
  let submitted = 0, persistComplete = false;
  await solveCoordinates(options({
    record: async () => { await Promise.resolve(); persistComplete = true; },
    transport: async path => {
      if (path === '/in.php') { assert.equal(persistComplete, true); submitted++; return task; }
      return success;
    }
  }));
  assert.equal(submitted, 1);
  submitted = 0;
  await assert.rejects(solveCoordinates(options({
    record: async () => { throw new Error(apiKey); },
    transport: async () => { submitted++; }
  })), { code: 'SOLVER_RECORD_ERROR', message: 'SOLVER_RECORD_ERROR' });
  assert.equal(submitted, 0);
});

test('ambiguous paid submits are never retried and retain the submitting receipt', async () => {
  for (const failure of [new Error(apiKey), Object.assign(new Error(image.toString('base64')), { code: 'SOLVER_' + apiKey.toUpperCase() })]) {
    const records = []; let submits = 0;
    await assert.rejects(solveCoordinates(options({
      record: value => records.push(value),
      transport: async () => { submits++; throw failure; }
    })), { code: 'SOLVER_NETWORK_ERROR', message: 'SOLVER_NETWORK_ERROR' });
    assert.equal(submits, 1);
    assert.deepEqual(records, [{ state: 'submitting', type: 'coordinates' }]);
  }
});

test('provider errors and malformed task IDs never leak provider text or re-submit', async () => {
  const cases = [
    [{ status: 0, request: 'ERROR_ZERO_BALANCE' }, 'SOLVER_ERROR_ZERO_BALANCE'],
    [{ status: 0, request: apiKey }, 'SOLVER_PROVIDER_ERROR'],
    [{ status: 1, request: apiKey }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: 1, request: 12345 }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: 1, request: '12345\n' }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: 1, request: '1'.repeat(41) }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: '1', request: '12345' }, 'SOLVER_RESPONSE_INVALID'],
    [null, 'SOLVER_RESPONSE_INVALID'], [[], 'SOLVER_RESPONSE_INVALID'],
    [{ request: 'CAPCHA_NOT_READY' }, 'SOLVER_RESPONSE_INVALID']
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    await assert.rejects(solveCoordinates(options({ transport: async () => { calls++; return response; } })), { code, message: code });
    assert.equal(calls, 1);
  }
  const numericKey = '1'.repeat(32), records = [];
  await assert.rejects(solveCoordinates(options({
    config: { apiKey: numericKey }, record: value => records.push(value),
    transport: async () => ({ status: 1, request: numericKey })
  })), { code: 'SOLVER_RESPONSE_INVALID' });
  assert.equal(JSON.stringify(records).includes(numericKey), false);
});

test('polling validates status, task errors, coordinates, and transport failures without another paid task', async () => {
  const cases = [
    [{ status: 0, request: apiKey }, 'SOLVER_PROVIDER_ERROR'],
    [{ status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' }, 'SOLVER_ERROR_CAPTCHA_UNSOLVABLE'],
    [{ status: 1, request: 'coordinate:x=300,y=0' }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: '0', request: 'CAPCHA_NOT_READY' }, 'SOLVER_RESPONSE_INVALID'],
    [{ status: 1, request: ['coordinate:x=1,y=1'] }, 'SOLVER_RESPONSE_INVALID'],
    [null, 'SOLVER_RESPONSE_INVALID']
  ];
  for (const [response, code] of cases) {
    const records = []; let submits = 0;
    await assert.rejects(solveCoordinates(options({
      record: value => records.push(value),
      transport: async path => path === '/in.php' ? (submits++, task) : response
    })), { code, message: code });
    assert.equal(submits, 1);
    assert.equal(records.at(-1).state, 'polling');
    assert.equal(records.at(-1).taskId, '12345');
  }
  await assert.rejects(solveCoordinates(options({
    transport: async path => {
      if (path === '/in.php') return task;
      throw Object.assign(new Error(apiKey), { code: 'SOLVER_HTTP_ERROR' });
    }
  })), { code: 'SOLVER_HTTP_ERROR', message: 'SOLVER_HTTP_ERROR' });
});

test('polling has bounded attempts and a default of 24, without resubmission', async () => {
  for (const maxPolls of [2, undefined]) {
    let submits = 0, polls = 0, waits = 0;
    await assert.rejects(solveCoordinates(options({
      ...(maxPolls === undefined ? {} : { maxPolls }),
      wait: async ms => { assert.equal(ms, 5000); waits++; },
      transport: async path => path === '/in.php' ? (submits++, task) :
        (polls++, { status: 0, request: 'CAPCHA_NOT_READY' })
    })), { code: 'SOLVER_TIMEOUT' });
    assert.equal(submits, 1);
    assert.equal(polls, maxPolls ?? 24);
    assert.equal(waits, maxPolls ?? 24);
  }
});

test('cancellation before submit, during persistence, waiting, and polling stops without leaking reasons', async () => {
  for (const stage of ['before', 'record', 'wait', 'poll']) {
    const controller = new AbortController(), records = []; let submits = 0, polls = 0;
    const abort = () => controller.abort(new Error(apiKey));
    if (stage === 'before') abort();
    await assert.rejects(solveCoordinates(options({
      signal: controller.signal,
      record: value => { records.push(value); if (stage === 'record') abort(); },
      wait: async () => { if (stage === 'wait') abort(); },
      transport: async path => {
        if (path === '/in.php') { submits++; return task; }
        polls++; if (stage === 'poll') abort();
        return success;
      }
    })), { code: 'CANCELLED', message: 'CANCELLED' });
    assert.equal(submits, ['before', 'record'].includes(stage) ? 0 : 1);
    assert.equal(polls, stage === 'poll' ? 1 : 0);
    assert.equal(records.some(value => value.state === 'solved'), false);
    assert.equal(JSON.stringify(records).includes(apiKey), false);
  }
});

test('cancellation racing task creation still preserves its known task ID', async () => {
  const controller = new AbortController(), records = [];
  await assert.rejects(solveCoordinates(options({
    signal: controller.signal, record: value => records.push(value),
    transport: async () => { controller.abort(); return task; }
  })), { code: 'CANCELLED' });
  assert.deepEqual(records.at(-1), { state: 'polling', taskId: '12345', type: 'coordinates' });
});

test('aborted default wait and unexpected wait failures are sanitized', async () => {
  const controller = new AbortController();
  await assert.rejects(solveCoordinates(options({
    signal: controller.signal,
    wait: async () => { controller.abort(new Error(apiKey)); throw new Error(apiKey); }
  })), { code: 'CANCELLED', message: 'CANCELLED' });
  await assert.rejects(solveCoordinates(options({
    wait: async () => { throw new Error(apiKey); }
  })), { code: 'SOLVER_WAIT_ERROR', message: 'SOLVER_WAIT_ERROR' });
});
