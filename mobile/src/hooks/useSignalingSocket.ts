import { useCallback, useEffect, useRef } from 'react';
import { RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import { CALL_EVENTS } from '../call/callStateMachine';
import {
  classifyCallDelivery,
  decideIncomingOffer,
  describeCallStateEnding,
  isStateChangeForOtherCall,
  isTerminalCallStatus,
  isTerminalIceState,
  resolveKnownCallId,
  shouldReportEmptyCallState,
} from '../call/callDecisions';
import type { CallDelivery } from '../call/callDecisions';
import {
  SESSION_EXPIRED_MESSAGE,
  SESSION_REMINT_RETRY_MS,
  sessionRemintAttempts,
} from '../call/sessionLifecycle';
import { readMediaStateFrame } from '../call/pushRehydration';
import { clearPendingAnswer, endCall as endCallKeepCall } from '../callKeep';
import { startCallService } from '../callService';
import { errorMessage } from '../errors';
import { emitMetric, getCorrelationId } from '../observability';
import { getSocketOptions } from '../socketConfig';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  TRANSPORT_EVENTS,
  createSignalingClient,
} from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import * as Telemetry from '../telemetry';
import { prefetchIceServersForCall } from '../webrtcConfig';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from '../components/StatusBanner';
import type { PeerConnection } from './usePeerConnection';
import type { CallHeartbeat } from './useCallHeartbeat';
import type { RecoveryPauseReason, RecoveryTrigger } from '../call/recoveryEpisode';

type MutableRef<T> = { current: T };

type SignalingClient = ReturnType<typeof createSignalingClient>;
type DispatchCallEvent = (event: string) => void;
type UpdateStatus = (message: string, severity?: CallStatus['severity']) => void;
type EndActiveCall = (
  message?: string,
  severity?: CallStatus['severity'],
  endReason?: string,
) => void;

type SocketHandlers = {
  consumeForeignDeviceCallEvent: (
    call: CallRecord | null | undefined,
    eventCallId: string | null,
    knownCallId: string | null,
  ) => boolean;
  createOrGetSession: () => Promise<string>;
  disconnectSocket: () => void;
  sendInitialOffer: (signaling: SignalingClient, callId: string) => Promise<void>;
  updateStatus: UpdateStatus;
  showIncomingCallUi: (call: { callId: string; callerId?: string | null }) => Promise<void>;
  handleMessageReceived: (message: any) => void;
  handleMessageDeleted: (payload: any) => void;
  handleMessageReaction: (payload: any) => void;
  handleMessageDelivered: (message: any) => void;
  handleMessageRead: (payload: any) => void;
  handleTypingEvent: (payload: { senderId: string; isTyping: boolean }) => void;
  handleSocketConnected: () => void;
  handleSocketDisconnected: () => void;
  recordConnectSuccess: () => void;
  recordConnectError: () => void;
  fetchConversations: () => void | Promise<void>;
  fetchBlocks: () => void | Promise<void>;
  wakeCallHeartbeat: CallHeartbeat['wakeCallHeartbeat'];
};

