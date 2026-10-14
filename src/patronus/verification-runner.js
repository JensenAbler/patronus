// Bounded verification orchestration. No browser, network, or filesystem side effects
// occur unless a caller supplies adapters and explicitly invokes runRound.
export class Halt extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}

const inside = (p, b) => Number.isInteger(p?.x) && Number.isInteger(p?.y)
  && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

export function normalizeAnswer(points, spec) {
  if (!Array.isArray(points) || !points.length || points.length > 10)
    throw new Halt('INVALID_POINTS');
  if (points.some(p => !inside(p, spec.image))) throw new Halt('OUTSIDE_IMAGE');
  if (new Set(points.map(p => `${p.x},${p.y}`)).size !== points.length)
    throw new Halt('DUPLICATE_POINTS');
  if (spec.type === 'select') return points.map(point => ({ type: 'click', point }));
  if (spec.type !== 'drag' || !spec.source) throw new Halt('UNKNOWN_FORMAT');
  if (!inside(spec.source.center, spec.source) || !inside(spec.source.center, spec.image))
    throw new Halt('INVALID_SOURCE_CENTER');
  if (points.length === 1 && !inside(points[0], spec.source))
    return [{ type: 'drag', from: spec.source.center, to: points[0] }];
  if (points.length === 2) {
    const sources = points.filter(p => inside(p, spec.source));
    const targets = points.filter(p => !inside(p, spec.source));
    if (sources.length === 1 && targets.length === 1)
      return [{ type: 'drag', from: sources[0], to: targets[0] }];
  }
  throw new Halt('AMBIGUOUS_DRAG');
}

export function exactControl(texts) {
  return Array.isArray(texts) && texts.length === 2 && texts[0] === texts[1]
    && ['Skip', 'Next', 'Verify'].includes(texts[0]) ? texts[0] : null;
}

