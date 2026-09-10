import {
  transitionCall,
  createCallRecord,
  callPeerId,
  findCallerBlockingCall,
  getCallExpiry,
  supersedeRedialledCalls,
} from './calls.ts';
import { DEFAULT_CALL_STATE_FRESHNESS_MS, TERMINAL_CALL_STATES } from '../config.ts';
import { describeError } from '../lib/errors.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type CallRecord = import('../stores/contracts.ts').CallRecord;

/**
 * Record that `callId` was just read from — or written to — the shared store,
 * so the freshness bound in {@link hydrateCallFromShared} can tell a record
 * this instance has just confirmed from one it merely remembers.
 */
function markCallSynced(state: ServerState, callId: string, now: number = Date.now()): void {
  if (!state.callState) return;
  state.callSyncedAt ??= new Map();
  state.callSyncedAt.set(callId, now);
}

/**
 * Adopt a record another instance owns into the local registry.
 *
 * The local `state.calls` map is a cache, so a record that arrives from the
 * shared store replaces whatever this instance believed. The event log is
 * created empty when missing: events are per-instance breadcrumbs, and the
 * durable log lives in Postgres.
 */
function adoptSharedCall(state: ServerState, call: CallRecord, now: number = Date.now()): CallRecord {
  state.calls.set(call.callId, call);
  if (!state.callEvents.has(call.callId)) {
    state.callEvents.set(call.callId, []);
  }
  markCallSynced(state, call.callId, now);
  return call;
}

/**
 * Resolve a call, preferring the shared record over this instance's cache.
 *
 * The cache used to win unconditionally, which is exactly how one instance kept
 * answering `ringing` for a call another instance had already ended: nothing
 * ever invalidated it. It is now trusted only for
 * {@link DEFAULT_CALL_STATE_FRESHNESS_MS} after this instance last confirmed it
 * against the shared store — long enough to keep Redis off the per-frame RTC
 * path, short enough that a divergence cannot outlive a ring.
 *
 * @param options.maxAgeMs - Freshness window; `0` forces a shared read.
 */
async function hydrateCallFromShared(
  state: ServerState,
  callId: string,
  { maxAgeMs = DEFAULT_CALL_STATE_FRESHNESS_MS }: { maxAgeMs?: number } = {}
): Promise<CallRecord | null> {
  const local = state.calls.get(callId);
  if (!state.callState) {
    return local ?? null;
  }
  const now = Date.now();
  const syncedAt = state.callSyncedAt?.get(callId) ?? 0;
  // A terminal record is final: no later read can change it, so it never needs
  // re-reading however old this instance's copy is.
  if (local && (TERMINAL_CALL_STATES.has(local.status) || now - syncedAt < maxAgeMs)) {
    return local;
  }

  const shared = await state.callState.get(callId);
  if (!shared) {
    return local ?? null;
  }
  return adoptSharedCall(state, shared, now);
}

async function persistCallToShared(state: ServerState, call: CallRecord): Promise<void> {
  if (!state.callState) return;
  await state.callState.save(call);
  markCallSynced(state, call.callId);
}

/**
 * Pull every call the shared store says `userId` is on into the local registry,
 * and drop local records the shared store no longer considers active.
 *
 * This is what makes a `busy` verdict answerable across instances: the question
 * is per *user*, and a key-per-call store cannot answer it without the index
 * this reads. Best-effort — a shared store that cannot answer (or fails) leaves
 * the local registry as the only evidence, which is what a single-instance
 * deployment has anyway.
 */
