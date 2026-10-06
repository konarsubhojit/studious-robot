import { RTC_ACTIVE_CALL_STATES, CONNECTED_CALL_STATUS, TERMINAL_CALL_STATES } from '../config.ts';
import { normaliseId, sanitizeForLog } from '../lib/normalize.ts';
import { isCallOwnedByAnotherDevice, recordCallHeartbeat } from '../domain/calls.ts';
import { notifyCallTransition, emitVersionedCallEvent, emitVersionedRtcSignal, callWithParticipants } from '../domain/notifications.ts';
import { hydrateCallFromShared, participantActionWithShared, transitionCallWithShared } from '../domain/sharedCalls.ts';
import { userRoom } from '../lib/state.ts';
import { describeError } from '../lib/errors.ts';
import { verboseLog } from '../lib/verbose.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from './ack.ts';
import { bufferRtcSignal, countBufferedRtcSignals, flushBufferedRtcSignals, isBufferableSignal } from './rtcBuffer.ts';
import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS, groupNegotiationId } from '../../../shared/index.ts';
import { persistCallQualitySample } from '../callQuality.ts';

/**
 * Generic Socket.IO handlers for authenticated call-state transitions and RTC
 * relay events.  Both are parameterised by an `options` bag so the individual
 * `call.accept` / `rtc.offer` / … listeners stay declarative.
 */

/**
 * Where a transition should take the call, and why.
 *
 * Most events know this statically (`call.decline` always ends the call). The
 * ones that do not derive it from the request through `resolveTransition`.
 */
type CallTransition = {
  nextStatus: string;
  reason?: string | null;
  /**
   * ICE state the transition was derived from, when the event carries one.
   *
   * Returned on the transition rather than smuggled out through a mutable
   * binding in the enclosing scope: `onSuccess` already receives the
   * transition, so the value reaches it by the same path as the destination it
   * was derived from.
   */
  iceState?: string;
};

type SocketCallTransitionBase = {
  state: import('../stores/contracts.ts').ServerState;
  io: any;
  eventName: string;
  /**
   * Reject the request, or return `null` to allow it.
   *
   * A plain string is a `forbidden` rejection with that message. Guards whose
   * refusal the client must react to differently — "another of your devices
   * already answered" is not the same as "you are not the callee" — return an
   * explicit code instead.
   */
  authorize: (
    call: import('../stores/contracts.ts').CallRecord,
    userId: string,
    context: { deviceId: string | null }
  ) => string | { code: string; message: string } | null;
  onSuccess?: (
    call: import('../stores/contracts.ts').CallRecord,
    transition: CallTransition,
    context: { actorDeviceId: string | null; actorSocketId: string }
  ) => void;
};

/**
 * Exactly one of the two ways to say where a transition is going, expressed as
 * a union so the compiler rejects supplying both — or neither — rather than a
 * comment asking callers not to.
 */
type SocketCallTransitionOptions = SocketCallTransitionBase &
  (
    | {
        /** Destination for events whose transition never depends on the request. */
        nextStatus: string;
        reason?: string | null;
        resolveTransition?: never;
      }
    | {
        nextStatus?: never;
        reason?: never;
        /**
         * Destination derived from the request. Called with the
         * *schema-validated* payload, so a handler never has to read raw input
         * to decide where the call is going.
         */
        resolveTransition: (parsed: Record<string, any>) => CallTransition;
      }
  );

/**
 * Handle an authenticated call-state transition requested over the socket
 * (`call.accept`, `call.decline`, `call.cancel`, `call.end`).
 *
 * @param options
 */
