import { randomUUID } from 'crypto';
import { TERMINAL_CALL_STATES, CALL_TRANSITIONS, DEFAULT_CALL_RETENTION_MS, DEFAULT_MAX_RETAINED_CALLS, DEFAULT_RINGING_TIMEOUT_MS, DEFAULT_MEDIA_CONNECT_TIMEOUT_MS, DEFAULT_MAX_CALL_DURATION_MS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS, CONNECTED_CALL_STATUS } from '../config.ts';
import { resolveReachableChannels, hasKnownUser } from '../lib/state.ts';
import { invalidateCallHistoryCache, persistCallRecord, persistCallEvent } from '../callPersistence.ts';

/**
 * Call lifecycle domain: the call-record state machine and its event log.
 *
 * All functions are pure with respect to Express/Socket.IO — they mutate the
 * shared `state` and persist to the DB, but leave client notification to the
 * `notifications` module.  This keeps the state machine independently testable.
 */
export type CallRecord = import('../stores/contracts.ts').CallRecord;
export type ServerState = import('../stores/contracts.ts').ServerState;

/**
 * Create a new call record and append the initial `created` event.
 *
 * Immediately resolves to `busy` when the callee already has an active
 * (non-terminal) call, or to `unreachable` when the callee has no reachable
 * channels at all; otherwise starts in `ringing`.
 */
