// @ts-check
'use strict';

const { SIGNALING_VERSION } = require('../config');
const { ERROR_CODES, SERVER_EVENTS, parseEventPayload } = require('../../../shared');

/**
 * Socket.IO acknowledgement envelope helpers and pre-handler guards.
 *
 * Every version-1 `call.*` / `rtc.*` event replies with a `{ ok, version, … }`
 * envelope (via the ack callback when provided, or a `signaling.error` emit as
 * a fallback).  Centralising the envelope shape here keeps every handler
 * consistent.
 */

/**
 * @typedef {{ telemetry: { recordSignalingError: (code: string) => void } }} SignalingState
 */

/**
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {string} eventName
 * @returns {boolean}
 */
function requireSocketSession(socket, ack, eventName) {
  if (socket.data.identity?.sessionId) {
    return true;
  }

  acknowledgeError(
    socket,
    ack,
    eventName,
    ERROR_CODES.UNAUTHORIZED,
    'a valid session is required'
  );
  return false;
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {any} payload
 * @param {Function|undefined} ack
 * @param {string} eventName
 * @returns {boolean}
 */
function validateSignalingVersion(socket, payload, ack, eventName) {
  if (payload?.version === SIGNALING_VERSION) {
    return true;
  }

  acknowledgeError(
    socket,
    ack,
    eventName,
    ERROR_CODES.UNSUPPORTED_VERSION,
    `version ${SIGNALING_VERSION} is required`
  );
  return false;
}

/**
 * Validate an inbound payload against its shared schema.
 *
 * A payload that does not match the contract is rejected with a `bad_request`
 * acknowledgement and logged, so a malformed (or hostile) event can never take
 * a handler down by dereferencing a missing field.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {string} eventName
 * @param {unknown} payload
 * @param {SignalingState} [state]
 * @returns {Record<string, any> | null} the parsed payload, or `null` when it
 *   was rejected.
 */
function parseInboundPayload(socket, ack, eventName, payload, state) {
  const result = parseEventPayload(eventName, payload);
  if (result.success) {
    return result.data;
  }

  console.warn(
    `[signaling] rejected malformed payload event=${eventName}` +
      ` socket=${socket?.id ?? 'unknown'} user=${socket?.data?.identity?.userId ?? 'unknown'}` +
      ` reason=${result.error.message}`
  );
  acknowledgeError(
    socket,
    ack,
    eventName,
    ERROR_CODES.BAD_REQUEST,
    result.error.message,
    state
  );
  return null;
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {Function|undefined} ack
 * @param {string} eventName
 * @param {object} [data]
 */
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
 * @param {SignalingState} [state]  - Optional server state (provides telemetry recorder).
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

  socket?.emit(SERVER_EVENTS.SIGNALING_ERROR, payload);
}

module.exports = {
  requireSocketSession,
  validateSignalingVersion,
  parseInboundPayload,
  acknowledgeSuccess,
  acknowledgeError,
};
