/**
 * Cross-instance call-state synchronisation.
 *
 * Every instance already *publishes* its transitions on
 * {@link CALL_TRANSITION_CHANNEL}, and nothing listened: an instance that did
 * not handle a transition kept serving its own cached record forever. That is
 * how one node went on reporting a call as `ringing` — blocking new calls,
 * suppressing the callee's push, rejecting RTC frames as `stale_call_state` —
 * seventeen seconds after another node had ended it.
 *
 * Socket delivery to participants is the Redis adapter's job and has always
 * worked, so this deliberately re-emits nothing. It only repairs local state:
 * the record, the per-call push bookkeeping, and any buffered RTC signals for a
 * call that has since ended.
 */
import { CALL_TRANSITION_CHANNEL, TERMINAL_CALL_STATES } from '../config.ts';
import { describeError } from '../lib/errors.ts';
import { adoptSharedCall, markCallSynced } from './sharedCalls.ts';
import { clearIncomingCallPushState } from './notifications.ts';
import { discardBufferedRtcSignals } from '../signaling/rtcBuffer.ts';

type ServerState = import('../stores/contracts.ts').ServerState;

/** A transition as published by a peer instance. */
type CallTransitionMessage = {
  callId: string;
  status: string;
  instanceId: string | null;
};

/**
 * Read a bus payload as a transition, or `null` when it is not one.
 *
 * The bus carries whatever a peer published, including messages from a future
 * (or past) version of this server, so every field is checked rather than
 * assumed.
 */
function parseTransitionMessage(message: unknown): CallTransitionMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const { callId, status, instanceId } = message as Record<string, unknown>;
  if (typeof callId !== 'string' || callId === '') return null;
  if (typeof status !== 'string' || status === '') return null;
  return {
    callId,
    status,
    instanceId: typeof instanceId === 'string' ? instanceId : null,
  };
}

/**
 * Drop everything this instance was holding on behalf of a call that has
 * reached a terminal state elsewhere.
 *
 * The push bookkeeping is what stops a device being re-pushed for a call that
 * is over, and the buffered RTC signals would otherwise be replayed into a dead
 * call the first time anything touched it.
 *
 * Discarding those signals is counted as `stranded_remote`: unlike a local
 * terminal transition, this instance never had the chance to replay them, so
 * the count is the cross-instance candidate loss described in
 * `docs/media-connect-latency-diagnosis.md` §2 rather than ordinary cleanup.
 */
function releaseCallResources(state: ServerState, callId: string): void {
  clearIncomingCallPushState(state, callId);
  discardBufferedRtcSignals(state, callId, 'stranded_remote');
}

/**
 * Apply a peer instance's transition to this instance's local registry.
 */
async function applyRemoteTransition(
  state: ServerState,
  transition: CallTransitionMessage
): Promise<void> {
  const { callId } = transition;
  // The shared store holds the whole record; the message only says that it
  // moved. Re-reading it keeps every field (end reason, duration, device
  // ownership) consistent instead of patching a status onto a stale copy.
  const shared = await state.callState?.get(callId);
  if (shared) {
    adoptSharedCall(state, shared);
  } else {
    const local = state.calls.get(callId);
    // No shared store (or the record has aged out of it): the status carried by
    // the message is still better than a record this instance knows is behind.
    if (local && local.status !== transition.status) {
      local.status = transition.status;
      local.updatedAt = new Date().toISOString();
      markCallSynced(state, callId);
    }
  }

  const status = state.calls.get(callId)?.status ?? transition.status;
  if (TERMINAL_CALL_STATES.has(status)) {
    releaseCallResources(state, callId);
  }
}

/**
 * Subscribe this instance to the call transitions its peers publish.
 *
 * A no-op (resolving to `null`) when no cross-instance bus is configured, which
 * is the single-instance shape: there are no peers to hear from.
 *
 * @returns Unsubscribe handle.
 */
async function subscribeToCallTransitions(
  state: ServerState
): Promise<(() => Promise<void>) | null> {
  if (!state.messageBus) return null;
  return state.messageBus.subscribe(CALL_TRANSITION_CHANNEL, (message) => {
    const transition = parseTransitionMessage(message);
    if (!transition) return;
    // This instance has already applied its own transitions; re-reading them
    // would put a shared-store round trip behind every local call action.
    if (transition.instanceId && transition.instanceId === state.instanceId) return;

    applyRemoteTransition(state, transition).catch((error: unknown) => {
      console.error(
        `[calls] failed to apply remote transition for ${transition.callId}:` +
          ` ${describeError(error)}`
      );
    });
  });
}

export { subscribeToCallTransitions, parseTransitionMessage };
