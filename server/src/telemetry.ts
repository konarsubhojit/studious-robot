import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  MAX_PLAUSIBLE_SETUP_LATENCY_MS,
  measureElapsedMs,
  measureSinceAnswered,
} from './lib/callLatency.ts';

type ElapsedResult = import('./lib/callLatency.ts').ElapsedResult;

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
    call: {
      callId: string;
      status: string;
      endReason?: string | null;
      /**
       * The ring start for any call that rang, carried in the shared store so
       * the instance that sees the call end can measure how long it rang even
       * when it did not create it.
       */
      createdAt?: string | null;
      /**
       * Stamped on the accepted transition and carried in the shared store, so
       * the instance that sees `in_call` can measure the connect latency even
       * when it did not handle the accept.
       */
      answeredAt?: string | null;
    },
    previousStatus: string
  ) => void;
  recordRtcBufferOutcome: (outcome: RtcBufferOutcome, count?: number) => void;
  recordRtcRelay: (eventName: string, recipients: number | null) => void;
  recordSignalingError: (code?: string) => void;
  recordMessagePersistenceFailure: () => void;
  recordCacheHit: () => void;
  recordCacheMiss: () => void;
  recordDbQuery: (record: import('./lib/queryTiming.ts').QueryTimingRecord) => void;
  getSnapshot: () => MetricsSnapshot;
};

/**
 * What became of RTC frames held while a call was still `ringing`.
 *
 * The two `stranded_*` outcomes are kept apart because they mean different
 * things: `stranded_local` is a call that ended before it was ever media-ready
 * (the buffer did its job and had nothing to replay into), while
 * `stranded_remote` is a buffer this instance was still holding when a *peer*
 * instance moved the call — the cross-instance loss described in
 * `docs/media-connect-latency-diagnosis.md` §2.
 */
export type RtcBufferOutcome = 'buffered' | 'replayed' | 'stranded_local' | 'stranded_remote';

/**
 * RTC events whose relays are counted individually.
 *
 * The relay counter exists to answer "did this frame have anywhere to go",
 * and the question is only ever asked of the three events that carry a call's
 * media negotiation. Anything else — `call.media-state`, or a future event
 * routed through the same relay — is folded into `other` so the per-event
 * breakdown can never grow without bound.
 */
const RELAYED_RTC_EVENTS = ['rtc.offer', 'rtc.answer', 'rtc.candidate'] as const;

/** Histogram upper-bound buckets in milliseconds. */
const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, Infinity];

/**
 * Query latencies live one to two orders of magnitude below call latencies, so
 * they need their own, much finer buckets: the call buckets start at 100 ms,
 * which is already the slow-query threshold.
 */
const QUERY_LATENCY_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, Infinity];

/**
 * Event-loop lag lives another order of magnitude below query latencies on a
 * healthy process (sub-millisecond to a few ms), and the resolution the
 * monitor samples at (`EVENT_LOOP_DELAY_RESOLUTION_MS`) sets a floor on what
 * it can ever report — so its buckets need to resolve well below that floor
 * to separate "at the floor" from "genuinely delayed", plus a `1000`+ tail
 * for pathological blocking (GC pauses, synchronous I/O).
 */
const EVENT_LOOP_LAG_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, Infinity];

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

/** Event-loop delay sampling cadence for the `/metrics` histogram. */
const EVENT_LOOP_DELAY_SAMPLE_MS = 1_000;

/** RTC buffer outcome → the counter it increments. */
const RTC_BUFFER_COUNTERS = {
  buffered: 'rtc_signals_buffered',
  replayed: 'rtc_signals_replayed',
  stranded_local: 'rtc_signals_stranded_local',
  stranded_remote: 'rtc_signals_stranded_remote',
} as const;

/**
 * Sampling resolution (ms) for `monitorEventLoopDelay`. The monitor reports
 * the time between successive samples, so this value is a *floor* on every
 * reported delay, not just a knob on precision — at the previous `20`, a
 * perfectly idle loop could never report below ~20ms, swamping any real
 * signal. `1` is the lowest resolution Node offers and moves that floor
 * below the ~1-3ms lag a healthy loop actually exhibits. The added cost is a
 * timer firing 1000x/sec instead of 50x/sec, each just recording a sample
 * into a fixed-size native histogram (no per-sample allocation, so memory
 * use — the constrained resource under `MemoryHigh=768M` — is unaffected);
 * the CPU cost of that is negligible next to everything else a request
 * handler does.
 */
