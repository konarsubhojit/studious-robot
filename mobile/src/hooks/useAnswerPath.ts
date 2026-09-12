import { useCallback, useEffect, useRef } from 'react';
import { logError, logInfo, logWarn } from '../appLogger';
import { bearerAuthHeaders } from '../authHeaders';
import {
  ANSWER_SOCKET_ATTEMPTS,
  ANSWER_SOCKET_WAIT_MS,
  classifyHttpAccept,
  decideQueuedAnswerReplay,
  describeAnswerFallback,
  describeDegradedMedia,
} from '../call/answerPath';
import {
  beginAnswerTimeline,
  endAnswerTimeline,
  markAnswerAccepted,
  markAnswerStage,
} from '../call/answerTimeline';
import { buildCallActionUrl } from '../call/callEndpoints';
import {
  callPeerId,
  decideAcceptIncomingCall,
  isLiveCallStatus,
  rememberAnsweredCallId,
  shouldResetReplayGuard,
} from '../call/callDecisions';
import {
  bringAppToForeground,
  clearPendingAnswer,
  consumePendingAnswer,
  endCall as endCallKeepCall,
  peekPendingAnswer,
  recordPendingAnswer,
  reportCallConnected as reportCallKeepConnected,
  setCallActionHandlers as setCallKeepActionHandlers,
  setupCallKeep,
} from '../callKeep';
import { errorMessage } from '../errors';
import {
  consumePendingCallAction,
  dismissIncomingCallNotification,
} from '../incomingCallNotification';
import { emitEvent } from '../observability';
import { getMissingCallPermissions } from '../permissions';
import { installForegroundMessageHandler, sendPushReceipt } from '../pushNotifications';
import { CLIENT_EVENTS, createSignalingClient } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import { stopIncomingRingtone } from '../ringtone';
import * as Telemetry from '../telemetry';
import { describeLastIceServerFetch } from '../webrtcConfig';
import { ERROR_CODES } from '../../../shared';
import type { CallEndSummary } from '../call/callDecisions';
import type { CallStatus } from '../components/StatusBanner';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { RehydrationOutcome } from '../call/pushRehydration';
import type { Socket } from 'socket.io-client';
import type { PeerConnection } from './usePeerConnection';

type MutableRef<T> = { current: T };
type AnswerError = Error & { answerFailureReason?: string; code?: string | null };
type EndActiveCall = (
  message?: string,
  severity?: CallStatus['severity'],
  endReason?: string,
) => void;
type UpdateStatus = (message: string, severity?: CallStatus['severity']) => void;

type UseAnswerPathParams = {
  acceptInFlightCallIdRef: MutableRef<string | null>;
  activeCallIdRef: MutableRef<string | null>;
  activeCallRef: MutableRef<CallRecord | null>;
  authedFetchRef: MutableRef<any>;
  answeredCallIdsRef: MutableRef<Set<string>>;
  connectSocket: (sessionId: string) => Socket | null | undefined;
  createOrGetSession: () => Promise<string>;
  dismissIncomingCallElsewhere: (callId: string, peerId: string) => void;
  endActiveCall: EndActiveCall;
  ensurePeerConnection: () => Promise<PeerConnection | null | undefined>;
  incomingCall: CallRecord | null;
  incomingCallRef: MutableRef<CallRecord | null>;
  isCallerRef: MutableRef<boolean>;
  rehydrateCallFromPushRef: MutableRef<((callId: string) => Promise<RehydrationOutcome>) | null>;
  replayedAnswerCallIdsRef: MutableRef<Set<string>>;
  sessionIdRef: MutableRef<string | null>;
  setActiveCall: (call: CallRecord | null) => void;
  setCallSummary: (summary: CallEndSummary | null) => void;
  setIncomingCall: (call: CallRecord | null) => void;
  signalingRef: MutableRef<ReturnType<typeof createSignalingClient> | null>;
  signalingUrl: string;
  socketRef: MutableRef<Socket | null>;
  startLocalPreview: () => Promise<unknown>;
  triggerHaptic: (kind: 'answer') => void;
  updateStatus: UpdateStatus;
  userIdRef: MutableRef<string>;
  recordTimelineCallRef: MutableRef<(call: CallRecord | null | undefined) => void>;
};

