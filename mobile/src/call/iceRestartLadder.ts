/**
 * The ICE-recovery ladder, as pure decision logic.
 *
 * `useCallFlow` owns every side effect of recovery — fetching ICE servers,
 * creating the restart offer, arming timers, emitting signaling — but the rules
 * that decide *whether* to restart, *when*, and *what to report* were tangled
 * up with those effects and could only be reached from a test by mounting the
 * whole hook and driving a fake peer connection. They are the least directly
 * tested code in the app and the most expensive to get wrong: a dropped call.
 *
 * So they live here instead: trigger in, decision out. No React, no WebRTC, no
 * refs, no timers. The hook feeds this module the state it already holds and
 * executes what comes back, which is why the extraction is behaviour-preserving
 * — the same rules, in a place where each one is a table-driven unit test.
 *
 * The same seam that already worked for `callStateMachine.ts` and
 * `recoveryEpisode.ts`.
 */

import type { RecoveryTrigger } from './recoveryEpisode';

/**
 * Backoff between rungs of the ICE-restart ladder.
 *
 * The ladder used to be three fixed rungs (`[0, 1500, 4000]`), exhausted ~5.5s
 * into an outage — after which nothing happened at all until the call was
 * declared dead. It now runs on a capped exponential backoff for as long as the
 * recovery episode has budget left, so a handoff that takes twenty seconds to
 * settle still gets attempts throughout.
 *
 * The first rung is immediate: beating ICE to the punch is the whole point.
 */
export const ICE_RESTART_BACKOFF_BASE_MS = 1500;
export const ICE_RESTART_BACKOFF_MAX_MS = 8000;

/**
 * Delay before retrying a rung that could not run because of a precondition
 * which clears on its own (a negotiation in flight, a socket that is coming
 * back). Such a retry deliberately does *not* consume a rung: the proactive
 * network-change attempt was otherwise always spent doing nothing, because a
 * handoff drops the socket for far longer than the debounce that scheduled it.
 */
export const ICE_RESTART_PRECONDITION_RETRY_MS = 1000;

/**
 * How long the peer that loses the tie-break waits before restarting.
 *
 * Both peers react to a failure, so without a tie-break both would send an
 * `rtc.offer` at once and glare. The lexicographically lower userId restarts
 * immediately; the other waits this long and only proceeds if the connection
 * has not come back in the meantime.
 */
export const ICE_RESTART_TIEBREAK_MS = 1500;

/** ICE/connection states that mean media is flowing again. */
const RECOVERED_STATES = new Set(['connected', 'completed']);

/** Delay for each rung of the ladder; capped so backoff cannot run away. */
export function iceRestartBackoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(
    ICE_RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 2),
    ICE_RESTART_BACKOFF_MAX_MS
  );
}

/**
 * How long this peer waits before restarting, so two peers that both saw the
 * failure do not offer at once. Lower userId goes first; the other only acts if
 * the connection is still down when its turn comes.
 *
 * With no peer id to compare there is no glare risk worth a delay.
 */
export function iceRestartTiebreakMs(
  localUserId: string | null | undefined,
  remoteUserId: string | null | undefined,
): number {
  const local = (localUserId ?? '').trim();
  const remote = (remoteUserId ?? '').trim();
  if (!local || !remote || local === remote) return 0;
  return local < remote ? 0 : ICE_RESTART_TIEBREAK_MS;
}

/**
 * Whether the peer connection is carrying media again.
 *
 * Both state machines are consulted by the caller: `iceConnectionState` moves
 * first, but a stub (or a platform that only surfaces `connectionState`) may
 * not have it.
 */
export function isRecoveredIceState(state: string | null | undefined): boolean {
  return typeof state === 'string' && RECOVERED_STATES.has(state);
}

/** What the hook knows about the open recovery episode when it asks. */
export type EpisodeView = {
  isOpen: boolean;
  isPaused: boolean;
  pauseReason: string | null;
  hasExpired: boolean;
};

export type ScheduleLadderInput = {
  trigger: RecoveryTrigger;
  /** Whether there is a call *and* a peer connection to restart. */
  hasActiveCall: boolean;
  /** A rung already queued, or an attempt in flight. */
  isPending: boolean;
  /** Rungs consumed by this ladder so far. */
  attempt: number;
  episode: EpisodeView;
  /** `false` for a retry of a rung blocked by a self-clearing precondition. */
  consumeAttempt?: boolean;
  localUserId?: string | null;
  remoteUserId?: string | null;
};

export type ScheduleLadderDecision =
  | { action: 'skip'; reason: 'no-active-call' | 'already-pending' | 'budget-spent' }
  | { action: 'skip'; reason: 'paused'; pauseReason: string | null }
  | {
      action: 'schedule';
      /** The rung this decision belongs to, after any increment. */
      attempt: number;
      /** Whether the caller must count this attempt against the budget. */
      consumeAttempt: boolean;
      backoffMs: number;
      tiebreakMs: number;
      delayMs: number;
    };

/**
 * Decide whether — and how far out — to queue the next rung of the ladder.
 *
 * The ladder is driven by the recovery budget rather than by a fixed attempt
 * count: it keeps restarting on a capped exponential backoff until either the
 * connection recovers or the budget expires.
 */
