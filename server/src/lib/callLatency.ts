/**
 * Elapsed-time measurement against timestamps carried on the call record.
 *
 * A call's lifecycle is not owned by one process. `call.accept` is handled on
 * the callee's instance while the caller's instance holds the only in-process
 * timestamps, so any latency derived from process-local clocks is blind to
 * every cross-instance call — which is precisely the population worth
 * measuring. The record's own `answeredAt` / `createdAt` are in the shared
 * store and readable from either instance, so they are the only timestamps a
 * cross-instance measurement can use.
 *
 * The cost of that is a dependency on wall-clock agreement between hosts:
 * `now - Date.parse(call.answeredAt)` is only meaningful if the two clocks
 * agree. **Both signaling VMs must run NTP.** Rather than trust that silently,
 * every measurement here is bounds-checked and an implausible result is
 * reported as such so the caller can count it instead of folding skew into a
 * latency histogram, where it is indistinguishable from a real regression.
 */

import { DEFAULT_MEDIA_CONNECT_TIMEOUT_MS, DEFAULT_RINGING_TIMEOUT_MS } from '../config.ts';

/**
 * Headroom over a state's own timeout before an elapsed time is treated as
 * clock skew rather than a slow call.
 *
 * A sweep is not instantaneous — it runs on a poll interval and the transition
 * it triggers is itself a round trip — so a measurement slightly over the
 * timeout is a real (if doomed) call, not a broken clock. Well beyond it, the
 * only explanation left is that the two hosts disagree about the time.
 */
const SKEW_HEADROOM_FACTOR = 2;

/**
 * Upper bound on a plausible `accepted → in_call` measurement.
 *
 * A call that has not reached `in_call` within `MEDIA_CONNECT_TIMEOUT_MS` is
 * force-ended with `media_connect_timeout` (`config.ts`), so no *legitimate*
 * connect latency can exceed that by much. Anything past the headroom is
 * rejected as skew.
 */
const MAX_PLAUSIBLE_CONNECT_LATENCY_MS =
  DEFAULT_MEDIA_CONNECT_TIMEOUT_MS * SKEW_HEADROOM_FACTOR;

/**
 * Upper bound on a plausible `ringing → accepted` measurement, bounded by the
 * ring timeout the same way.
 */
const MAX_PLAUSIBLE_SETUP_LATENCY_MS = DEFAULT_RINGING_TIMEOUT_MS * SKEW_HEADROOM_FACTOR;

/**
 * Tolerance for a *negative* elapsed time.
 *
 * Zero, deliberately. A timestamp in the future means the recording host's
 * clock is behind the stamping host's, and there is no amount of that which is
 * benign — unlike a large positive value, which at least has a plausible
 * innocent reading (a genuinely slow call). Treating it as a floor of `0`
 * instead would quietly report skewed calls as instantaneous ones.
 */
const MAX_NEGATIVE_SKEW_MS = 0;

/** Why a measurement could not be made, when it could not. */
export type ElapsedRejection =
  /** The record carries no such timestamp (or it is not a parseable date). */
  | 'absent'
  /** The timestamp is in the future: the two hosts' clocks disagree. */
  | 'negative'
  /** Further in the past than the state's own timeout allows: skew. */
  | 'implausible';

export type ElapsedResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; reason: ElapsedRejection };

/**
 * Milliseconds between an ISO timestamp on a call record and `nowMs`.
 *
 * @param timestamp - ISO-8601 instant from the (possibly shared) call record.
 * @param nowMs - Epoch milliseconds to measure to.
 * @param maxPlausibleMs - Ceiling past which the result is treated as clock
 *   skew rather than a slow call.
 * @returns The elapsed time, or why it is not trustworthy.
 */
function measureElapsedMs(
  timestamp: string | null | undefined,
  nowMs: number,
  maxPlausibleMs: number
): ElapsedResult {
  if (typeof timestamp !== 'string' || timestamp === '') return { ok: false, reason: 'absent' };
  const fromMs = Date.parse(timestamp);
  if (!Number.isFinite(fromMs)) return { ok: false, reason: 'absent' };

  const elapsedMs = nowMs - fromMs;
  if (elapsedMs < -MAX_NEGATIVE_SKEW_MS) return { ok: false, reason: 'negative' };
  if (elapsedMs > maxPlausibleMs) return { ok: false, reason: 'implausible' };
  return { ok: true, elapsedMs };
}

/**
 * How long a call has been in media setup, measured from the shared
 * `answeredAt` stamp so the answer and the connect may be on different hosts.
 */
function measureSinceAnswered(
  call: { answeredAt?: string | null },
  nowMs: number
): ElapsedResult {
  return measureElapsedMs(call.answeredAt, nowMs, MAX_PLAUSIBLE_CONNECT_LATENCY_MS);
}

export {
  MAX_PLAUSIBLE_CONNECT_LATENCY_MS,
  MAX_PLAUSIBLE_SETUP_LATENCY_MS,
  measureElapsedMs,
  measureSinceAnswered,
};
