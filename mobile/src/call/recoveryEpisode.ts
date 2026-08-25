import { CALL_RECOVERY_BUDGET_MS, CALL_RECOVERY_MAX_EPISODE_MS } from '../../../shared';

/**
 * A bounded, pausable *recovery episode* for a call whose media path broke.
 *
 * What this replaces was a single latched timer: the first `disconnected` dip
 * armed a 12s fuse, and when it burned down the client told the server its
 * media had failed — which the server maps straight to "end the call". A
 * Wi-Fi⇄cellular handoff routinely takes longer than that, so the "grace
 * period" was really a 12s client-initiated hangup, and it could never be
 * re-armed, extended, or paused: it ran even through the offline window in
 * which recovery is impossible, so the budget was spent waiting rather than
 * trying.
 *
 * An episode instead owns the whole outage:
 *
 *   - it **opens** on the first symptom (an ICE dip, an ICE failure, a socket
 *     disconnect, or a network path change) and closes on genuine recovery;
 *   - it is **paused** whenever recovery is impossible — no connectivity, or no
 *     signaling socket — so the budget is spent on attempts, not on waiting;
 *   - a genuine new network transition **extends** it rather than being
 *     swallowed by a latch, bounded by an absolute ceiling so a flapping
 *     interface cannot keep a dead call alive forever;
 *   - it counts the restart attempts made against it, so the ladder can run for
 *     the whole budget instead of a fixed number of rungs.
 *
 * Extracted from `useCallFlow.ts` (which is already 3,500 lines) so this logic
 * can be unit-tested directly rather than only through the hook harness.
 */

/** What opened or extended an episode; carried into every log line about it. */
export type RecoveryTrigger =
  | 'ice-disconnected'
  | 'ice-failure'
  | 'socket-disconnect'
  | 'socket-reconnect'
  | 'network-change';

/** Why the budget is currently not running. */
export type RecoveryPauseReason = 'no-connectivity' | 'socket-offline';

/** Everything a log line, metric, or banner needs to describe an episode. */
export type RecoveryEpisodeSnapshot = {
  trigger: RecoveryTrigger;
  startedAtMs: number;
  deadlineAtMs: number;
  attempts: number;
  extensions: number;
  pausedMs: number;
  pauseReason: RecoveryPauseReason | null;
  remainingMs: number;
};

/** The closing record of an episode, for one correlated log line. */
export type RecoveryEpisodeSummary = RecoveryEpisodeSnapshot & {
  outcome: string;
  elapsedMs: number;
};

export type RecoveryEpisodeOptions = {
  /** How long recovery may run, excluding paused time. */
  budgetMs?: number;
  /** Absolute ceiling across all extensions. */
  maxEpisodeMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
};

type EpisodeState = {
  trigger: RecoveryTrigger;
  startedAtMs: number;
  deadlineAtMs: number;
  ceilingAtMs: number;
  attempts: number;
  extensions: number;
  pausedMs: number;
  pausedAtMs: number | null;
  pauseReason: RecoveryPauseReason | null;
};

export type RecoveryEpisode = {
  /** Open an episode, or extend the open one for a genuinely new trigger. */
  note: (trigger: RecoveryTrigger) => 'opened' | 'extended' | 'ignored';
  /** Stop the clock because recovery is impossible right now. */
  pause: (reason: RecoveryPauseReason) => boolean;
  /** Restart the clock, giving back exactly the time that was paused. */
  resume: () => boolean;
  /** Close the episode, returning its summary (or `null` if none was open). */
  close: (outcome: string) => RecoveryEpisodeSummary | null;
  /** Count one restart attempt against the budget. */
  recordAttempt: () => number;
  isOpen: () => boolean;
  isPaused: () => boolean;
  /** Milliseconds of budget left, or `0` once it is spent. */
  remainingMs: () => number;
  /** Whether the budget is spent. A paused episode never expires. */
  hasExpired: () => boolean;
  attemptCount: () => number;
  snapshot: () => RecoveryEpisodeSnapshot | null;
};

/**
 * Triggers that represent a genuinely new event worth extending an open
 * episode for.
 *
 * A repeated ICE symptom is *the same outage still being observed* and must not
 * buy more time, or a permanently dead connection would extend itself
 * indefinitely (up to the ceiling) on its own state changes. A network path
 * change is different: it is new information that recovery might now be
 * possible, and it is exactly what the old latch swallowed.
 */