type UseSignalingSocketParams = Omit<SocketHandlers, 'disconnectSocket'> & {
  activeCallIdRef: MutableRef<string | null>;
  activeCallRef: MutableRef<CallRecord | null>;
  beginIceRecoveryRef: MutableRef<((trigger: RecoveryTrigger) => void) | null>;
  detachManagerPingRef: MutableRef<(() => void) | null>;
  deviceIdRef: MutableRef<string | null>;
  dispatchCallEvent: DispatchCallEvent;
  displayedIncomingCallIdsRef: MutableRef<Set<string>>;
  endActiveCallRef: MutableRef<EndActiveCall | null>;
  ensurePeerConnectionRef: MutableRef<(() => Promise<PeerConnection | null | undefined>) | null>;
  iceCandidateBufferRef: MutableRef<any[]>;
  incomingCallRef: MutableRef<CallRecord | null>;
  isCallerRef: MutableRef<boolean>;
  isInCallRef: MutableRef<boolean>;
  isNegotiatingRef: MutableRef<boolean>;
  noteRecoverySymptomRef: MutableRef<((trigger: RecoveryTrigger, state?: string) => void) | null>;
  pauseRecoveryBudgetRef: MutableRef<((reason: RecoveryPauseReason) => void) | null>;
  peerConnectionRef: MutableRef<PeerConnection | null>;
  recordTimelineCallRef: MutableRef<(call: CallRecord | null | undefined) => void>;
  reportOwnCallState: (
    signaling: SignalingClient,
    activeCallIds: string[],
    options?: { reason?: string },
  ) => void;
  resetTypingStateRef: MutableRef<() => void>;
  resyncCallStateRef: MutableRef<(() => void) | null>;
  resumeRecoveryBudgetRef: MutableRef<((reason: string) => void) | null>;
  sessionIdRef: MutableRef<string | null>;
  setActiveCall: (call: CallRecord | null) => void;
  setCallDelivery: (delivery: CallDelivery | null) => void;
  setIncomingCall: (call: CallRecord | null) => void;
  setIsReconnecting: (value: boolean) => void;
  setIsRemoteScreenSharing: (value: boolean) => void;
  setIsRemoteVideoEnabled: (value: boolean) => void;
  signalingRef: MutableRef<SignalingClient | null>;
  signalingUrl: string;
  socketRef: MutableRef<Socket | null>;
};

