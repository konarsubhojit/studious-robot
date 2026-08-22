// @ts-check
'use strict';

const { invalidateCache, callHistoryCachePrefix } = require('./cache');

/**
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {string} the driver error code, when the error carries one.
 */
function errorCode(error) {
  const code = /** @type {Record<string, unknown>} */ (error ?? {}).code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Evict the cached `GET /calls` pages of every listed participant, on this and
 * every other instance.
 *
 * Fire-and-forget by design: call-state transitions are synchronous and must
 * not be blocked (or failed) by a cache eviction.  The shared cache evicts its
 * local entries synchronously, so a read issued on this instance after the
 * write can never observe the stale page.
 *
 * @param {import('./stores/contracts').ServerState} state
 * @param {...string} userIds
 * @returns {void}
 */
function invalidateCallHistoryCache(state, ...userIds) {
  if (!state?.cache || userIds.length === 0) return;
  const prefixes = userIds.filter(Boolean).map((userId) => callHistoryCachePrefix(userId));
  if (prefixes.length === 0) return;
  invalidateCache(state, ...prefixes).catch((/** @type {unknown} */ error) => {
    console.error(`[calls] call history cache invalidation failed: ${errorMessage(error)}`);
  });
}

/**
 * @param {unknown} value
 * @returns {Date|null} the parsed date, or `null` when it is missing/invalid.
 */
function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(/** @type {string|number} */ (value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Persist (upsert) a call record, fire-and-forget.
 *
 * @param {any} db
 * @param {import('./stores/contracts').CallRecord} call
 */
function persistCallRecord(db, call) {
  if (!db || !call?.callId) return;
  const { calls: callsTable } = require('../db/schema');
  return db
    .insert(callsTable)
    .values({
      callId: call.callId,
      callerId: call.callerId,
      calleeId: call.calleeId,
      status: call.status,
      endReason: call.endReason ?? null,
      durationSeconds: call.durationSeconds ?? null,
      missedReadAt: toDateOrNull(call.missedReadAt),
      createdAt: toDateOrNull(call.createdAt) ?? new Date(),
      updatedAt: toDateOrNull(call.updatedAt) ?? new Date(),
      ringTimeoutAt: toDateOrNull(call.ringTimeoutAt),
    })
    .onConflictDoUpdate({
      target: callsTable.callId,
      set: {
        callerId: call.callerId,
        calleeId: call.calleeId,
        status: call.status,
        endReason: call.endReason ?? null,
        durationSeconds: call.durationSeconds ?? null,
        missedReadAt: toDateOrNull(call.missedReadAt),
        updatedAt: toDateOrNull(call.updatedAt) ?? new Date(),
        ringTimeoutAt: toDateOrNull(call.ringTimeoutAt),
      },
    })
    .catch((/** @type {unknown} */ error) => {
      // Non-fatal: the in-memory call record already reflects reality and the
      // caller doesn't await this promise. `code` is the Postgres error code
      // (e.g. `23503` foreign_key_violation, `23505` unique_violation) — logging
      // it alongside the message makes a recurrence diagnosable without
      // reproducing it, instead of the bare message alone.
      console.error(
        `[calls] failed to persist call to DB: callId=${call.callId}` +
          ` code=${errorCode(error)} ${errorMessage(error)}`
      );
    });
}

/**
 * Persist a call event, fire-and-forget.
 *
 * @param {any} db
 * @param {import('./stores/contracts').CallEvent} event
 */
function persistCallEvent(db, event) {
  if (!db || !event?.eventId) return;
  const { callEvents: callEventsTable } = require('../db/schema');
  // Runtime call events expose `timestamp`; persist it as `createdAt`.
  return db
    .insert(callEventsTable)
    .values({
      eventId: event.eventId,
      callId: event.callId,
      event: event.event,
      actor: event.actor,
      reason: event.reason,
      createdAt: toDateOrNull(event.timestamp) ?? new Date(),
    })
    .catch((/** @type {unknown} */ error) => {
      // Non-fatal by design (an audit-log write failure must never block the
      // call itself), but this is still a silent audit-trail gap: log the
      // Postgres error `code` plus the ids involved so a recurrence can be
      // traced to its exact cause (e.g. a FK violation because the parent call
      // row hadn't committed yet) rather than only ever seeing the message.
      console.error(
        `[calls] failed to persist call event to DB: eventId=${event.eventId}` +
          ` callId=${event.callId} event=${event.event}` +
          ` code=${errorCode(error)} ${errorMessage(error)}`
      );
    });
}

/**
 * Load persisted calls and call events into the in-memory stores at boot.
 *
 * @param {any} db
 * @param {import('./stores/contracts').Stores} state
 */
async function hydrateCallsAndEventsFromDb(db, state) {
  if (!db) return;
  const { calls: callsTable, callEvents: callEventsTable } = require('../db/schema');

  try {
    const rows = await db.select().from(callsTable);
    for (const row of rows) {
      if (!row?.callId || !row?.callerId || !row?.calleeId || !row?.status) continue;
      state.calls.set(row.callId, {
        callId: row.callId,
        callerId: row.callerId,
        calleeId: row.calleeId,
        status: row.status,
        endReason: row.endReason ?? null,
        durationSeconds: row.durationSeconds ?? null,
        missedReadAt:
          row.missedReadAt instanceof Date
            ? row.missedReadAt.toISOString()
            : row.missedReadAt ?? null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        ringTimeoutAt:
          row.ringTimeoutAt instanceof Date
            ? row.ringTimeoutAt.toISOString()
            : row.ringTimeoutAt ?? null,
      });
      if (!state.callEvents.has(row.callId)) {
        state.callEvents.set(row.callId, []);
      }
    }
    console.log(`[signaling] hydrated ${rows.length} call record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate calls from DB:', errorMessage(err));
  }

  try {
    const rows = await db.select().from(callEventsTable);
    for (const row of rows) {
      if (!row?.callId || !row?.eventId || !row?.event) continue;
      if (!state.callEvents.has(row.callId)) {
        state.callEvents.set(row.callId, []);
      }
      const events = state.callEvents.get(row.callId) ?? [];
      events.push({
        eventId: row.eventId,
        callId: row.callId,
        event: row.event,
        actor: row.actor ?? null,
        reason: row.reason ?? null,
        timestamp: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      });
    }
    for (const events of state.callEvents.values()) {
      events.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    }
    console.log(`[signaling] hydrated ${rows.length} call event(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate call events from DB:', errorMessage(err));
  }
}

module.exports = {
  invalidateCallHistoryCache,
  persistCallRecord,
  persistCallEvent,
  hydrateCallsAndEventsFromDb,
};
