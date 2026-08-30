/**
 * Call-lifecycle decisions, as pure logic.
 *
 * Phase 5, slice 1 of the `useCallFlow` decomposition (#216). These are the
 * rules the hook applied inline, tangled up with the refs and side effects that
 * act on them: whether a second Answer tap is a duplicate, whether an incoming
 * offer is glare, what a status or an ICE state means, and what a finished call
 * should say for itself.
 *
 * Same seam as `callStateMachine.ts`, `recoveryEpisode.ts` and
 * `iceRestartLadder.ts`: facts in, decision out. No React, no refs, no peer
 * connection — so every rule below is a table-driven unit test rather than
 * something reachable only by mounting the hook.
 *
 * The hook still owns every side effect (logging, telemetry, CallKeep, history
 * writes); it asks this module what to do and then does it.
 */

/**
 * How the callee is being reached while an outgoing call rings.
 *
 * `ringing` — a device with a live socket is ringing right now.
 * `push` — every device is asleep; a push has been sent and must wake one.
 */
export type CallDelivery = 'ringing' | 'push';

/**
 * What the UI is told about a call once it is over.
 *
 * The user used to be returned to the tab shell with no resolution at all — a
 * call that dropped and a call the peer hung up looked identical. The reason is
 * phrased with the same vocabulary the conversation timeline uses, so the same
 * call is described the same way at the moment it ends and forever after.
 */
export type CallEndSummary = {
  durationSeconds: number | null;
  quality: string;
  endReason: string | null;
  status: string | null;
  direction: 'outgoing' | 'incoming';
  peerId: string | null;
};

/** The parts of a call record these decisions read. */
export type CallEndRecord = {
  status?: string | null;
  endReason?: string | null;
  callerId?: string | null;
  calleeId?: string | null;
};

/**
 * Call statuses that mean a call is up (or coming up) on this device.  A failed
 * accept must never tear one of these down: a duplicate Answer tap for a call
 * that is already connected fails server-side ("not ringing any more") and the
 * naive cleanup would kill the very call the user just picked up.
 */
const LIVE_CALL_STATUSES = new Set(['accepted', 'connecting_media', 'in_call']);

/** Statuses that mean a call has stopped ringing for good. */
const TERMINAL_CALL_STATUSES = new Set([
  'ended',
  'declined',
  'missed',
  'busy',
  'unreachable',
]);

/** ICE states the server reads as "this call is over". */
const TERMINAL_ICE_STATES = new Set(['disconnected', 'failed']);

/**
 * End reasons worth summarising for a call that never connected.
 *
 * A call that failed leaves the user with a question ("was that them, or is
 * this app broken?"); a call they cancelled themself does not.
 */
const SUMMARISED_END_REASONS = new Set([
  'media_failed',
  'failed',
  'missed',
  'timeout',
  'busy',
  'unreachable',
]);

/** End reasons that make a call a missed one in the timeline. */
const MISSED_END_REASONS = new Set(['missed', 'timeout']);

/** How many answered callIds are remembered for duplicate-accept suppression. */
export const ANSWERED_CALL_HISTORY_LIMIT = 20;

/** Whether a call in this status is one an accept failure must not tear down. */
export function isLiveCallStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && LIVE_CALL_STATUSES.has(status);
}

/** Whether a `call.state_changed` status means the call stopped ringing for good. */
export function isTerminalCallStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_CALL_STATUSES.has(status);
}

/** Whether a queued `call.connected` payload would end the call. */
export function isTerminalIceState(value: unknown): boolean {
  return typeof value === 'string' && TERMINAL_ICE_STATES.has(value);
}

/**
 * How the server says the callee is being reached.
 *
 * A server that does not report delivery is one that only ever rang a live
 * device, which is what `ringing` means.
 */
export function classifyCallDelivery(delivery: unknown): CallDelivery {
  return delivery === 'push' ? 'push' : 'ringing';
}

/**
 * Add `callId` to the bounded answered-call history.
 *
 * Returns the next history; the oldest entry is dropped past the bound, and a
 * callId already remembered is left where it is (its position is its age).
 */