/** Owns the Socket.IO transport lifecycle for `useCallFlow`. */
export default function useSignalingSocket({
  activeCallIdRef,
  activeCallRef,
  beginIceRecoveryRef,
  consumeForeignDeviceCallEvent,
  createOrGetSession,
  detachManagerPingRef,
  deviceIdRef,
  dispatchCallEvent,
  displayedIncomingCallIdsRef,
  endActiveCallRef,
  ensurePeerConnectionRef,
  fetchBlocks,
  fetchConversations,
  handleMessageDeleted,
  handleMessageDelivered,
  handleMessageReaction,
  handleMessageRead,
  handleMessageReceived,
  handleSocketConnected,
  handleSocketDisconnected,
  handleTypingEvent,
  iceCandidateBufferRef,
  incomingCallRef,
  isCallerRef,
  isInCallRef,
  isNegotiatingRef,
  noteRecoverySymptomRef,
  pauseRecoveryBudgetRef,
  peerConnectionRef,
  recordConnectError,
  recordConnectSuccess,
  recordTimelineCallRef,
  reportOwnCallState,
  resetTypingStateRef,
  resyncCallStateRef,
  resumeRecoveryBudgetRef,
  sendInitialOffer,
  sessionIdRef,
  setActiveCall,
  setCallDelivery,
  setIncomingCall,
  setIsReconnecting,
  setIsRemoteScreenSharing,
  setIsRemoteVideoEnabled,
  showIncomingCallUi,
  signalingRef,
  signalingUrl,
  socketRef,
  updateStatus,
  wakeCallHeartbeat,
}: UseSignalingSocketParams) {
  const disconnectSocket = useCallback(() => {
    detachManagerPingRef.current?.();
    detachManagerPingRef.current = null;
    if (socketRef.current) {
      logInfo('[CallFlow] Disconnecting socket');
      signalingRef.current?.dispose();
      socketRef.current.disconnect();
      socketRef.current = null;
      signalingRef.current = null;
    }
    resetTypingStateRef.current();
  }, [detachManagerPingRef, resetTypingStateRef, signalingRef, socketRef]);

  const connectSocketHandlersRef = useRef<SocketHandlers>({
    consumeForeignDeviceCallEvent,
    createOrGetSession,
    disconnectSocket,
    sendInitialOffer,
    updateStatus,
    showIncomingCallUi,
    handleMessageReceived,
    handleMessageDeleted,
    handleMessageReaction,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
    handleSocketConnected,
    handleSocketDisconnected,
    recordConnectSuccess,
    recordConnectError,
    fetchConversations,
    fetchBlocks,
    wakeCallHeartbeat,
  });

  useEffect(() => {
    connectSocketHandlersRef.current = {
      consumeForeignDeviceCallEvent,
      createOrGetSession,
      disconnectSocket,
      sendInitialOffer,
      updateStatus,
      showIncomingCallUi,
      handleMessageReceived,
      handleMessageDeleted,
      handleMessageReaction,
      handleMessageDelivered,
      handleMessageRead,
      handleTypingEvent,
      handleSocketConnected,
      handleSocketDisconnected,
      recordConnectSuccess,
      recordConnectError,
      fetchConversations,
      fetchBlocks,
      wakeCallHeartbeat,
    };
  }, [
    consumeForeignDeviceCallEvent,
    createOrGetSession,
    disconnectSocket,
    sendInitialOffer,
    updateStatus,
    showIncomingCallUi,
    handleMessageReceived,
    handleMessageDeleted,
    handleMessageReaction,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
    handleSocketConnected,
    handleSocketDisconnected,
    recordConnectSuccess,
    recordConnectError,
    fetchConversations,
    fetchBlocks,
    wakeCallHeartbeat,
  ]);

  const connectSocket = useCallback(
    (sessionId: string) => {
      connectSocketHandlersRef.current.disconnectSocket();
      prefetchIceServersForCall({ signalingUrl, sessionId });
      logInfo('[CallFlow] Connecting socket', { signalingUrl });
      const socket = io(signalingUrl.trim(), {
        ...getSocketOptions(),
        auth: { sessionId, correlationId: getCorrelationId() },
      });
      socketRef.current = socket;
      const signaling = createSignalingClient(socket);
      signalingRef.current = signaling;

      type ManagerEvents = {
        on?: (event: string, listener: () => void) => void;
        off?: (event: string, listener: () => void) => void;
      };
      const manager = (socket as { io?: ManagerEvents }).io;
      const onManagerPing = () => {
        connectSocketHandlersRef.current.wakeCallHeartbeat('socket-ping');
      };
      manager?.on?.('ping', onManagerPing);
      const onManagerReconnectFailed = () => {
        logWarn('[CallFlow] Socket reconnection ladder exhausted', {
          inCall: isInCallRef.current,
          callId: activeCallIdRef.current,
        });
        if (!isInCallRef.current) return;
        socketRef.current?.connect();
      };
      manager?.on?.(TRANSPORT_EVENTS.RECONNECT_FAILED, onManagerReconnectFailed);
      detachManagerPingRef.current = () => {
        manager?.off?.('ping', onManagerPing);
        manager?.off?.(TRANSPORT_EVENTS.RECONNECT_FAILED, onManagerReconnectFailed);
      };

      signaling.on(SERVER_EVENTS.CALL_INCOMING, ({ call }) => {
        logInfo('[CallFlow] Incoming call', {
          callId: call.callId,
          callerId: call.callerId,
        });
        signaling.emit(
          CLIENT_EVENTS.CALL_INCOMING_ACK,
          {
            version: SIGNALING_VERSION,
            callId: call.callId,
            deviceId: deviceIdRef.current || undefined,
          },
          ack => {
            if (!ack?.ok) {
              logWarn('[CallFlow] call.incoming.ack failed', { error: ack?.error });
            }
          },
        );
        incomingCallRef.current = call;
        setIncomingCall(call);
        recordTimelineCallRef.current(call);
        dispatchCallEvent(CALL_EVENTS.RECEIVE);
        connectSocketHandlersRef.current.updateStatus(`Incoming call from ${call.callerId}`);
        connectSocketHandlersRef.current.showIncomingCallUi(call).catch(error => {
          logWarn('[CallFlow] showIncomingCallUi unexpected error', {
            message: errorMessage(error),
          });
        });
      });

      signaling.on(SERVER_EVENTS.CALL_RINGING, ({ call, delivery }) => {
        logInfo('[CallFlow] Call ringing', { callId: call.callId, delivery });
        activeCallRef.current = call;
        setActiveCall(call);
        recordTimelineCallRef.current(call);
        setCallDelivery(classifyCallDelivery(delivery));
      });

      signaling.on(
        SERVER_EVENTS.CALL_STATE_CHANGED,
        async ({ status: callStatus, call, reason }) => {
          logInfo('[CallFlow] call.state_changed', {
            callStatus,
            callId: call?.callId,
            reason,
          });
          const eventCallId = call?.callId ?? null;
          const knownCallId = resolveKnownCallId({
            activeCallId: activeCallIdRef.current,
            activeCall: activeCallRef.current,
            incomingCall: incomingCallRef.current,
          });

          if (eventCallId && isTerminalCallStatus(callStatus)) {
            logInfo('[CallFlow] Dismissing call UI for terminal transition', {
              callId: eventCallId,
              callStatus,
              reason: reason ?? null,
            });
            clearPendingAnswer(eventCallId, `state_${callStatus}`);
            displayedIncomingCallIdsRef.current.delete(eventCallId);
            endCallKeepCall(eventCallId);
          }

          if (isStateChangeForOtherCall({ eventCallId, knownCallId })) {
            logInfo('[CallFlow] Ignoring state change for a non-current call', {
              callId: eventCallId,
              knownCallId,
              callStatus,
            });
            return;
          }

          if (
            callStatus === 'busy' &&
            shouldReportEmptyCallState({
              eventCallId,
              activeCallId: activeCallIdRef.current,
              incomingCallId: incomingCallRef.current?.callId,
            })
          ) {
            reportOwnCallState(signaling, [], { reason: 'busy-rejection' });
          }

          if (
            connectSocketHandlersRef.current.consumeForeignDeviceCallEvent(
              call,
              eventCallId,
              knownCallId,
            )
          )
            return;

          if (call) {
            activeCallRef.current = call;
            setActiveCall(call);
            recordTimelineCallRef.current(call);
          }

          if (callStatus === 'accepted') {
            connectSocketHandlersRef.current.updateStatus('Call accepted, connecting media…');
            if (isCallerRef.current && call) {
              activeCallIdRef.current = call.callId;
              await connectSocketHandlersRef.current.sendInitialOffer(signaling, call.callId);
            }
            return;
          }

          const ending = describeCallStateEnding({ status: callStatus, reason });
          if (ending) {
            endActiveCallRef.current?.(ending.message, ending.severity, ending.endReason);
          }
        },
      );

      signaling.on(SERVER_EVENTS.RTC_OFFER, async ({ sdp, callId }) => {
        const offerDecision = decideIncomingOffer({
          callId,
          activeCallId: activeCallIdRef.current,
          isNegotiating: isNegotiatingRef.current,
        });
        if (offerDecision === 'ignore-unknown-call') {
          logWarn('[CallFlow] rtc.offer for unknown callId', { callId });
          return;
        }
        if (offerDecision === 'ignore-glare') {
          logWarn('[CallFlow] Glare: ignoring concurrent rtc.offer');
          return;
        }
        isNegotiatingRef.current = true;
        logInfo('[CallFlow] RTC offer received');
        try {
          const pc = await ensurePeerConnectionRef.current?.();
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const buffered = iceCandidateBufferRef.current;
          iceCandidateBufferRef.current = [];
          for (const c of buffered) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch (err) {
              logWarn('[CallFlow] Failed to add buffered ICE candidate', {
                message: errorMessage(err),
              });
            }
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          signaling.emit(
            CLIENT_EVENTS.RTC_ANSWER,
            {
              version: SIGNALING_VERSION,
              callId,
              sdp: pc.localDescription,
            },
            ack => {
              if (!ack?.ok) logWarn('[CallFlow] rtc.answer ack failed', ack?.error);
            },
          );
          dispatchCallEvent(CALL_EVENTS.CONNECT);
          connectSocketHandlersRef.current.updateStatus('Connected', 'success');
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC offer', error);
          connectSocketHandlersRef.current.updateStatus('Failed to connect media', 'error');
          endActiveCallRef.current?.('Failed to connect media', 'error');
        } finally {
          isNegotiatingRef.current = false;
        }
      });

      signaling.on(SERVER_EVENTS.RTC_ANSWER, async ({ sdp, callId }) => {
        if (callId !== activeCallIdRef.current) {
          logWarn('[CallFlow] rtc.answer for unknown callId', { callId });
          return;
        }
        logInfo('[CallFlow] RTC answer received');
        try {
          const pc = peerConnectionRef.current;
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          const buffered = iceCandidateBufferRef.current;
          iceCandidateBufferRef.current = [];
          for (const c of buffered) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch (err) {
              logWarn('[CallFlow] Failed to add buffered ICE candidate', {
                message: errorMessage(err),
              });
            }
          }
          dispatchCallEvent(CALL_EVENTS.CONNECT);
          connectSocketHandlersRef.current.updateStatus('Connected', 'success');
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC answer', error);
          connectSocketHandlersRef.current.updateStatus('Failed to connect media', 'error');
          endActiveCallRef.current?.('Failed to connect media', 'error');
        }
      });

      signaling.on(SERVER_EVENTS.RTC_CANDIDATE, async ({ candidate, callId }) => {
        if (callId !== activeCallIdRef.current) return;
        const pc = peerConnectionRef.current;
        if (!pc) return;
        if (!pc.remoteDescription) {
          iceCandidateBufferRef.current.push(candidate);
          logVerbose('[CallFlow] ICE candidate buffered (awaiting remote description)');
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          logWarn('[CallFlow] Failed to add ICE candidate', {
            message: errorMessage(error),
          });
        }
      });

      signaling.on(SERVER_EVENTS.MESSAGE_RECEIVED, ({ message }) => {
        connectSocketHandlersRef.current.handleMessageReceived(message);
      });
      signaling.on(SERVER_EVENTS.MESSAGE_DELETED, payload => {
        connectSocketHandlersRef.current.handleMessageDeleted(payload);
      });
      signaling.on(SERVER_EVENTS.MESSAGE_REACTION, payload => {
        connectSocketHandlersRef.current.handleMessageReaction(payload);
      });
      signaling.on(SERVER_EVENTS.MESSAGE_DELIVERED, ({ message }) => {
        connectSocketHandlersRef.current.handleMessageDelivered(message);
      });
      signaling.on(SERVER_EVENTS.MESSAGE_READ, ({ readerId, readAt }) => {
        connectSocketHandlersRef.current.handleMessageRead({ readerId, readAt });
      });
      signaling.on(SERVER_EVENTS.MESSAGE_TYPING, ({ senderId, isTyping }) => {
        connectSocketHandlersRef.current.handleTypingEvent({ senderId, isTyping });
      });

      signaling.on(SERVER_EVENTS.CALL_MEDIA_STATE, ({ callId, mediaState }) => {
        if (callId !== activeCallIdRef.current) return;
        connectSocketHandlersRef.current.wakeCallHeartbeat('peer-media-state');
        const frame = readMediaStateFrame(mediaState);
        if (frame.isScreenSharing !== undefined) setIsRemoteScreenSharing(frame.isScreenSharing);
        if (frame.isVideoEnabled !== undefined) setIsRemoteVideoEnabled(frame.isVideoEnabled);
      });

      signaling.on(TRANSPORT_EVENTS.CONNECT, async () => {
        logInfo('[CallFlow] Socket connected', { socketId: socket.id });
        connectSocketHandlersRef.current.recordConnectSuccess();
        resumeRecoveryBudgetRef.current?.('socket-connected');
        resyncCallStateRef.current?.();
        const droppedTerminalReports = signaling.dropQueuedEvents(
          item =>
            item.event === CLIENT_EVENTS.CALL_CONNECTED &&
            isTerminalIceState((item.payload as { iceState?: unknown })?.iceState),
        );
        if (droppedTerminalReports > 0) {
          logWarn('[CallFlow] Dropped stale media-failure reports on reconnect', {
            count: droppedTerminalReports,
            callId: activeCallIdRef.current,
          });
        }
        signaling.flushQueue();
        connectSocketHandlersRef.current.fetchConversations();
        connectSocketHandlersRef.current.fetchBlocks();
        connectSocketHandlersRef.current.handleSocketConnected();
        connectSocketHandlersRef.current.wakeCallHeartbeat('socket-connect');
        if (!isInCallRef.current) return;
        setIsReconnecting(false);
        if (activeCallIdRef.current) {
          Telemetry.trackReconnect(activeCallIdRef.current);
          emitMetric('call.reconnect', 1, { callId: activeCallIdRef.current });
        }
        if (peerConnectionRef.current) {
          logInfo('[CallFlow] Socket reconnected mid-call; restarting ICE', {
            callId: activeCallIdRef.current,
            isCaller: isCallerRef.current,
          });
          beginIceRecoveryRef.current?.('socket-reconnect');
        }
      });

      signaling.on(TRANSPORT_EVENTS.DISCONNECT, reason => {
        logWarn('[CallFlow] Socket disconnected', { reason });
        connectSocketHandlersRef.current.handleSocketDisconnected();
        if (isInCallRef.current) {
          setIsReconnecting(true);
          connectSocketHandlersRef.current.updateStatus('Reconnecting…');
          noteRecoverySymptomRef.current?.('socket-disconnect');
          pauseRecoveryBudgetRef.current?.('socket-offline');
        }
      });

      signaling.on(TRANSPORT_EVENTS.CONNECT_ERROR, error => {
        logError('[CallFlow] Socket connect error', {
          message: errorMessage(error),
          description: (error as { description?: unknown })?.description,
        });
        connectSocketHandlersRef.current.recordConnectError();
      });

      signaling.on(SERVER_EVENTS.SESSION_INVALID, async ({ sessionId: staleSessionId } = {}) => {
        logWarn('[CallFlow] Session invalidated by server; re-minting session', {
          sessionId: staleSessionId,
          inCall: isInCallRef.current,
        });
        sessionIdRef.current = null;
        const attempts = sessionRemintAttempts(isInCallRef.current);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const newSessionId = await connectSocketHandlersRef.current.createOrGetSession();
            if (socketRef.current !== socket) return;
            logInfo('[CallFlow] Session re-minted after session.invalid', { attempt });
            connectSocket(newSessionId);
            return;
          } catch (error) {
            logWarn('[CallFlow] Session re-mint attempt failed', {
              attempt,
              attempts,
              message: errorMessage(error),
            });
            if (socketRef.current !== socket) return;
            if (attempt >= attempts) {
              logError('[CallFlow] Failed to re-mint session after session.invalid', error);
              connectSocketHandlersRef.current.updateStatus(SESSION_EXPIRED_MESSAGE, 'error');
              return;
            }
            await new Promise(resolve => setTimeout(resolve, SESSION_REMINT_RETRY_MS));
            if (socketRef.current !== socket) return;
          }
        }
      });

      return socket;
    },
    // Socket listeners read volatile handlers through connectSocketHandlersRef;
    // reconnecting is only required when the endpoint itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signalingUrl],
  );

  return { connectSocket, disconnectSocket };
}
