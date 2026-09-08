import { asc, inArray } from 'drizzle-orm';
import { callEvents as callEventsTable } from '../../db/schema.ts';
import { describeError } from '../lib/errors.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type CallEvent = import('../stores/contracts.ts').CallEvent;

function eventsFromMemory(state: ServerState, callIds: string[]): CallEvent[] {
  const events = callIds.flatMap((callId) => state.callEvents.get(callId) ?? []);
  return events.sort(
    (left, right) =>
      Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
      left.eventId.localeCompare(right.eventId)
  );
}

/**
 * Read events for an already participant-scoped call page.
 *
 * Durable history may be older than the bounded call/event set hydrated at
 * boot, so Postgres is authoritative when configured. A failed query degrades
 * to resident events in the same way `readCallHistory` degrades to resident
 * calls.
 */
async function readAccountCallEvents(state: ServerState, callIds: string[]): Promise<CallEvent[]> {
  if (callIds.length === 0) return [];
  if (!state.db) return eventsFromMemory(state, callIds);

  try {
    const rows = await state.db
      .select()
      .from(callEventsTable)
      .where(inArray(callEventsTable.callId, callIds))
      .orderBy(asc(callEventsTable.createdAt), asc(callEventsTable.eventId));
    return rows.map((row) => ({
      eventId: row.eventId,
      callId: row.callId,
      event: row.event,
      actor: row.actor ?? null,
      reason: row.reason ?? null,
      timestamp:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));
  } catch (error) {
    console.error(
      `[account-export] call event query failed, serving resident events: ${describeError(error)}`
    );
    return eventsFromMemory(state, callIds);
  }
}

export { readAccountCallEvents };