async function handleSocketCallTransition(socket: import('socket.io').Socket, ack: Function | undefined, payload: object, options: SocketCallTransitionOptions) {
  if (!requireSocketSession(socket, ack, options.eventName)) {
    return;
  }
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) {
    return;
  }

  const parsed = parseInboundPayload(socket, ack, options.eventName, payload, options.state);
  if (!parsed) {
    return;
  }

  // The payload is schema-validated above, so `callId` is a non-empty id.
  const callId = (normaliseId(parsed.callId) as string);
  const call = await hydrateCallFromShared(options.state, callId);
  if (!call) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'call_not_found',
      'call not found',
      options.state
    );
    return;
  }

  const actorDeviceId = normaliseId(socket.data.identity?.deviceId) ?? null;
  const authorizationError = options.authorize(call, socket.data.identity.userId, {
    deviceId: actorDeviceId,
  });
  if (authorizationError) {
    const { code, message } =
      typeof authorizationError === 'string'
        ? { code: ERROR_CODES.FORBIDDEN, message: authorizationError }
        : authorizationError;
    acknowledgeError(socket, ack, options.eventName, code, message, options.state);
    console.log(
      `[signaling] ${sanitizeForLog(options.eventName)} rejected callId=${sanitizeForLog(callId)}` +
        ` actor=${sanitizeForLog(socket.data.identity.userId)}` +
        (actorDeviceId ? ` actorDevice=${sanitizeForLog(actorDeviceId)}` : '') +
        ` actorSocket=${sanitizeForLog(socket.id)}` +
        ` reason=${sanitizeForLog(message)}`
    );
    return;
  }

  const previousStatus = call.status;
  // Resolved from the validated payload, never from the raw request.
  const transition: CallTransition = options.resolveTransition
    ? options.resolveTransition(parsed)
    : { nextStatus: options.nextStatus, reason: options.reason ?? null };
  const result = await transitionCallWithShared(options.state, callId, transition.nextStatus, {
    actor: socket.data.identity.userId,
    reason: transition.reason ?? null,
    actorDeviceId,
  });
  if (!result.ok) {
    const errorCode = result.error === 'stale_call_state' ? 'stale_call_state' : 'invalid_state';
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      errorCode,
      result.message || result.error,
      options.state
    );
    return;
  }

  if (!result.stale && previousStatus !== result.call.status) {
    notifyCallTransition(options.io, options.state, result.call, {
      previousStatus,
      actor: socket.data.identity.userId,
      reason: transition.reason ?? null,
      actorDeviceId,
      actorSocketId: socket.id,
      source: 'socket',
    });
  }
  // Candidates that arrived during the ring are replayed here — the accept that
  // makes the call media-ready is exactly what they were waiting for — and
  // discarded when the transition was into a terminal state instead.
  flushBufferedRtcSignals(options.io, options.state, callId, result.call.status);
  options.onSuccess?.(result.call, transition, { actorDeviceId, actorSocketId: socket.id });
  acknowledgeSuccess(socket, ack, options.eventName, { call: callWithParticipants(result.call) });
}

/**
 * Handle an RTC relay event (`rtc.offer`, `rtc.answer`, `rtc.candidate`),
 * forwarding the SDP/candidate to the peer after authorization and rate-limit
 * checks, and promoting the call from `accepted` to `connecting_media` on the
 * first relayed frame.
 *
 * @param options
 */
/**
 * Deal with an RTC frame for a call that is not media-ready: hold it for replay
 * if it is the kind that legitimately races the accept, and otherwise report it
 * as stale, exactly as before.
 */
function holdOrRejectRtcSignal(socket: import('socket.io').Socket, ack: Function | undefined, options: {
        state: import('../stores/contracts.ts').ServerState;
        eventName: string;
        dataKey: string;
        call: import('../stores/contracts.ts').CallRecord;
        callId: string;
        userId: string;
        value: unknown;
    }): void {
  const { call, callId, userId, value } = options;
  const buffered =
    isBufferableSignal(options.eventName, call.status) &&
    bufferRtcSignal(options.state, callId, {
      eventName: options.eventName,
      dataKey: options.dataKey,
      fromUserId: userId,
      toUserId: call.participants?.find(({ userId: id, state }) => id !== userId &&
        (state === 'joined' || state === 'ringing' || state === 'invited'))?.userId ??
        (call.callerId === userId ? call.calleeId : call.callerId),
      value,
    });
  if (buffered) {
    acknowledgeSuccess(socket, ack, options.eventName, {
      callId,
      buffered: true,
      bufferedCount: countBufferedRtcSignals(options.state, callId),
    });
    return;
  }
  acknowledgeError(
    socket,
    ack,
    options.eventName,
    'stale_call_state',
    `call is not ready for RTC in state: ${call.status}`,
    options.state
  );
}