export function createRunner(io, { maxRounds = 2, timeoutMs = 100000,
  pollMs = 1200, maxLeaseAgeMs = 2000, maxCallMs = 20000, allowAdvance = false } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3 ||
      !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000 ||
      !Number.isInteger(maxCallMs) || maxCallMs <= 0 || maxCallMs > 30000 ||
      !Number.isInteger(pollMs) || pollMs < 0 || pollMs > 10000 ||
      !Number.isInteger(maxLeaseAgeMs) || maxLeaseAgeMs < 0 || maxLeaseAgeMs > 10000)
    throw new Halt('INVALID_RUN_BUDGET');
  let usedRounds = 0;
  let activeSolve = null;
  let halted = false;
  let inFlight = false;
  let uncertainOperation = null;
  const events = [];
  const emit = (stage, data = {}) => {
    const e = { stage, utc: io.utc(), monotonicMs: io.now(), ...data };
    events.push(e); io.record(e); return e;
  };
  const step = async (stage, fn) => {
    emit(`${stage}:start`);
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Halt('ADAPTER_WAIT_TIMEOUT', { stage })), maxCallMs);
      });
      const value = await Promise.race([Promise.resolve().then(fn), timeout]);
      emit(`${stage}:end`); return value;
    }
    catch (e) {
      if (e.code === 'ADAPTER_WAIT_TIMEOUT') uncertainOperation = { stage, mayStillRun: true };
      emit(`${stage}:error`, { code: e.code || 'ADAPTER_ERROR' }); throw e;
    }
    finally { clearTimeout(timer); }
  };
  async function lease(session) {
    const status = await step('lease', () => io.lease());
    if (status.active !== false) throw new Halt('OWNER_ACTIVE_OR_UNKNOWN');
    if (status.session !== session) throw new Halt('SESSION_CHANGED');
    if (!Number.isFinite(status.observedAtMs) || status.observedAtMs > io.now()
      || io.now() - status.observedAtMs > maxLeaseAgeMs)
      throw new Halt('LEASE_STALE');
    return status;
  }
  function samePanel(frame, spec) {
    if (frame.session !== spec.session) throw new Halt('SESSION_CHANGED');
    if (frame.panelPresent !== true || frame.anchorHash !== spec.anchorHash)
      throw new Halt('PANEL_CHANGED_OR_DISMISSED');
  }
  async function capture(spec, phase) {
    const frame = await step(`capture:${phase}`, () => io.capture());
    // Adapter persists uniquely named challenge-only crops when panel is known
    // present. For absent/unknown panels it records metadata only, not the form.
    await step(`preserve:${phase}`, () => io.preserve(frame, phase));
    samePanel(frame, spec);
    return frame;
  }
  async function guardedInput(action, prior, spec, phase) {
    const current = await capture(spec, `${phase}:preinput`);
    if (current.imageHash !== prior.imageHash || current.controlHash !== prior.controlHash)
      throw new Halt('IMAGE_CHANGED_BEFORE_INPUT');
    if (action.type === 'advance' && exactControl(current.controlTexts) !== action.label)
      throw new Halt('CONTROL_CHANGED_BEFORE_INPUT');
    await lease(spec.session);
    // This adapter MUST enforce the same owner lease atomically at dispatch, or
    // provide an explicitly approved exclusive input lease. A preceding check
    // alone does not prevent a takeover race. Production uses the reader-owned lease.
    if (io.atomicOwnerGuard !== true) throw new Halt('ATOMIC_OWNER_GUARD_MISSING');
    const expected = { session: current.session, anchorHash: current.anchorHash,
      imageHash: current.imageHash, controlHash: current.controlHash,
      dispatchBeforeMs: io.now() + maxCallMs };
    const frame = await step(`input:${phase}`, async () => {
      // Adapter must revalidate these immediately before dispatch as well.
      // Image capture cannot freeze page time: a residual capture-to-click race
      // remains and must be reported, not described as an atomic page guard.
      const returned = await io.input(action, expected);
      // Save before fallible end-event logging, and before any later input.
      await io.preserve(returned, `${phase}:returned`);
      return returned;
    });
    return frame;
  }
  return {
    events,
    state: () => ({ usedRounds, activeSolve, halted, inFlight, uncertainOperation }),
    async runRound(spec) {
      if (halted) throw new Halt('RUNNER_HALTED');
      if (inFlight) throw new Halt('RUNNER_BUSY');
      if (activeSolve) throw new Halt('SOLVER_ALREADY_ACTIVE');
      if (usedRounds >= maxRounds) throw new Halt('ROUND_BUDGET_EXHAUSTED');
      spec = structuredClone(spec);
      inFlight = true;
      usedRounds++;
      try {
        emit('round:start', { round: usedRounds, type: spec.type });
        if (io.atomicOwnerGuard !== true) throw new Halt('ATOMIC_OWNER_GUARD_MISSING');
        await lease(spec.session);
        const source = await capture(spec, 'source');
        if (source.imageHash !== spec.observedImageHash) throw new Halt('OBSERVED_IMAGE_CHANGED');
        // The prompt/geometry must already have been reviewed. No model turn or
        // code generation belongs between this fresh capture and startSolve.
        if (spec.reviewed !== true) throw new Halt('REVIEW_REQUIRED');
        const deadline = io.now() + timeoutMs;
        const started = await step('solve:start', async () => {
          const value = await io.startSolve(source, spec);
          if (value?.jobId) activeSolve = value.jobId; // Before fallible end logging.
          return value;
        });
        if (!started?.jobId || !['running', 'succeeded', 'failed', 'cancelled'].includes(started.solverState))
          throw new Halt('AMBIGUOUS_SOLVER_START');
        activeSolve = started.jobId;
        let result;
        for (;;) {
          if (io.now() >= deadline) throw new Halt('SOLVER_WAIT_TIMEOUT', { jobId: activeSolve });
          result = await step('solve:status', () => io.status(activeSolve));
          if (io.now() >= deadline) throw new Halt('SOLVER_WAIT_TIMEOUT', { jobId: activeSolve });
          if (['succeeded', 'failed', 'cancelled'].includes(result?.state)) break;
          if (!['queued', 'running'].includes(result?.state)) throw new Halt('UNKNOWN_SOLVER_STATE');
          if (io.now() >= deadline) throw new Halt('SOLVER_WAIT_TIMEOUT', { jobId: activeSolve });
          await step('solve:poll-delay', () => io.sleep(pollMs));
        }
        activeSolve = null;
        if (result.state !== 'succeeded') throw new Halt('SOLVER_NOT_SUCCESS');
        if (result.session !== spec.session || result.imageHash !== source.imageHash)
          throw new Halt('SOLVER_RESULT_MISMATCH');
        const actions = normalizeAnswer(result.points, spec);
        let prior = source;
        for (let i = 0; i < actions.length; i++) {
          prior = await guardedInput(actions[i], prior, spec, `answer-${i + 1}`);
          samePanel(prior, spec); // Disappearance after click1 blocks click2.
          if (i < actions.length - 1 && prior.imageHash !== source.imageHash)
            throw new Halt('CHALLENGE_CHANGED_AFTER_INPUT'); // Never rebaseline stale solver points.
        }
        if (!allowAdvance) {
          emit('round:end', { awaitingControlReview: true });
          return { outcome: prior, acceptance: 'unverified', awaitingControlReview: true, events };
        }
        const label = exactControl(prior.controlTexts);
        if (!['Next', 'Verify'].includes(label)) throw new Halt('ADVANCE_NOT_RECOGNIZED');
        const outcome = await guardedInput({ type: 'advance', label }, prior, spec, 'advance');
        emit('round:end', { advanced: label });
        return { label, outcome, acceptance: 'unverified', events };
      } catch (e) {
        halted = true;
        emit('round:halt', { code: e.code || 'ADAPTER_ERROR', activeSolve });
        // Never replay an uncertain solve or input. Keep the durable job ID for
        // status recovery; caller coordinates any cancellation/cleanup.
        throw e;
      } finally {
        inFlight = false;
      }
    }
  };
}
