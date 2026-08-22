// @ts-check
'use strict';

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

/**
 * @typedef {object} Histogram
 * @property {number} count
 * @property {number} sum
 * @property {number} min
 * @property {number} max
 * @property {Record<string, number>} buckets
 */

/**
 * @typedef {object} HistogramSnapshot
 * @property {number} count
 * @property {number} sum
 * @property {number|null} mean
 * @property {number|null} min
 * @property {number|null} max
 * @property {Record<string, number>} buckets
 */

/**
 * @typedef {object} MetricsSnapshot
 * @property {string} collectedAt
 * @property {Record<string, number>} counters
 * @property {Record<string, HistogramSnapshot>} histograms
 * @property {Record<string, number|null>} derived
 */

/**
 * @typedef {object} Telemetry
 * @property {(call: { callId: string, status: string, createdAt: string }) => void} recordCallCreated
 * @property {(call: { callId: string, status: string, endReason?: string|null },
 *   previousStatus: string) => void} recordCallTransition
 * @property {(code?: string) => void} recordSignalingError
 * @property {() => void} recordCacheHit
 * @property {() => void} recordCacheMiss
 * @property {() => MetricsSnapshot} getSnapshot
 */

/** Histogram upper-bound buckets in milliseconds. */
const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity];

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * @param {number[]} buckets
 * @returns {Histogram}
 */
function createHistogram(buckets) {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    buckets: Object.fromEntries(buckets.map((b) => [b === Infinity ? '+Inf' : b, 0])),
  };
}

/**
 * @param {Histogram} h
 * @param {number} valueMs
 */
function observeHistogram(h, valueMs) {
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

/**
 * @param {Histogram} h
 * @returns {HistogramSnapshot}
 */
function snapshotHistogram(h) {
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
 *
 * @returns {Telemetry}
 */
function createTelemetry() {
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
  };

  // ── Per-call timestamp tracking (for latency calculations) ───────────────
  /** @type {Map<string, { createdMs: number, ringingMs: number|null, acceptedMs: number|null, inCallMs: number|null, endedMs: number|null }>} */
  const callTimestamps = new Map();

  // ─── Recording API ──────────────────────────────────────────────────────

  /**
   * Record a newly created call.
   *
   * @param {{ callId: string, status: string, createdAt: string }} call
   */
  function recordCallCreated(call) {
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
   *
   * @param {{ callId: string, status: string, endReason?: string|null }} call
   * @param {string} previousStatus
   */
  function recordCallTransition(call, previousStatus) {
    const ts = callTimestamps.get(call.callId);
    const nowMs = Date.now();

    switch (call.status) {
      case 'accepted': {
        counters.calls_accepted += 1;
        if (ts) {
          ts.acceptedMs = nowMs;
          if (ts.ringingMs !== null) {
            observeHistogram(histograms.call_setup_latency_ms, nowMs - ts.ringingMs);
          }
        }
        break;
      }

      case 'in_call': {
        counters.calls_in_call += 1;
        if (ts) {
          ts.inCallMs = nowMs;
          if (ts.acceptedMs !== null) {
            observeHistogram(histograms.call_connect_latency_ms, nowMs - ts.acceptedMs);
          }
        }
        break;
      }

      case 'declined': {
        counters.calls_declined += 1;
        if (ts && ts.ringingMs !== null) {
          observeHistogram(histograms.call_ring_duration_ms, nowMs - ts.ringingMs);
        }
        break;
      }

      case 'missed': {
        counters.calls_missed += 1;
        if (ts && ts.ringingMs !== null) {
          observeHistogram(histograms.call_ring_duration_ms, nowMs - ts.ringingMs);
        }
        break;
      }

      case 'ended': {
        counters.calls_ended += 1;
        if (call.endReason === 'failed') counters.calls_failed += 1;
        if (call.endReason === 'cancelled') counters.calls_cancelled += 1;
        if (ts) {
          ts.endedMs = nowMs;
          if (ts.inCallMs !== null) {
            observeHistogram(histograms.call_duration_ms, nowMs - ts.inCallMs);
          } else if (ts.ringingMs !== null) {
            observeHistogram(histograms.call_ring_duration_ms, nowMs - ts.ringingMs);
          }
        }
        break;
      }

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
   * Increment the signaling error counter.
   *
   * @param {string} [_code] - Error code (reserved for future per-code breakdown).
   */
  function recordSignalingError(_code) {
    counters.signaling_errors += 1;
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
   * Return a point-in-time snapshot of all metrics.
   *
   * The shape is intentionally flat and JSON-serialisable so it can be
   * returned verbatim from a `/metrics` HTTP endpoint.
   *
   * @returns {MetricsSnapshot}
   */
  function getSnapshot() {
    const snap = /** @type {MetricsSnapshot} */ ({
      collectedAt: new Date().toISOString(),
      counters: { ...counters },
      histograms: {},
      derived: {},
    });

    for (const [name, h] of Object.entries(histograms)) {
      snap.histograms[name] = snapshotHistogram(h);
    }

    // Derived call-funnel rates (null when no calls have been seen yet).
    const { calls_initiated, calls_in_call, calls_ended } = snap.counters;
    snap.derived.call_connect_rate =
      calls_initiated > 0 ? Number((calls_in_call / calls_initiated).toFixed(4)) : null;
    snap.derived.call_completion_rate =
      calls_in_call > 0 ? Number((calls_ended / calls_in_call).toFixed(4)) : null;

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
    getSnapshot,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * @param {string} status
 * @returns {boolean} whether the status is terminal.
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = { createTelemetry };