function isAnsweredElsewhereRejection(error: unknown): boolean {
  const candidate = error as { code?: unknown; answerFailureReason?: unknown };
  return (
    candidate?.code === ERROR_CODES.ANSWERED_ELSEWHERE ||
    candidate?.answerFailureReason === ERROR_CODES.ANSWERED_ELSEWHERE
  );
}

async function readErrorCode(
  response: { json?: () => Promise<unknown> } | null | undefined,
): Promise<string | null> {
  try {
    const body = await response?.json?.();
    const code = (body as { error?: unknown })?.error;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export default function useAnswerPath({
  acceptInFlightCallIdRef,
  activeCallIdRef,
  activeCallRef,
  authedFetchRef,
  answeredCallIdsRef,
  connectSocket,
  createOrGetSession,
  dismissIncomingCallElsewhere,
  endActiveCall,
  ensurePeerConnection,
  incomingCall,
  incomingCallRef,
  isCallerRef,
  rehydrateCallFromPushRef,
  replayedAnswerCallIdsRef,
  sessionIdRef,
  setActiveCall,
  setCallSummary,
  setIncomingCall,
  signalingRef,
  signalingUrl,
  socketRef,
  startLocalPreview,
  triggerHaptic,
  updateStatus,
  userIdRef,
  recordTimelineCallRef,
}: UseAnswerPathParams) {
  const reportAnswerStage = useCallback(
    (
      callId: string | null,
      stage: string,
      reason: string | null = null,
      durationMs: number | null = null,
    ) => {
      if (!callId) return;
      sendPushReceipt({
        callId,
        stage,
        reason,
        durationMs,
        sessionId: sessionIdRef.current,
        signalingUrl: (signalingUrl ?? '').trim(),
      }).catch(error => {
        logWarn('[CallFlow] answer receipt failed', {
          stage,
          message: errorMessage(error),
        });
      });
    },
    [sessionIdRef, signalingUrl],
  );

  const reportAnswerStageRef = useRef(reportAnswerStage);
  useEffect(() => {
    reportAnswerStageRef.current = reportAnswerStage;
  }, [reportAnswerStage]);

  const waitForConnectedSocket = useCallback(
    async (timeoutMs = ANSWER_SOCKET_WAIT_MS) => {
      if (socketRef.current?.connected) return socketRef.current;
      try {
        let socket = socketRef.current;
        if (!socket) {
          const sessionId = await createOrGetSession();
          socket = connectSocket(sessionId) ?? null;
        }
        if (!socket) return null;
        const connectingSocket = socket;
        await new Promise((resolve: (value?: unknown) => void, reject) => {
          const timer = setTimeout(() => reject(new Error('socket connect timeout')), timeoutMs);
          connectingSocket.once('connect', () => {
            clearTimeout(timer);
            resolve();
          });
          connectingSocket.once('connect_error', error => {
            clearTimeout(timer);
            reject(error);
          });
        });
        return socketRef.current?.connected ? socketRef.current : null;
      } catch (error) {
        logWarn('[CallFlow] Socket not connected in time to answer', {
          message: errorMessage(error),
        });
        return null;
      }
    },
    [connectSocket, createOrGetSession, socketRef],
  );

  const acceptCallOverHttp = useCallback(
    async (callId: string): Promise<CallRecord> => {
      const response = await authedFetchRef.current?.((sessionId: string) => ({
        url: buildCallActionUrl({ signalingUrl: signalingUrl ?? '', callId, action: 'accept' }),
        options: {
          method: 'POST',
          headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
          body: '{}',
        },
      }));
      const verdict = classifyHttpAccept(response);
      if (verdict.outcome === 'failed') {
        const error = new Error(verdict.message) as AnswerError;
        error.answerFailureReason = verdict.answerFailureReason;
        error.code = await readErrorCode(response);
        throw error;
      }
      return verdict.response.json();
    },
    [authedFetchRef, signalingUrl],
  );

  const sendCallAccept = useCallback(
    async (callId: string): Promise<{ call: CallRecord; transport: 'socket' | 'http' }> => {
      const socket = await waitForConnectedSocket();
      if (socket) {
        for (let attempt = 1; attempt <= ANSWER_SOCKET_ATTEMPTS; attempt += 1) {
          try {
            const ack = await signalingRef.current?.request(CLIENT_EVENTS.CALL_ACCEPT, {
              version: SIGNALING_VERSION,
              callId,
            });
            return { call: ack.call, transport: 'socket' };
          } catch (error) {
            if (isAnsweredElsewhereRejection(error)) throw error;
            logWarn('[CallFlow] call.accept over socket failed', {
              callId,
              attempt,
              message: errorMessage(error),
            });
          }
        }
      }

      const fallback = describeAnswerFallback(Boolean(socket));
      logWarn('[CallFlow] Answering over HTTP', { callId, reason: fallback.reason });
      updateStatus(fallback.message, 'warning');

      const call = await acceptCallOverHttp(callId);
      return { call, transport: 'http' };
    },
    [acceptCallOverHttp, signalingRef, updateStatus, waitForConnectedSocket],
  );

  /**
   * Report a stage of the answer with how long it took.
   *
   * The stage clock is started by `acceptIncomingCall`; a call that is not
   * being timed reports the stage without a duration rather than a zero.
   */
  const reportAnswerStageTiming = useCallback(
    (callId: string, stage: string, reason: string | null = null) => {
      const timing = markAnswerStage(callId);
      reportAnswerStage(callId, stage, reason, timing?.stageMs ?? null);
    },
    [reportAnswerStage],
  );

  const acquireMediaForAcceptedCall = useCallback(
    async (callId: string) => {
      const permissions = await getMissingCallPermissions().catch(() => null);
      reportAnswerStageTiming(
        callId,
        'permissions_checked',
        permissions?.missing?.length ? permissions.missing.join(',') : 'granted',
      );
      if (permissions?.missing?.length) {
        logWarn('[CallFlow] Answering without granted media permissions', {
          callId,
          missing: permissions.missing,
          camera: permissions.camera,
          microphone: permissions.microphone,
        });
        bringAppToForeground();
      }

      let stream = null;
      try {
        stream = await startLocalPreview();
      } catch (error) {
        logError('[CallFlow] Local media failed after accepting call', error);
      }
      // `startLocalPreview` is the single longest serialised step on this path
      // and, until now, entirely unmeasured (diagnosis §6).
      reportAnswerStageTiming(callId, 'media_acquired', stream ? 'ok' : 'no_stream');

      const degraded = describeDegradedMedia({
        hasStream: Boolean(stream),
        missingPermissions: permissions?.missing,
        permissionMessage: permissions?.message,
      });
      if (degraded) {
        logWarn('[CallFlow] Call accepted without local media', {
          callId,
          reason: degraded.reason,
        });
        updateStatus(degraded.message, 'warning');
        reportAnswerStage(callId, 'answer_failed', degraded.reason);
      }

      try {
        await ensurePeerConnection();
        // Includes the ICE-server fetch, which reports its own tier and
        // duration separately so §1 stays separable from §6.
        reportAnswerStageTiming(callId, 'peer_connection_ready', describeLastIceServerFetch());
      } catch (error) {
        logError('[CallFlow] Failed to prepare peer connection after accept', error);
        updateStatus('Failed to connect media', 'error');
        reportAnswerStageTiming(callId, 'answer_failed', 'peer_connection_failed');
      }
    },
    [
      ensurePeerConnection,
      reportAnswerStage,
      reportAnswerStageTiming,
      startLocalPreview,
      updateStatus,
    ],
  );

  const rememberAnsweredCall = useCallback(
    (callId: string) => {
      rememberAnsweredCallId(answeredCallIdsRef.current, callId);
    },
    [answeredCallIdsRef],
  );

  const acceptIncomingCall = useCallback(async () => {
    const call = incomingCallRef.current ?? incomingCall;
    if (!call?.callId) {
      const queuedCallId = peekPendingAnswer();
      logWarn('[CallFlow] acceptIncomingCall aborted', {
        reason: 'no_incoming_call',
        queuedCallId,
      });
      updateStatus('No incoming call to answer', 'error');
      reportAnswerStage(queuedCallId, 'answer_failed', 'no_incoming_call');
      return;
    }

    const acceptDecision = decideAcceptIncomingCall({
      callId: call.callId,
      status: call.status,
      acceptInFlightCallId: acceptInFlightCallIdRef.current,
      answeredCallIds: answeredCallIdsRef.current,
    });
    if (acceptDecision.action === 'skip') {
      logInfo('[CallFlow] Ignoring duplicate acceptIncomingCall', {
        callId: call.callId,
        reason: acceptDecision.reason,
      });
      reportAnswerStage(call.callId, 'answer_skipped_duplicate', acceptDecision.reason);
      return;
    }
    if (acceptDecision.action === 'dismiss') {
      logInfo('[CallFlow] Ignoring accept for a call that stopped ringing', {
        callId: call.callId,
        status: call.status,
      });
      reportAnswerStage(call.callId, 'accept_tapped', acceptDecision.reason);
      clearPendingAnswer(call.callId, acceptDecision.reason);
      endCallKeepCall(call.callId);
      return;
    }

    triggerHaptic('answer');
    setCallSummary(null);
    logInfo('[CallFlow] Accepting incoming call', { callId: call.callId });
    acceptInFlightCallIdRef.current = call.callId;
    dismissIncomingCallNotification(call.callId);
    // Everything from here until `rtc.answer` is sent lands inside the
    // server's `accepted -> in_call` window, so this is where its clock starts.
    beginAnswerTimeline(call.callId);
    reportAnswerStage(call.callId, 'answer_attempted');

    try {
      isCallerRef.current = false;
      activeCallIdRef.current = call.callId;
      updateStatus('Answering…');

      const { call: acceptedCall, transport } = await sendCallAccept(call.callId);

      const nextCall = acceptedCall ?? call;
      rememberAnsweredCall(call.callId);
      activeCallRef.current = nextCall;
      setActiveCall(nextCall);
      recordTimelineCallRef.current(nextCall);
      incomingCallRef.current = null;
      setIncomingCall(null);
      clearPendingAnswer(call.callId, 'answered');
      updateStatus('Connecting…');
      Telemetry.trackCallStart(call.callId, sessionIdRef.current);
      emitEvent('info', 'call.started', { callId: call.callId, direction: 'incoming' });
      stopIncomingRingtone();
      logInfo('[CallFlow] Ringing stopped (call accepted)', {
        callId: call.callId,
        transport,
      });
      reportCallKeepConnected(call.callId);
      // Closes the accept round trip as its own stage and rebases the clock
      // onto it. Without this mark the next stage to report —
      // `permissions_checked` — would be charged the whole network hop, which
      // is exactly the mis-attribution this instrumentation exists to remove.
      const accepted = markAnswerAccepted(call.callId);
      reportAnswerStage(call.callId, 'answer_accepted', transport, accepted?.stageMs ?? null);

      await acquireMediaForAcceptedCall(call.callId);
    } catch (error) {
      const reason = (error as AnswerError)?.answerFailureReason ?? 'accept_failed';
      logError('[CallFlow] acceptIncomingCall failed', error);
      endAnswerTimeline(call.callId);
      reportAnswerStage(call.callId, 'answer_failed', reason);
      clearPendingAnswer(call.callId, reason);

      if (isAnsweredElsewhereRejection(error)) {
        activeCallIdRef.current = null;
        dismissIncomingCallElsewhere(call.callId, callPeerId(call, userIdRef.current) ?? '');
        return;
      }

      const liveCall = activeCallRef.current;
      if (liveCall && isLiveCallStatus(liveCall.status)) {
        logWarn('[CallFlow] Accept failed while a call is already active; keeping it', {
          callId: call.callId,
          activeCallId: liveCall.callId,
          activeStatus: liveCall.status,
          reason,
        });
        updateStatus('Call already answered', 'info');
        return;
      }

      updateStatus(`Failed to accept call: ${errorMessage(error)}`, 'error');
      endActiveCall();
    } finally {
      if (acceptInFlightCallIdRef.current === call.callId) {
        acceptInFlightCallIdRef.current = null;
      }
    }
  }, [
    acceptInFlightCallIdRef,
    acquireMediaForAcceptedCall,
    activeCallIdRef,
    activeCallRef,
    answeredCallIdsRef,
    dismissIncomingCallElsewhere,
    endActiveCall,
    incomingCall,
    incomingCallRef,
    isCallerRef,
    rememberAnsweredCall,
    reportAnswerStage,
    sendCallAccept,
    sessionIdRef,
    setActiveCall,
    setCallSummary,
    setIncomingCall,
    triggerHaptic,
    updateStatus,
    userIdRef,
    recordTimelineCallRef,
  ]);

  const declineCallById = useCallback(
    async (callId: string): Promise<boolean> => {
      if (!callId) return false;
      clearPendingAnswer(callId, 'declined');

      if (socketRef.current?.connected) {
        try {
          await signalingRef.current?.request(CLIENT_EVENTS.CALL_DECLINE, {
            version: SIGNALING_VERSION,
            callId,
          });
          return true;
        } catch (error) {
          logWarn('[CallFlow] decline ack failed', { message: errorMessage(error) });
        }
      }

      try {
        const response = await authedFetchRef.current?.((sessionId: string) => ({
          url: buildCallActionUrl({
            signalingUrl: signalingUrl ?? '',
            callId,
            action: 'decline',
          }),
          options: {
            method: 'POST',
            headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
            body: '{}',
          },
        }));
        if (response?.ok) return true;
        logWarn('[CallFlow] HTTP decline failed', {
          callId,
          status: response?.status ?? null,
        });
      } catch (error) {
        logWarn('[CallFlow] HTTP decline threw', { callId, message: errorMessage(error) });
      }
      return false;
    },
    [authedFetchRef, signalingRef, signalingUrl, socketRef],
  );

  const declineIncomingCall = useCallback(async () => {
    const call = incomingCallRef.current ?? incomingCall;
    if (!call) {
      logWarn('[CallFlow] declineIncomingCall aborted', { reason: 'no_incoming_call' });
      return;
    }

    dismissIncomingCallNotification(call.callId);
    await declineCallById(call.callId);
    endActiveCall('Call declined', 'info', 'declined');
  }, [declineCallById, endActiveCall, incomingCall, incomingCallRef]);

  const acceptIncomingCallRef = useRef(acceptIncomingCall);
  const declineIncomingCallRef = useRef(declineIncomingCall);
  useEffect(() => {
    acceptIncomingCallRef.current = acceptIncomingCall;
    declineIncomingCallRef.current = declineIncomingCall;
  }, [acceptIncomingCall, declineIncomingCall]);

  const queueAnswerForReplay = useCallback(
    (callUUID: string, source: string) => {
      if (!callUUID) return;
      recordPendingAnswer(callUUID, source);
      Promise.resolve(rehydrateCallFromPushRef.current?.(callUUID))
        .then(outcome => {
          const replay = decideQueuedAnswerReplay({
            outcome,
            callUUID,
            queuedCallId: peekPendingAnswer(),
            knownIncomingCallId: incomingCallRef.current?.callId ?? null,
          });
          if (replay.action === 'wait' || replay.action === 'ignore') return;

          if (replay.action === 'dismiss') {
            logInfo('[CallFlow] Queued answer dropped; call already ended', {
              callUUID,
              source,
              outcome,
            });
            reportAnswerStageRef.current?.(callUUID, 'accept_tapped', replay.reason);
            clearPendingAnswer(callUUID, replay.reason);
            endCallKeepCall(callUUID);
            return;
          }

          logWarn('[CallFlow] Queued answer cannot be replayed; call unavailable', {
            callUUID,
            source,
          });
          reportAnswerStageRef.current?.(callUUID, 'answer_failed', replay.reason);
          clearPendingAnswer(callUUID, replay.reason);
        })
        .catch(error => {
          const reason = (error as AnswerError)?.answerFailureReason ?? 'rehydrate_failed';
          logError('[CallFlow] Queued answer rehydrate failed', error);
          reportAnswerStageRef.current?.(callUUID, 'answer_failed', reason);
          clearPendingAnswer(callUUID, reason);
          endCallKeepCall(callUUID);
        });
    },
    [incomingCallRef, rehydrateCallFromPushRef],
  );

  const declineCallByIdRef = useRef(declineCallById);
  useEffect(() => {
    declineCallByIdRef.current = declineCallById;
  }, [declineCallById]);

  useEffect(() => {
    let cancelled = false;
    consumePendingCallAction()
      .then(pending => {
        if (cancelled || !pending?.callId) return;
        const { callId, action, connectionLive } = pending;
        const reason = connectionLive ? 'connection_live' : 'connection_missing';
        logInfo('[CallFlow] Replaying persisted notification action', pending);
        if (action === 'accept') {
          reportAnswerStageRef.current?.(callId, 'accept_tapped', reason);
          queueAnswerForReplay(callId, 'native_persisted_intent');
        } else if (action === 'decline') {
          reportAnswerStageRef.current?.(callId, 'decline_tapped', reason);
          declineCallByIdRef.current?.(callId);
        }
      })
      .catch(error => {
        logWarn('[CallFlow] Failed to drain persisted notification action', {
          message: errorMessage(error),
        });
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount; handlers are invoked via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setupCallKeep().catch(() => {});
    const detachCallActionHandlers = setCallKeepActionHandlers({
      onAnswer: callUUID => {
        if (callUUID && incomingCallRef.current?.callId !== callUUID) {
          logInfo('[CallFlow] Recording answerCall for replay', { callUUID });
          queueAnswerForReplay(callUUID, 'call_flow_unknown_call');
          return;
        }
        acceptIncomingCallRef.current?.();
      },
      onEnd: callUUID => {
        clearPendingAnswer(callUUID, 'ended_before_answer');
        const incoming = incomingCallRef.current;
        if (incoming?.callId === callUUID) {
          declineIncomingCallRef.current?.();
          return;
        }
        logInfo('[CallFlow] Ignoring CallKeep endCall with no ringing call', { callUUID });
      },
    });
    const unsubscribeForegroundPush = installForegroundMessageHandler();
    return () => {
      unsubscribeForegroundPush();
      detachCallActionHandlers();
    };
    // Run once on mount; handlers are invoked via refs (`queueAnswerForReplay`
    // is stable and only touches refs, so it is safe to omit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const callId = incomingCall?.callId;
    if (!callId) return;
    if (replayedAnswerCallIdsRef.current.has(callId)) return;
    if (!consumePendingAnswer(callId)) return;
    if (shouldResetReplayGuard(replayedAnswerCallIdsRef.current.size)) {
      replayedAnswerCallIdsRef.current.clear();
    }
    replayedAnswerCallIdsRef.current.add(callId);
    logInfo('[CallFlow] Replaying recorded answerCall', { callId });
    acceptIncomingCallRef.current?.();
  }, [incomingCall, replayedAnswerCallIdsRef]);

  return { acceptIncomingCall, declineIncomingCall };
}
