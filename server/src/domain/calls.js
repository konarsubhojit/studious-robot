'use strict';

const { randomUUID } = require('crypto');
const {
  TERMINAL_CALL_STATES,
  CALL_TRANSITIONS,
  DEFAULT_RINGING_TIMEOUT_MS,
  DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CALL_DURATION_MS,
} = require('../config');
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
    // Name the offender: a `busy` rejection is otherwise undiagnosable, and the
    // usual cause is a stale call the callee never actually hung up.
    const blockers = describeActiveCallsForUser(state, calleeId)
      .map(
        (blocker) =>
          `${blocker.callId}(status=${blocker.status} ageMs=${blocker.ageMs} caller=${blocker.callerId} callee=${blocker.calleeId})`
      )
      .join(',');
    console.log(
      `[calls] busy callerId=${callerId} calleeId=${calleeId} blockedBy=${blockers}`
    );
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
 * Advance every `ringing` call whose `ringTimeoutAt` is ≤ `now` to `missed`,
 * and force-end every other **non-terminal** call that has been stuck in its
 * state for longer than that state's window.
 *
 * Sweeping only `ringing` used to leave calls stranded in `accepted` /
 * `connecting_media` / `in_call` forever whenever both peers vanished mid
 * setup: those records are persisted and rehydrated on restart, and each one
 * permanently marks both participants busy.  Every state now has a finite
 * lifetime.
 *
 * @param {object} state
 * @param {number} now - Unix timestamp in ms.
 * @param {(call: CallRecord, previousStatus: string, reason: string) => void} [onTransition]
 * @param {{ ringingTimeoutMs?: number, mediaConnectTimeoutMs?: number, maxCallDurationMs?: number }} [options]
 * @returns {number} Number of calls transitioned.
 */
function tickRingingTimeouts(state, now, onTransition, options = {}) {
  let count = 0;
  for (const call of state.calls.values()) {
    const expiry = getCallExpiry(call, options);
    if (!expiry) continue;
    if (expiry.deadlineMs > now) continue;

    const previousStatus = finalizeCall(state, call, expiry.status, expiry.reason, now);
    state.telemetry?.recordCallTransition(call, previousStatus);
    onTransition?.(call, previousStatus, expiry.reason);
    count++;
  }
  return count;
}

/**
 * Force every non-terminal call `userId` participates in to `ended` when
 * neither participant has a live socket left.
 *
 * `ringing` calls are left alone: they are delivered by push to a callee who
 * is expected to be offline, and the ring timeout already bounds them.
 *
 * @param {object} state
 * @param {string} userId
 * @param {{ reason?: string, onTransition?: (call: CallRecord, previousStatus: string, reason: string) => void }} [opts]
 * @returns {number} Number of calls transitioned.
 */
function endCallsForDisconnectedParticipant(
  state,
  userId,
  { reason = 'participant_disconnected', onTransition } = {}
) {
  if (!userId) return 0;
  let count = 0;
  const now = Date.now();
  for (const call of getActiveCallsForUser(state, userId)) {
    if (call.status === 'ringing') continue;
    if (hasLiveSockets(state, call.callerId) || hasLiveSockets(state, call.calleeId)) continue;

    const previousStatus = finalizeCall(state, call, 'ended', reason, now);
    state.telemetry?.recordCallTransition(call, previousStatus);
    console.log(
      `[calls] call.stale_cleanup callId=${call.callId} ${previousStatus}->ended reason=${reason}`
    );
    onTransition?.(call, previousStatus, reason);
    count++;
  }
  return count;
}

/**
 * Close out every non-terminal call that was restored from the database but is
 * already older than its state's timeout window.
 *
 * A restart must never resurrect a dead call: the in-memory `state.calls` map
 * is rebuilt from the `calls` table, so a stranded row would otherwise keep
 * both participants permanently busy across every future restart.
 *
 * @param {object} state
 * @param {{ now?: number, ringingTimeoutMs?: number, mediaConnectTimeoutMs?: number, maxCallDurationMs?: number }} [options]
 * @returns {number} Number of calls closed out.
 */
function sanitizeHydratedCalls(state, { now = Date.now(), ...timeouts } = {}) {
  let count = 0;
  for (const call of state.calls.values()) {
    const expiry = getCallExpiry(call, timeouts);
    if (!expiry) continue;
    if (expiry.deadlineMs > now) continue;

    const previousStatus = finalizeCall(state, call, expiry.status, 'stale_cleanup', now);
    console.log(
      `[calls] hydration closed stale call callId=${call.callId} ${previousStatus}->${call.status} reason=stale_cleanup`
    );
    count++;
  }
  return count;
}

