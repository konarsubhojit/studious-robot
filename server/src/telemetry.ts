/**
 * In-process call telemetry and QoS metrics.
 *
 * Tracks call-funnel counters and latency histograms entirely in-memory
 * (reset on process restart).  The data is exposed via `GET /metrics` so
 * any Prometheus-compatible scraper or a simple JSON dashboard can consume it.
 *
 * Usage:
 *   const telemetry = createTelemetry();
 *   telemetry.recordCallCreated(call);       // on every new call
 *   telemetry.recordCallTransition(call, previousStatus);
 *   telemetry.recordSignalingError(code);
 *   res.json(telemetry.getSnapshot());       // GET /metrics handler
 */

export type Histogram = { count: number; sum: number; min: number; max: number; buckets: Record<string, number>; };

export type HistogramSnapshot = {
  count: number;
  sum: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  buckets: Record<string, number>;
};

export type QueryOperationSnapshot = {
  backend: string;
  operation: string;
  kind: 'read' | 'write';
  count: number;
  errors: number;
  slow: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
};

export type MetricsSnapshot = {
  collectedAt: string;
  counters: Record<string, number>;
  /**
   * Signaling acknowledgement errors broken down by error code, so a spike in
   * the aggregate `signaling_errors` counter can be attributed without having
   * to correlate against the journal.
   */
  signaling_errors_by_code: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
  derived: Record<string, number | null>;
  /**
   * Per-operation datastore timing breakdown, slowest total time first, so the
   * operation costing the most is the first row of the table.
   */
  dbQueries: QueryOperationSnapshot[];
};

export type Telemetry = {
  recordCallCreated: (call: {
    callId: string;
    status: string;
    createdAt: string;
  }) => void;
  recordCallTransition: (
    call: { callId: string; status: string; endReason?: string | null },
    previousStatus: string
  ) => void;
  recordSignalingError: (code?: string) => void;
  recordCacheHit: () => void;
  recordCacheMiss: () => void;
  recordDbQuery: (record: import('./lib/queryTiming.ts').QueryTimingRecord) => void;
  getSnapshot: () => MetricsSnapshot;
};

/** Histogram upper-bound buckets in milliseconds. */
const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity];

/**
 * Query latencies live one to two orders of magnitude below call latencies, so
 * they need their own, much finer buckets: the call buckets start at 100 ms,
 * which is already the slow-query threshold.
 */
const QUERY_LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, Infinity];

/**
 * Upper bound on distinct `backend:kind:operation` keys tracked.  Every key
 * beyond it is folded into an `other` bucket (per backend *and* kind, so the
 * overflow row never averages reads together with writes) — a pathological
 * label set can then never grow the snapshot without limit.
 */
const MAX_TRACKED_QUERY_OPERATIONS = 100;

/**
 * Upper bound on distinct signaling error codes tracked individually.  Codes
 * come from a small frozen taxonomy, but the recorder accepts a free-form
 * string, so anything past the cap is folded into an `other` bucket rather
 * than growing the snapshot without limit.
 */
const MAX_TRACKED_SIGNALING_ERROR_CODES = 50;

/**
 * Running totals for one `backend:kind:operation`.  Separate from the wire
 * type: `meanMs` is derived at snapshot time, so keeping a field for it here
 * would only ever hold a stale zero.
 */
type QueryOperationTotals = Omit<QueryOperationSnapshot, 'meanMs'>;
type CallTimestamp = {
  createdMs: number;
  ringingMs: number | null;
  acceptedMs: number | null;
  inCallMs: number | null;
  endedMs: number | null;
};

// ─── Private helpers ──────────────────────────────────────────────────────────

function createHistogram(buckets: number[]): Histogram {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    buckets: Object.fromEntries(buckets.map((b) => [b === Infinity ? '+Inf' : b, 0])),
  };
}

function observeHistogram(h: Histogram, valueMs: number) {
  h.count += 1;
  h.sum += valueMs;
  if (valueMs < h.min) h.min = valueMs;
  if (valueMs > h.max) h.max = valueMs;
  for (const key of Object.keys(h.buckets)) {
    const bound = key === '+Inf' ? Infinity : Number(key);
    if (valueMs <= bound) {
      h.buckets[key] += 1;
    }
  }
}