const EVENT_LOOP_DELAY_RESOLUTION_MS = 1;

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
    // ── Latency-sample provenance ───────────────────────────────────────────
    // Both call-latency histograms are fed from two different clocks (the call
    // record's, shared between instances, and this process's own), and a shift
    // in the mix moves the distribution on its own. Counting the sources keeps
    // them separable in analysis instead of silently blended.
    //
    // Measured from the shared record's `answeredAt`: works for every call,
    // including one accepted on the other instance.
    call_connect_latency_shared: 0,
    // Measured from this process's own `accepted` timestamp, because the
    // record carried no usable `answeredAt`. Same-instance calls only.
    call_connect_latency_local: 0,
    // Neither source was usable: `answeredAt` was absent *and* this process
    // never saw the accept. These are the samples the histogram loses.
    call_connect_latency_unmeasured: 0,
    // Rejected because the elapsed time was negative or beyond the media
    // timeout — i.e. the two hosts' clocks disagree. A non-zero value here
    // means NTP on the signaling VMs needs attention, and it means the
    // histogram is *under*-counting, not that the calls were fast.
    call_connect_latency_skew_rejected: 0,
    // The same four, for `call_setup_latency_ms` measured from the record's
    // `createdAt` (the ring start for any call that rang).
    call_setup_latency_shared: 0,
    call_setup_latency_local: 0,
    call_setup_latency_unmeasured: 0,
    call_setup_latency_skew_rejected: 0,
    // The same four again, for `call_ring_duration_ms` measured from the
    // record's `createdAt`.
    call_ring_duration_shared: 0,
    call_ring_duration_local: 0,
    call_ring_duration_unmeasured: 0,
    call_ring_duration_skew_rejected: 0,
    // Ends this process could not attribute to a ring *or* a conversation:
    // the record says the call was answered, but the `in_call` transition was
    // handled by a peer instance, so no duration sample can be taken here. The
    // sample is not lost — the instance that handled `in_call` takes it — but
    // charging it to the ring histogram would be a lie, so it is counted.
    call_ring_duration_answered_elsewhere: 0,
    // ── RTC hold-and-replay buffer (see rtcBuffer.ts) ───────────────────────
    // These four count *ICE candidates held during a ring* and nothing else:
    // `rtcBuffer.ts` buffers only `rtc.candidate`, and only while the call is
    // `ringing`. An SDP frame can never increment any of them, so an all-zero
    // reading says nothing whatsoever about whether an offer or answer was
    // delivered — that question is answered by the `rtc_relays_*` counters
    // below.
    rtc_signals_buffered: 0, // frames held because the call was still ringing
    rtc_signals_replayed: 0, // held frames released into a media-ready call
    rtc_signals_stranded_local: 0, // discarded: the call ended on this instance
    rtc_signals_stranded_remote: 0, // discarded: a peer instance moved the call
    // ── RTC relay (see signaling/callHandlers.ts) ───────────────────────────
    // Every frame this instance forwarded to the peer's user room, split by
    // event so a missing offer is distinguishable from a missing answer.
    rtc_relays_offer: 0,
    rtc_relays_answer: 0,
    rtc_relays_candidate: 0,
    rtc_relays_other: 0,
    // Of the relays whose recipients were counted, those that reached *no*
    // socket anywhere on the fleet. The emit is a room broadcast, so this is
    // the only evidence that a frame was acknowledged as sent and silently
    // went nowhere.
    rtc_relays_no_recipient: 0,
    signaling_errors: 0, // acknowledgeError / error ack responses
    message_persist_errors: 0, // accepted messages that failed durable persistence
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
    /** Redis cache round-trip duration, in ms. */
    redis_query_duration_ms: createHistogram(QUERY_LATENCY_BUCKETS_MS),
    /** Per-window mean event-loop scheduling lag, in ms — the sustained-lag signal. */
    event_loop_lag_ms: createHistogram(EVENT_LOOP_LAG_BUCKETS_MS),
    /** Per-window maximum event-loop scheduling lag, in ms — the worst-tick/spike signal. */
    event_loop_lag_max_ms: createHistogram(EVENT_LOOP_LAG_BUCKETS_MS),
  };
  const eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
  eventLoopDelay.enable();
  const eventLoopDelaySampleTimer = setInterval(() => {
    observeEventLoopDelay();
  }, EVENT_LOOP_DELAY_SAMPLE_MS);
  eventLoopDelaySampleTimer.unref();

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
  function recordAcceptedCall(
    call: { createdAt?: string | null },
    ts: CallTimestamp | undefined,
    nowMs: number
  ) {
    counters.calls_accepted += 1;
    if (ts) ts.acceptedMs = nowMs;
    observeDerivedLatency({
      histogram: histograms.call_setup_latency_ms,
      // `createdAt` is the ring start for any call that rang, and a call that
      // never rang cannot be accepted — so it carries the same meaning as the
      // in-process `ringingMs` it replaces, and is readable on both hosts.
      shared: measureElapsedMs(call.createdAt, nowMs, MAX_PLAUSIBLE_SETUP_LATENCY_MS),
      localElapsedMs: ts?.ringingMs != null ? nowMs - ts.ringingMs : null,
      provenance: {
        shared: 'call_setup_latency_shared',
        local: 'call_setup_latency_local',
        unmeasured: 'call_setup_latency_unmeasured',
        skewRejected: 'call_setup_latency_skew_rejected',
      },
    });
  }

  function recordInCall(
    call: { answeredAt?: string | null },
    ts: CallTimestamp | undefined,
    nowMs: number
  ) {
    counters.calls_in_call += 1;
    if (ts) ts.inCallMs = nowMs;
    observeDerivedLatency({
      histogram: histograms.call_connect_latency_ms,
      // The whole point of the shared source: `call.accept` is handled on the
      // callee's instance, so on a cross-instance call this process has no
      // `acceptedMs` of its own and used to observe nothing at all.
      shared: measureSinceAnswered(call, nowMs),
      localElapsedMs: ts?.acceptedMs != null ? nowMs - ts.acceptedMs : null,
      provenance: {
        shared: 'call_connect_latency_shared',
        local: 'call_connect_latency_local',
        unmeasured: 'call_connect_latency_unmeasured',
        skewRejected: 'call_connect_latency_skew_rejected',
      },
    });
  }

  /**
   * Observe one latency sample, preferring the call record's own timestamp and
   * falling back to this process's, and account for which source was used.
   *
   * A sample rejected as clock skew is **not** retried against the local
   * clock. A skewed shared timestamp means the record was stamped by another
   * host, and a call stamped elsewhere has no local timestamp to fall back to
   * anyway; keeping the outcomes disjoint makes `*_skew_rejected` mean exactly
   * "samples this histogram is missing because the clocks disagree".
   */
  function observeDerivedLatency({ histogram, shared, localElapsedMs, provenance }: {
        histogram: Histogram;
        shared: ElapsedResult;
        localElapsedMs: number | null;
        provenance: {
            shared: keyof typeof counters;
            local: keyof typeof counters;
            unmeasured: keyof typeof counters;
            skewRejected: keyof typeof counters;
        };
    }): void {
    if (shared.ok) {
      observeHistogram(histogram, shared.elapsedMs);
      counters[provenance.shared] += 1;
      return;
    }
    if (shared.reason !== 'absent') {
      counters[provenance.skewRejected] += 1;
      return;
    }
    if (localElapsedMs === null) {
      counters[provenance.unmeasured] += 1;
      return;
    }
    observeHistogram(histogram, localElapsedMs);
    counters[provenance.local] += 1;
  }

  function recordRingEnd(
    counter: 'calls_declined' | 'calls_missed',
    call: { createdAt?: string | null },
    ts: CallTimestamp | undefined,
    nowMs: number
  ) {
    counters[counter] += 1;
    observeRingDuration(call, ts, nowMs);
  }

  /**
   * Observe one `ringing → terminal` sample.
   *
   * Measured from the record's own `createdAt` in preference to this process's
   * `ringingMs`, for the same reason `call_connect_latency_ms` prefers
   * `answeredAt`: a call created on one instance and ended on another has no
   * local ring start at all, and the record's is readable from both hosts.
   */
  function observeRingDuration(
    call: { createdAt?: string | null },
    ts: CallTimestamp | undefined,
    nowMs: number
  ) {
    observeDerivedLatency({
      histogram: histograms.call_ring_duration_ms,
      shared: measureElapsedMs(call.createdAt, nowMs, MAX_PLAUSIBLE_SETUP_LATENCY_MS),
      localElapsedMs: ts?.ringingMs != null ? nowMs - ts.ringingMs : null,
      provenance: {
        shared: 'call_ring_duration_shared',
        local: 'call_ring_duration_local',
        unmeasured: 'call_ring_duration_unmeasured',
        skewRejected: 'call_ring_duration_skew_rejected',
      },
    });
  }

  function recordCallEnd(
    call: { endReason?: string | null; createdAt?: string | null; answeredAt?: string | null },
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
      return;
    }
    // `inCallMs` is only set by the instance that *handled* the `in_call`
    // transition, and a transition applied from the cross-instance bus does not
    // reach this recorder at all — so its absence does not mean the call was
    // never answered. The record knows: a call with `answeredAt` set did not
    // end during its ring, whichever host saw it connect, and charging its
    // whole conversation to `call_ring_duration_ms` is how a twenty-minute
    // "ring" gets recorded. Counted rather than silently dropped, so the
    // histogram's blind spot stays visible.
    if (typeof call.answeredAt === 'string' && call.answeredAt !== '') {
      counters.call_ring_duration_answered_elsewhere += 1;
      return;
    }
    observeRingDuration(call, ts, nowMs);
  }

  function recordCallTransition(call: { callId: string; status: string; endReason?: string | null; createdAt?: string | null; answeredAt?: string | null; }, previousStatus: string) {
    const ts = callTimestamps.get(call.callId);
    const nowMs = Date.now();

    switch (call.status) {
      case 'accepted':
        recordAcceptedCall(call, ts, nowMs);
        break;
      case 'in_call':
        recordInCall(call, ts, nowMs);
        break;
      case 'declined':
        recordRingEnd('calls_declined', call, ts, nowMs);
        break;
      case 'missed':
        recordRingEnd('calls_missed', call, ts, nowMs);
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
   * Record what became of RTC frames held while a call was still `ringing`.
   *
   * Until now the buffer's only trace was two `console.log` lines, and the
   * case that matters most — a buffer still held when a peer instance moved
   * the call — emitted neither. See `docs/media-connect-latency-diagnosis.md`.
   *
   * @param outcome - Which of the four fates the frames met.
   * @param count - How many frames; a buffer is flushed or dropped wholesale.
   */
  function recordRtcBufferOutcome(outcome: RtcBufferOutcome, count: number = 1) {
    if (!Number.isFinite(count) || count <= 0) return;
    counters[RTC_BUFFER_COUNTERS[outcome]] += count;
  }

  /**
   * Record that an RTC frame was forwarded to the peer's user room.
   *
   * The relay is a room broadcast that succeeds whether or not the peer has a
   * socket anywhere on the fleet, and it acknowledges the sender either way —
   * so a frame that went nowhere used to leave no trace at all. That is the
   * failure this counts.
   *
   * @param eventName - The relayed event; anything outside
   *   {@link RELAYED_RTC_EVENTS} is bucketed as `other`.
   * @param recipients - How many sockets the room held, or `null` when the
   *   count was not taken. Counting costs an adapter round trip, so the caller
   *   takes it only for the one-or-two-per-call SDP frames and passes `null`
   *   for the high-rate candidate stream; a `null` still counts the relay, it
   *   just cannot contribute to `rtc_relays_no_recipient`.
   */
  function recordRtcRelay(eventName: string, recipients: number | null = null) {
    const bucket = (RELAYED_RTC_EVENTS as readonly string[]).includes(eventName)
      ? (`rtc_relays_${eventName.slice('rtc.'.length)}` as keyof typeof counters)
      : 'rtc_relays_other';
    counters[bucket] += 1;
    if (recipients === 0) counters.rtc_relays_no_recipient += 1;
  }

  /**
   * Increment the signaling error counter, both in aggregate and per code.
   *
   * @param code - Error code from the acknowledgement envelope.  A missing or
   *   empty code is bucketed as `unknown`, and anything past
   *   {@link MAX_TRACKED_SIGNALING_ERROR_CODES} distinct codes as `other`, so
   *   the breakdown always sums to the aggregate `signaling_errors` counter.
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
   * Record an accepted message whose asynchronous durable persistence failed.
   */
  function recordMessagePersistenceFailure() {
    counters.message_persist_errors += 1;
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

  function observeEventLoopDelay() {
    if (eventLoopDelay.count === 0) return;
    const meanMs = eventLoopDelay.mean / 1_000_000;
    const maxMs = eventLoopDelay.max / 1_000_000;
    if (Number.isFinite(meanMs)) {
      observeHistogram(histograms.event_loop_lag_ms, meanMs);
    }
    if (Number.isFinite(maxMs)) {
      observeHistogram(histograms.event_loop_lag_max_ms, maxMs);
    }
    eventLoopDelay.reset();
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
    recordRtcBufferOutcome,
    recordRtcRelay,
    recordSignalingError,
    recordMessagePersistenceFailure,
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
