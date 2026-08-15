'use strict';

const { randomUUID } = require('crypto');
const { TERMINAL_CALL_STATES, CALL_TRANSITIONS } = require('../config');
const { resolveReachableChannels, hasKnownUser } = require('../lib/state');
const {
  invalidateCallHistoryCache,
  persistCallRecord,
  persistCallEvent,
} = require('../callPersistence');

/**
 * Call lifecycle domain: the call-record state machine and its event log.
 *
 * All functions are pure with respect to Express/Socket.IO — they mutate the
 * shared `state` and persist to the DB, but leave client notification to the
 * `notifications` module.  This keeps the state machine independently testable.
 *
 * @typedef {object} CallRecord
 */

/**
 * Create a new call record and append the initial `created` event.
 *
 * Immediately resolves to `busy` when the callee already has an active
 * (non-terminal) call, or to `unreachable` when the callee has no reachable
 * channels at all; otherwise starts in `ringing`.
 *
 * @param {object} state
 * @param {{ callerId: string, calleeId: string, ringingTimeoutMs: number }} opts
 * @returns {CallRecord}
 */
function createCallRecord(state, { callerId, calleeId, ringingTimeoutMs }) {
  const callId = randomUUID();
  const now = new Date().toISOString();

  // Determine initial status.
  let status = 'ringing';
  let endReason = null;

  if (getActiveCallsForUser(state, calleeId).length > 0) {
    status = 'busy';
    endReason = 'busy';
    // In single-instance mode (no cross-instance bus), we can safely short-circuit
    // unknown callees as `unreachable`. In multi-instance mode, the callee may be
    // connected to another node, so we allow ringing delivery via user-room fanout.
  } else if (isSingleInstanceMode(state) && isCalleeUnreachable(state, calleeId)) {
    status = 'unreachable';
    endReason = 'unreachable';
  }

  const call = {
    callId,
    callerId,
    calleeId,
    status,
    endReason,
    createdAt: now,
    updatedAt: now,
    ringTimeoutAt:
      status === 'ringing' ? new Date(Date.now() + ringingTimeoutMs).toISOString() : null,
  };

  state.calls.set(callId, call);
  state.callEvents.set(callId, []);
  invalidateCallHistoryCache(state, callerId, calleeId);
  const persistedCall = persistCallRecord(state.db, call);
  appendCallEvent(state, callId, 'created', callerId, null, persistedCall);
  if (status !== 'ringing') {
    appendCallEvent(state, callId, status, null, endReason, persistedCall);
  }

  return call;
}

/**
 * Attempt to move a call to `toStatus`.
 *
 * Idempotent: if the call is already in `toStatus`, returns `{ ok: true }`.
 * Terminal states are immutable: any other transition out of a terminal state
 * returns `{ ok: false, status: 409 }`.
 *
 * @param {object} state
 * @param {string} callId
 * @param {string} toStatus
 * @param {{ actor?: string|null, reason?: string|null }} [opts]
 * @returns {{ ok: boolean, call?: CallRecord, status?: number, error?: string, message?: string }}
 */
function transitionCall(state, callId, toStatus, { actor = null, reason = null } = {}) {
  const call = state.calls.get(callId);
  if (!call) {
    return { ok: false, error: 'not_found', status: 404 };
  }

  // Idempotent: already in the requested state.
  if (call.status === toStatus) {
    return { ok: true, call };
  }

  // Terminal states are immutable.
  if (TERMINAL_CALL_STATES.has(call.status)) {
    return {
      ok: false,
      error: 'terminal_state',
      status: 409,
      message: `call is already in terminal state: ${call.status}`,
    };
  }

  const allowed = CALL_TRANSITIONS.get(call.status);
  if (!allowed || !allowed.has(toStatus)) {
    return {
      ok: false,
      error: 'invalid_transition',
      status: 409,
      message: `cannot transition from ${call.status} to ${toStatus}`,
    };
  }

  call.status = toStatus;
  const isTerminal = TERMINAL_CALL_STATES.has(toStatus);
  call.endReason = isTerminal ? reason ?? null : null;
  call.updatedAt = new Date().toISOString();
  if (isTerminal) {
    call.ringTimeoutAt = null;
  }

  invalidateCallHistoryCache(state, call.callerId, call.calleeId);
  persistCallRecord(state.db, call);
  appendCallEvent(state, callId, toStatus, actor, reason);

  return { ok: true, call };
}

