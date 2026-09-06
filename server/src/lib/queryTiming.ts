import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { sanitizeForLog } from './normalize.ts';
import { verboseLog } from './verbose.ts';

/**
 * Wall-clock timing for every datastore round trip (Postgres, Redis).
 *
 * The goal is answering two operational questions without an external APM:
 *   1. how long does each query take, and
 *   2. which *kind* of operation (read vs write) and which named operation
 *      costs the most time.
 *
 * Design
 * ──────
 * `timeQuery()` measures a single operation and hands the result to a *sink*.
 * The sink is a module-level, settable function rather than something passed
 * down through call sites, because the instrumented modules (`db/client.ts`,
 * `messageStore.ts`, `cache.ts`) are constructed before — or entirely without —
 * a server `state` handle.  `createServer()` installs a telemetry-backed sink;
 * until then (and in every test that never installs one) the sink is a no-op
 * and the wrappers are a thin `await`.
 *
 * Every timed operation is logged to the console: slow ones (>= the threshold)
 * as a warning, the rest through the existing verbose logger, so a normal
 * deployment gets the slow-query trail and a debugging session gets everything.
 *
 * Only the *shape* of a query is ever recorded or logged — backend, operation
 * name, target table, duration, and error code.  Statement parameters and
 * message bodies never reach a log line.
 */

/** Datastore behind a timed operation. */
export type QueryBackend = 'pg' | 'redis';

/** Whether the operation reads or mutates data. */
export type QueryKind = 'read' | 'write';

export type QueryTimingRecord = {
  backend: QueryBackend;
  /** Operation name, e.g. `select`, `listConversations`, `get`. */
  operation: string;
  kind: QueryKind;
  /** Table / collection / key namespace the operation touched, when known. */
  target: string | null;
  durationMs: number;
  ok: boolean;
  /** Driver error code (or error name) when `ok` is false. */
  errorCode: string | null;
  slow: boolean;
  /**
   * Whether a user-facing operation actually waited for this query.
   *
   * `false` for work started inside {@link runDetached} — the fire-and-forget
   * audit, call-persistence and read-receipt writes that are deliberately not
   * awaited. Their duration is real, but nobody's request paid it, so counting
   * them as slow queries made the slow log describe latency that no user
   * experienced.
   */
  blocking: boolean;
};

export type QueryTimingSink = (record: QueryTimingRecord) => void;

/** Default slow-query threshold, in milliseconds. */
const DEFAULT_SLOW_QUERY_MS = 100;

/**
 * Longest operation/target label kept, so a pathological label can never blow
 * up a log line or the metrics snapshot.
 */
const MAX_LABEL_LENGTH = 64;

const noopSink: QueryTimingSink = () => {};

let sink: QueryTimingSink = noopSink;

/**
 * Marks the async context of deliberately unawaited work.
 *
 * An async-context flag rather than an argument threaded through every call
 * site: the queries being classified are issued by the drivers, several frames
 * below the code that decided not to await them (`pool.query` is wrapped once,
 * in `db/client.ts`, and has no idea who called it). Setting the flag once
 * around the detached work labels every statement it goes on to issue, at any
 * depth, including ones added later.
 */
const detachedStorage = new AsyncLocalStorage<true>();

/**
 * Run `start` as detached work: every query it issues, at any depth, is
 * reported with `blocking: false`.
 *
 * Intended to wrap the *initiation* of fire-and-forget work, and it returns
 * whatever `start` returns so a caller can still attach a `.catch`.
 */
function runDetached<T>(start: () => T): T {
  return detachedStorage.run(true, start);
}

/** @returns whether the current async context is detached work. */
function isDetached(): boolean {
  return detachedStorage.getStore() === true;
}

/**
 * Install the sink that receives every timing record.  Called by
 * `createServer()` with a telemetry-backed reporter.
 *
 * @returns a disposer that uninstalls *this* sink, and only this sink: a
 *   process can hold several servers (the test suite builds dozens), and
 *   tearing one down must not silently stop the timings of the ones still
 *   running — which a blind reset to the no-op sink would do.
 */
function setQueryTimingSink(next: QueryTimingSink | null): () => void {
  const installed = next ?? noopSink;
  sink = installed;
  return () => {
    if (sink === installed) sink = noopSink;
  };
}

/**
 * @returns whether query timing is enabled (default on; set
 *   `DB_QUERY_TIMING=false` to make every wrapper a pass-through).
 *
 * Deliberately read per query rather than cached at module load: the cost is a
 * property read plus a short string compare, and reading it live means an
 * operator (or a test) can flip the flag without restarting the process.
 */
function isQueryTimingEnabled(): boolean {
  const flag = process.env.DB_QUERY_TIMING?.trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off');
}

/**
 * @returns the slow-query threshold in ms for `backend`.
 *
 * Read live for the same reason as {@link isQueryTimingEnabled}: a threshold
 * that can only be changed by a restart is a threshold nobody tunes.
 */
function slowQueryThresholdMs(backend: QueryBackend): number {
  const raw =
    backend === 'redis' ? process.env.REDIS_SLOW_QUERY_MS : process.env.DB_SLOW_QUERY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOW_QUERY_MS;
}

/**
 * Clamp a label to a bounded, log-safe string.
 */
function normaliseLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return sanitizeForLog(trimmed.slice(0, MAX_LABEL_LENGTH));
}