/**
 * Move an accepted call to `connecting_media` on its first RTC frame, and
 * release anything buffered while it was still ringing.
 *
 * @param eventName - Which frame moved it. An offer and a stray trickled
 *   candidate promote the call identically, so without this the transition
 *   log cannot say whether the caller's SDP ever arrived — precisely the
 *   question a call stuck in `connecting_media` raises.
 */
async function promoteToConnectingMedia(
  state: import('../stores/contracts.ts').ServerState,
  io: any,
  callId: string,
  userId: string,
  eventName: string
): Promise<void> {
  const previousStatus = 'accepted';
  const result = await transitionCallWithShared(state, callId, 'connecting_media', { actor: userId });
  if (!result.ok) return;
  if (!result.stale && previousStatus !== result.call.status) {
    notifyCallTransition(io, state, result.call, { previousStatus, actor: userId });
    console.log(
      `[calls] call.connecting_media callId=${callId} trigger=${eventName}` +
        ` actor=${sanitizeForLog(userId)}`
    );
  }
  flushBufferedRtcSignals(io, state, callId, result.call.status);
}

function resolveCallPeerId(
  call: import('../stores/contracts.ts').CallRecord,
  userId: string,
  requestedPeerId?: string
): string | null {
  const allMembers = call.participants
    ? call.participants.map(({ userId: participantId }) => participantId)
    : [call.callerId, call.calleeId];
  const activeMembers = call.participants
    ? call.participants.filter(isRtcEligibleParticipant).map(({ userId: participantId }) => participantId)
    : allMembers;
  const isTerminal = TERMINAL_CALL_STATES.has(call.status);
  const peerId = requestedPeerId ?? (isTerminal ? allMembers : activeMembers).find((id) => id !== userId);
  return isRtcPeerAllowed(allMembers, activeMembers, userId, peerId, isTerminal) ? peerId : null;
}

function isRtcEligibleParticipant(participant: NonNullable<import('../stores/contracts.ts').CallRecord['participants']>[number]): boolean {
  return participant.state === 'joined' || participant.state === 'ringing' || participant.state === 'invited';
}

function isRtcPeerAllowed(
  allMembers: string[],
  activeMembers: string[],
  userId: string,
  peerId: string | undefined,
  isTerminal: boolean
): peerId is string {
  if (!allMembers.includes(userId) || !peerId || peerId === userId || !allMembers.includes(peerId)) return false;
  return isTerminal || activeMembers.includes(peerId);
}

function rejectActionFromNonOwnerDevice(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  options: {
    state: import('../stores/contracts.ts').ServerState;
    eventName: string;
    action: 'join' | 'leave' | 'decline';
  },
  call: import('../stores/contracts.ts').CallRecord,
  callId: string,
  userId: string,
  deviceId: string | null
): boolean {
  if (options.action === 'decline' || !isCallOwnedByAnotherDevice(call, userId, deviceId)) return false;
  const message = 'this call is active on another device';
  console.log(
    `[signaling] ${options.eventName} rejected callId=${sanitizeForLog(callId)}` +
      ` actor=${sanitizeForLog(userId)}` +
      (deviceId ? ` actorDevice=${sanitizeForLog(deviceId)}` : '') +
      ` reason=${sanitizeForLog(message)}`
  );
  acknowledgeError(socket, ack, options.eventName, ERROR_CODES.ANSWERED_ELSEWHERE, message, options.state);
  return true;
}

