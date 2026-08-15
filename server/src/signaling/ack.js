'use strict';

const { SIGNALING_VERSION } = require('../config');

/**
 * Socket.IO acknowledgement envelope helpers and pre-handler guards.
 *
 * Every version-1 `call.*` / `rtc.*` event replies with a `{ ok, version, … }`
 * envelope (via the ack callback when provided, or a `signaling.error` emit as
 * a fallback).  Centralising the envelope shape here keeps every handler
 * consistent.
 */

function requireSocketSession(socket, ack, eventName) {
  if (socket.data.identity?.sessionId) {
    return true;
  }

  acknowledgeError(socket, ack, eventName, 'unauthorized', 'a valid session is required');
  return false;
}

function validateSignalingVersion(socket, payload, ack, eventName) {
  if (payload?.version === SIGNALING_VERSION) {
    return true;
  }

  acknowledgeError(
    socket,
    ack,
    eventName,
    'unsupported_version',
    `version ${SIGNALING_VERSION} is required`
  );
  return false;
}

function acknowledgeSuccess(socket, ack, eventName, data) {
  const payload = {
    ok: true,
    version: SIGNALING_VERSION,
    event: eventName,
    ...data,
  };

  if (typeof ack === 'function') {
    ack(payload);
  }
}

/**
 * Send an error acknowledgement and record a signaling error in telemetry.
 *
 * `state` is intentionally optional: early guards like `requireSocketSession`
 * and `validateSignalingVersion` call this helper before they have access to a
 * call-scoped state object.  All call/RTC handlers that do have state pass it
 * so the error is counted in the telemetry metrics.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {string} eventName
 * @param {string} code
 * @param {string} message
 * @param {object} [state]  - Optional server state (provides telemetry recorder).
 */
function acknowledgeError(socket, ack, eventName, code, message, state) {
  if (state) {
    state.telemetry.recordSignalingError(code);
  }

  const payload = {
    ok: false,
    version: SIGNALING_VERSION,
    event: eventName,
    error: {
      code,
      message,
    },
  };

  if (typeof ack === 'function') {
    ack(payload);
    return;
  }

  socket?.emit('signaling.error', payload);
}

module.exports = {
  requireSocketSession,
  validateSignalingVersion,
  acknowledgeSuccess,
  acknowledgeError,
};
