import { invalidateCache, callHistoryCachePrefix } from './cache.ts';
import { calls as callsTable } from '../db/schema.ts';
import { callEvents as callEventsTable } from '../db/schema.ts';
import { describeError } from './lib/errors.ts';
import { callRecordFromRow } from './domain/callHistory.ts';
import type { Database } from '../db/client.ts';

/**
 * @returns the driver error code, when the error carries one.
 */
function errorCode(error: unknown): string {
  const code = ((error ?? {}) as Record<string, unknown>).code;
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
 */
function invalidateCallHistoryCache(state: import('./stores/contracts.ts').ServerState, ...userIds: string[]): void {
  if (!state?.cache || userIds.length === 0) return;
  const prefixes = userIds.filter(Boolean).map((userId) => callHistoryCachePrefix(userId));
  if (prefixes.length === 0) return;
  invalidateCache(state, ...prefixes).catch((error: unknown) => {
    console.error(`[calls] call history cache invalidation failed: ${describeError(error)}`);
  });
}

/**
 * @returns the parsed date, or `null` when it is missing/invalid.
 */
function toDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date((value as string|number));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Persist (upsert) a call record, fire-and-forget.
 */
function persistCallRecord(db: Database | null, call: import('./stores/contracts.ts').CallRecord) {
  if (!db || !call?.callId) return;
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
    .catch((error: unknown) => {
      // Non-fatal: the in-memory call record already reflects reality and the
      // caller doesn't await this promise. `code` is the Postgres error code
      // (e.g. `23503` foreign_key_violation, `23505` unique_violation) — logging
      // it alongside the message makes a recurrence diagnosable without
      // reproducing it, instead of the bare message alone.
      console.error(
        `[calls] failed to persist call to DB: callId=${call.callId}` +
          ` code=${errorCode(error)} ${describeError(error)}`
      );
    });
}

/**
 * Persist a call event, fire-and-forget.
 */
function persistCallEvent(db: Database | null, event: import('./stores/contracts.ts').CallEvent) {
  if (!db || !event?.eventId) return;
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
    .catch((error: unknown) => {
      // Non-fatal by design (an audit-log write failure must never block the
      // call itself), but this is still a silent audit-trail gap: log the
      // Postgres error `code` plus the ids involved so a recurrence can be
      // traced to its exact cause (e.g. a FK violation because the parent call
      // row hadn't committed yet) rather than only ever seeing the message.
      console.error(
        `[calls] failed to persist call event to DB: eventId=${event.eventId}` +
          ` callId=${event.callId} event=${event.event}` +
          ` code=${errorCode(error)} ${describeError(error)}`
      );
    });
}

/**
 * Load persisted calls and call events into the in-memory stores at boot.
 */
async function hydrateCallRecords(db: Database, state: import('./stores/contracts.ts').Stores) {
  try {
    const rows = await db.select().from(callsTable);
    for (const row of rows) {
      if (!row?.callId || !row?.callerId || !row?.calleeId || !row?.status) continue;
      state.calls.set(row.callId, callRecordFromRow(row));
      if (!state.callEvents.has(row.callId)) {
        state.callEvents.set(row.callId, []);
      }
    }
    console.log(`[signaling] hydrated ${rows.length} call record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate calls from DB:', describeError(err));
  }
}

async function hydrateCallEvents(db: Database, state: import('./stores/contracts.ts').Stores) {
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
    console.error('[signaling] failed to hydrate call events from DB:', describeError(err));
  }
}

async function hydrateCallsAndEventsFromDb(db: Database | null, state: import('./stores/contracts.ts').Stores) {
  if (!db) return;
  await hydrateCallRecords(db, state);
  await hydrateCallEvents(db, state);
}

export {
  invalidateCallHistoryCache,
  persistCallRecord,
  persistCallEvent,
  hydrateCallsAndEventsFromDb,
};
