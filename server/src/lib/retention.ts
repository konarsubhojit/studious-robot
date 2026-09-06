import { and, inArray, lt } from 'drizzle-orm';
import { calls as callsTable, auditLog as auditLogTable } from '../../db/schema.ts';
import { TERMINAL_CALL_STATES, DB_RETENTION_DELETE_BATCH } from '../config.ts';
import { describeError } from './errors.ts';
import type { Database } from '../../db/client.ts';

/**
 * Retention sweep for the append-only Postgres tables.
 *
 * `calls`, `call_events` and `audit_log` are written on every call and every
 * security-relevant action and were never deleted from, so they grew without
 * bound.  That is a storage problem, but on this deployment it is first a
 * *boot* problem: `hydrateCallsAndEventsFromDb` reads `calls` and `call_events`
 * in full at startup, so an unbounded table becomes an unbounded startup read
 * on both signaling VMs, and the process is not serving until it finishes.
 *
 * `call_events` is not swept directly — its FK to `calls` is
 * `ON DELETE CASCADE`, so pruning the parent row removes the timeline with it,
 * and doing it in one statement keeps a call and its events from ever
 * disagreeing about whether they exist.
 *
 * Only *terminal* calls are eligible, whatever their age: a row still in
 * `ringing` or `connected` is live state, and deleting it would strand the
 * peers.  This mirrors `pruneOldCalls`, which applies the same rule to the
 * in-memory map.
 *
 * Every instance runs this, so on a multi-VM fleet two sweeps can select the
 * same batch.  That is harmless rather than coordinated away: the loser blocks
 * briefly on the row lock and then deletes nothing, and no reader depends on a
 * terminal row that is already past its retention window.
 */

/** Terminal statuses, as an array for the SQL `IN (...)` predicate. */
const TERMINAL_STATUS_LIST = [...TERMINAL_CALL_STATES];

/** Outcome of one sweep, for logging and tests. */
type RetentionSweepResult = {
  calls: number;
  auditLog: number;
};

type RetentionOptions = {
  now?: number;
  callRetentionMs: number;
  auditRetentionMs: number;
  batchSize?: number;
};

/**
 * Delete at most `batchSize` expired terminal calls.
 *
 * The delete is bounded by a sub-select rather than issued as a bare
 * `DELETE ... WHERE updated_at < $1`, so the first run against a table that has
 * never been pruned cannot lock millions of rows in a single statement.  What
 * the batch leaves behind is collected on the next tick.
 *
 * @returns the number of rows deleted.
 */
async function pruneExpiredCalls(db: Database, cutoff: Date, batchSize: number): Promise<number> {
  const doomed = db
    .select({ callId: callsTable.callId })
    .from(callsTable)
    .where(and(inArray(callsTable.status, TERMINAL_STATUS_LIST), lt(callsTable.updatedAt, cutoff)))
    .limit(batchSize);

  const deleted = await db
    .delete(callsTable)
    .where(inArray(callsTable.callId, doomed))
    .returning({ callId: callsTable.callId });

  return deleted.length;
}

/**
 * Delete at most `batchSize` expired audit-log rows.
 *
 * @returns the number of rows deleted.
 */
async function pruneExpiredAuditLog(db: Database, cutoff: Date, batchSize: number): Promise<number> {
  const doomed = db
    .select({ auditId: auditLogTable.auditId })
    .from(auditLogTable)
    .where(lt(auditLogTable.ts, cutoff))
    .limit(batchSize);

  const deleted = await db
    .delete(auditLogTable)
    .where(inArray(auditLogTable.auditId, doomed))
    .returning({ auditId: auditLogTable.auditId });

  return deleted.length;
}

/**
 * Run one retention sweep.
 *
 * Each table is swept independently so a failure on one — a lock timeout, say —
 * still lets the other make progress.  A retention of `0` disables that table's
 * sweep, which is the escape hatch for an operator who must keep everything.
 *
 * @param db - Drizzle handle, or `null` when Postgres is not configured.
 * @param options.now - Injected clock, in epoch milliseconds.
 * @returns per-table deleted row counts (zeroes when disabled or unconfigured).
 */
async function runRetentionSweep(
  db: Database | null,
  { now = Date.now(), callRetentionMs, auditRetentionMs, batchSize = DB_RETENTION_DELETE_BATCH }: RetentionOptions
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = { calls: 0, auditLog: 0 };
  if (!db) return result;

  if (callRetentionMs > 0) {
    try {
      result.calls = await pruneExpiredCalls(db, new Date(now - callRetentionMs), batchSize);
    } catch (error) {
      console.error(`[retention] call sweep failed: ${describeError(error)}`);
    }
  }

  if (auditRetentionMs > 0) {
    try {
      result.auditLog = await pruneExpiredAuditLog(db, new Date(now - auditRetentionMs), batchSize);
    } catch (error) {
      console.error(`[retention] audit-log sweep failed: ${describeError(error)}`);
    }
  }

  if (result.calls > 0 || result.auditLog > 0) {
    console.log(
      `[retention] pruned calls=${result.calls} auditLog=${result.auditLog}` +
        ` (call events cascade with their call)`
    );
  }

  return result;
}

export { runRetentionSweep };
export type { RetentionSweepResult };
