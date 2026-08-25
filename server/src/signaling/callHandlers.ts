import { RTC_ACTIVE_CALL_STATES, SIGNALING_VERSION, CONNECTED_CALL_STATUS } from '../config.ts';
import { normaliseId } from '../lib/normalize.ts';
import { transitionCall, recordCallHeartbeat } from '../domain/calls.ts';
import { notifyCallTransition, emitToUserSockets } from '../domain/notifications.ts';
import { requireSocketSession, validateSignalingVersion, parseInboundPayload, acknowledgeSuccess, acknowledgeError } from './ack.ts';
import { CLIENT_EVENTS, ERROR_CODES } from '../../../shared/index.ts';

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
};

type SocketCallTransitionOptions = {
  state: import('../stores/contracts.ts').ServerState;
  io: any;
  eventName: string;
  /**
   * Destination for events whose transition never depends on the request.
   * Exactly one of this and `resolveTransition` must be supplied.
   */
  nextStatus?: string;
  reason?: string | null;
  /**
   * Destination derived from the request. Called with the *schema-validated*
   * payload, so a handler never has to read raw input to decide where the
   * call is going.
   */
  resolveTransition?: (parsed: Record<string, any>) => CallTransition;
  authorize: (
    call: import('../stores/contracts.ts').CallRecord,
    userId: string
  ) => string | null;
  onSuccess?: (
    call: import('../stores/contracts.ts').CallRecord,
    transition: CallTransition
  ) => void;
};

/**
 * Handle an authenticated call-state transition requested over the socket
 * (`call.accept`, `call.decline`, `call.cancel`, `call.end`).
 *
 * @param options
 */
function handleSocketCallTransition(socket: import('socket.io').Socket, ack: Function | undefined, payload: object, options: SocketCallTransitionOptions) {
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
  const call = options.state.calls.get(callId);
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

  const authorizationError = options.authorize(call, socket.data.identity.userId);
  if (authorizationError) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      ERROR_CODES.FORBIDDEN,
      authorizationError,
      options.state
    );
    return;
  }

  const previousStatus = call.status;
  // Resolved from the validated payload, never from the raw request.
  const transition: CallTransition = options.resolveTransition
    ? options.resolveTransition(parsed)
    : { nextStatus: (options.nextStatus as string), reason: options.reason ?? null };
  const result = transitionCall(options.state, callId, transition.nextStatus, {
    actor: socket.data.identity.userId,
    reason: transition.reason ?? null,
  });
  if (!result.ok) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'invalid_state',
      result.message || result.error,
      options.state
    );
    return;
  }

  if (previousStatus !== result.call.status) {
    notifyCallTransition(options.io, options.state, result.call, {
      previousStatus,
      actor: socket.data.identity.userId,
      reason: transition.reason ?? null,
    });
  }
  options.onSuccess?.(result.call, transition);
  acknowledgeSuccess(socket, ack, options.eventName, { call: result.call });
}

/**
 * Handle an RTC relay event (`rtc.offer`, `rtc.answer`, `rtc.candidate`),
 * forwarding the SDP/candidate to the peer after authorization and rate-limit
 * checks, and promoting the call from `accepted` to `connecting_media` on the
 * first relayed frame.
 *
 * @param options
 */
function handleRtcRelay(socket: import('socket.io').Socket, ack: Function | undefined, payload: object, options: {
        state: import('../stores/contracts.ts').ServerState;
        io: any;
        eventName: string;
        dataKey: string;
        recordsHeartbeat?: boolean;
    }) {
  if (!requireSocketSession(socket, ack, options.eventName)) {
    return;
  }
  if (!validateSignalingVersion(socket, payload, ack, options.eventName)) {
    return;
  }

  // Rate limit: cap RTC signaling events per user per window.
  const userId = socket.data.identity.userId;
  const rtcCheck = options.state.rtcRateLimiter.check(userId);
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

  const call = options.state.calls.get(callId);
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

  if (call.callerId !== userId && call.calleeId !== userId) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      ERROR_CODES.FORBIDDEN,
      'not a participant in this call',
      options.state
    );
    return;
  }
  if (!RTC_ACTIVE_CALL_STATES.has(call.status)) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'stale_call_state',
      `call is not ready for RTC in state: ${call.status}`,
      options.state
    );
    return;
  }

  if (call.status === 'accepted') {
    const previousStatus = call.status;
    const result = transitionCall(options.state, callId, 'connecting_media', {
      actor: userId,
    });
    if (result.ok && previousStatus !== result.call.status) {
      notifyCallTransition(options.io, options.state, result.call, {
        previousStatus,
        actor: userId,
      });
    }
  }

  // A connected client relays its liveness over this channel every 30s, which
  // is what lets the sweep tell a long healthy call from an abandoned one.
  // The opt-in flag matters: older clients emit this event when screen sharing
  // is toggled but never send beats, and stamping those would arm the
  // heartbeat deadline on a call that will never satisfy it.
  if (options.recordsHeartbeat && value?.heartbeat === true) {
    recordCallHeartbeat(options.state, callId);
  }

  const peerUserId = call.callerId === userId ? call.calleeId : call.callerId;
  const relayPayload = {
    version: SIGNALING_VERSION,
    callId,
    fromUserId: userId,
    [options.dataKey]: value,
  };
  emitToUserSockets(options.io, peerUserId, options.eventName, relayPayload);
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
function handleCallConnected(socket: import('socket.io').Socket, ack: Function | undefined, payload: object, options: { state: import('../stores/contracts.ts').ServerState; io: any; }) {
  // `iceState` is read out of the validated payload rather than the raw
  // request, so the destination status can never be chosen from input the
  // schema has not accepted yet.
  let iceState = 'connected';

  handleSocketCallTransition(socket, ack, payload, {
    state: options.state,
    io: options.io,
    eventName: CLIENT_EVENTS.CALL_CONNECTED,
    resolveTransition: (parsed) => {
      iceState = typeof parsed.iceState === 'string' ? parsed.iceState : 'connected';
      return iceState === 'disconnected' || iceState === 'failed'
        ? { nextStatus: 'ended', reason: 'media_failed' }
        : { nextStatus: CONNECTED_CALL_STATUS, reason: null };
    },
    authorize: (call, userId) =>
      call.callerId === userId || call.calleeId === userId
        ? null
        : 'not a participant in this call',
    onSuccess: (call, transition) => {
      if (transition.reason !== 'media_failed') {
        recordCallHeartbeat(options.state, call.callId);
      }
      console.log(
        `[calls] call.connected callId=${call.callId} iceState=${iceState}` +
          ` status=${call.status} actor=${socket.data.identity.userId}`
      );
    },
  });
}

export {
  handleSocketCallTransition,
  handleRtcRelay,
  handleCallConnected,
};
