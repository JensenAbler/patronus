import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, normalizeAnswer, exactControl } from '../src/patronus/verification-runner.js';

const spec = { reviewed: true, type: 'select', session: 'S', anchorHash: 'A',
  observedImageHash: 'I0', image: { x: 475, y: 294, width: 320, height: 214 } };
const frame = (imageHash = 'I0', label = 'Skip', extra = {}) => ({ session: 'S',
  panelPresent: true, anchorHash: 'A', imageHash, controlHash: label,
  controlTexts: [label, label], ...extra });
function fixture(options = {}) {
  let time = 0, state = frame(), calls = [], preserved = [], inputCount = 0;
  const io = { atomicOwnerGuard: options.atomic !== false, now: () => time,
    utc: () => new Date(time).toISOString(), record: () => {},
    lease: async () => ({ active: options.ownerActive || false, session: 'S',
      observedAtMs: options.staleLease ? time - 3000 : time }),
    capture: async () => { calls.push('capture'); return { ...state }; },
    preserve: async (f, phase) => { preserved.push({ phase, imageHash: f.imageHash, present: f.panelPresent }); },
    startSolve: async () => { calls.push('solve'); time += 10;
      if (options.startThrows) throw Error('uncertain start');
      return { jobId: 'J', solverState: 'running' }; },
    status: async () => { calls.push('status'); return { state: options.status || 'succeeded',
      points: options.points || [{ x: 663, y: 346 }, { x: 653, y: 461 }],
      session: options.solverSession || 'S', imageHash: options.solverHash || 'I0' }; },
    sleep: async ms => { time += ms; },
    input: async a => { calls.push(a.type); inputCount++;
      if (options.inputThrows) throw Error('uncertain input');
      if (options.disappearAfterFirst && inputCount === 1) state = frame('gone', null, { panelPresent: false });
      else if (a.type === 'advance') state = frame('next-round', 'Skip');
      else state = frame(options.dynamic ? `I${inputCount}` : 'I0', options.unknown ? '???' : 'Next');
      if (options.disagree) state.controlTexts = ['Next', 'Verify'];
      return { ...state }; }
  };
  return { io, calls, preserved, set: f => { state = f; } };
}

