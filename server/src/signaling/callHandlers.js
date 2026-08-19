'use strict';

const { RTC_ACTIVE_CALL_STATES, SIGNALING_VERSION, CONNECTED_CALL_STATUS } = require('../config');
const { normaliseId } = require('../lib/normalize');
const { transitionCall, recordCallHeartbeat } = require('../domain/calls');
const { notifyCallTransition, emitToUserSockets } = require('../domain/notifications');
const {
  requireSocketSession,
  validateSignalingVersion,
  parseInboundPayload,
  acknowledgeSuccess,
  acknowledgeError,
} = require('./ack');
const { CLIENT_EVENTS, ERROR_CODES } = require('../../../shared');

/**
 * Generic Socket.IO handlers for authenticated call-state transitions and RTC
 * relay events.  Both are parameterised by an `options` bag so the individual
 * `call.accept` / `rtc.offer` / … listeners stay declarative.
 */

/**
 * Handle an authenticated call-state transition requested over the socket
 * (`call.accept`, `call.decline`, `call.cancel`, `call.end`).
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {object} payload
 * @param {object} options
 */
function handleSocketCallTransition(socket, ack, payload, options) {
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

  const callId = normaliseId(parsed.callId);
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
  const result = transitionCall(options.state, callId, options.nextStatus, {
    actor: socket.data.identity.userId,
    reason: options.reason ?? null,
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
      reason: options.reason ?? null,
    });
  }
  options.onSuccess?.(result.call);
  acknowledgeSuccess(socket, ack, options.eventName, { call: result.call });
}

/**
 * Handle an RTC relay event (`rtc.offer`, `rtc.answer`, `rtc.candidate`),
 * forwarding the SDP/candidate to the peer after authorization and rate-limit
 * checks, and promoting the call from `accepted` to `connecting_media` on the
 * first relayed frame.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {object} payload
 * @param {object} options
 */
function handleRtcRelay(socket, ack, payload, options) {
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

  const callId = normaliseId(parsed.callId);
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
  if (options.recordsHeartbeat) {
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
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {object} payload
 * @param {{ state: object, io: object }} options
 */
function handleCallConnected(socket, ack, payload, options) {
  const iceState = typeof payload?.iceState === 'string' ? payload.iceState : 'connected';
  const isFailure = iceState === 'disconnected' || iceState === 'failed';

  handleSocketCallTransition(socket, ack, payload, {
    state: options.state,
    io: options.io,
    eventName: CLIENT_EVENTS.CALL_CONNECTED,
    nextStatus: isFailure ? 'ended' : CONNECTED_CALL_STATUS,
    reason: isFailure ? 'media_failed' : null,
    authorize: (call, userId) =>
      call.callerId === userId || call.calleeId === userId
        ? null
        : 'not a participant in this call',
    onSuccess: (call) => {
      if (!isFailure) {
        recordCallHeartbeat(options.state, call.callId);
      }
      console.log(
        `[calls] call.connected callId=${call.callId} iceState=${iceState}` +
          ` status=${call.status} actor=${socket.data.identity.userId}`
      );
    },
  });
}

module.exports = {
  handleSocketCallTransition,
  handleRtcRelay,
  handleCallConnected,
};