async function handleSocketParticipantAction(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  payload: object,
  options: {
    state: import('../stores/contracts.ts').ServerState;
    io: any;
    eventName: string;
    action: 'join' | 'leave' | 'decline';
  }
): Promise<void> {
  if (!requireSocketSession(socket, ack, options.eventName)) return;
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) return;
  const parsed = parseInboundPayload(socket, ack, options.eventName, payload, options.state);
  if (!parsed) return;

  const callId = normaliseId(parsed.callId) as string;
  const userId = socket.data.identity.userId;
  const deviceId = normaliseId(socket.data.identity.deviceId) ?? null;
  const call = await hydrateCallFromShared(options.state, callId);
  if (!call) {
    acknowledgeError(socket, ack, options.eventName, 'call_not_found', 'call not found', options.state);
    return;
  }
  if (rejectActionFromNonOwnerDevice(socket, ack, options, call, callId, userId, deviceId)) return;
  const previousStatus = call.status;
  const result = await participantActionWithShared(options.state, callId, userId, options.action, deviceId);
  if (!result.ok) {
    const code = result.status === 403 ? ERROR_CODES.FORBIDDEN : 'invalid_state';
    acknowledgeError(socket, ack, options.eventName, code, result.message ?? result.error, options.state);
    return;
  }
  if (!result.stale) {
    const reason = options.action === 'decline' ? 'declined' : options.action === 'leave' ? 'user_hangup' : null;
    notifyCallTransition(options.io, options.state, result.call, {
      previousStatus,
      actor: userId,
      reason,
      actorDeviceId: deviceId,
      actorSocketId: socket.id,
      source: 'socket',
    });
    flushBufferedRtcSignals(options.io, options.state, callId, result.call.status);
  }
  acknowledgeSuccess(socket, ack, options.eventName, { call: callWithParticipants(result.call) });
}

function rtcRelayEventNames(eventName: string): {
  currentEventName: string;
  legacyEventName: string;
} {
  const isIceSignal = eventName === CLIENT_EVENTS.RTC_CANDIDATE || eventName === CLIENT_EVENTS.RTC_ICE;
  return {
    currentEventName: isIceSignal ? SERVER_EVENTS.RTC_ICE : eventName,
    legacyEventName: isIceSignal ? SERVER_EVENTS.RTC_CANDIDATE : eventName,
  };
}

function needsVersionedRtcRelay(eventName: string): boolean {
  return eventName === CLIENT_EVENTS.RTC_OFFER ||
    eventName === CLIENT_EVENTS.RTC_ANSWER ||
    eventName === CLIENT_EVENTS.RTC_CANDIDATE ||
    eventName === CLIENT_EVENTS.RTC_ICE;
}

/**
 * Events whose delivery is worth an adapter round trip to confirm.
 *
 * Counting recipients means asking the Socket.IO adapter who is in a room,
 * which on a fleet is a Redis request. The SDP frames are one or two per call,
 * so the cost is negligible and the answer is the one that matters: an offer
 * relayed to nobody is a call that will sit in `connecting_media` until the
 * media timeout. Candidates are trickled by the dozen and are deliberately
 * left uncounted — they are still counted as *relays*, just without recipient
 * cardinality.
 */
const RECIPIENT_COUNTED_EVENTS = new Set<string>([
  CLIENT_EVENTS.RTC_OFFER,
  CLIENT_EVENTS.RTC_ANSWER,
]);

/**
 * How long the relay path will wait for the adapter's recipient count before
 * giving up on it.
 *
 * `fetchSockets()` is a Redis round trip on a multi-instance fleet. It is
 * useful when it is fast and worthless when it is not: an SDP frame that sat
 * behind a multi-second adapter timeout is worse than one relayed without a
 * recipient count. 200ms is generous for a healthy adapter and cheap for a
 * degraded one.
 */
const RECIPIENT_LOOKUP_TIMEOUT_MS = 200;