export function rememberAnsweredCallId(
  history: readonly string[],
  callId: string,
): string[] {
  if (history.includes(callId)) return history.slice();
  const next = [...history, callId];
  if (next.length > ANSWERED_CALL_HISTORY_LIMIT) next.shift();
  return next;
}

/**
 * Whether the replayed-answer guard set should be emptied before the next
 * insert. callIds are unique, so the set would otherwise grow for the lifetime
 * of the app.
 */
export function shouldResetReplayGuard(size: number): boolean {
  return size >= ANSWERED_CALL_HISTORY_LIMIT;
}

/** What to do with an inbound `rtc.offer`. */
export type IncomingOfferDecision = 'negotiate' | 'ignore-unknown-call' | 'ignore-glare';

/**
 * Whether an inbound offer may be answered.
 *
 * An offer for a call this device is not in is stale, and one that arrives
 * while a negotiation is already in flight is glare: answering both is how two
 * peers talk over each other and neither connects.
 */
export function decideIncomingOffer({
  callId,
  activeCallId,
  isNegotiating,
}: {
  callId: string | null | undefined;
  activeCallId: string | null | undefined;
  isNegotiating: boolean;
}): IncomingOfferDecision {
  if (callId !== activeCallId) return 'ignore-unknown-call';
  if (isNegotiating) return 'ignore-glare';
  return 'negotiate';
}

/** What `acceptIncomingCall` should do with the tap it just received. */
export type AcceptDecision =
  | { action: 'accept'; }
  | { action: 'skip'; reason: 'accept_in_flight' | 'already_accepted'; }
  | { action: 'dismiss'; reason: 'call_already_ended'; };

/**
 * Whether this Answer tap should be acted on.
 *
 * The same tap can reach the hook through several paths at once (CallKeep
 * event, replayed queue entry, in-app button), and a second accept for a call
 * that is already up fails server-side — where the old failure handling tore
 * down the call that had just connected. So each callId is accepted at most
 * once, and a tap for a call that has already stopped ringing is dismissed
 * rather than answered.
 */
export function decideAcceptIncomingCall({
  callId,
  status,
  acceptInFlightCallId,
  answeredCallIds,
}: {
  callId: string;
  status?: string | null;
  acceptInFlightCallId: string | null;
  answeredCallIds: readonly string[];
}): AcceptDecision {
  if (acceptInFlightCallId === callId) {
    return { action: 'skip', reason: 'accept_in_flight' };
  }
  if (answeredCallIds.includes(callId)) {
    return { action: 'skip', reason: 'already_accepted' };
  }
  if (status && status !== 'ringing') {
    return { action: 'dismiss', reason: 'call_already_ended' };
  }
  return { action: 'accept' };
}

/** How long a call was connected, or `null` if it never was. */
export function callDurationSeconds(
  connectedAtMs: number | null,
  nowMs: number,
): number | null {
  if (!connectedAtMs) return null;
  return Math.floor((nowMs - connectedAtMs) / 1000);
}

/**
 * The reason a call is recorded as having ended.
 *
 * A call whose media never came back ends as a plain `ended` like any hangup,
 * so the local knowledge that recovery was exhausted outranks the reason that
 * came back over the wire. This is deliberately the reason recorded in call
 * history too: the timeline should say "Connection lost" for the call the user
 * just watched die, not "Call ended".
 */
export function resolveCallEndReason({
  isConnectionLost,
  requestedReason,
  recordEndReason,
}: {
  isConnectionLost: boolean;
  requestedReason: string | null;
  recordEndReason?: string | null;
}): string | null {
  if (isConnectionLost) return 'media_failed';
  return requestedReason ?? recordEndReason ?? null;
}

/**
 * Whether a finished call is worth summarising: one that connected, and one
 * that failed. A call the user themself cancelled needs no summary — they
 * already know how it ended.
 */
export function shouldSummariseCall({
  hasConnected,
  endReason,
}: {
  hasConnected: boolean;
  endReason: string | null;
}): boolean {
  return hasConnected || SUMMARISED_END_REASONS.has(endReason ?? '');
}

