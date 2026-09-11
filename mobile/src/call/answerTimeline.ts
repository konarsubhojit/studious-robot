/**
 * Stage timing for the answer path, as pure bookkeeping.
 *
 * Everything the callee does after its `call.accept` is acknowledged —
 * checking permissions, opening the camera, building the peer connection,
 * sending the answer — runs inside the server's `accepted → in_call` window
 * and so is charged to `call_connect_latency_ms`. None of it was measured:
 * the receipts the device already sends carry a `latencyMs` the *server*
 * computes from the call record, which cannot see a client-side step at all
 * (`docs/media-connect-latency-diagnosis.md` §6).
 *
 * This module answers "how long did that stage take, and how far into the
 * answer are we", and nothing else. No I/O, no React, no receipts — the hooks
 * own those. It lives here rather than in a hook because the stages are
 * observed from two different hooks (`useAnswerPath` for media acquisition,
 * `useSignalingSocket` for the answer that is sent from the offer handler),
 * and a module keyed by callId is the seam both can reach without either
 * owning the other.
 */

/** A stage mark, relative to the start of the answer. */
export type AnswerStageTiming = {
  /** Time taken by this stage alone, i.e. since the previous mark. */
  stageMs: number;
  /**
   * Time since the server recorded the accept, i.e. since
   * {@link markAnswerAccepted} rebased the origin.
   *
   * Deliberately *not* measured from the Answer tap: this number exists to be
   * compared against the server's `accepted → in_call` interval, and the
   * accept round trip sits before that window opens. Until the accept is
   * acknowledged it is measured from the tap, which is the closest available
   * origin and is only ever used by stages that precede the ack.
   */
  sinceAcceptMs: number;
};

type AnswerTimeline = { startedMs: number; lastMs: number };

/**
 * How many answers are tracked at once.
 *
 * One is the normal case and two covers an answer racing a call that is being
 * torn down. The cap exists because `endAnswerTimeline` is best-effort — a
 * call that dies between stages must not leak an entry forever — and the
 * oldest entry is evicted rather than the newest rejected, so a stuck old
 * answer can never stop the live one being measured.
 */
const MAX_TRACKED_ANSWERS = 4;

const timelines = new Map<string, AnswerTimeline>();

/**
 * Start timing an answer. Restarts the clock if one was already running for
 * this call, which is what a retried accept should do.
 *
 * @param callId - The call being answered.
 * @param nowMs - Epoch milliseconds; injectable so tests need no fake timers.
 */
export function beginAnswerTimeline(callId: string | null | undefined, nowMs: number = Date.now()): void {
  if (!callId) return;
  if (!timelines.has(callId) && timelines.size >= MAX_TRACKED_ANSWERS) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = timelines.keys().next().value;
    if (oldest !== undefined) timelines.delete(oldest);
  }
  timelines.set(callId, { startedMs: nowMs, lastMs: nowMs });
}

/**
 * Close out one stage of the answer.
 *
 * @returns The stage's own duration and the elapsed time since the accept, or
 *   `null` when this call is not being timed — a stage reported for an
 *   untracked call is a receipt without a duration, never a fabricated zero.
 */
export function markAnswerStage(
  callId: string | null | undefined,
  nowMs: number = Date.now(),
): AnswerStageTiming | null {
  if (!callId) return null;
  const timeline = timelines.get(callId);
  if (!timeline) return null;
  // A clock that went backwards (NTP step, device sleep accounting) would
  // otherwise report a negative stage; clamp rather than emit a duration the
  // server would reject anyway.
  const stageMs = Math.max(0, nowMs - timeline.lastMs);
  const sinceAcceptMs = Math.max(0, nowMs - timeline.startedMs);
  timeline.lastMs = nowMs;
  return { stageMs, sinceAcceptMs };
}

/**
 * Mark the accept as acknowledged, closing the accept round trip as a stage
 * and rebasing `sinceAcceptMs` onto it.
 *
 * The round trip happens before the server's `accepted → in_call` window
 * opens, so leaving it inside the origin would charge a network hop to the
 * first stage that reports — and would make every `sinceAcceptMs` larger than
 * the server-side interval it is meant to explain.
 *
 * @returns The accept round trip's duration, or `null` when untracked.
 */
export function markAnswerAccepted(
  callId: string | null | undefined,
  nowMs: number = Date.now(),
): AnswerStageTiming | null {
  const timing = markAnswerStage(callId, nowMs);
  if (!timing) return null;
  const timeline = timelines.get(callId as string);
  if (timeline) timeline.startedMs = nowMs;
  return timing;
}

/** Stop timing an answer. Safe to call for a call that was never tracked. */
export function endAnswerTimeline(callId: string | null | undefined): void {
  if (!callId) return;
  timelines.delete(callId);
}

/** Whether an answer is currently being timed. */
export function isAnswerTimelineActive(callId: string | null | undefined): boolean {
  return Boolean(callId) && timelines.has(callId as string);
}

/** Drop every timeline. Test seam; the app has no reason to call this. */
export function resetAnswerTimelines(): void {
  timelines.clear();
}
