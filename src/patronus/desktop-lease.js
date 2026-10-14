import { randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id);

/** Reader-owned, ephemeral control. A released/expired action drains before takeover. */
export function createDesktopLease({ now = Date.now, ownerMs = 900000, agentMs = 60000 } = {}) {
  let held = null, closed = false, ownerEpoch = 0;
  const clear = lease => {
    if (held !== lease) return;
    clearTimeout(lease.timer); held = null;
  };
  const drain = lease => {
    lease.draining = true;
    if (!lease.controller.signal.aborted) lease.controller.abort(fail('DESKTOP_CONTROL_RELEASED'));
    if (!lease.inFlight) clear(lease);
  };
  const sweep = () => {
    if (held && held.expiresAt <= now()) drain(held);
  };
  const status = () => {
    sweep();
    return { held: !!held, kind: held?.kind ?? null, ownerEpoch, inFlight: !!held?.inFlight,
      draining: !!held?.draining, expiresAt: held && Number.isFinite(held.expiresAt) ? new Date(held.expiresAt).toISOString() : null };
  };
  function acquire({ kind } = {}) {
    if (kind !== 'owner' && kind !== 'agent') throw fail('DESKTOP_LEASE_POLICY');
    sweep();
    if (closed) throw fail('DESKTOP_CONTROL_CLOSED');
    if (held) throw fail(held.kind === 'owner' ? 'DESKTOP_HUMAN_CONTROL' : 'DESKTOP_BUSY');
    const duration = kind === 'owner' ? ownerMs : agentMs;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 900000) throw fail('DESKTOP_LEASE_POLICY');
    const lease = { id: randomBytes(32).toString('base64url'), kind, expiresAt: now() + duration,
      draining: false, inFlight: false, controller: new AbortController(), timer: null };
    held = lease;
    if (kind === 'owner') ownerEpoch++;
    lease.timer = setTimeout(() => { if (held === lease) drain(lease); }, duration);
    lease.timer.unref();
    return { leaseId: lease.id, kind, ownerEpoch, expiresAt: new Date(lease.expiresAt).toISOString() };
  }
  function release({ leaseId } = {}) {
    if (!validId(leaseId)) throw fail('DESKTOP_LEASE_POLICY');
    sweep();
    if (!held) return { released: true, draining: false };
    if (held.id !== leaseId) throw fail('DESKTOP_CONTROL_LEASE_INVALID');
    const lease = held; drain(lease);
    return { released: !held, draining: held === lease };
  }
  async function run(leaseId, operation) {
    if (typeof operation !== 'function' || (leaseId !== undefined && !validId(leaseId))) throw fail('DESKTOP_LEASE_POLICY');
    sweep();
    if (closed) throw fail('DESKTOP_CONTROL_CLOSED');
    let lease = held;
    if (leaseId !== undefined) {
      if (!lease || lease.id !== leaseId) throw fail('DESKTOP_CONTROL_LEASE_INVALID');
    } else {
      if (lease) throw fail(lease.kind === 'owner' ? 'DESKTOP_HUMAN_CONTROL' : 'DESKTOP_BUSY');
      lease = { id: null, kind: 'raw', expiresAt: Infinity, draining: false, inFlight: false,
        controller: new AbortController(), timer: null };
      held = lease;
    }
    if (lease.draining) throw fail('DESKTOP_CONTROL_RELEASED');
    if (lease.inFlight) throw fail('DESKTOP_BUSY');
    lease.inFlight = true;
    const assertActive = () => {
      sweep();
      if (closed || held !== lease || lease.draining || lease.controller.signal.aborted) throw fail('DESKTOP_CONTROL_RELEASED');
    };
    try {
      assertActive();
      return await operation({ kind: lease.kind, signal: lease.controller.signal, assertActive });
    } finally {
      lease.inFlight = false;
      if (lease.kind === 'raw' || lease.draining || lease.expiresAt <= now()) clear(lease);
    }
  }
  return { acquire, release, status, run, close() { closed = true; if (held) drain(held); } };
}