/** Repeat the recipient-lookup-failed log line at most this often. */
const RECIPIENT_LOOKUP_LOG_INTERVAL_MS = 60_000;

/** Process-wide, so the rate limit applies across every relayed call. */
let lastRecipientLookupFailureLoggedAt = 0;

/** Exposed for tests: forget the last time the failure log fired. */
function resetRecipientLookupRateLimit(): void {
  lastRecipientLookupFailureLoggedAt = 0;
}

/**
 * Resolve/reject with `promise`, or reject on our own after `timeoutMs` —
 * whichever comes first.
 *
 * `promise` is not abandoned when the timeout wins: its settlement is still
 * consumed here (silently), so a late resolution or rejection never becomes
 * an unhandled promise rejection.
 */
function raceAgainstTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * How many sockets the user's room holds, across every instance.
 *
 * @returns the count, or `null` when it was not taken (high-rate event), took
 *   too long (`RECIPIENT_LOOKUP_TIMEOUT_MS`), or could not be taken (the
 *   adapter failed). `null` is deliberately distinct from `0`: "nobody was
 *   there" is a finding, "we did not look" is not.
 */
async function countRoomRecipients(io: any, userId: string, eventName: string): Promise<number | null> {
  if (!RECIPIENT_COUNTED_EVENTS.has(eventName)) return null;
  try {
    const sockets = await raceAgainstTimeout(
      io.in(userRoom(userId)).fetchSockets(),
      RECIPIENT_LOOKUP_TIMEOUT_MS
    );
    return Array.isArray(sockets) ? sockets.length : null;
  } catch (error: unknown) {
    // Never gate the relay on the diagnostic: a frame that cannot be counted
    // (or counted quickly enough) must still be forwarded. The adapter being
    // slow or unhealthy is worth knowing about, but not once per relay.
    const now = Date.now();
    if (now - lastRecipientLookupFailureLoggedAt >= RECIPIENT_LOOKUP_LOG_INTERVAL_MS) {
      lastRecipientLookupFailureLoggedAt = now;
      console.error(`[signaling] rtc.relay recipient lookup failed: ${describeError(error)}`);
    }
    return null;
  }
}

/**
 * Record and log one relay.
 *
 * The SDP frames are logged at normal level rather than behind
 * `VERBOSE_LOGGING`, because the absence of this line is the only evidence
 * that an offer or answer never reached the server — and verbose logging is
 * never on when the incident happens. Candidates are trickled by the dozen, so
 * they are counted at normal level but logged only when verbose logging is on:
 * a per-candidate line would bury the two lines that matter.
 */
function logRtcRelay(state: import('../stores/contracts.ts').ServerState, options: {
        eventName: string;
        callId: string;
        fromUserId: string;
        toUserId: string;
        recipients: number | null;
        isHeartbeat: boolean;
    }): void {
  state.telemetry?.recordRtcRelay(options.eventName, options.recipients, options.isHeartbeat);
  const line =
    `[signaling] rtc.relay event=${options.eventName} callId=${options.callId}` +
    ` from=${sanitizeForLog(options.fromUserId)} to=${sanitizeForLog(options.toUserId)}` +
    ` instance=${sanitizeForLog(state.instanceId ?? 'unknown')}` +
    ` recipients=${options.recipients ?? 'unmeasured'}`;
  if (RECIPIENT_COUNTED_EVENTS.has(options.eventName)) {
    console.log(line);
    return;
  }
  verboseLog('signaling', 'rtc.relay', {
    event: options.eventName,
    callId: options.callId,
    fromUserId: options.fromUserId,
    toUserId: options.toUserId,
  });
}

