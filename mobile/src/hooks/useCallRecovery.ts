import { useCallback, useEffect, useRef } from 'react';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import { emitMetric } from '../observability';
import { CLIENT_EVENTS, createSignalingClient } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import { CALL_RECOVERY_BUDGET_MS } from '../../../shared';
import { subscribeNetworkChanges } from '../networkMonitor';
import { createRecoveryEpisode } from '../call/recoveryEpisode';
import type { RecoveryPauseReason, RecoveryTrigger } from '../call/recoveryEpisode';
import {
  canReuseIceServers,
  decideFetchedIceServers,
  decideLadderRun,
  decideLadderSchedule,
  decideRecoveryExhausted,
  isRecoveredIceState,
} from '../call/iceRestartLadder';
import {
  getIceServersForCall,
  getTurnServerEndpoints,
  resetIceServersForCallCache,
} from '../webrtcConfig';
import type { IceTransportPolicy } from '../webrtcConfig';
import * as Telemetry from '../telemetry';
import type { Socket } from 'socket.io-client';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { CallHeartbeat } from './useCallHeartbeat';
import type { CallRecoveryStatus, PeerConnection } from './useCallFlow';

type MutableRef<T> = { current: T };

/**
 * What prompted an ICE restart or opened a recovery episode; carried into every
 * log line about it. Shared with `call/recoveryEpisode.ts` so a trigger means
 * the same thing to the ladder and to the budget it runs against.
 */
type IceRestartTrigger = RecoveryTrigger;

/**
 * How long connectivity must settle before a network change triggers a
 * restart, so a flapping interface produces one restart rather than a storm.
 */
const NETWORK_CHANGE_DEBOUNCE_MS = 800;

/**
 * Shared refs and lifecycle hooks the recovery ladder reads. They are owned by
 * `useCallFlow` (the call lifecycle mutates them) and passed in so the ladder
 * can act on the *current* call without depending on callback identity.
 */
export type UseCallRecoveryParams = {
  activeCallIdRef: MutableRef<string | null>;
  activeCallRef: MutableRef<CallRecord | null>;
  isCallerRef: MutableRef<boolean>;
  peerConnectionRef: MutableRef<PeerConnection | null>;
  socketRef: MutableRef<Socket | null>;
  signalingRef: MutableRef<ReturnType<typeof createSignalingClient> | null>;
  isNegotiatingRef: MutableRef<boolean>;
  userIdRef: MutableRef<string>;
  connectedReportedCallIdRef: MutableRef<string | null>;
  isConnectionLostRef: MutableRef<boolean>;
  signalingUrl: string;
  activeIceTransportPolicy: IceTransportPolicy;
  ensureIceSessionId: () => Promise<string | null>;
  startCallHeartbeat: CallHeartbeat['startCallHeartbeat'];
  setRecoveryStatus: (status: CallRecoveryStatus | null) => void;
  setIsReconnecting: (value: boolean) => void;
  setIsConnectionLost: (value: boolean) => void;
};

/**
 * Owns the media-recovery machinery: the bounded, pausable recovery episode and
 * the backed-off ICE-restart ladder that runs against it, plus the proactive
 * network-change restart. Extracted from `useCallFlow` so the ref-forwarded
 * ladder is one cohesive unit; the pure decision rules stay in
 * `call/recoveryEpisode.ts` and `call/iceRestartLadder.ts`.
 */
