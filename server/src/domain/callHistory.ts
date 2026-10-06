import { and, count, desc, eq, inArray, or } from 'drizzle-orm';
import { calls as callsTable, callParticipants as callParticipantsTable } from '../../db/schema.ts';
import { describeError } from '../lib/errors.ts';
import type { Database } from '../../db/client.ts';

/**
 * Read path for `GET /calls`.
 *
 * History is served from the durable `calls` table (written on every state
 * transition by `callPersistence.ts`), **not** from the in-memory `state.calls`
 * map.  That map is bounded by `CALL_RETENTION_MS` / `MAX_RETAINED_CALLS` and
 * is emptied by a restart, so reading history from it conflated a memory bound
 * with the history horizon (see `docs/OPTIMIZATION_PLAN.md`, P1.3).
 * `state.calls` now backs live-call state only.
 *
 * The in-memory fallback below is used when no database is configured (tests,
 * and deployments without `DATABASE_URL`) or when the query fails: a database
 * outage degrades history to whatever is still resident rather than failing the
 * request outright.
 */

type ServerState = import('../stores/contracts.ts').ServerState;
type CallRecord = import('../stores/contracts.ts').CallRecord;

export type CallHistoryQuery = {
  userId: string;
  statusFilter?: string | null;
  limit: number;
  offset?: number;
};

export type CallHistoryPage = {
  calls: CallRecord[];
  /** Total rows matching the query, i.e. ignoring `limit`/`offset`. */
  total: number;
  /** Where the rows came from — surfaced for tests and diagnostics. */
  source: 'db' | 'memory';
};

/**
 * @returns the ISO form of a timestamp column, which Drizzle hands back as a
 * `Date` but a raw driver row (or a stubbed db in tests) may yield as a string.
 */
function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

/**
 * Map a durable `calls` row onto the runtime call record shape returned by the
 * HTTP API.
 *
 * Live-only fields (`answeredAt`, `lastHeartbeatAt`) are deliberately absent:
 * they exist to drive an in-progress call, not to describe a finished one, and
 * are never persisted.
 */
function callRecordFromRow(row: any): CallRecord {
  return {
    callId: row.callId,
    callerId: row.callerId,
    calleeId: row.calleeId,
    mediaType: row.mediaType === 'audio' ? 'audio' : 'video',
    status: row.status,
    endReason: row.endReason ?? null,
    durationSeconds: row.durationSeconds ?? null,
    missedReadAt: toIsoString(row.missedReadAt),
    createdAt: toIsoString(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIsoString(row.updatedAt),
    ringTimeoutAt: toIsoString(row.ringTimeoutAt),
    participants: row.participants,
  };
}

/**
 * @returns the timestamp a call last changed state, which is how history is
 * ordered (a call that ended today is more recent than one placed today and
 * still ringing).
 */
function lastActivityMs(call: CallRecord): number {
  const parsed = Date.parse(call.updatedAt ?? call.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Page a user's call history out of the in-memory map.
 *
 * Use the same tie-breaks as the durable read and the merged group/direct page.
 */
function readFromMemory(state: ServerState, { userId, statusFilter = null, limit, offset = 0 }: CallHistoryQuery): CallHistoryPage {
  const userCalls: CallRecord[] = [];
  for (const call of state.calls.values()) {
    if (!(call.participants?.some(({ userId: participantId }) => participantId === userId) ??
      (call.callerId === userId || call.calleeId === userId))) continue;
    if (statusFilter && call.status !== statusFilter) continue;
    userCalls.push(call);
  }

  userCalls.sort((a, b) => lastActivityMs(b) - lastActivityMs(a) ||
    b.createdAt.localeCompare(a.createdAt) || b.callId.localeCompare(a.callId));

  return {
    calls: userCalls.slice(offset, offset + limit),
    total: userCalls.length,
    source: 'memory',
  };
}

/**
 * Page a user's call history out of the durable `calls` table.
 *
 * Ordered by `updatedAt` descending, with `createdAt` and `callId` as further
 * tie-breaks so a row can never appear on two consecutive pages (or on none)
 * when rows share a timestamp.
 */
async function readFromDb(db: Database, { userId, statusFilter = null, limit, offset = 0 }: CallHistoryQuery): Promise<CallHistoryPage> {
  const participantRows = await db
    .select({ callId: callParticipantsTable.callId })
    .from(callParticipantsTable)
    .where(eq(callParticipantsTable.userId, userId));
  const participantCallIds = (participantRows ?? []).map(({ callId }) => callId);
  const participantFilter = participantCallIds.length > 0
    ? or(
    eq(callsTable.callerId, userId),
    eq(callsTable.calleeId, userId),
    inArray(callsTable.callId, participantCallIds),
    )
    : or(
      eq(callsTable.callerId, userId),
      eq(callsTable.calleeId, userId),
    );
  const where = statusFilter
    ? and(participantFilter, eq(callsTable.status, statusFilter))
    : participantFilter;

  // Page and count are independent queries against a remote Postgres: issued
  // together they cost one round trip instead of two.
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(callsTable)
      .where(where)
      .orderBy(desc(callsTable.updatedAt), desc(callsTable.createdAt), desc(callsTable.callId))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(callsTable).where(where),
  ]);

  const rowCallIds = (rows ?? []).map((row) => row.callId);
  const participants = rowCallIds.length > 0 && participantCallIds.length > 0
    ? await db.select().from(callParticipantsTable).where(inArray(callParticipantsTable.callId, rowCallIds))
    : [];
  const participantsByCall = new Map<string, NonNullable<CallRecord['participants']>>();
  for (const participant of participants) {
    const list = participantsByCall.get(participant.callId) ?? [];
    list.push({
      userId: participant.userId,
      state: participant.state as NonNullable<CallRecord['participants']>[number]['state'],
      ringTimeoutAt: toIsoString(participant.ringTimeoutAt),
      joinedAt: toIsoString(participant.joinedAt),
      leftAt: toIsoString(participant.leftAt),
      deviceId: participant.deviceId,
    });
    participantsByCall.set(participant.callId, list);
  }
  return {
    calls: (rows ?? []).map((row) => callRecordFromRow({
      ...row,
      participants: participantsByCall.get(row.callId),
    })),
    total: Number(totals?.[0]?.value ?? 0),
    source: 'db',
  };
}

/**
 * Read one page of a user's call history, newest activity first.
 */
async function readCallHistory(state: ServerState, query: CallHistoryQuery): Promise<CallHistoryPage> {
  if (!state.db) return readFromMemory(state, query);
  try {
    return await readFromDb(state.db, query);
  } catch (error) {
    console.error(`[calls] call history query failed, serving resident calls: ${describeError(error)}`);
    return readFromMemory(state, query);
  }
}

export { readCallHistory, callRecordFromRow };
