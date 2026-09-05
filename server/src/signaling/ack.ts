import { SIGNALING_VERSION } from '../config.ts';
import { ERROR_CODES, SERVER_EVENTS, parseEventPayload } from '../../../shared/index.ts';

/**
 * Socket.IO acknowledgement envelope helpers and pre-handler guards.
 *
 * Every version-1 `call.*` / `rtc.*` event replies with a `{ ok, version, … }`
 * envelope (via the ack callback when provided, or a `signaling.error` emit as
 * a fallback).  Centralising the envelope shape here keeps every handler
 * consistent.
 */

export type SignalingState = { telemetry: { recordSignalingError: (code: string) => void; }; };

/** Upper bound on each client-controlled field written to a log line. */
const MAX_LOGGED_CHARS = 200;

function requireSocketSession(socket: import('socket.io').Socket, ack: Function | undefined, eventName: string): boolean {
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

function validateSignalingVersion(socket: import('socket.io').Socket, payload: any, ack: Function | undefined, eventName: string): boolean {
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
 * @returns the parsed payload, or `null` when it
 *   was rejected.
 */
function parseInboundPayload(socket: import('socket.io').Socket, ack: Function | undefined, eventName: string, payload: unknown, state?: SignalingState): Record<string, any> | null {
  const result = parseEventPayload(eventName, payload);
  if (result.success) {
    return result.data;
  }

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
 * Flatten a value for a single-line log entry.
 *
 * Event names, error messages and user ids can all carry client-controlled
 * text, so control characters (newlines above all) are replaced and the result
 * is truncated: a hostile payload can then never forge extra journal lines.
 */
function sanitizeForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_LOGGED_CHARS);
}

function acknowledgeSuccess(socket: import('socket.io').Socket, ack: Function | undefined, eventName: string, data?: object) {
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
 * Send an error acknowledgement, log it, and record a signaling error in
 * telemetry.
 *
 * Every rejection is logged with its code, event, socket id and user id: the
 * telemetry counters alone made error bursts (for example during socket
 * reconnect churn) invisible in the journal.
 *
 * `state` is intentionally optional: early guards like `requireSocketSession`
 * and `validateSignalingVersion` call this helper before they have access to a
 * call-scoped state object.  All call/RTC handlers that do have state pass it
 * so the error is counted in the telemetry metrics.
 *
 * @param state  - Optional server state (provides telemetry recorder).
 */
function acknowledgeError(socket: import('socket.io').Socket, ack: Function | undefined, eventName: string, code: string, message: string, state?: SignalingState) {
  if (state) {
    state.telemetry.recordSignalingError(code);
  }

  console.warn(
    `[signaling] error ack code=${sanitizeForLog(code)} event=${sanitizeForLog(eventName)}` +
      ` socket=${socket?.id ?? 'unknown'} user=${sanitizeForLog(socket?.data?.identity?.userId ?? 'unknown')}` +
      ` reason=${sanitizeForLog(message)}`
  );

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

export {
  requireSocketSession,
  validateSignalingVersion,
  parseInboundPayload,
  acknowledgeSuccess,
  acknowledgeError,
};