test('selection normalization retains screen coordinates without offset', () => {
  assert.deepEqual(normalizeAnswer([{ x: 663, y: 346 }], spec), [{ type: 'click', point: { x: 663, y: 346 } }]);
});
test('drag accepts target-only and either source-target order', () => {
  const d = { ...spec, type: 'drag', source: { x: 720, y: 294, width: 75, height: 82, center: { x: 764, y: 332 } } };
  for (const p of [[{ x: 650, y: 450 }], [{ x: 764, y: 332 }, { x: 650, y: 450 }], [{ x: 650, y: 450 }, { x: 764, y: 332 }]])
    assert.deepEqual(normalizeAnswer(p, d), [{ type: 'drag', from: { x: 764, y: 332 }, to: { x: 650, y: 450 } }]);
});
test('rejects outside, fractional and duplicate points', () => {
  for (const points of [[{ x: 774, y: 558 }], [{ x: 663.5, y: 346 }], [{ x: 663, y: 346 }, { x: 663, y: 346 }]])
    assert.throws(() => normalizeAnswer(points, spec));
});
test('control classifier requires exact two-scale agreement', () => {
  for (const s of ['Next', 'Verify', 'Skip']) assert.equal(exactControl([s, s]), s);
  for (const x of [['next', 'next'], ['Next', 'Verify'], ['Next'], ['| Next |', '| Next |'], ['', '']])
    assert.equal(exactControl(x), null);
});
test('happy mock path records each preinput and returned frame', async () => {
  const f = fixture(); const r = createRunner(f.io, { allowAdvance: true }); const out = await r.runRound(spec);
  assert.equal(out.label, 'Next'); assert.equal(out.acceptance, 'unverified');
  assert.equal(f.calls.filter(c => c === 'solve').length, 1);
  assert.deepEqual(f.calls.filter(c => ['click', 'advance'].includes(c)), ['click', 'click', 'advance']);
  assert.equal(f.preserved.filter(p => p.phase.endsWith(':returned')).length, 3);
});
test('panel disappearance after click1 blocks click2 and advance', async () => {
  const f = fixture({ disappearAfterFirst: true }); const r = createRunner(f.io, { allowAdvance: true });
  await assert.rejects(r.runRound(spec), { code: 'PANEL_CHANGED_OR_DISMISSED' });
  assert.equal(f.calls.filter(c => c === 'click').length, 1);
  assert.ok(f.preserved.some(p => p.phase === 'answer-1:returned' && !p.present));
});
for (const [name, options, code] of [
  ['owner active', { ownerActive: true }, 'OWNER_ACTIVE_OR_UNKNOWN'],
  ['stale lease', { staleLease: true }, 'LEASE_STALE'],
  ['missing atomic guard', { atomic: false }, 'ATOMIC_OWNER_GUARD_MISSING'],
  ['failed solver', { status: 'failed' }, 'SOLVER_NOT_SUCCESS'],
  ['cancelled solver', { status: 'cancelled' }, 'SOLVER_NOT_SUCCESS'],
  ['unknown solver state', { status: 'mystery' }, 'UNKNOWN_SOLVER_STATE'],
  ['wrong solver image', { solverHash: 'wrong' }, 'SOLVER_RESULT_MISMATCH'],
  ['wrong solver session', { solverSession: 'other' }, 'SOLVER_RESULT_MISMATCH'],
  ['unknown control', { unknown: true }, 'ADVANCE_NOT_RECOGNIZED'],
  ['disagreeing control', { disagree: true }, 'ADVANCE_NOT_RECOGNIZED']
]) test(name, async () => {
  const f = fixture(options); const r = createRunner(f.io, { allowAdvance: true });
  await assert.rejects(r.runRound(spec), { code });
  assert.ok(!f.calls.includes('advance'));
  await assert.rejects(r.runRound(spec), { code: 'RUNNER_HALTED' });
});
test('timeout retains job ID and never repeats paid solve', async () => {
  const f = fixture({ status: 'running' }); const r = createRunner(f.io, { allowAdvance: true, timeoutMs: 3, pollMs: 2 });
  await assert.rejects(r.runRound(spec), { code: 'SOLVER_WAIT_TIMEOUT' });
  assert.equal(r.state().activeSolve, 'J'); assert.equal(f.calls.filter(x => x === 'solve').length, 1);
});
test('uncertain start and input are never replayed', async () => {
  for (const o of [{ startThrows: true }, { inputThrows: true }]) {
    const f = fixture(o); const r = createRunner(f.io, { allowAdvance: true });
    await assert.rejects(r.runRound(spec)); await assert.rejects(r.runRound(spec), { code: 'RUNNER_HALTED' });
    assert.equal(f.calls.filter(x => x === 'solve').length, 1);
    assert.ok(f.calls.filter(x => x === 'click').length <= 1);
  }
});
test('new round needs explicit review and bounded budget', async () => {
  const f = fixture(); const r = createRunner(f.io, { allowAdvance: true, maxRounds: 1 });
  await r.runRound(spec); await assert.rejects(r.runRound(spec), { code: 'ROUND_BUDGET_EXHAUSTED' });
  const g = fixture(); await assert.rejects(createRunner(g.io).runRound({ ...spec, reviewed: false }), { code: 'REVIEW_REQUIRED' });
});
test('overlapping run is blocked before solver starts', async () => {
  const f = fixture(); let release; const wait = new Promise(r => { release = r; });
  const original = f.io.lease; f.io.lease = async () => { await wait; return original(); };
  const r = createRunner(f.io, { allowAdvance: true }); const first = r.runRound(spec);
  await assert.rejects(r.runRound(spec), { code: 'RUNNER_BUSY' });
  release(); await first;
  assert.equal(f.calls.filter(c => c === 'solve').length, 1);
});
test('overlapping run is blocked after solver result during input', async () => {
  const f = fixture(); let release, entered;
  const wait = new Promise(r => { release = r; });
  const ready = new Promise(r => { entered = r; });
  const original = f.io.input; f.io.input = async a => { entered(); await wait; return original(a); };
  const r = createRunner(f.io, { allowAdvance: true }); const first = r.runRound(spec); await ready;
  await assert.rejects(r.runRound(spec), { code: 'RUNNER_BUSY' });
  release(); await first;
  assert.equal(f.calls.filter(c => c === 'solve').length, 1);
});
test('missing atomic guard prevents paid solver start', async () => {
  const f = fixture({ atomic: false }); await assert.rejects(createRunner(f.io, { allowAdvance: true }).runRound(spec));
  assert.equal(f.calls.filter(c => c === 'solve').length, 0);
});
test('future-dated lease is rejected', async () => {
  const f = fixture(); f.io.lease = async () => ({ active: false, session: 'S', observedAtMs: 1e9 });
  await assert.rejects(createRunner(f.io, { allowAdvance: true }).runRound(spec), { code: 'LEASE_STALE' });
});
test('late successful solver result cannot authorize input', async () => {
  const f = fixture(); const original = f.io.status;
  f.io.status = async () => { await f.io.sleep(100); return original(); };
  await assert.rejects(createRunner(f.io, { allowAdvance: true, timeoutMs: 50 }).runRound(spec), { code: 'SOLVER_WAIT_TIMEOUT' });
  assert.ok(!f.calls.includes('click'));
});
test('unresolved adapter is bounded and never retried', async () => {
  const f = fixture(); f.io.status = async () => new Promise(() => {});
  const r = createRunner(f.io, { allowAdvance: true, maxCallMs: 10 });
  await assert.rejects(r.runRound(spec), { code: 'ADAPTER_WAIT_TIMEOUT' });
  assert.equal(r.state().activeSolve, 'J');
  assert.equal(f.calls.filter(c => c === 'solve').length, 1);
});
test('end-log failure does not lose successful solver job ID', async () => {
  const f = fixture(); f.io.record = e => { if (e.stage === 'solve:start:end') throw Error('logging'); };
  const r = createRunner(f.io, { allowAdvance: true }); await assert.rejects(r.runRound(spec));
  assert.equal(r.state().activeSolve, 'J'); assert.ok(!f.calls.includes('click'));
});
test('end-log failure does not lose first returned input frame', async () => {
  const f = fixture(); f.io.record = e => { if (e.stage === 'input:answer-1:end') throw Error('logging'); };
  const r = createRunner(f.io, { allowAdvance: true }); await assert.rejects(r.runRound(spec));
  assert.ok(f.preserved.some(p => p.phase === 'answer-1:returned'));
  assert.equal(f.calls.filter(c => c === 'click').length, 1);
});
test('preservation failure stops all subsequent input', async () => {
  const f = fixture(); const original = f.io.preserve;
  f.io.preserve = async (frame, phase) => {
    if (phase === 'answer-1:returned') throw Error('disk failure');
    return original(frame, phase);
  };
  await assert.rejects(createRunner(f.io, { allowAdvance: true }).runRound(spec));
  assert.equal(f.calls.filter(c => c === 'click').length, 1); assert.ok(!f.calls.includes('advance'));
});
test('dispatch receives expected identity for adapter-side revalidation', async () => {
  const f = fixture(); const original = f.io.input; const expected = [];
  f.io.input = async (action, identity) => { expected.push(identity); return original(action); };
  await createRunner(f.io, { allowAdvance: true }).runRound(spec);
  assert.equal(expected[0].session, 'S'); assert.equal(expected[0].imageHash, 'I0');
  assert.equal(expected[0].controlHash, 'Skip'); assert.ok(Number.isFinite(expected[0].dispatchBeforeMs));
});
test('hung polling delay is bounded and reported as uncertain', async () => {
  const f = fixture({ status: 'running' }); f.io.sleep = async () => new Promise(() => {});
  const r = createRunner(f.io, { allowAdvance: true, maxCallMs: 10 });
  await assert.rejects(r.runRound(spec), { code: 'ADAPTER_WAIT_TIMEOUT' });
  assert.deepEqual(r.state().uncertainOperation, { stage: 'solve:poll-delay', mayStillRun: true });
});
test('input timeout is outstanding work, not proof of cancellation', async () => {
  const f = fixture(); f.io.input = async () => new Promise(() => {});
  const r = createRunner(f.io, { allowAdvance: true, maxCallMs: 10 });
  await assert.rejects(r.runRound(spec), { code: 'ADAPTER_WAIT_TIMEOUT' });
  assert.deepEqual(r.state().uncertainOperation, { stage: 'input:answer-1', mayStillRun: true });
  await assert.rejects(r.runRound(spec), { code: 'RUNNER_HALTED' });
});

test('same-anchor grid replacement after click1 cannot rebaseline stale solver points', async () => {
 const f=fixture({dynamic:true});const r=createRunner(f.io,{allowAdvance:true});
 await assert.rejects(r.runRound(spec),{code:'CHALLENGE_CHANGED_AFTER_INPUT'});
 assert.equal(f.calls.filter(c=>c==='click').length,1);assert.ok(!f.calls.includes('advance'));
});