/**
 * Reconcile a client's own view of its call state with the server's.
 *
 * A client that receives a `busy` rejection while holding no call reports the
 * calls it actually believes are live; every other non-terminal call it
 * participates in is a phantom and is closed out.  Ringing calls the user did
 * not initiate are left alone so a genuine concurrent incoming ring survives
 * (the ring timeout bounds it anyway).
 *
 * @param {object} state
 * @param {string} userId
 * @param {Iterable<string>} activeCallIds - Call ids the client still considers live.
 * @param {{ onTransition?: (call: CallRecord, previousStatus: string, reason: string) => void }} [opts]
 * @returns {CallRecord[]} The calls that were closed out.
 */
function reconcileClientCallState(state, userId, activeCallIds, { onTransition } = {}) {
  if (!userId) return [];
  const claimed = new Set(activeCallIds ?? []);
  const now = Date.now();
  const cleared = [];
  for (const call of getActiveCallsForUser(state, userId)) {
    if (claimed.has(call.callId)) continue;
    if (call.status === 'ringing' && call.callerId !== userId) continue;

    const previousStatus = finalizeCall(state, call, 'ended', 'client_state_reconciled', now);
    state.telemetry?.recordCallTransition(call, previousStatus);
    console.log(
      `[calls] call.reconciled callId=${call.callId} ${previousStatus}->ended` +
        ` reason=client_state_reconciled actor=${userId}`
    );
    onTransition?.(call, previousStatus, 'client_state_reconciled');
    cleared.push(call);
  }
  return cleared;
}

/**
 * Describe the calls that make `userId` busy, for log lines and the
 * `/debug/active-calls/:userId` endpoint.
 *
 * @param {object} state
 * @param {string} userId
 * @param {number} [now]
 * @returns {{ callId: string, status: string, callerId: string, calleeId: string, ageMs: number, updatedAt: string }[]}
 */
function describeActiveCallsForUser(state, userId, now = Date.now()) {
  return getActiveCallsForUser(state, userId).map((call) => ({
    callId: call.callId,
    status: call.status,
    callerId: call.callerId,
    calleeId: call.calleeId,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    ageMs: Math.max(0, now - toTimestamp(call.createdAt, now)),
  }));
}

function hasLiveSockets(state, userId) {
  return (state.userConnections?.get(userId)?.size ?? 0) > 0;
}

function toTimestamp(value, fallback) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Resolve the terminal transition a non-terminal call is due for, if any.
 *
 * @param {CallRecord} call
 * @param {{ ringingTimeoutMs?: number, mediaConnectTimeoutMs?: number, maxCallDurationMs?: number }} timeouts
 * @returns {{ status: string, reason: string, deadlineMs: number }|null}
 */
function getCallExpiry(
  call,
  {
    ringingTimeoutMs = DEFAULT_RINGING_TIMEOUT_MS,
    mediaConnectTimeoutMs = DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
    maxCallDurationMs = DEFAULT_MAX_CALL_DURATION_MS,
  } = {}
) {
  if (TERMINAL_CALL_STATES.has(call.status)) return null;

  const enteredStateMs = toTimestamp(call.updatedAt ?? call.createdAt, Date.now());
  switch (call.status) {
    case 'ringing':
      return {
        status: 'missed',
        reason: 'timeout',
        deadlineMs: call.ringTimeoutAt
          ? toTimestamp(call.ringTimeoutAt, enteredStateMs + ringingTimeoutMs)
          : enteredStateMs + ringingTimeoutMs,
      };
    case 'accepted':
    case 'connecting_media':
      return {
        status: 'ended',
        reason: 'media_connect_timeout',
        deadlineMs: enteredStateMs + mediaConnectTimeoutMs,
      };
    case 'in_call':
      return {
        status: 'ended',
        reason: 'max_duration_exceeded',
        deadlineMs: enteredStateMs + maxCallDurationMs,
      };
    default:
      return null;
  }
}

/**
 * Move a call into a terminal state without the transition-table checks, for
 * server-initiated cleanups (timeouts, disconnects, hydration sanitation).
 *
 * @param {object} state
 * @param {CallRecord} call
 * @param {string} status
 * @param {string} reason
 * @param {number} now
 * @returns {string} The previous status.
 */
function finalizeCall(state, call, status, reason, now) {
  const previousStatus = call.status;
  call.status = status;
  call.endReason = reason;
  call.updatedAt = new Date(now).toISOString();
  call.ringTimeoutAt = null;
  invalidateCallHistoryCache(state, call.callerId, call.calleeId);
  persistCallRecord(state.db, call);
  appendCallEvent(state, call.callId, status, null, reason);
  return previousStatus;
}

module.exports = {
  createCallRecord,
  transitionCall,
  appendCallEvent,
  getActiveCallsForUser,
  describeActiveCallsForUser,
  isCalleeUnreachable,
  isSingleInstanceMode,
  tickRingingTimeouts,
  endCallsForDisconnectedParticipant,
  reconcileClientCallState,
  sanitizeHydratedCalls,
};