const EXTENDING_TRIGGERS = new Set<RecoveryTrigger>(['network-change', 'socket-reconnect']);

/**
 * Create an episode tracker for one call.
 */
export function createRecoveryEpisode(options: RecoveryEpisodeOptions = {}): RecoveryEpisode {
  const budgetMs = options.budgetMs ?? CALL_RECOVERY_BUDGET_MS;
  const maxEpisodeMs = options.maxEpisodeMs ?? CALL_RECOVERY_MAX_EPISODE_MS;
  const now = options.now ?? Date.now;

  let episode: EpisodeState | null = null;

  function describe(state: EpisodeState, at: number): RecoveryEpisodeSnapshot {
    return {
      trigger: state.trigger,
      startedAtMs: state.startedAtMs,
      deadlineAtMs: state.deadlineAtMs,
      attempts: state.attempts,
      extensions: state.extensions,
      pausedMs: totalPausedMs(state, at),
      pauseReason: state.pauseReason,
      remainingMs: remainingFor(state, at),
    };
  }

  function totalPausedMs(state: EpisodeState, at: number): number {
    if (state.pausedAtMs === null) return state.pausedMs;
    return state.pausedMs + Math.max(0, at - state.pausedAtMs);
  }

  function remainingFor(state: EpisodeState, at: number): number {
    // A paused episode is frozen: its deadline is re-based on resume, so the
    // remaining budget is whatever was left when the clock stopped.
    const reference = state.pausedAtMs ?? at;
    return Math.max(0, state.deadlineAtMs - reference);
  }

  function note(trigger: RecoveryTrigger): 'opened' | 'extended' | 'ignored' {
    const at = now();
    if (!episode) {
      episode = {
        trigger,
        startedAtMs: at,
        deadlineAtMs: at + budgetMs,
        ceilingAtMs: at + maxEpisodeMs,
        attempts: 0,
        extensions: 0,
        pausedMs: 0,
        pausedAtMs: null,
        pauseReason: null,
      };
      return 'opened';
    }
    if (!EXTENDING_TRIGGERS.has(trigger)) return 'ignored';

    // The ceiling moves with paused time for the same reason the deadline
    // does: time in which recovery was impossible was never the call's to
    // spend.
    const ceiling = episode.ceilingAtMs + episode.pausedMs;
    const base = episode.pausedAtMs ?? at;
    const extended = Math.min(base + budgetMs, ceiling);
    if (extended <= episode.deadlineAtMs) return 'ignored';
    episode.deadlineAtMs = extended;
    episode.extensions += 1;
    return 'extended';
  }

  function pause(reason: RecoveryPauseReason): boolean {
    if (!episode || episode.pausedAtMs !== null) return false;
    episode.pausedAtMs = now();
    episode.pauseReason = reason;
    return true;
  }

  function resume(): boolean {
    if (!episode || episode.pausedAtMs === null) return false;
    const at = now();
    const pausedFor = Math.max(0, at - episode.pausedAtMs);
    episode.pausedMs += pausedFor;
    episode.deadlineAtMs += pausedFor;
    episode.ceilingAtMs += pausedFor;
    episode.pausedAtMs = null;
    episode.pauseReason = null;
    return true;
  }

  function close(outcome: string): RecoveryEpisodeSummary | null {
    if (!episode) return null;
    const at = now();
    const summary: RecoveryEpisodeSummary = {
      ...describe(episode, at),
      outcome,
      elapsedMs: at - episode.startedAtMs,
    };
    episode = null;
    return summary;
  }

  return {
    note,
    pause,
    resume,
    close,
    recordAttempt: () => {
      if (!episode) return 0;
      episode.attempts += 1;
      return episode.attempts;
    },
    isOpen: () => episode !== null,
    isPaused: () => episode?.pausedAtMs !== null && episode !== null,
    remainingMs: () => (episode ? remainingFor(episode, now()) : 0),
    hasExpired: () => {
      if (!episode) return false;
      if (episode.pausedAtMs !== null) return false;
      return remainingFor(episode, now()) <= 0;
    },
    attemptCount: () => episode?.attempts ?? 0,
    snapshot: () => (episode ? describe(episode, now()) : null),
  };
}