async function relayRtcSignalToPeer(options: {
  state: import('../stores/contracts.ts').ServerState;
  io: any;
  eventName: string;
  callId: string;
  userId: string;
  peerUserId: string;
  dataKey: string;
  value: unknown;
  negotiationId?: string;
  isHeartbeat?: boolean;
}): Promise<void> {
  const { currentEventName, legacyEventName } = rtcRelayEventNames(options.eventName);
  const relayPayload = {
    callId: options.callId,
    peerId: options.userId,
    fromUserId: options.userId,
    ...(options.negotiationId ? { negotiationId: options.negotiationId } : {}),
    [options.dataKey]: options.value,
  };
  // SDP frames are counted to confirm the target room has recipients.
  const recipients = await countRoomRecipients(options.io, options.peerUserId, options.eventName);
  if (needsVersionedRtcRelay(options.eventName)) {
    emitVersionedRtcSignal(options.io, options.peerUserId, currentEventName, legacyEventName, relayPayload);
  } else {
    emitVersionedCallEvent(options.io, options.peerUserId, options.eventName, relayPayload);
  }
  logRtcRelay(options.state, {
    eventName: options.eventName,
    callId: options.callId,
    fromUserId: options.userId,
    toUserId: options.peerUserId,
    recipients,
    isHeartbeat: options.isHeartbeat ?? false,
  });
}

type RtcRelayOptions = {
  state: import('../stores/contracts.ts').ServerState;
  io: any;
  eventName: string;
  dataKey: string;
  recordsHeartbeat?: boolean;
};

async function relayGroupCallSignal(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  options: RtcRelayOptions,
  callId: string,
  userId: string,
  parsed: Record<string, any>,
  value: unknown,
): Promise<boolean> {
  const groupCall = await options.state.conversationStore.getCall(callId);
  if (!groupCall) return false;
  const peerUserId = normaliseId(parsed.peerId);
  const sender = groupCall.participants.find(person => person.userId === userId);
  const recipient = groupCall.participants.find(person => person.userId === peerUserId);
  const senderMembership = await options.state.conversationStore.getMember(groupCall.call.conversationId, userId);
  const recipientMembership = peerUserId
    ? await options.state.conversationStore.getMember(groupCall.call.conversationId, peerUserId)
    : null;
  if (
    !peerUserId ||
    peerUserId === userId ||
    groupCall.call.status !== 'active' ||
    sender?.status !== 'accepted' ||
    recipient?.status !== 'accepted' ||
    !senderMembership ||
    !recipientMembership
  ) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      ERROR_CODES.FORBIDDEN,
      'sender and peer must be active call participants',
      options.state,
    );
    return true;
  }
  const negotiationId = groupNegotiationId(groupCall.participants, userId, peerUserId);
  if (parsed.negotiationId !== negotiationId) {
    acknowledgeError(socket, ack, options.eventName, ERROR_CODES.FORBIDDEN,
      'stale group negotiation; refresh call membership', options.state);
    return true;
  }
  await relayRtcSignalToPeer({
    state: options.state,
    io: options.io,
    eventName: options.eventName,
    callId,
    userId,
    peerUserId,
    dataKey: options.dataKey,
    value,
    negotiationId,
  });
  acknowledgeSuccess(socket, ack, options.eventName, { callId });
  return true;
}