/**
 * Append an event entry to a call's event log.
 *
 * @param {object} state
 * @param {string} callId
 * @param {string} event
 * @param {string|null} actor
 * @param {string|null} reason
 * @param {Promise<unknown>|undefined} [afterPersist]
 */
function appendCallEvent(state, callId, event, actor, reason, afterPersist) {
  const events = state.callEvents.get(callId);
  if (!events) return;

  const eventRecord = {
    eventId: randomUUID(),
    callId,
    event,
    actor: actor === '' ? null : actor ?? null,
    reason: reason === '' ? null : reason ?? null,
    timestamp: new Date().toISOString(),
  };
  events.push(eventRecord);
  if (afterPersist) {
    Promise.resolve(afterPersist)
      .then(() => persistCallEvent(state.db, eventRecord))
      .catch((error) => {
        console.error('[calls] failed to persist call event after call to DB:', error?.message);
      });
    return;
  }
  persistCallEvent(state.db, eventRecord);
}

/**
 * Return all non-terminal calls where `userId` is either the caller or callee.
 *
 * @param {object} state
 * @param {string} userId
 * @returns {CallRecord[]}
 */
function getActiveCallsForUser(state, userId) {
  const active = [];
  for (const call of state.calls.values()) {
    if (
      !TERMINAL_CALL_STATES.has(call.status) &&
      (call.callerId === userId || call.calleeId === userId)
    ) {
      active.push(call);
    }
  }
  return active;
}

/**
 * Return true when the callee has never interacted with this server instance
 * (completely unknown user with no reachable channels).
 *
 * A known-but-offline user is intentionally **not** considered unreachable
 * here: they may come online or register a push token before the ringing
 * timeout fires.
 *
 * @param {object} state
 * @param {string} calleeId
 * @returns {boolean}
 */
function isCalleeUnreachable(state, calleeId) {
  return resolveReachableChannels(state, calleeId).length === 0 && !hasKnownUser(state, calleeId);
}

function isSingleInstanceMode(state) {
  return !state.messageBus;
}

/**
 * Advance every `ringing` call whose `ringTimeoutAt` is ≤ `now` to `missed`.
 *
 * @param {object} state
 * @param {number} now - Unix timestamp in ms.
 * @param {(call: CallRecord, previousStatus: string, reason: string) => void} [onTransition]
 * @returns {number} Number of calls transitioned.
 */
function tickRingingTimeouts(state, now, onTransition) {
  let count = 0;
  for (const call of state.calls.values()) {
    if (call.status !== 'ringing') continue;
    if (call.ringTimeoutAt === null) continue;
    if (new Date(call.ringTimeoutAt).getTime() > now) continue;

    const previousStatus = call.status;
    call.status = 'missed';
    call.endReason = 'timeout';
    call.updatedAt = new Date(now).toISOString();
    call.ringTimeoutAt = null;
    invalidateCallHistoryCache(state, call.callerId, call.calleeId);
    persistCallRecord(state.db, call);
    appendCallEvent(state, call.callId, 'missed', null, 'timeout');
    state.telemetry.recordCallTransition(call, previousStatus);
    onTransition?.(call, previousStatus, 'timeout');
    count++;
  }
  return count;
}

module.exports = {
  createCallRecord,
  transitionCall,
  appendCallEvent,
  getActiveCallsForUser,
  isCalleeUnreachable,
  isSingleInstanceMode,
  tickRingingTimeouts,
};