/**
 * @returns the driver error code, or the error name, or `'unknown'`.
 */
function toErrorCode(error: unknown): string {
  const raw = (error ?? {}) as { code?: unknown; name?: unknown };
  if (typeof raw.code === 'string' && raw.code) return sanitizeForLog(raw.code.slice(0, MAX_LABEL_LENGTH));
  if (typeof raw.code === 'number') return String(raw.code);
  if (typeof raw.name === 'string' && raw.name) return sanitizeForLog(raw.name.slice(0, MAX_LABEL_LENGTH));
  return 'unknown';
}

/**
 * Report one measured operation: log it and hand it to the sink.
 */
function report(record: QueryTimingRecord): void {
  try {
    sink(record);
  } catch {
    // A broken sink must never fail the query it was measuring.
  }

  // A slow *detached* query is not a latency incident: no request waited for
  // it. Warning about it buried the blocking slow queries — the ones that do
  // describe user-visible latency — under a steady trickle of audit-log and
  // call-persistence writes. It still reaches the verbose log and `/metrics`.
  // A *failed* one is reported either way: a dropped audit write is a real
  // audit-trail gap whether or not anybody was waiting for it.
  if ((record.slow && record.blocking) || !record.ok) {
    const detail =
      `backend=${record.backend} op=${record.operation} kind=${record.kind}` +
      ` target=${record.target ?? 'unknown'} durationMs=${record.durationMs.toFixed(1)}` +
      `${record.blocking ? '' : ' detached=true'}` +
      `${record.ok ? '' : ` error=${record.errorCode}`}`;
    // A fast query that threw is a failure, not a slow query: labelling both
    // `SLOW` would bury the actual latency evidence under failed queries when
    // someone greps for it during an incident.
    const label = record.slow ? (record.ok ? 'SLOW' : 'SLOW+FAILED') : 'FAILED';
    console.warn(`[db-timing] ${label} ${detail}`);
    return;
  }
  verboseLog('db-timing', 'query', {
    backend: record.backend,
    operation: record.operation,
    kind: record.kind,
    target: record.target,
    durationMs: Number(record.durationMs.toFixed(1)),
    blocking: record.blocking,
  });
}

/**
 * Measure `run()` and report how long it took.
 *
 * The operation's result is returned and its rejection re-thrown untouched, so
 * wrapping a call site can never change its behaviour.
 */
async function timeQuery<T>(
  descriptor: {
    backend: QueryBackend;
    operation: string;
    kind: QueryKind;
    target?: string | null;
  },
  run: () => Promise<T> | T
): Promise<T> {
  if (!isQueryTimingEnabled()) return await run();

  const operation = normaliseLabel(descriptor.operation) ?? 'other';
  const target = normaliseLabel(descriptor.target);
  // Captured before `run()` so a detached operation stays labelled detached
  // even if it resolves after the context that started it has gone.
  const blocking = !isDetached();

  const startedAt = performance.now();
  try {
    const result = await run();
    const durationMs = performance.now() - startedAt;
    report({
      backend: descriptor.backend,
      operation,
      kind: descriptor.kind,
      target,
      durationMs,
      ok: true,
      errorCode: null,
      slow: durationMs >= slowQueryThresholdMs(descriptor.backend),
      blocking,
    });
    return result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    report({
      backend: descriptor.backend,
      operation,
      kind: descriptor.kind,
      target,
      durationMs,
      ok: false,
      errorCode: toErrorCode(error),
      slow: durationMs >= slowQueryThresholdMs(descriptor.backend),
      blocking,
    });
    throw error;
  }
}

/** SQL verbs that only read. */
const SQL_READ_VERBS = new Set(['select', 'with', 'show', 'explain']);

/**
 * Derive `{ operation, kind, target }` from a SQL statement.
 *
 * Deliberately text-only and parameter-free: the statement's *shape* is all
 * that is recorded, never a bound value.
 *
 * An unrecognised statement is classified as a write: over-reporting mutation
 * cost is the safe error, since a write miscounted as a read would understate
 * exactly the number this instrumentation exists to surface.
 */
function describeSqlStatement(sql: unknown): { operation: string; kind: QueryKind; target: string | null; } {
  if (typeof sql !== 'string' || !sql.trim()) {
    return { operation: 'other', kind: 'write', target: null };
  }
  const text = sql.trim();
  const verb = (text.match(/^[a-zA-Z]+/)?.[0] ?? 'other').toLowerCase();
  const kind: QueryKind = SQL_READ_VERBS.has(verb) ? 'read' : 'write';

  // `from "users"`, `into "devices"`, `update "calls"` — the first table the
  // statement names is a good enough attribution for a timing breakdown.
  const tableMatch = text.match(/\b(?:from|into|update|join)\s+"?([a-zA-Z_][a-zA-Z0-9_$]*)"?/i);
  const target = tableMatch?.[1]?.toLowerCase() ?? null;

  return { operation: verb, kind, target: normaliseLabel(target) };
}

/**
 * @returns the statement text carried by a `pg` query argument (string or
 *   config object), or `null` when it carries none.
 */
function sqlTextOf(query: unknown): string | null {
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object') {
    const text = (query as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

export {
  DEFAULT_SLOW_QUERY_MS,
  describeSqlStatement,
  isDetached,
  isQueryTimingEnabled,
  runDetached,
  setQueryTimingSink,
  slowQueryThresholdMs,
  sqlTextOf,
  timeQuery,
};
