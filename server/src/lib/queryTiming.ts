import { performance } from 'node:perf_hooks';
import { sanitizeForLog } from './normalize.ts';
import { verboseLog } from './verbose.ts';

/**
 * Wall-clock timing for every datastore round trip (Postgres, MongoDB, Redis).
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
 * name, target (table/collection), duration, and error code.  Statement
 * parameters, filter documents and message bodies never reach a log line.
 */

/** Datastore behind a timed operation. */
export type QueryBackend = 'pg' | 'mongo' | 'redis';

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
 * Install the sink that receives every timing record.  Called by
 * `createServer()` with a telemetry-backed reporter, and with `null` on
 * shutdown so a torn-down instance stops accumulating.
 */
function setQueryTimingSink(next: QueryTimingSink | null): void {
  sink = next ?? noopSink;
}

/**
 * @returns whether query timing is enabled (default on; set
 *   `DB_QUERY_TIMING=false` to make every wrapper a pass-through).
 */
function isQueryTimingEnabled(): boolean {
  const flag = process.env.DB_QUERY_TIMING?.trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off');
}

/**
 * @returns the slow-query threshold in ms for `backend`.
 */
function slowQueryThresholdMs(backend: QueryBackend): number {
  const raw =
    backend === 'mongo'
      ? process.env.MONGO_SLOW_QUERY_MS
      : backend === 'redis'
        ? process.env.REDIS_SLOW_QUERY_MS
        : process.env.DB_SLOW_QUERY_MS;
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

  const detail =
    `backend=${record.backend} op=${record.operation} kind=${record.kind}` +
    ` target=${record.target ?? 'unknown'} durationMs=${record.durationMs.toFixed(1)}` +
    `${record.ok ? '' : ` error=${record.errorCode}`}`;

  if (record.slow || !record.ok) {
    console.warn(`[db-timing] SLOW ${detail}`);
    return;
  }
  verboseLog('db-timing', 'query', {
    backend: record.backend,
    operation: record.operation,
    kind: record.kind,
    target: record.target,
    durationMs: Number(record.durationMs.toFixed(1)),
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

  const startedAt = performance.now();
  const operation = normaliseLabel(descriptor.operation) ?? 'other';
  const target = normaliseLabel(descriptor.target);

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
  isQueryTimingEnabled,
  setQueryTimingSink,
  slowQueryThresholdMs,
  sqlTextOf,
  timeQuery,
};