function createCallRecord(state: ServerState, { callerId, calleeId, ringingTimeoutMs }: { callerId: string; calleeId: string; ringingTimeoutMs: number; }): CallRecord {
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
    // Seconds of connected conversation; known only once the call is terminal.
    durationSeconds: TERMINAL_CALL_STATES.has(status) ? 0 : null,
    // When the callee (if ever) read the missed-call entry for this call.
    missedReadAt: null,
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
 * States a call has to have reached for media to have been connected (or to be
 * about to connect): the point from which conversation time is measured.
 */
const CONNECTED_CALL_STATES = new Set(['accepted', 'connecting_media', 'in_call']);

/**
 * Compute how long a call was connected, in whole seconds.
 *
 * The clock starts when the callee accepted (`answeredAt`, recorded in memory)
 * and stops when the call reaches a terminal state.  A call that never got past
 * `ringing` — missed, declined, cancelled, busy, unreachable — has no
 * conversation time at all and is reported as `0` rather than `null`, so every
 * terminal call carries a duration the client can render without guessing.
 *
 * `answeredAt` is deliberately not persisted: a call restored from the database
 * mid-conversation still has `updatedAt` pointing at the moment it entered its
 * current state, which is the same instant for `accepted`, and a close enough
 * lower bound for the later media states.
 */
function computeDurationSeconds(call: CallRecord, previousStatus: string, endedAtMs: number): number {
  if (!CONNECTED_CALL_STATES.has(previousStatus)) return 0;
  const startedAtMs = call.answeredAt
    ? toTimestamp(call.answeredAt, endedAtMs)
    : toTimestamp(call.updatedAt ?? call.createdAt, endedAtMs);
  return Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
}

/**
 * Attempt to move a call to `toStatus`.
 *
 * Idempotent: if the call is already in `toStatus`, returns `{ ok: true }`.
 * Terminal states are immutable: any other transition out of a terminal state
 * returns `{ ok: false, status: 409 }`.
 */
function transitionCall(state: ServerState, callId: string, toStatus: string, { actor = null, reason = null }: { actor?: string | null; reason?: string | null; } = {}): { ok: true; call: CallRecord; } |
{ ok: false; status: number; error: string; message?: string; } {
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

  const previousStatus = call.status;
  const nowMs = Date.now();
  const durationSeconds = TERMINAL_CALL_STATES.has(toStatus)
    ? computeDurationSeconds(call, previousStatus, nowMs)
    : null;
  call.status = toStatus;
  const isTerminal = TERMINAL_CALL_STATES.has(toStatus);
  call.endReason = isTerminal ? reason ?? null : null;
  call.updatedAt = new Date(nowMs).toISOString();
  if (toStatus === 'accepted') {
    call.answeredAt = call.updatedAt;
  }
  if (isTerminal) {
    call.ringTimeoutAt = null;
    call.durationSeconds = durationSeconds;
  }

  invalidateCallHistoryCache(state, call.callerId, call.calleeId);
  persistCallRecord(state.db, call);
  appendCallEvent(state, callId, toStatus, actor, reason);

  return { ok: true, call };
}

/**
 * Append an event entry to a call's event log.
 */
function appendCallEvent(state: ServerState, callId: string, event: string, actor: string | null, reason: string | null, afterPersist?: Promise<unknown> | undefined) {
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
 */
function getActiveCallsForUser(state: ServerState, userId: string): CallRecord[] {
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
 */
function isCalleeUnreachable(state: ServerState, calleeId: string): boolean {
  return resolveReachableChannels(state, calleeId).length === 0 && !hasKnownUser(state, calleeId);
}

/**
 * @returns true when no cross-instance message bus is configured.
 */
function isSingleInstanceMode(state: ServerState): boolean {
  return !state.messageBus;
}

/**
 * Record that a participant of `callId` is still alive.
 *
 * Connected calls have no media-setup deadline, so the heartbeat is what tells
 * an abandoned conversation (both devices gone without a `call.end`) apart
 * from a long healthy one.  Best-effort and in-memory only: it is a liveness
 * signal, not part of the persisted call record.
 *
 * @returns Whether a live call was found and stamped.
 */
function recordCallHeartbeat(state: ServerState, callId: string, now: number = Date.now()): boolean {
  const call = state.calls.get(callId);
  if (!call || TERMINAL_CALL_STATES.has(call.status)) return false;
  call.lastHeartbeatAt = new Date(now).toISOString();
  return true;
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
 * @param now - Unix timestamp in ms.
 * @returns Number of calls transitioned.
 */
function tickRingingTimeouts(state: ServerState, now: number, onTransition?: (call: CallRecord, previousStatus: string, reason: string) => void, options: { ringingTimeoutMs?: number; mediaConnectTimeoutMs?: number; maxCallDurationMs?: number; heartbeatTimeoutMs?: number; } = {}): number {
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
 * @returns Number of calls transitioned.
 */
function endCallsForDisconnectedParticipant(
  state: ServerState,
  userId: string,
  { reason = 'participant_disconnected', onTransition }: { reason?: string; onTransition?: (call: CallRecord, previousStatus: string, reason: string) => void; } = {}
): number {
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
 * Bounds applied by {@link pruneTerminalCalls}.
 *
 * Named rather than written inline so the declaration stays inside the
 * `max-len` lint rule, which only matches `type`/`interface` lines.
 *
 * `0` means "skip this bound on this pass" for both windows, so a deployment
 * can disable age-based or count-based eviction without disabling the other.
 */
type PruneTerminalCallsOptions = {
  maxAgeMs?: number;
  maxRetainedCalls?: number;
  now?: number;
};

/**
 * Drop terminal calls from the in-memory map once they are older than the
 * retention window, and enforce a hard ceiling on how many are retained.
 *
 * `state.calls` is the read path for `GET /calls`, and nothing ever deleted
 * from it: a long-lived process accumulated every call it had ever seen, so
 * both the history route and the sweep below iterated a set that only ever
 * grew.
 *
 * Only calls in a terminal state are ever evicted — an in-progress call is
 * live state, not history, and is bounded instead by the timeout sweep. The
 * call's event log is dropped alongside it, since it is keyed by the same id
 * and is only ever read for a call still present in the map.
 *
 * Where Postgres is configured the durable record in the `calls` table is
 * unaffected; this only bounds the in-memory copy.
 *
 * @returns Number of calls evicted.
 */
function pruneTerminalCalls(
  state: ServerState,
  {
    maxAgeMs = DEFAULT_CALL_RETENTION_MS,
    maxRetainedCalls = DEFAULT_MAX_RETAINED_CALLS,
    now = Date.now(),
  }: PruneTerminalCallsOptions = {}
): number {
  const retained: { callId: string; endedAtMs: number; }[] = [];
  let evicted = 0;

  for (const call of state.calls.values()) {
    if (!TERMINAL_CALL_STATES.has(call.status)) continue;

    // `updatedAt` is stamped at the moment the call reached its terminal
    // state, so it is the call's end time. Fall back to `createdAt` for a
    // record hydrated from an older row that never carried one.
    const endedAtMs = toTimestamp(call.updatedAt ?? call.createdAt, now);

    if (maxAgeMs > 0 && now - endedAtMs >= maxAgeMs) {
      evictCall(state, call.callId);
      evicted++;
      continue;
    }
    retained.push({ callId: call.callId, endedAtMs });
  }

  // Age alone bounds a steady workload; the ceiling bounds a burst that lands
  // entirely inside one retention window.
  if (maxRetainedCalls > 0 && retained.length > maxRetainedCalls) {
    retained.sort((a, b) => a.endedAtMs - b.endedAtMs);
    for (const { callId } of retained.slice(0, retained.length - maxRetainedCalls)) {
      evictCall(state, callId);
      evicted++;
    }
  }

  return evicted;
}

/**
 * Remove a call and its event log from the in-memory stores.
 */
function evictCall(state: ServerState, callId: string): void {
  state.calls.delete(callId);
  state.callEvents.delete(callId);
}

/**
 * Close out every non-terminal call that was restored from the database but is
 * already older than its state's timeout window.
 *
 * A restart must never resurrect a dead call: the in-memory `state.calls` map
 * is rebuilt from the `calls` table, so a stranded row would otherwise keep
 * both participants permanently busy across every future restart.
 *
 * @returns Number of calls closed out.
 */
function sanitizeHydratedCalls(state: ServerState, { now = Date.now(), ...timeouts }: { now?: number; ringingTimeoutMs?: number; mediaConnectTimeoutMs?: number; maxCallDurationMs?: number; heartbeatTimeoutMs?: number; } = {}): number {
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
 * @param activeCallIds - Call ids the client still considers live.
 * @returns The calls that were closed out.
 */
function reconcileClientCallState(state: ServerState, userId: string, activeCallIds: Iterable<string>, { onTransition }: { onTransition?: (call: CallRecord, previousStatus: string, reason: string) => void; } = {}): CallRecord[] {
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
 */
function describeActiveCallsForUser(state: ServerState, userId: string, now: number = Date.now()): {
    callId: string;
    status: string;
    callerId: string;
    calleeId: string;
    createdAt: string;
    updatedAt: string | null | undefined;
    ageMs: number;
}[] {
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

function hasLiveSockets(state: ServerState, userId: string): boolean {
  return (state.userConnections?.get(userId)?.size ?? 0) > 0;
}

/**
 * @param value ISO timestamp, if any.
 * @param fallback used when `value` is missing or unparseable.
 * @returns epoch milliseconds
 */
function toTimestamp(value: string | null | undefined, fallback: number): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Resolve the terminal transition a non-terminal call is due for, if any.
 */
function getCallExpiry(
  call: CallRecord,
  {
    ringingTimeoutMs = DEFAULT_RINGING_TIMEOUT_MS,
    mediaConnectTimeoutMs = DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
    maxCallDurationMs = DEFAULT_MAX_CALL_DURATION_MS,
    heartbeatTimeoutMs = DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  }: { ringingTimeoutMs?: number; mediaConnectTimeoutMs?: number; maxCallDurationMs?: number; heartbeatTimeoutMs?: number; } = {}
): { status: string; reason: string; deadlineMs: number; } | null {
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
    case CONNECTED_CALL_STATUS: {
      // A connected call is a legitimate long-lived steady state: it is never
      // subject to the media-setup deadline.  It ends on explicit hangup, on
      // participant disconnect, when its heartbeat stops (only once the client
      // has proven it sends them), or at the absolute duration cap.
      const durationDeadlineMs = enteredStateMs + maxCallDurationMs;
      if (!call.lastHeartbeatAt) {
        return {
          status: 'ended',
          reason: 'max_duration_exceeded',
          deadlineMs: durationDeadlineMs,
        };
      }
      const heartbeatDeadlineMs =
        toTimestamp(call.lastHeartbeatAt, enteredStateMs) + heartbeatTimeoutMs;
      return heartbeatDeadlineMs < durationDeadlineMs
        ? { status: 'ended', reason: 'heartbeat_timeout', deadlineMs: heartbeatDeadlineMs }
        : { status: 'ended', reason: 'max_duration_exceeded', deadlineMs: durationDeadlineMs };
    }
    default:
      return null;
  }
}

/**
 * Move a call into a terminal state without the transition-table checks, for
 * server-initiated cleanups (timeouts, disconnects, hydration sanitation).
 *
 * @returns The previous status.
 */
function finalizeCall(state: ServerState, call: CallRecord, status: string, reason: string, now: number): string {
  const previousStatus = call.status;
  const durationSeconds = computeDurationSeconds(call, previousStatus, now);
  call.status = status;
  call.endReason = reason;
  call.updatedAt = new Date(now).toISOString();
  call.ringTimeoutAt = null;
  call.durationSeconds = durationSeconds;
  invalidateCallHistoryCache(state, call.callerId, call.calleeId);
  persistCallRecord(state.db, call);
  appendCallEvent(state, call.callId, status, null, reason);
  return previousStatus;
}

export {
  createCallRecord,
  transitionCall,
  appendCallEvent,
  getActiveCallsForUser,
  describeActiveCallsForUser,
  isCalleeUnreachable,
  isSingleInstanceMode,
  recordCallHeartbeat,
  pruneTerminalCalls,
  // Exported for the state-machine invariant test, which asserts every
  // non-terminal status has a bounded — and appropriate — timeout.
  getCallExpiry,
  tickRingingTimeouts,
  endCallsForDisconnectedParticipant,
  reconcileClientCallState,
  sanitizeHydratedCalls,
};