/** The end-of-call card's contents, phrased as the timeline phrases them. */
export function buildCallEndSummary({
  durationSeconds,
  qualityLabel,
  endReason,
  isCaller,
  call,
}: {
  durationSeconds: number | null;
  qualityLabel?: string | null;
  endReason: string | null;
  isCaller: boolean;
  call?: CallEndRecord | null;
}): CallEndSummary {
  return {
    durationSeconds,
    quality: qualityLabel || 'No link',
    endReason,
    status: call?.status ?? null,
    direction: isCaller ? 'outgoing' : 'incoming',
    peerId: (isCaller ? call?.calleeId : call?.callerId) ?? null,
  };
}

/** Whether the history entry for this call should count as unread/missed. */
export function isMissedCall({
  endReason,
  status,
}: {
  endReason: string | null;
  status?: string | null;
}): boolean {
  return MISSED_END_REASONS.has(endReason ?? '') || status === 'missed';
}

/**
 * The severity vocabulary the status banner understands.
 *
 * Declared here rather than imported from the banner component so this module
 * stays free of anything React touches; `CallStatus['severity']` is the same
 * union and the hook passes these values straight through.
 */
export type CallStatusSeverity = 'info' | 'success' | 'warning' | 'error';

/** How a `call.state_changed` transition ends the call, if it ends it. */
export type CallEndingTransition = {
  message: string;
  severity: CallStatusSeverity;
  endReason: string;
};

/**
 * The callId this device currently considers its own.
 *
 * An accepted call, the outgoing one it is placing, and an incoming one still
 * ringing are the three places a callId can be, in that order of authority.
 */
export function resolveKnownCallId({
  activeCallId,
  activeCall,
  incomingCall,
}: {
  activeCallId?: string | null;
  activeCall?: { callId?: string | null; } | null;
  incomingCall?: { callId?: string | null; } | null;
}): string | null {
  return activeCallId ?? activeCall?.callId ?? incomingCall?.callId ?? null;
}

/**
 * Whether a transition belongs to some other call.
 *
 * A stale ring that ends while a call is up must not touch the call in
 * progress. An event for a call this device cannot identify — either side
 * unknown — is not evidence of that, so it is not suppressed here.
 */
export function isStateChangeForOtherCall({
  eventCallId,
  knownCallId,
}: {
  eventCallId: string | null;
  knownCallId: string | null;
}): boolean {
  return Boolean(eventCallId && knownCallId && eventCallId !== knownCallId);
}

/**
 * How a terminal `call.state_changed` status is reported to the user and
 * recorded in history, or `null` for a status that does not end the call.
 *
 * `ended` alone reads its `reason`: the caller hanging up before the callee
 * picked up is a cancellation, and saying "Call ended" for it describes a call
 * that never happened.
 */
export function describeCallStateEnding({
  status,
  reason,
}: {
  status: string;
  reason?: string | null;
}): CallEndingTransition | null {
  switch (status) {
    case 'declined':
      return { message: 'Call declined', severity: 'info', endReason: 'declined' };
    case 'missed':
      return { message: 'Call not answered', severity: 'error', endReason: 'missed' };
    case 'busy':
      return { message: 'Callee is busy', severity: 'error', endReason: 'busy' };
    case 'unreachable':
      return {
        message: 'Callee is unreachable',
        severity: 'error',
        endReason: 'unreachable',
      };
    case 'ended':
      return {
        message: reason === 'cancelled' ? 'Call cancelled' : 'Call ended',
        severity: 'info',
        endReason: reason ?? 'ended',
      };
    default:
      return null;
  }
}

/**
 * Whether a `busy` rejection should be answered with an empty call-state
 * report.
 *
 * `busy` means the server still believes one of the participants is in a call.
 * When this device holds no live call of its own, saying so lets the server
 * clear the phantom that is blocking every new call, instead of the user being
 * stuck forever. The call the rejection is *about* does not count as one this
 * device holds.
 */
export function shouldReportEmptyCallState({
  eventCallId,
  activeCallId,
  incomingCallId,
}: {
  eventCallId: string | null;
  activeCallId?: string | null;
  incomingCallId?: string | null;
}): boolean {
  return ![activeCallId, incomingCallId].some(
    callId => callId && callId !== eventCallId,
  );
}
