/**
 * Hold-and-replay for RTC signals that arrive before a call is media-ready.
 *
 * Trickle ICE starts the instant the callee taps accept, so candidates
 * routinely reach the server while the call is still `ringing` — the accept is
 * in flight, or was handled by the other instance. They used to be answered
 * with `stale_call_state` and dropped, which starves ICE: the call reaches
 * `connecting_media`, never gathers a working pair, and dies on the media
 * timeout instead of connecting.
 *
 * Buffering them is not a state-machine loophole. Nothing is relayed early:
 * the frames are replayed only once the call actually reaches a media-ready
 * state, and are dropped outright when it ends.
 */
import {
  MAX_BUFFERED_RTC_SIGNALS_PER_CALL,
  RTC_ACTIVE_CALL_STATES,
  SIGNALING_VERSION,
  TERMINAL_CALL_STATES,
} from '../config.ts';
import { emitToUserSockets } from '../domain/notifications.ts';
import { CLIENT_EVENTS } from '../../../shared/index.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type PendingRtcSignal = import('../stores/contracts.ts').PendingRtcSignal;

/**
 * Statuses whose RTC frames are worth keeping.
 *
 * Only the ring: a call that has not been accepted yet is one whose media is
 * about to be negotiated. Terminal calls buffer nothing, and media-ready calls
 * relay directly.
 */
const BUFFERABLE_CALL_STATES = new Set(['ringing']);

/**
 * Only trickled ICE candidates are replayed.
 *
 * Candidates race the accept legitimately: the caller's peer connection starts
 * gathering as soon as it has a local description, so a candidate can reach the
 * server microseconds before the callee's `call.accept` lands. Replaying it is
 * exactly what the peer would have received had the two arrived in the other
 * order.
 *
 * `rtc.offer`/`rtc.answer` are deliberately excluded: an offer sent while the
 * call is still `ringing` is a client protocol violation rather than a race,
 * and the rejection is the signal that surfaces it. `call.media-state` is
 * excluded for a different reason — it reports whether a track is muted *now*,
 * so a copy replayed seconds later would announce a state that has since
 * changed.
 */
const BUFFERABLE_RTC_EVENTS = new Set<string>([CLIENT_EVENTS.RTC_CANDIDATE]);

/**
 * Whether a frame for this event, in this state, is worth holding rather than
 * rejecting.
 */
function isBufferableSignal(eventName: string, status: string): boolean {
  return BUFFERABLE_RTC_EVENTS.has(eventName) && BUFFERABLE_CALL_STATES.has(status);
}

/**
 * Queue a signal for replay.
 *
 * @returns whether it was accepted; `false` means the per-call cap is reached
 *   and the caller should report the frame as rejected, as before.
 */
function bufferRtcSignal(state: ServerState, callId: string, signal: PendingRtcSignal): boolean {
  state.pendingRtcSignals ??= new Map();
  const pending = state.pendingRtcSignals.get(callId) ?? [];
  // Bounded: the queue is filled by a client, so an unbounded one is a memory
  // amplification vector. The cap is per call and generous enough for a normal
  // gathering phase.
  if (pending.length >= MAX_BUFFERED_RTC_SIGNALS_PER_CALL) return false;
  pending.push(signal);
  state.pendingRtcSignals.set(callId, pending);
  return true;
}

/** How many signals are currently held for `callId`. */
function countBufferedRtcSignals(state: ServerState, callId: string): number {
  return state.pendingRtcSignals?.get(callId)?.length ?? 0;
}

/** Forget every signal held for `callId`. */
function discardBufferedRtcSignals(state: ServerState, callId: string): number {
  const held = countBufferedRtcSignals(state, callId);
  state.pendingRtcSignals?.delete(callId);
  return held;
}

/**
 * Replay everything held for a call that has just become media-ready, or drop
 * it if the call ended instead.
 *
 * Safe to call after any transition: a call that is neither media-ready nor
 * terminal (there is none today, but the state machine may grow one) keeps its
 * buffer.
 *
 * @param io - Socket.IO server; delivery is by user room, so a replayed frame
 *   reaches the peer wherever it is connected.
 * @returns Number of signals replayed.
 */
function flushBufferedRtcSignals(io: any, state: ServerState, callId: string, status: string): number {
  if (TERMINAL_CALL_STATES.has(status)) {
    const dropped = discardBufferedRtcSignals(state, callId);
    if (dropped > 0) {
      console.log(`[signaling] rtc.buffer_dropped callId=${callId} count=${dropped} status=${status}`);
    }
    return 0;
  }
  if (!RTC_ACTIVE_CALL_STATES.has(status)) return 0;

  const pending = state.pendingRtcSignals?.get(callId);
  if (!pending || pending.length === 0) return 0;
  state.pendingRtcSignals?.delete(callId);

  for (const signal of pending) {
    emitToUserSockets(io, signal.toUserId, signal.eventName, {
      version: SIGNALING_VERSION,
      callId,
      fromUserId: signal.fromUserId,
      [signal.dataKey]: signal.value,
    });
  }
  console.log(`[signaling] rtc.buffer_flushed callId=${callId} count=${pending.length} status=${status}`);
  return pending.length;
}

export {
  BUFFERABLE_CALL_STATES,
  BUFFERABLE_RTC_EVENTS,
  bufferRtcSignal,
  countBufferedRtcSignals,
  discardBufferedRtcSignals,
  flushBufferedRtcSignals,
  isBufferableSignal,
};