async function refreshActiveCallsForUser(state: ServerState, userId: string): Promise<void> {
  const listActive = state.callState?.listActiveCallsForUser;
  if (!listActive) return;
  let shared: CallRecord[];
  try {
    shared = await listActive(userId);
  } catch (error: unknown) {
    console.error(
      `[calls] failed to read shared active calls for ${userId}: ${describeError(error)}`
    );
    return;
  }

  const now = Date.now();
  const active = new Set<string>();
  for (const call of shared) {
    active.add(call.callId);
    adoptSharedCall(state, call, now);
  }
  // Anything this instance still holds as non-terminal that the shared store
  // does not list has been ended elsewhere; keeping it would let a fossil on
  // one instance keep reporting the user as busy.
  const orphans = [];
  for (const call of state.calls.values()) {
    if (TERMINAL_CALL_STATES.has(call.status)) continue;
    if (call.callerId !== userId && call.calleeId !== userId) continue;
    if (active.has(call.callId)) continue;
    orphans.push(call.callId);
  }
  for (const callId of orphans) {
    const latest = await state.callState?.get(callId);
    if (latest) {
      adoptSharedCall(state, latest, now);
      continue;
    }
    state.calls.delete(callId);
    state.callSyncedAt?.delete(callId);
  }
}

async function createCallRecordWithShared(
  state: ServerState,
  args: {
    callerId: string;
    calleeId: string;
    ringingTimeoutMs: number;
    callerDeviceId?: string | null;
  }
): Promise<CallRecord> {
  const call = createCallRecord(state, args);
  await persistCallToShared(state, call);
  return call;
}

/**
 * Re-read every locally expired call from the shared store before the sweep
 * acts on it.
 *
 * The sweep finalises records directly, bypassing the atomic transition, so
 * without this an instance whose copy of a call is behind would overwrite a
 * conversation another instance is happily running with `media_connect_timeout`.
 * Only records this instance already believes are past their deadline are read,
 * so the cost is bounded by how many calls are actually expiring.
 *
 * A no-op without a shared store: there is then nothing to be behind.
 *
 * @returns Number of records refreshed from the shared store.
 */
async function refreshExpiredCallsFromShared(
  state: ServerState,
  timeouts: { ringingTimeoutMs?: number; mediaConnectTimeoutMs?: number; maxCallDurationMs?: number; heartbeatTimeoutMs?: number; } = {}
): Promise<number> {
  if (!state.callState) return 0;
  const now = Date.now();
  const expiring = [];
  for (const call of state.calls.values()) {
    const expiry = getCallExpiry(call, timeouts);
    if (expiry && expiry.deadlineMs <= now) expiring.push(call.callId);
  }

  let refreshed = 0;
  for (const callId of expiring) {
    try {
      const shared = await state.callState.get(callId);
      if (shared) {
        adoptSharedCall(state, shared, now);
        refreshed++;
      }
    } catch (error: unknown) {
      console.error(`[calls] failed to refresh expiring call ${callId}: ${describeError(error)}`);
    }
  }
  return refreshed;
}

/**
 * The outcome of a placement request: either a call record (which may itself be
 * a terminal `busy`/`unreachable` verdict about the *callee*) or a refusal
 * because the *caller* is already on a call.
 */
type PlaceCallResult =
  | { ok: true; call: CallRecord; superseded: CallRecord[] }
  | { ok: false; error: 'call_in_progress'; call: CallRecord; peerId: string };

/**
 * Place a call on behalf of `callerId`, enforcing that a user may only hold one
 * call at a time.
 *
 * Two failures used to be conflated into a `busy` record, and both left the
 * caller stuck:
 *
 * 1. A stale ring the caller themselves had placed to the same callee made
 *    every retry report the callee as busy — "busy with myself". Those rings
 *    are now superseded so the redial goes through.
 * 2. A caller already talking to someone else could still place a second call,
 *    from this device or another one, and the two immediately fought over the
 *    same media session. That is now refused with `call_in_progress`, naming
 *    the peer so the client can say who the user is already talking to.
 *
 * @param onSuperseded - Invoked for each stale ring closed out, so the caller
 *   can notify participants exactly as any other server-side ending does.
 */