function snapshotHistogram(h: Histogram): HistogramSnapshot {
  return {
    count: h.count,
    sum: h.sum,
    mean: h.count > 0 ? Math.round(h.sum / h.count) : null,
    min: h.count > 0 ? h.min : null,
    max: h.count > 0 ? h.max : null,
    buckets: { ...h.buckets },
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create an isolated telemetry recorder.
 *
 * Each call to `createTelemetry()` produces independent counters so that
 * tests that spin up isolated server instances never share state.
 */
function createTelemetry(): Telemetry {
  // ── Counters ──────────────────────────────────────────────────────────────
  const counters = {
    calls_initiated: 0, // every POST /calls or call.initiate
    calls_ringing: 0, // started in ringing state
    calls_busy: 0, // immediately busy (callee has active call)
    calls_unreachable: 0, // immediately unreachable (no channels)
    calls_accepted: 0, // transitioned to accepted
    calls_declined: 0, // transitioned to declined
    calls_missed: 0, // ringing timeout → missed
    calls_cancelled: 0, // caller cancelled during ringing
    calls_in_call: 0, // successfully reached in_call
    calls_ended: 0, // reached terminal ended state
    calls_failed: 0, // ended with endReason=failed
    signaling_errors: 0, // acknowledgeError / error ack responses
    cache_hits: 0, // read served from the shared read cache
    cache_misses: 0, // read that fell through to the store
    db_queries_total: 0, // every timed datastore round trip
    db_query_errors_total: 0, // timed round trips that threw
    db_slow_queries_total: 0, // round trips at/over the slow threshold
    // Of the slow ones, the subset a user-facing operation actually waited
    // for. The difference is deliberately unawaited work (audit, call
    // persistence, read receipts): real database time, but not anybody's
    // request latency.
    db_blocking_slow_queries_total: 0,
    // Every round trip nobody awaited, slow or not — the denominator for how
    // much of the load is background work.
    db_detached_queries_total: 0,
    db_reads_total: 0, // timed round trips that only read
    db_writes_total: 0, // timed round trips that mutate
  };

  // ── Latency histograms ────────────────────────────────────────────────────
  const histograms = {
    /** Time from call created (ringing) to accepted, in ms. */
    call_setup_latency_ms: createHistogram(LATENCY_BUCKETS_MS),
    /** Time from accepted to in_call (media connected), in ms. */
    call_connect_latency_ms: createHistogram(LATENCY_BUCKETS_MS),
    /** Total duration of connected calls (in_call → ended), in ms. */
    call_duration_ms: createHistogram(LATENCY_BUCKETS_MS),
    /** Time spent ringing before a terminal outcome (for unanswered calls). */
    call_ring_duration_ms: createHistogram(LATENCY_BUCKETS_MS),
    /** Postgres round-trip duration, in ms. */
    pg_query_duration_ms: createHistogram(QUERY_LATENCY_BUCKETS_MS),
    /** MongoDB round-trip duration, in ms. */
    mongo_query_duration_ms: createHistogram(QUERY_LATENCY_BUCKETS_MS),
    /** Redis cache round-trip duration, in ms. */
    redis_query_duration_ms: createHistogram(QUERY_LATENCY_BUCKETS_MS),
  };

  /**
   * `backend:kind:operation` → running totals, so `/metrics` can answer "which
   * operation costs the most time" without keeping per-query rows.  `kind` is
   * part of the key so a row can never mix read and write cost.
   */
  const queryOperations: Map<string, QueryOperationTotals> = new Map();

  /**
   * Error code → count, the per-code breakdown behind the aggregate
   * `signaling_errors` counter.
   */
  const signalingErrorsByCode: Map<string, number> = new Map();

  // ── Per-call timestamp tracking (for latency calculations) ───────────────
  const callTimestamps: Map<string, CallTimestamp> = new Map();

  // ─── Recording API ──────────────────────────────────────────────────────

  /**
   * Record a newly created call.
   */
  function recordCallCreated(call: { callId: string; status: string; createdAt: string; }) {
    counters.calls_initiated += 1;

    const createdMs = new Date(call.createdAt).getTime();
    callTimestamps.set(call.callId, {
      createdMs,
      ringingMs: call.status === 'ringing' ? createdMs : null,
      acceptedMs: null,
      inCallMs: null,
      endedMs: null,
    });

    if (call.status === 'ringing') {
      counters.calls_ringing += 1;
    } else if (call.status === 'busy') {
      counters.calls_busy += 1;
    } else if (call.status === 'unreachable') {
      counters.calls_unreachable += 1;
    }
  }

  /**
   * Record a call state transition.
   */
  function recordAcceptedCall(ts: CallTimestamp | undefined, nowMs: number) {
    counters.calls_accepted += 1;
    if (!ts) return;
    ts.acceptedMs = nowMs;
    if (ts.ringingMs !== null) {
      observeHistogram(histograms.call_setup_latency_ms, nowMs - ts.ringingMs);
    }
  }

  function recordInCall(ts: CallTimestamp | undefined, nowMs: number) {
    counters.calls_in_call += 1;
    if (!ts) return;
    ts.inCallMs = nowMs;
    if (ts.acceptedMs !== null) {
      observeHistogram(histograms.call_connect_latency_ms, nowMs - ts.acceptedMs);
    }
  }

  function recordRingEnd(counter: 'calls_declined' | 'calls_missed', ts: CallTimestamp | undefined, nowMs: number) {
    counters[counter] += 1;
    if (ts?.ringingMs !== null && ts?.ringingMs !== undefined) {
      observeHistogram(histograms.call_ring_duration_ms, nowMs - ts.ringingMs);
    }
  }

  function recordCallEnd(
    call: { endReason?: string | null },
    ts: CallTimestamp | undefined,
    nowMs: number,
  ) {
    counters.calls_ended += 1;
    if (call.endReason === 'failed') counters.calls_failed += 1;
    if (call.endReason === 'cancelled') counters.calls_cancelled += 1;
    if (!ts) return;
    ts.endedMs = nowMs;
    if (ts.inCallMs !== null) {
      observeHistogram(histograms.call_duration_ms, nowMs - ts.inCallMs);
    } else if (ts.ringingMs !== null) {
      observeHistogram(histograms.call_ring_duration_ms, nowMs - ts.ringingMs);
    }
  }

  function recordCallTransition(call: { callId: string; status: string; endReason?: string | null; }, previousStatus: string) {
    const ts = callTimestamps.get(call.callId);
    const nowMs = Date.now();

    switch (call.status) {
      case 'accepted':
        recordAcceptedCall(ts, nowMs);
        break;
      case 'in_call':
        recordInCall(ts, nowMs);
        break;
      case 'declined':
        recordRingEnd('calls_declined', ts, nowMs);
        break;
      case 'missed':
        recordRingEnd('calls_missed', ts, nowMs);
        break;
      case 'ended':
        recordCallEnd(call, ts, nowMs);
        break;
      default:
        break;
    }

    // Prevent unbounded growth: remove timestamps once the call reaches a
    // terminal state (all latencies that can be measured have been measured).
    if (ts && isTerminalStatus(call.status)) {
      callTimestamps.delete(call.callId);
    }
  }

  /**
   * Increment the signaling error counter, both in aggregate and per code.
   *
   * @param code - Error code from the acknowledgement envelope.  A missing or
   *   empty code is bucketed as `unknown` so the per-code breakdown always
   *   sums to the aggregate `signaling_errors` counter.
   */
  function recordSignalingError(code?: string) {
    counters.signaling_errors += 1;

    const label = typeof code === 'string' && code.length > 0 ? code : 'unknown';
    const key =
      signalingErrorsByCode.has(label) ||
      signalingErrorsByCode.size < MAX_TRACKED_SIGNALING_ERROR_CODES
        ? label
        : 'other';
    signalingErrorsByCode.set(key, (signalingErrorsByCode.get(key) ?? 0) + 1);
  }

  /**
   * Record a read served from the shared cache.
   */
  function recordCacheHit() {
    counters.cache_hits += 1;
  }

  /**
   * Record a read that missed the shared cache and hit the underlying store.
   */
  function recordCacheMiss() {
    counters.cache_misses += 1;
  }

  /**
   * Record one timed datastore round trip (see `lib/queryTiming.ts`).
   */
  function recordDbQueryCounters(record: import('./lib/queryTiming.ts').QueryTimingRecord) {
    counters.db_queries_total += 1;
    if (!record.ok) counters.db_query_errors_total += 1;
    if (record.slow) counters.db_slow_queries_total += 1;
    if (record.slow && record.blocking) counters.db_blocking_slow_queries_total += 1;
    if (!record.blocking) counters.db_detached_queries_total += 1;
    if (record.kind === 'read') counters.db_reads_total += 1;
    else counters.db_writes_total += 1;
  }

  function queryHistogramFor(record: import('./lib/queryTiming.ts').QueryTimingRecord) {
    if (record.backend === 'pg') return histograms.pg_query_duration_ms;
    if (record.backend === 'mongo') return histograms.mongo_query_duration_ms;
    return histograms.redis_query_duration_ms;
  }

  function queryOperationFor(record: import('./lib/queryTiming.ts').QueryTimingRecord) {
    const preferredKey = `${record.backend}:${record.kind}:${record.operation}`;
    // Fold anything past the cap into a per-backend, per-kind overflow row
    // rather than growing the map without bound.  `kind` stays part of the key
    // so the overflow row can never average read cost together with write cost.
    const key =
      queryOperations.has(preferredKey) || queryOperations.size < MAX_TRACKED_QUERY_OPERATIONS
        ? preferredKey
        : `${record.backend}:${record.kind}:other`;
    let entry = queryOperations.get(key);
    if (!entry) {
      entry = {
        backend: record.backend,
        operation: key === preferredKey ? record.operation : 'other',
        kind: record.kind,
        count: 0,
        errors: 0,
        slow: 0,
        totalMs: 0,
        maxMs: 0,
      };
      queryOperations.set(key, entry);
    }
    return entry;
  }

  function recordDbQuery(record: import('./lib/queryTiming.ts').QueryTimingRecord) {
    if (!record || !Number.isFinite(record.durationMs)) return;
    recordDbQueryCounters(record);
    observeHistogram(queryHistogramFor(record), record.durationMs);
    const entry = queryOperationFor(record);

    entry.count += 1;
    if (!record.ok) entry.errors += 1;
    if (record.slow) entry.slow += 1;
    entry.totalMs += record.durationMs;
    if (record.durationMs > entry.maxMs) entry.maxMs = record.durationMs;
  }

  /**
   * Return a point-in-time snapshot of all metrics.
   *
   * The shape is intentionally flat and JSON-serialisable so it can be
   * returned verbatim from a `/metrics` HTTP endpoint.
   */
  function getSnapshot(): MetricsSnapshot {
    const snap = ({
      collectedAt: new Date().toISOString(),
      counters: { ...counters },
      signaling_errors_by_code: Object.fromEntries(signalingErrorsByCode),
      histograms: {},
      derived: {},
      dbQueries: [],
    } as MetricsSnapshot);

    for (const [name, h] of Object.entries(histograms)) {
      snap.histograms[name] = snapshotHistogram(h);
    }

    // Derived call-funnel rates (null when no calls have been seen yet).
    const { calls_initiated, calls_in_call, calls_ended } = snap.counters;
    snap.derived.call_connect_rate =
      calls_initiated > 0 ? Number((calls_in_call / calls_initiated).toFixed(4)) : null;
    snap.derived.call_completion_rate =
      calls_in_call > 0 ? Number((calls_ended / calls_in_call).toFixed(4)) : null;

    // Per-operation datastore breakdown, most expensive (by total time) first.
    snap.dbQueries = [...queryOperations.values()]
      .map((entry) => ({
        ...entry,
        totalMs: Math.round(entry.totalMs),
        meanMs: entry.count > 0 ? Number((entry.totalMs / entry.count).toFixed(2)) : 0,
        maxMs: Number(entry.maxMs.toFixed(2)),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    const { db_queries_total, db_query_errors_total, db_slow_queries_total } = snap.counters;
    snap.derived.db_slow_query_rate =
      db_queries_total > 0 ? Number((db_slow_queries_total / db_queries_total).toFixed(4)) : null;
    snap.derived.db_query_error_rate =
      db_queries_total > 0 ? Number((db_query_errors_total / db_queries_total).toFixed(4)) : null;

    // Cache effectiveness: null until the first cacheable read is served.
    const { cache_hits, cache_misses } = snap.counters;
    const cacheReads = cache_hits + cache_misses;
    snap.derived.cache_hit_rate =
      cacheReads > 0 ? Number((cache_hits / cacheReads).toFixed(4)) : null;

    return snap;
  }

  return {
    recordCallCreated,
    recordCallTransition,
    recordSignalingError,
    recordCacheHit,
    recordCacheMiss,
    recordDbQuery,
    getSnapshot,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * @returns whether the status is terminal.
 */
function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export { createTelemetry };