export function decideLadderSchedule(input: ScheduleLadderInput): ScheduleLadderDecision {
  const { episode } = input;
  if (!input.hasActiveCall) return { action: 'skip', reason: 'no-active-call' };
  if (input.isPending) return { action: 'skip', reason: 'already-pending' };
  if (episode.isOpen && episode.isPaused) {
    // Nothing can be restarted with no connectivity or no socket; the resume
    // path re-enters the ladder the moment recovery is possible again, so
    // retrying here would only burn CPU against a dead interface.
    return { action: 'skip', reason: 'paused', pauseReason: episode.pauseReason };
  }
  if (episode.isOpen && episode.hasExpired) return { action: 'skip', reason: 'budget-spent' };

  const consumeAttempt = input.consumeAttempt !== false;
  const attempt = consumeAttempt ? input.attempt + 1 : input.attempt;
  const backoffMs = consumeAttempt
    ? iceRestartBackoffMs(attempt)
    : ICE_RESTART_PRECONDITION_RETRY_MS;
  // The tie-break applies to every rung, not just the first: once both peers
  // are laddering, later rungs glare exactly as the first one would.
  const tiebreakMs = iceRestartTiebreakMs(input.localUserId, input.remoteUserId);
  return {
    action: 'schedule',
    attempt,
    consumeAttempt,
    backoffMs,
    tiebreakMs,
    delayMs: backoffMs + tiebreakMs,
  };
}

export type RunLadderInput = {
  trigger: RecoveryTrigger;
  hasActiveCall: boolean;
  /** The rung about to run. */
  attempt: number;
  /** The peer connection's current ICE (or connection) state. */
  iceState: string | null | undefined;
  socketConnected: boolean;
  isNegotiating: boolean;
};

export type RunLadderDecision =
  | { action: 'abort'; reason: 'no-active-call' | 'recovered' }
  | { action: 'defer'; reason: 'socket-offline' | 'negotiating' }
  | { action: 'restart' };

/**
 * Decide whether the rung that just came due may actually run.
 *
 * A network change is acted on *before* ICE notices the old path is dead, so on
 * its first attempt a still-"connected" state is expected and is not a reason
 * to skip. Every other case stops the moment media is back.
 *
 * The two `defer` cases clear on their own, so they cost a retry rather than a
 * rung: the caller has already counted this attempt and left no timer behind.
 */
export function decideLadderRun(input: RunLadderInput): RunLadderDecision {
  if (!input.hasActiveCall) return { action: 'abort', reason: 'no-active-call' };
  const proactive = input.trigger === 'network-change' && input.attempt <= 1;
  if (!proactive && isRecoveredIceState(input.iceState)) {
    return { action: 'abort', reason: 'recovered' };
  }
  if (!input.socketConnected) return { action: 'defer', reason: 'socket-offline' };
  if (input.isNegotiating) return { action: 'defer', reason: 'negotiating' };
  return { action: 'restart' };
}

/**
 * Whether a cached ICE-server list may serve another rung.
 *
 * One usable list per episode: re-fetching on every rung means a network
 * round-trip per attempt, over the very network that just broke. A list with no
 * relay is never cached, so the forced re-fetch below still happens next rung.
 */
export function canReuseIceServers(cachedHasTurn: boolean | null | undefined): boolean {
  return cachedHasTurn === true;
}

export type FetchedIceServersDecision = 'cache-and-use' | 'refetch' | 'use-without-turn';

/**
 * What to do with a freshly fetched ICE-server list.
 *
 * A handoff is exactly when TURN matters: the new path is far more likely to
 * sit behind carrier-grade NAT, so restarting on a STUN-only list usually just
 * fails again. A missing relay is therefore an error worth one forced re-fetch
 * — but never a reason to abandon the restart, since degraded recovery still
 * beats none.
 */
export function decideFetchedIceServers(
  hasTurn: boolean,
  isRefetch: boolean,
): FetchedIceServersDecision {
  if (hasTurn) return 'cache-and-use';
  return isRefetch ? 'use-without-turn' : 'refetch';
}

export type RecoveryExhaustedInput = {
  /** The peer connection's current ICE (or connection) state. */
  iceState: string | null | undefined;
  socketConnected: boolean;
  /** Worst ICE state seen during the episode. */
  worstIceState: string;
};

export type RecoveryExhaustedDecision =
  | { action: 'close'; outcome: 'recovered' }
  | { action: 'skip-report'; reason: 'offline' }
  | { action: 'report-failure'; iceState: 'failed' | 'disconnected' };

/**
 * Decide what a spent recovery budget means.
 *
 * The server maps a terminal `iceState` straight to "end this call", so the
 * report is a hangup and is treated as one: it is only ever sent over a live
 * socket, never queued, because a report queued while offline was — on
 * precisely the handoff this machinery exists to survive — the first thing
 * replayed on reconnect, defeating recovery by its own success.
 */
export function decideRecoveryExhausted(
  input: RecoveryExhaustedInput,
): RecoveryExhaustedDecision {
  if (isRecoveredIceState(input.iceState)) return { action: 'close', outcome: 'recovered' };
  if (!input.socketConnected) return { action: 'skip-report', reason: 'offline' };
  return {
    action: 'report-failure',
    iceState: input.worstIceState === 'failed' ? 'failed' : 'disconnected',
  };
}

export type IceConnectionStateDecision =
  | { action: 'recovered' }
  | { action: 'symptom'; trigger: RecoveryTrigger; restart: boolean }
  | { action: 'ignore' };

/**
 * What an observed `iceConnectionState` means for the ladder.
 *
 * `connected`/`completed` clear the ladder: media is back, so any queued rung
 * would only glare with a healthy connection. A failure starts a fresh ladder;
 * a mere dip records the symptom (which opens the recovery episode) but does
 * not restart, because ICE recovers from `disconnected` on its own more often
 * than not.
 */
export function decideIceConnectionState(
  state: string | null | undefined,
): IceConnectionStateDecision {
  if (isRecoveredIceState(state)) return { action: 'recovered' };
  if (state === 'disconnected') {
    return { action: 'symptom', trigger: 'ice-disconnected', restart: false };
  }
  if (state === 'failed') return { action: 'symptom', trigger: 'ice-failure', restart: true };
  return { action: 'ignore' };
}