async function handleRtcRelay(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  payload: object,
  options: RtcRelayOptions,
) {
  if (!requireSocketSession(socket, ack, options.eventName)) {
    return;
  }
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) {
    return;
  }

  // Rate limit: cap RTC signaling events per user per window.
  const userId = socket.data.identity.userId;
  const rtcCheck = await options.state.rtcRateLimiter.check(userId);
  if (!rtcCheck.allowed) {
    options.state.auditLog.record({
      event: 'rtc.rate_limited',
      actor: userId,
      outcome: 'rejected',
      details: { event: options.eventName },
    });
    console.log(`[security] rtc.rate_limited userId=${userId} event=${options.eventName}`);
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      ERROR_CODES.RATE_LIMITED,
      'too many signaling events',
      options.state
    );
    return;
  }

  const parsed = parseInboundPayload(socket, ack, options.eventName, payload, options.state);
  if (!parsed) {
    return;
  }

  // The payload is schema-validated above, so `callId` is a non-empty id.
  const callId = (normaliseId(parsed.callId) as string);
  const value = parsed[options.dataKey];

  const call = await hydrateCallFromShared(options.state, callId);
  if (!call) {
    if (await relayGroupCallSignal(socket, ack, options, callId, userId, parsed, value)) return;
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'call_not_found',
      'call not found',
      options.state
    );
    return;
  }

  const peerUserId = resolveCallPeerId(call, userId, parsed.peerId);
  if (!peerUserId) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      ERROR_CODES.FORBIDDEN,
      'sender or peer is not a participant in this call',
      options.state
    );
    return;
  }
  // Only now, with a rejection on the table, is a shared-store read worth its
  // latency: the local record may simply be behind a peer instance that has
  // already accepted the call. Frames for a call that really is media-ready
  // never pay for this.
  const current = RTC_ACTIVE_CALL_STATES.has(call.status)
    ? call
    : (await hydrateCallFromShared(options.state, callId, { maxAgeMs: 0 })) ?? call;

  if (!RTC_ACTIVE_CALL_STATES.has(current.status)) {
    holdOrRejectRtcSignal(socket, ack, { ...options, call: current, callId, userId, value });
    return;
  }

  if (current.status === 'accepted') {
    await promoteToConnectingMedia(options.state, options.io, callId, userId, options.eventName);
  }

  // A connected client relays its liveness over this channel every 30s, which
  // is what lets the sweep tell a long healthy call from an abandoned one.
  // The opt-in flag matters: older clients emit this event when screen sharing
  // is toggled but never send beats, and stamping those would arm the
  // heartbeat deadline on a call that will never satisfy it.
  //
  // Computed once and reused by `logRtcRelay` below, so the telemetry split
  // between `rtc_relays_media_heartbeat` and `rtc_relays_media_state_change`
  // uses the exact same predicate as the heartbeat-recording decision itself.
  const isHeartbeatFrame = options.recordsHeartbeat === true && value?.heartbeat === true;
  if (isHeartbeatFrame) {
    // `recordCallHeartbeat` already mirrors the stamped record to the shared
    // store fire-and-forget. Awaiting a second, identical save here put a
    // shared-store round trip in front of every heartbeat ack — for a liveness
    // signal that is explicitly best-effort and has no ordering requirement.
    recordCallHeartbeat(options.state, callId);
  }

  await relayRtcSignalToPeer({
    state: options.state,
    io: options.io,
    eventName: options.eventName,
    callId,
    userId,
    peerUserId,
    dataKey: options.dataKey,
    value,
    isHeartbeat: isHeartbeatFrame,
  });
  acknowledgeSuccess(socket, ack, options.eventName, { callId });
}

/**
 * Handle a `call.connected` report from a participant.
 *
 * The client emits this once its `RTCPeerConnection` reaches the
 * `connected`/`completed` ICE state, which is the only signal the server has
 * that media actually established: without it a call never leaves
 * `connecting_media` and the stale-call sweep force-ends it with
 * `media_connect_timeout` while the conversation is still going.
 *
 * The first peer to report wins; the second is absorbed by `transitionCall`'s
 * idempotency.  A report of `disconnected`/`failed` ends the call immediately
 * instead of leaving it to a sweep.
 */
