'use strict';

function getCallHistoryCacheKey(userId, statusFilter, limit) {
  return `${userId}::${statusFilter || '*'}::${limit}`;
}

function invalidateCallHistoryCache(state, ...userIds) {
  if (!state?.callHistoryCache || userIds.length === 0) return;
  for (const userId of userIds) {
    if (!userId) continue;
    const prefix = `${userId}::`;
    for (const key of state.callHistoryCache.keys()) {
      if (key.startsWith(prefix)) {
        state.callHistoryCache.delete(key);
      }
    }
  }
}

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function emptyStringToNull(value) {
  return value === '' ? null : (value ?? null);
}

function persistCallRecord(db, call) {
  if (!db || !call?.callId) return;
  const { calls: callsTable } = require('../db/schema');
  return db.insert(callsTable).values({
    callId: call.callId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    status: call.status,
    endReason: call.endReason ?? null,
    createdAt: toDateOrNull(call.createdAt) ?? new Date(),
    updatedAt: toDateOrNull(call.updatedAt) ?? new Date(),
    ringTimeoutAt: toDateOrNull(call.ringTimeoutAt),
  }).onConflictDoUpdate({
    target: callsTable.callId,
    set: {
      callerId: call.callerId,
      calleeId: call.calleeId,
      status: call.status,
      endReason: call.endReason ?? null,
      updatedAt: toDateOrNull(call.updatedAt) ?? new Date(),
      ringTimeoutAt: toDateOrNull(call.ringTimeoutAt),
    },
  }).catch((error) => {
    console.error('[calls] failed to persist call to DB:', error?.message);
  });
}

function persistCallEvent(db, event) {
  if (!db || !event?.eventId) return;
  const { callEvents: callEventsTable } = require('../db/schema');
  // Runtime call events expose `timestamp`; persist it as `createdAt`.
  return db.insert(callEventsTable).values({
    eventId: event.eventId,
    callId: event.callId,
    event: event.event,
    actor: emptyStringToNull(event.actor),
    reason: emptyStringToNull(event.reason),
    createdAt: toDateOrNull(event.timestamp) ?? new Date(),
  }).catch((error) => {
    console.error('[calls] failed to persist call event to DB:', error?.message);
  });
}

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
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        ringTimeoutAt: row.ringTimeoutAt instanceof Date ? row.ringTimeoutAt.toISOString() : (row.ringTimeoutAt ?? null),
      });
      if (!state.callEvents.has(row.callId)) {
        state.callEvents.set(row.callId, []);
      }
    }
    console.log(`[signaling] hydrated ${rows.length} call record(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate calls from DB:', err?.message);
  }

  try {
    const rows = await db.select().from(callEventsTable);
    for (const row of rows) {
      if (!row?.callId || !row?.eventId || !row?.event) continue;
      if (!state.callEvents.has(row.callId)) {
        state.callEvents.set(row.callId, []);
      }
      state.callEvents.get(row.callId).push({
        eventId: row.eventId,
        callId: row.callId,
        event: row.event,
        actor: row.actor ?? null,
        reason: row.reason ?? null,
        timestamp: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      });
    }
    for (const events of state.callEvents.values()) {
      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    console.log(`[signaling] hydrated ${rows.length} call event(s) from DB`);
  } catch (err) {
    console.error('[signaling] failed to hydrate call events from DB:', err?.message);
  }
}

module.exports = {
  getCallHistoryCacheKey,
  invalidateCallHistoryCache,
  persistCallRecord,
  persistCallEvent,
  hydrateCallsAndEventsFromDb,
};