async function placeCallWithShared(
  state: ServerState,
  {
    callerId,
    calleeId,
    ringingTimeoutMs,
    callerDeviceId = null,
    onSuperseded,
  }: {
    callerId: string;
    calleeId: string;
    ringingTimeoutMs: number;
    callerDeviceId?: string | null;
    onSuperseded?: (call: CallRecord, previousStatus: string, reason: string) => void;
  }
): Promise<PlaceCallResult> {
  // Both verdicts this makes — "the caller is already on a call" and "the
  // callee is busy" — are per *user*, and the local registry only knows about
  // calls this instance handled. Pull the shared view of both participants in
  // first, so a call running on another instance is seen and a fossil this
  // instance never saw ended is dropped.
  await Promise.all([
    refreshActiveCallsForUser(state, callerId),
    refreshActiveCallsForUser(state, calleeId),
  ]);

  const blocking = findCallerBlockingCall(state, callerId, calleeId, {
    staleAfterMs: ringingTimeoutMs,
  });
  if (blocking) {
    return {
      ok: false,
      error: 'call_in_progress',
      call: blocking,
      peerId: callPeerId(blocking, callerId),
    };
  }

  const superseded = supersedeRedialledCalls(state, callerId, calleeId, {
    onTransition: onSuperseded,
  });
  for (const call of superseded) {
    await persistCallToShared(state, call);
  }

  const call = await createCallRecordWithShared(state, {
    callerId,
    calleeId,
    ringingTimeoutMs,
    callerDeviceId,
  });
  return { ok: true, call, superseded };
}

async function transitionCallWithShared(
  state: ServerState,
  callId: string,
  toStatus: string,
  {
    actor = null,
    reason = null,
    actorDeviceId = null,
  }: { actor?: string | null; reason?: string | null; actorDeviceId?: string | null } = {}
): Promise<
  | { ok: true; call: CallRecord; stale: boolean }
  | { ok: false; status: number; error: string; message?: string }
> {
  const call = await hydrateCallFromShared(state, callId);
  if (!call) {
    return { ok: false, status: 404, error: 'not_found' };
  }

  if (!state.callState) {
    const local = transitionCall(state, callId, toStatus, { actor, reason, actorDeviceId });
    return local.ok
      ? { ok: true, call: local.call, stale: false }
      : local;
  }

  const fromStatus = call.status;
  const atomic = await state.callState.transitionAtomic({
    callId,
    fromStatus,
    toStatus,
    actor,
    reason,
  });
  if (!atomic.ok) {
    return await handleAtomicTransitionFailure(state, callId, atomic.error);
  }

  if (atomic.idempotent) {
    hydrateCallFromAtomicResult(state, callId, atomic.call);
    return { ok: true, call: atomic.call, stale: true };
  }

  primeLocalCallForTransition(state, callId, atomic.call, fromStatus);
  const transitioned = transitionCall(state, callId, toStatus, { actor, reason, actorDeviceId });
  if (!transitioned.ok) {
    return transitioned;
  }
  await persistCallToShared(state, transitioned.call);
  return { ok: true, call: transitioned.call, stale: false };
}

function hydrateCallFromAtomicResult(state: ServerState, callId: string, call: CallRecord): void {
  adoptSharedCall(state, call);
}

function primeLocalCallForTransition(
  state: ServerState,
  callId: string,
  atomicCall: CallRecord,
  fromStatus: string
): void {
  const local = state.calls.get(callId);
  if (local) {
    local.status = fromStatus;
    return;
  }
  adoptSharedCall(state, { ...atomicCall, status: fromStatus });
}

async function handleAtomicTransitionFailure(
  state: ServerState,
  callId: string,
  error: 'not_found' | 'stale_call_state' | 'terminal_state'
) {
  if (error === 'not_found') {
    return { ok: false as const, status: 404, error: 'not_found' };
  }
  if (error === 'stale_call_state') {
    const latest = await state.callState?.get(callId);
    if (latest) adoptSharedCall(state, latest);
    return {
      ok: false as const,
      status: 409,
      error: 'stale_call_state',
      message: 'call state changed on another instance',
    };
  }
  return {
    ok: false as const,
    status: 409,
    error: 'terminal_state',
    message: 'call is already in terminal state',
  };
}

export {
  adoptSharedCall,
  hydrateCallFromShared,
  refreshExpiredCallsFromShared,
  markCallSynced,
  persistCallToShared,
  refreshActiveCallsForUser,
  createCallRecordWithShared,
  placeCallWithShared,
  transitionCallWithShared,
};
export type { PlaceCallResult };