export default function useCallRecovery({
  activeCallIdRef,
  activeCallRef,
  isCallerRef,
  peerConnectionRef,
  socketRef,
  signalingRef,
  isNegotiatingRef,
  userIdRef,
  connectedReportedCallIdRef,
  isConnectionLostRef,
  signalingUrl,
  activeIceTransportPolicy,
  ensureIceSessionId,
  startCallHeartbeat,
  setRecoveryStatus,
  setIsReconnecting,
  setIsConnectionLost,
}: UseCallRecoveryParams) {
  // The open recovery episode: one bounded, pausable budget owning an entire
  // outage (see `call/recoveryEpisode.ts`). This replaces a single latched
  // 12s timer whose expiry told the server "my media failed" — which the
  // server maps straight to ending the call, so the "grace period" was really
  // a 12s client-initiated hangup that could never be paused or extended.
  const recoveryEpisodeRef = useRef(createRecoveryEpisode());
  // Fires when the budget is spent; re-armed on every pause, resume and
  // extension rather than being a single fixed deadline.
  const recoveryDeadlineTimerRef = useRef((null as ReturnType<typeof setTimeout> | null));
  // Worst ICE state seen during the open episode, reported if it expires.
  const recoveryIceStateRef = useRef('disconnected');
  // Whether the transport currently claims to be usable; `false` is the one
  // moment the budget must stop running, because recovery is impossible.
  const hasConnectivityRef = useRef(true);
  const armRecoveryDeadlineRef = useRef((null as (() => void) | null));
  // Ref-forwarded so the restart ladder (defined above them) can pause the
  // budget and refresh the banner without depending on callback identity.
  const pauseRecoveryBudgetRef = useRef(
    (null as ((reason: RecoveryPauseReason) => void) | null),
  );
  const publishRecoveryStatusRef = useRef((null as (() => void) | null));
  const noteRecoverySymptomRef = useRef(
    (null as ((trigger: IceRestartTrigger, iceState?: string) => void) | null),
  );
  const resumeRecoveryBudgetRef = useRef((null as ((reason: string) => void) | null));
  // Bookkeeping for the bounded, backed-off ICE-restart ladder: how many
  // attempts this loss of connectivity has used, the pending timer, and
  // whether one is already in flight.
  const iceRestartRef = useRef({
    attempt: 0,
    timer: (null as ReturnType<typeof setTimeout> | null),
    inFlight: false,
    // TURN credentials are fetched once per episode rather than once per rung:
    // the fetch travels over the very network that just broke and can add its
    // own `ICE_SESSION_WAIT_MS` to every attempt.
    iceServers: (null as any[] | null),
  });
  // Set below, so the socket/ICE/network handlers can schedule a restart
  // without depending on the callback identity.
  const scheduleIceRestartRef = useRef(
    (null as
      | ((trigger: IceRestartTrigger, options?: { consumeAttempt?: boolean; }) => void)
      | null),
  );
  const beginIceRecoveryRef = useRef((null as ((trigger: IceRestartTrigger) => void) | null));
  const cancelIceRestartsRef = useRef((null as ((reason: string) => void) | null));
  const networkChangeTimerRef = useRef((null as ReturnType<typeof setTimeout> | null));
  // When the last network change was acted on, so the *first* transition fires
  // immediately (it is the one path designed to beat ICE to the punch) and only
  // repeats inside the debounce window are coalesced.
  const lastNetworkChangeAtRef = useRef(0);

  /** Publish the open episode (or its absence) to the call screen. */
  const publishRecoveryStatus = useCallback(() => {
    const snapshot = recoveryEpisodeRef.current.snapshot();
    const restart = iceRestartRef.current;
    setRecoveryStatus(
      snapshot
        ? {
            trigger: snapshot.trigger,
            attempts: snapshot.attempts,
            remainingMs: snapshot.remainingMs,
            isPaused: snapshot.pauseReason !== null,
            pauseReason: snapshot.pauseReason,
            isAttemptPending: Boolean(restart.timer || restart.inFlight),
          }
        : null,
    );
  }, [setRecoveryStatus]);

  /**
   * Close the open recovery episode, and say how it ended.
   *
   * Logged as one correlated unit — trigger, attempts, paused time, elapsed,
   * outcome — so "why did this call drop" is one line in the diagnostics
   * export rather than a reconstruction from scattered events.
   */
  const closeRecoveryEpisode = useCallback((outcome: string) => {
    if (recoveryDeadlineTimerRef.current) {
      clearTimeout(recoveryDeadlineTimerRef.current);
      recoveryDeadlineTimerRef.current = null;
    }
    iceRestartRef.current.iceServers = null;
    const summary = recoveryEpisodeRef.current.close(outcome);
    if (!summary) return null;
    logInfo('[CallFlow] Recovery episode closed', {
      callId: activeCallIdRef.current,
      trigger: summary.trigger,
      outcome: summary.outcome,
      attempts: summary.attempts,
      extensions: summary.extensions,
      pausedMs: summary.pausedMs,
      elapsedMs: summary.elapsedMs,
    });
    emitMetric('call.recovery_episode', summary.elapsedMs, {
      callId: activeCallIdRef.current,
      trigger: summary.trigger,
      outcome: summary.outcome,
      attempts: summary.attempts,
    });
    setIsReconnecting(false);
    publishRecoveryStatus();
    return summary;
  }, [activeCallIdRef, publishRecoveryStatus, setIsReconnecting]);

  /**
   * Record that recovery is over and the media never came back.
   *
   * Kept until the call is torn down so the banner can say "Connection lost"
   * instead of vanishing with the episode, and so the end-of-call summary can
   * name the reason even when the failure was never reportable.
   */
  const markConnectionLost = useCallback(() => {
    isConnectionLostRef.current = true;
    setIsConnectionLost(true);
  }, [isConnectionLostRef, setIsConnectionLost]);

  /**
   * Report that media never came back, once the recovery budget is spent.
   *
   * The server maps a terminal `iceState` straight to "end this call", so this
   * is a hangup and is treated as one: it is only ever sent over a live socket,
   * and always with an acknowledgement so it takes the direct path rather than
   * the offline queue that a reconnect replays wholesale. A report queued while
   * offline was, on precisely the handoff this machinery exists to survive, the
   * first thing replayed on reconnect — recovery defeated by its own success.
   */
  const reportRecoveryExhausted = useCallback(() => {
    const callId = activeCallIdRef.current;
    const pc = peerConnectionRef.current;
    if (!callId || !pc) return;
    const currentState = pc.iceConnectionState ?? pc.connectionState;
    const decision = decideRecoveryExhausted({
      iceState: currentState,
      socketConnected: Boolean(socketRef.current?.connected),
      worstIceState: recoveryIceStateRef.current,
    });
    if (decision.action === 'close') {
      closeRecoveryEpisode(decision.outcome);
      return;
    }
    if (decision.action === 'skip-report') {
      logWarn('[CallFlow] Recovery budget spent while offline; not reporting failure', {
        callId,
        currentState,
      });
      // The report cannot travel, but the ladder is over either way: say so
      // rather than leaving a "Reconnecting…" banner over a dead call.
      markConnectionLost();
      return;
    }
    const iceState = decision.iceState;
    logWarn('[CallFlow] Media did not recover within the budget; reporting failure', {
      callId,
      currentState,
      iceState,
      budgetMs: CALL_RECOVERY_BUDGET_MS,
    });
    markConnectionLost();
    closeRecoveryEpisode('failed');
    signalingRef.current?.emit(
      CLIENT_EVENTS.CALL_CONNECTED,
      { version: SIGNALING_VERSION, callId, iceState },
      ack => {
        if (!ack?.ok) logWarn('[CallFlow] media-failure report ack failed', ack?.error);
      },
    );
  }, [activeCallIdRef, closeRecoveryEpisode, markConnectionLost, peerConnectionRef, signalingRef, socketRef]);

  /**
   * (Re-)arm the deadline for the open episode.
   *
   * A paused episode has no timer at all: its budget is frozen, so there is
   * nothing to expire until it resumes.
   */
  const armRecoveryDeadline = useCallback(() => {
    if (recoveryDeadlineTimerRef.current) {
      clearTimeout(recoveryDeadlineTimerRef.current);
      recoveryDeadlineTimerRef.current = null;
    }
    const episode = recoveryEpisodeRef.current;
    if (!episode.isOpen() || episode.isPaused()) return;
    recoveryDeadlineTimerRef.current = setTimeout(() => {
      recoveryDeadlineTimerRef.current = null;
      const current = recoveryEpisodeRef.current;
      if (!current.isOpen() || current.isPaused()) return;
      // The deadline may have moved (an extension, or time given back after a
      // pause) since this timer was armed.
      if (!current.hasExpired()) {
        armRecoveryDeadlineRef.current?.();
        return;
      }
      reportRecoveryExhausted();
    }, Math.max(0, episode.remainingMs()));
  }, [reportRecoveryExhausted]);

  useEffect(() => {
    armRecoveryDeadlineRef.current = armRecoveryDeadline;
    publishRecoveryStatusRef.current = publishRecoveryStatus;
  }, [armRecoveryDeadline, publishRecoveryStatus]);

  /** Stop the budget because recovery is impossible right now. */
  const pauseRecoveryBudget = useCallback((reason: RecoveryPauseReason) => {
    const episode = recoveryEpisodeRef.current;
    if (!episode.pause(reason)) return;
    logInfo('[CallFlow] Recovery budget paused', {
      callId: activeCallIdRef.current,
      reason,
      remainingMs: episode.remainingMs(),
    });
    armRecoveryDeadlineRef.current?.();
    publishRecoveryStatus();
  }, [activeCallIdRef, publishRecoveryStatus]);

  useEffect(() => {
    pauseRecoveryBudgetRef.current = pauseRecoveryBudget;
  }, [pauseRecoveryBudget]);

  /** Give back exactly the time recovery was impossible for. */
  const resumeRecoveryBudget = useCallback((reason: string) => {
    const episode = recoveryEpisodeRef.current;
    if (!episode.resume()) return;
    logInfo('[CallFlow] Recovery budget resumed', {
      callId: activeCallIdRef.current,
      reason,
      remainingMs: episode.remainingMs(),
    });
    armRecoveryDeadlineRef.current?.();
    publishRecoveryStatus();
    // The ladder stops while the episode is paused, because nothing can be
    // negotiated with no connectivity or no socket. Re-entering it here is what
    // makes that a pause rather than an abandonment: the rung that could not
    // run is retried the moment recovery is possible again, without having been
    // counted against the budget.
    if (!activeCallIdRef.current || !peerConnectionRef.current) return;
    if (isPeerConnectionRecovered(peerConnectionRef.current)) return;
    scheduleIceRestartRef.current?.(
      episode.snapshot()?.trigger ?? 'network-change',
      { consumeAttempt: false },
    );
  }, [activeCallIdRef, peerConnectionRef, publishRecoveryStatus]);

  /**
   * Record a symptom of a broken media path: open a recovery episode, or
   * extend the open one when the trigger is genuinely new information.
   *
   * Nothing terminal is reported from here. While an episode is open the
   * client never tells the server its media failed — that only happens once
   * the whole budget has been spent with the connection still down.
   */
  const noteRecoverySymptom = useCallback(
    (trigger: IceRestartTrigger, iceState?: string) => {
      if (!activeCallIdRef.current) return;
      if (iceState) recoveryIceStateRef.current = iceState;
      const episode = recoveryEpisodeRef.current;
      const result = episode.note(trigger);
      if (result !== 'ignored') {
        logInfo(`[CallFlow] Recovery episode ${result}`, {
          callId: activeCallIdRef.current,
          trigger,
          iceState: iceState ?? null,
          remainingMs: episode.remainingMs(),
        });
      }
      if (!hasConnectivityRef.current) episode.pause('no-connectivity');
      else if (!socketRef.current?.connected) episode.pause('socket-offline');
      setIsReconnecting(true);
      armRecoveryDeadlineRef.current?.();
      publishRecoveryStatus();
    },
    [activeCallIdRef, publishRecoveryStatus, setIsReconnecting, socketRef],
  );

  /**
   * Tell the server this device's media is connected.
   *
   * This is the only signal that advances the call out of `connecting_media`;
   * without it the server's stale-call sweep force-ends every answered call
   * with `media_connect_timeout` while media is still flowing.  Both peers
   * report and the server accepts whichever arrives first.
   *
   * @param iceState - the observed peer-connection/ICE state.
   */
  const reportCallConnected = useCallback(
      (iceState: string) => {
      const callId = activeCallIdRef.current;
      if (!callId) return;
      closeRecoveryEpisode('recovered');
      startCallHeartbeat(`media-connected:${iceState}`);
      if (connectedReportedCallIdRef.current === callId) return;
      connectedReportedCallIdRef.current = callId;
      logInfo('[CallFlow] Media connected; reporting call.connected', { callId, iceState });
      signalingRef.current?.emit(
        CLIENT_EVENTS.CALL_CONNECTED,
        { version: SIGNALING_VERSION, callId, iceState },
        ack => {
          if (!ack?.ok) logWarn('[CallFlow] call.connected ack failed', ack?.error);
        },
      );
    },
    [activeCallIdRef, closeRecoveryEpisode, connectedReportedCallIdRef, signalingRef, startCallHeartbeat],
  );
  /**
   * Whether the peer connection is carrying media again.
   *
   * Both state machines are consulted: `iceConnectionState` moves first, but a
   * stub (or a platform that only surfaces `connectionState`) may not have it.
   */
  function isPeerConnectionRecovered(pc: PeerConnection | null): boolean {
    if (!pc) return false;
    return isRecoveredIceState(pc.iceConnectionState ?? pc.connectionState);
  }

  /** Abandon any pending/queued ICE restart, and say why. */
  const cancelIceRestarts = useCallback((reason: string) => {
    const restart = iceRestartRef.current;
    if (restart.timer) {
      clearTimeout(restart.timer);
      restart.timer = null;
    }
    if (restart.attempt > 0) {
      logInfo('[CallFlow] ICE restart ladder cleared', { reason, attempts: restart.attempt });
    }
    restart.attempt = 0;
    restart.inFlight = false;
    publishRecoveryStatusRef.current?.();
  }, []);

  /**
   * ICE servers for a restart, insisting on a relay.
   *
   * A handoff is exactly when TURN matters: the new path is far more likely to
   * sit behind carrier-grade NAT, so restarting on a STUN-only list usually
   * just fails again. A missing relay is therefore an error worth one forced
   * re-fetch — but never a reason to abandon the restart, since degraded
   * recovery still beats none.
   */
  const fetchIceServersForRestart = useCallback(async (trigger: IceRestartTrigger) => {
    // One usable list per episode: re-fetching on every rung means a network
    // round-trip (plus up to `ICE_SESSION_WAIT_MS`) per attempt, over the very
    // network that just broke. A list that had no relay is not cached, so the
    // forced re-fetch below still happens on the next rung.
    const cached = iceRestartRef.current.iceServers;
    if (cached && canReuseIceServers(getTurnServerEndpoints(cached).length > 0)) return cached;

    const request = { signalingUrl, sessionId: await ensureIceSessionId() };
    let iceServers = await getIceServersForCall(request);
    if (
      decideFetchedIceServers(getTurnServerEndpoints(iceServers).length > 0, false)
        === 'cache-and-use'
    ) {
      iceRestartRef.current.iceServers = iceServers;
      return iceServers;
    }

    logError('[CallFlow] ICE restart has no TURN server; re-fetching credentials', {
      trigger,
      callId: activeCallIdRef.current,
    });
    try {
      resetIceServersForCallCache?.();
      iceServers = await getIceServersForCall({
        ...request,
        sessionId: await ensureIceSessionId(),
      });
    } catch (error) {
      logWarn('[CallFlow] TURN credential re-fetch failed before ICE restart', {
        trigger,
        message: errorMessage(error),
      });
    }
    if (
      decideFetchedIceServers(getTurnServerEndpoints(iceServers).length > 0, true)
        === 'cache-and-use'
    ) {
      iceRestartRef.current.iceServers = iceServers;
    } else {
      logError('[CallFlow] Restarting ICE without any TURN server', {
        trigger,
        callId: activeCallIdRef.current,
        impact: 'recovery will fail if either peer is behind symmetric NAT',
      });
    }
    return iceServers;
  }, [activeCallIdRef, ensureIceSessionId, signalingUrl]);

  /**
   * Send an ICE-restart offer for the active call.
   *
   * Deliberately *not* gated on the caller role: if the callee's IP changes it
   * is the callee that sees the failure, and waiting for an offer that the
   * other side has no reason to send is how those calls used to die. Glare is
   * prevented by the userId tie-break in `scheduleIceRestart` plus the
   * existing `isNegotiatingRef` guard.
   */
  const runIceRestart = useCallback(async (trigger: IceRestartTrigger) => {
    const restart = iceRestartRef.current;
    const callId = activeCallIdRef.current;
    const pc = peerConnectionRef.current;

    const decision = decideLadderRun({
      trigger,
      hasActiveCall: Boolean(callId && pc),
      attempt: restart.attempt,
      iceState: pc ? pc.iceConnectionState ?? pc.connectionState : null,
      socketConnected: Boolean(socketRef.current?.connected),
      isNegotiating: isNegotiatingRef.current,
    });
    if (decision.action === 'abort') {
      if (decision.reason === 'no-active-call') {
        logVerbose('[CallFlow] ICE restart skipped: no active call', { trigger });
      } else {
        logInfo('[CallFlow] ICE restart skipped: connection already recovered', {
          trigger,
          callId,
        });
      }
      cancelIceRestarts(decision.reason);
      return;
    }
    if (decision.action === 'defer') {
      // Both preconditions clear on their own, so they cost a retry rather than
      // a rung: `scheduleIceRestart` has already counted this attempt and left
      // no timer behind, which is why the proactive network-change rung was
      // always spent doing nothing (a handoff drops the socket for much longer
      // than the debounce that scheduled it).
      if (decision.reason === 'socket-offline') {
        logWarn('[CallFlow] ICE restart deferred: signaling socket is offline', {
          trigger,
          callId,
        });
        pauseRecoveryBudgetRef.current?.('socket-offline');
      } else {
        logWarn('[CallFlow] ICE restart deferred: a negotiation is already in flight', {
          trigger,
          callId,
        });
      }
      scheduleIceRestartRef.current?.(trigger, { consumeAttempt: false });
      return;
    }

    // Unreachable: the machine only decides `restart` when both exist. Present
    // so `callId`/`pc` narrow to non-null for the negotiation below.
    if (!callId || !pc) return;
    restart.inFlight = true;
    publishRecoveryStatusRef.current?.();
    const attempt = restart.attempt;
    try {
      const iceServers = await fetchIceServersForRestart(trigger);
      pc.setConfiguration?.({ iceServers, iceTransportPolicy: activeIceTransportPolicy });
      Telemetry.trackIceRestart(callId);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      signalingRef.current?.emit(
        CLIENT_EVENTS.RTC_OFFER,
        { version: SIGNALING_VERSION, callId, sdp: pc.localDescription },
        ack => {
          if (ack?.ok) return;
          logWarn('[CallFlow] ICE restart rtc.offer ack failed', {
            trigger,
            attempt,
            error: ack?.error,
          });
          scheduleIceRestartRef.current?.(trigger);
        },
      );
      logInfo('[CallFlow] ICE restart offer sent', { trigger, callId, attempt });
    } catch (error) {
      // One failed restart used to end the call; a handoff often just needs the
      // new interface to become routable, so the ladder gets another rung.
      logError('[CallFlow] ICE restart failed', {
        trigger,
        callId,
        attempt,
        message: errorMessage(error),
      });
      restart.inFlight = false;
      scheduleIceRestartRef.current?.(trigger);
      return;
    } finally {
      restart.inFlight = false;
      publishRecoveryStatusRef.current?.();
    }
  }, [activeCallIdRef, activeIceTransportPolicy, cancelIceRestarts, fetchIceServersForRestart, isNegotiatingRef, peerConnectionRef, signalingRef, socketRef]);

  /** The peer whose userId the glare tie-break is compared against. */
  const remotePeerUserId = useCallback(() => {
    const call = activeCallRef.current;
    return (isCallerRef.current ? call?.calleeId : call?.callerId) ?? null;
  }, [activeCallRef, isCallerRef]);

  /**
   * Queue the next rung of the restart ladder for `trigger`.
   *
   * The ladder is driven by the recovery budget rather than by a fixed attempt
   * count: it keeps restarting on a capped exponential backoff until either the
   * connection recovers or the budget expires.
   *
   * @param options.consumeAttempt - `false` for a retry of a rung that could
   *   not run because of a precondition that clears on its own.
   */
  const scheduleIceRestart = useCallback(
    (trigger: IceRestartTrigger, options: { consumeAttempt?: boolean; } = {}) => {
      const restart = iceRestartRef.current;
      const episode = recoveryEpisodeRef.current;
      const snapshot = episode.snapshot();
      const decision = decideLadderSchedule({
        trigger,
        hasActiveCall: Boolean(activeCallIdRef.current && peerConnectionRef.current),
        isPending: Boolean(restart.timer || restart.inFlight),
        attempt: restart.attempt,
        episode: {
          isOpen: episode.isOpen(),
          isPaused: episode.isPaused(),
          pauseReason: snapshot?.pauseReason ?? null,
          hasExpired: episode.hasExpired(),
        },
        consumeAttempt: options.consumeAttempt,
        localUserId: userIdRef.current,
        remoteUserId: remotePeerUserId(),
      });
      if (decision.action === 'skip') {
        if (decision.reason === 'no-active-call') {
          logVerbose('[CallFlow] ICE restart not scheduled: no active call', { trigger });
        } else if (decision.reason === 'already-pending') {
          logVerbose('[CallFlow] ICE restart already pending', {
            trigger,
            attempt: restart.attempt,
          });
        } else if (decision.reason === 'paused') {
          // Nothing can be restarted with no connectivity or no socket; the
          // resume path re-enters the ladder the moment recovery is possible
          // again, so retrying here would only burn CPU against a dead
          // interface.
          logVerbose('[CallFlow] ICE restart deferred: recovery is paused', {
            trigger,
            reason: decision.pauseReason,
          });
        } else {
          logWarn('[CallFlow] ICE restart budget spent', {
            trigger,
            callId: activeCallIdRef.current,
            attempts: restart.attempt,
          });
        }
        return;
      }

      restart.attempt = decision.attempt;
      if (decision.consumeAttempt) episode.recordAttempt();
      const { delayMs, tiebreakMs } = decision;
      logInfo('[CallFlow] Scheduling ICE restart', {
        trigger,
        callId: activeCallIdRef.current,
        attempt: restart.attempt,
        delayMs,
        deferredForGlare: tiebreakMs > 0,
        budgetRemainingMs: episode.isOpen() ? episode.remainingMs() : null,
      });
      if (delayMs <= 0) {
        publishRecoveryStatusRef.current?.();
        void runIceRestart(trigger);
        return;
      }
      restart.timer = setTimeout(() => {
        restart.timer = null;
        void runIceRestart(trigger);
      }, delayMs);
      publishRecoveryStatusRef.current?.();
    },
    [activeCallIdRef, peerConnectionRef, remotePeerUserId, runIceRestart, userIdRef],
  );

  useEffect(() => {
    scheduleIceRestartRef.current = scheduleIceRestart;
  }, [scheduleIceRestart]);

  /**
   * Start a fresh restart ladder for a newly observed loss of connectivity.
   *
   * Opening (or extending) the episode first is what gives the ladder its
   * budget: every rung is scheduled against the same deadline the failure
   * report is.
   */
  const beginIceRecovery = useCallback((trigger: IceRestartTrigger) => {
    noteRecoverySymptom(trigger);
    cancelIceRestarts(`new-trigger:${trigger}`);
    scheduleIceRestart(trigger);
  }, [cancelIceRestarts, noteRecoverySymptom, scheduleIceRestart]);

  useEffect(() => {
    beginIceRecoveryRef.current = beginIceRecovery;
    cancelIceRestartsRef.current = cancelIceRestarts;
  }, [beginIceRecovery, cancelIceRestarts]);

  // ── Proactive recovery: restart on a network path change ─────────────────
  //
  // Waiting for ICE to reach `failed` means seconds of dead audio on a
  // Wi-Fi→cellular handoff. The transport knows first, so the call acts on
  // that instead — debounced, and only while a call is actually up.
  useEffect(() => {
    const unsubscribe = subscribeNetworkChanges(
      ({ from, to }) => {
        // Connectivity is back (or moved): the budget can run again, and this
        // is new information worth extending the episode for.
        hasConnectivityRef.current = true;
        resumeRecoveryBudget(`connectivity:${to.type}`);
        // A call that is still negotiating counts: `isInCall` only flips once
        // media is up, and the handoff most worth surviving is the one during
        // setup.
        if (!activeCallIdRef.current || !peerConnectionRef.current) {
          logVerbose('[CallFlow] Network change ignored: no active call', { to: to.type });
          return;
        }

        const restartNow = () => {
          if (!activeCallIdRef.current) return;
          lastNetworkChangeAtRef.current = Date.now();
          logWarn('[CallFlow] Network path changed mid-call; restarting ICE', {
            callId: activeCallIdRef.current,
            from: from?.type ?? null,
            to: to.type,
            // The old path is already dead here even when ICE still says it is
            // connected; that lag is the audio gap this restart avoids.
            iceState: peerConnectionRef.current?.iceConnectionState ?? null,
          });
          beginIceRecovery('network-change');
        };

        // The first transition fires immediately: this is the one path
        // designed to beat ICE to the punch, and debouncing it gave that head
        // start away. The debounce is kept for *repeat* events, so a flapping
        // interface still produces one restart rather than a storm.
        const sinceLastMs = Date.now() - lastNetworkChangeAtRef.current;
        if (!networkChangeTimerRef.current && sinceLastMs >= NETWORK_CHANGE_DEBOUNCE_MS) {
          restartNow();
          return;
        }
        if (networkChangeTimerRef.current) clearTimeout(networkChangeTimerRef.current);
        networkChangeTimerRef.current = setTimeout(() => {
          networkChangeTimerRef.current = null;
          restartNow();
        }, NETWORK_CHANGE_DEBOUNCE_MS);
      },
      {
        // "Connectivity lost" is the one moment the budget must stop running:
        // an ICE restart needs a live socket, so time spent here would be
        // spent waiting rather than trying. It used to be logged and dropped.
        onConnectivityLost: snapshot => {
          hasConnectivityRef.current = false;
          logWarn('[CallFlow] Connectivity lost; pausing recovery budget', {
            callId: activeCallIdRef.current,
            type: snapshot.type,
          });
          pauseRecoveryBudget('no-connectivity');
        },
      },
    );
    return () => {
      unsubscribe();
      if (networkChangeTimerRef.current) {
        clearTimeout(networkChangeTimerRef.current);
        networkChangeTimerRef.current = null;
      }
    };
  }, [activeCallIdRef, beginIceRecovery, pauseRecoveryBudget, peerConnectionRef, resumeRecoveryBudget]);

  // Ref-forward the symptom recorder and budget resumer so the socket handlers
  // (registered once) can reach the current callback identity.
  useEffect(() => {
    noteRecoverySymptomRef.current = noteRecoverySymptom;
    resumeRecoveryBudgetRef.current = resumeRecoveryBudget;
  }, [noteRecoverySymptom, resumeRecoveryBudget]);

  return {
    closeRecoveryEpisode,
    reportCallConnected,
    noteRecoverySymptom,
    beginIceRecovery,
    cancelIceRestarts,
    beginIceRecoveryRef,
    cancelIceRestartsRef,
    noteRecoverySymptomRef,
    pauseRecoveryBudgetRef,
    resumeRecoveryBudgetRef,
  };
}
