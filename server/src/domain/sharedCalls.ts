import {
  transitionCall,
  createCallRecord,
  callPeerId,
  findCallerBlockingCall,
  supersedeRedialledCalls,
} from './calls.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type CallRecord = import('../stores/contracts.ts').CallRecord;

async function hydrateCallFromShared(
  state: ServerState,
  callId: string
): Promise<CallRecord | null> {
  const local = state.calls.get(callId);
  if (local) {
    return local;
  }
  if (!state.callState) {
    return null;
  }
  const shared = await state.callState.get(callId);
  if (!shared) {
    return null;
  }
  state.calls.set(callId, shared);
  if (!state.callEvents.has(callId)) {
    state.callEvents.set(callId, []);
  }
  return shared;
}

async function persistCallToShared(state: ServerState, call: CallRecord): Promise<void> {
  if (!state.callState) return;
  await state.callState.save(call);
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
  const blocking = findCallerBlockingCall(state, callerId, calleeId);
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
  state.calls.set(callId, call);
  if (!state.callEvents.has(callId)) {
    state.callEvents.set(callId, []);
  }
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
  state.calls.set(callId, { ...atomicCall, status: fromStatus });
  if (!state.callEvents.has(callId)) state.callEvents.set(callId, []);
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
    if (latest) state.calls.set(callId, latest);
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
  hydrateCallFromShared,
  persistCallToShared,
  createCallRecordWithShared,
  placeCallWithShared,
  transitionCallWithShared,
};
export type { PlaceCallResult };
