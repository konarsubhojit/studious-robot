'use strict';

const { RTC_ACTIVE_CALL_STATES, SIGNALING_VERSION } = require('../config');
const { normaliseId } = require('../lib/normalize');
const { transitionCall } = require('../domain/calls');
const { notifyCallTransition, emitToUserSockets } = require('../domain/notifications');
const {
  requireSocketSession,
  validateSignalingVersion,
  acknowledgeSuccess,
  acknowledgeError,
} = require('./ack');

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

  const callId = normaliseId(payload.callId);
  if (!callId) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'bad_request',
      'callId is required',
      options.state
    );
    return;
  }

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
      'forbidden',
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
      'rate_limited',
      'too many signaling events',
      options.state
    );
    return;
  }

  const callId = normaliseId(payload.callId);
  if (!callId) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'bad_request',
      'callId is required',
      options.state
    );
    return;
  }

  const value = payload[options.dataKey];
  if (!options.validateData(value)) {
    acknowledgeError(
      socket,
      ack,
      options.eventName,
      'bad_request',
      `${options.dataKey} is required`,
      options.state
    );
    return;
  }

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
      'forbidden',
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

module.exports = {
  handleSocketCallTransition,
  handleRtcRelay,
};