async function handleCallConnected(socket: import('socket.io').Socket, ack: Function | undefined, payload: object, options: { state: import('../stores/contracts.ts').ServerState; io: any; }) {
  await handleSocketCallTransition(socket, ack, payload, {
    state: options.state,
    io: options.io,
    eventName: CLIENT_EVENTS.CALL_CONNECTED,
    // `iceState` is read out of the validated payload rather than the raw
    // request, so the destination status can never be chosen from input the
    // schema has not accepted yet.
    resolveTransition: (parsed) => {
      const iceState = typeof parsed.iceState === 'string' ? parsed.iceState : 'connected';
      return iceState === 'disconnected' || iceState === 'failed'
        ? { nextStatus: 'ended', reason: 'media_failed', iceState }
        : { nextStatus: CONNECTED_CALL_STATUS, reason: null, iceState };
    },
    authorize: (call, userId) => {
      if (!(call.participants?.some((participant) => participant.userId === userId && participant.state === 'joined') ??
        (call.callerId === userId || call.calleeId === userId))) {
        return 'not a participant in this call';
      }
      return isCallOwnedByAnotherDevice(call, userId, socket.data.identity.deviceId ?? null)
        ? 'this call is active on another device'
        : null;
    },
    onSuccess: (call, transition, context) => {
      if (transition.reason !== 'media_failed') {
        recordCallHeartbeat(options.state, call.callId);
      }
      console.log(
        `[calls] call.connected callId=${sanitizeForLog(call.callId)}` +
          ` iceState=${sanitizeForLog(transition.iceState ?? 'connected')}` +
          ` status=${sanitizeForLog(call.status)}` +
          ` actor=${sanitizeForLog(socket.data.identity.userId)}` +
          (context.actorDeviceId ? ` actorDevice=${sanitizeForLog(context.actorDeviceId)}` : '') +
          ` actorSocket=${sanitizeForLog(context.actorSocketId)}`
      );
    },
  });
}

async function handleCallStats(
  socket: import('socket.io').Socket,
  ack: Function | undefined,
  payload: object,
  state: import('../stores/contracts.ts').ServerState
) {
  const eventName = CLIENT_EVENTS.CALL_STATS;
  if (!requireSocketSession(socket, ack, eventName)) return;
  if (!validateSignalingVersion(socket, payload, ack, eventName)) return;

  const userId = socket.data.identity.userId;
  if (!(await state.callStatsRateLimiter.check(userId)).allowed) {
    state.auditLog.record({
      event: 'call.stats.rate_limited',
      actor: userId,
      outcome: 'rejected',
    });
    acknowledgeError(socket, ack, eventName, ERROR_CODES.RATE_LIMITED, 'too many call statistics reports', state);
    return;
  }

  const parsed = parseInboundPayload(socket, ack, eventName, payload, state);
  if (!parsed) return;

  const call = await hydrateCallFromShared(state, parsed.callId);
  if (!call) {
    acknowledgeError(socket, ack, eventName, 'call_not_found', 'call not found', state);
    return;
  }
  if (!(call.participants?.some((participant) => participant.userId === userId && participant.state === 'joined') ??
    (call.callerId === userId || call.calleeId === userId))) {
    acknowledgeError(socket, ack, eventName, ERROR_CODES.FORBIDDEN, 'not a participant in this call', state);
    return;
  }
  if (!RTC_ACTIVE_CALL_STATES.has(call.status)) {
    acknowledgeError(socket, ack, eventName, ERROR_CODES.FORBIDDEN, 'call is not active', state);
    return;
  }

  try {
    await persistCallQualitySample(state.db, {
      callId: call.callId,
      rttMs: parsed.rttMs,
      jitterMs: parsed.jitterMs,
      packetLossPercent: parsed.packetLossPercent,
      bitrateBps: parsed.bitrateBps,
      codec: parsed.codec,
    });
  } catch (error) {
    console.error(`[signaling] call.stats persistence failed: ${describeError(error)}`);
    acknowledgeError(socket, ack, eventName, ERROR_CODES.INTERNAL_ERROR, 'could not record call statistics', state);
    return;
  }

  state.telemetry.recordCallStats();
  acknowledgeSuccess(socket, ack, eventName, { callId: call.callId });
}

export {
  handleSocketCallTransition,
  handleSocketParticipantAction,
  handleRtcRelay,
  handleCallConnected,
  handleCallStats,
  countRoomRecipients,
  resetRecipientLookupRateLimit,
  RECIPIENT_LOOKUP_TIMEOUT_MS,
};
