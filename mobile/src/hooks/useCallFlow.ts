import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import {
  CALL_EVENTS,
  CALL_STATES,
  INITIAL_CALL_STATE,
  callStateReducer,
} from '../call/callStateMachine';
import * as Telemetry from '../telemetry';
import { emitEvent, emitMetric, getCorrelationId } from '../observability';
import {
  applyPreferredAudioRoute,
  AUDIO_ROUTES,
  chooseAudioRoute,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../audioRouting';
import { startCallService, stopCallService } from '../callService';
import useAttachments from './useAttachments';
import useBlocks from './useBlocks';
import useCallHistory from './useCallHistory';
import useCompactCallView from './useCompactCallView';
import useIdentity from './useIdentity';
import useMessaging from './useMessaging';
import usePresenceSearch from './usePresenceSearch';
import useSession from './useSession';
import useStartupPermissions from './useStartupPermissions';
import { getConnectionQuality } from '../callUx';
import { getMediaAccessStatus, summarizeIceCandidate } from '../diagnostics';
import { initHaptics, triggerHaptic } from '../haptics';
import { consumePendingCallAction } from '../incomingCallNotification';
import { isTrackEnabled, setTrackEnabled } from '../mediaControls';
import { ensureCallPermissions, getMissingCallPermissions } from '../permissions';
import {
  addCallLinkListener,
  getInitialCallLink,
  installForegroundMessageHandler,
  registerForPushNotifications,
  sendPushReceipt,
  unregisterPushToken,
} from '../pushNotifications';
import { API_ROUTES } from '../../../shared';
import { getSocketOptions } from '../socketConfig';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  TRANSPORT_EVENTS,
  createSignalingClient,
} from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import {
  ICE_TRANSPORT_POLICIES,
  getIceServersForCall,
  applyBitrateConstraints,
  normalizeIceTransportPolicy,
} from '../webrtcConfig';
import useScreenShare from './useScreenShare';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from '../components/StatusBanner';
import type { MediaStream } from 'react-native-webrtc';
import type { Socket } from 'socket.io-client';
import type { IceTransportPolicy } from '../webrtcConfig';
import {
  bringAppToForeground,
  clearPendingAnswer,
  consumePendingAnswer,
  displayIncomingCall,
  endCall as endCallKeepCall,
  peekPendingAnswer,
  recordPendingAnswer,
  setCallActionHandlers as setCallKeepActionHandlers,
  reportCallConnected as reportCallKeepConnected,
  setupCallKeep,
} from '../callKeep';
import {
  startIncomingRingtone,
  startOutgoingRingback,
  stopIncomingRingtone,
  stopOutgoingRingback,
} from '../ringtone';

export type { CallRecord };

/**
 * An accept failure annotated with the canonical reason reported to the server.
 */
export type AnswerError = Error & { answerFailureReason?: string; };
export type { CallStatus };

/**
 * @returns the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
/**
 * `react-native-webrtc`'s peer connection, plus the legacy `on*` handler
 * properties it supports at runtime but omits from its published types.
 */
export type PeerConnection = RTCPeerConnection & { onicecandidate: ((event: any) => void) | null; ontrack: ((event: any) => void) | null; oniceconnectionstatechange: ((event: any) => void) | null; onconnectionstatechange: ((event: any) => void) | null; };
export type WebrtcMediaStream = MediaStream;

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';

const STATS_POLL_INTERVAL_MS = 7000;

/**
 * How long to wait for the signaling socket to connect before answering a call
 * over HTTP instead.  Kept short: on a cold start the caller is already
 * ringing, so a slow socket must never be the reason a call cannot be picked
 * up.
 */
const ANSWER_SOCKET_WAIT_MS = 5000;

/**
 * Call statuses that mean a call is up (or coming up) on this device.  A failed
 * accept must never tear one of these down: a duplicate Answer tap for a call
 * that is already connected fails server-side ("not ringing any more") and the
 * naive cleanup would kill the very call the user just picked up.
 */
const LIVE_CALL_STATUSES = new Set(['accepted', 'connecting_media', 'in_call']);

/** Statuses that mean a call has stopped ringing for good. */
const TERMINAL_CALL_STATUSES = new Set([
  'ended',
  'declined',
  'missed',
  'busy',
  'unreachable',
]);

/**
 * How often a connected client reports call liveness to the server.
 *
 * Mirrors `CALL_HEARTBEAT_INTERVAL_MS` on the server, which ends a connected
 * call only after several consecutive beats are missed.
 */
const CALL_HEARTBEAT_INTERVAL_MS = 30000;

/**
 * How long a peer connection may stay `disconnected`/`failed` before the loss
 * of media is reported to the server.
 *
 * ICE routinely dips through `disconnected` during a network handoff and
 * recovers on its own (and the caller additionally attempts an ICE restart on
 * `failed`), so reporting immediately would tear down recoverable calls.
 */
const ICE_FAILURE_GRACE_MS = 12000;

/** How many answered callIds are remembered for duplicate-accept suppression. */
const ANSWERED_CALL_HISTORY_LIMIT = 20;

/**
 * How often to proactively rotate the session token.  Set well below typical
 * server-side TTLs (e.g. 1 h) so the token never expires mid-call.
 */
const SESSION_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Call phases that drive which screen the UI renders.  Alias of the state
 * machine's `CALL_STATES` (see `src/call/callStateMachine`), kept under the
 * historical name for the hook's consumers.
 *
 * idle             – no active call; show Lobby
 * outgoing_ringing – caller placed a call, waiting for callee to answer
 * incoming_ringing – callee received a call, waiting for user action
 * in_call          – call accepted and media connected
 * ended            – transient terminal state; teardown then returns to idle
 */
export const CALL_PHASES = CALL_STATES;

/**
 * English display strings for server-side `endReason` codes.
 *
 * Each key mirrors a value that can appear in `call.endReason` from the
 * server.  The mapped string is the default English label shown in the UI.
 * Applications that support multiple languages should use these as fallback
 * defaults and provide translated overrides keyed by the same reason code.
 */
export const CALL_END_REASON_LABELS: Record<string, string> = {
  ended: 'Call ended',
  declined: 'Call declined',
  cancelled: 'Call cancelled',
  timeout: 'Missed call',
  missed: 'Missed call',
  busy: 'Line was busy',
  unreachable: 'User unavailable',
  failed: 'Call failed',
};

/**
 * Tell the server which calls this device still considers live.
 *
 * Used as a self-heal after a `busy` rejection: a call the server thinks is in
 * progress but that no client is holding is a phantom, and the server closes
 * it out when it hears the client's own view of the world.
 */
function reportOwnCallState(signaling: ReturnType<typeof createSignalingClient>, activeCallIds: string[]) {
  logInfo('[CallFlow] Reporting own call state after busy rejection', { activeCallIds });
  signaling.emit(
    CLIENT_EVENTS.CALL_STATE_REPORT,
    { version: SIGNALING_VERSION, activeCallIds },
    ack => {
      if (!ack?.ok) {
        logWarn('[CallFlow] call.state.report ack failed', ack?.error);
        return;
      }
      logInfo('[CallFlow] Server cleared phantom calls', {
        clearedCallIds: ack.clearedCallIds ?? [],
      });
    },
  );
}

/**
 * Manages the full lifecycle of a server-authoritative call:
 *
 *   1. User identity / session (POST /session)
 *   2. Persistent Socket.IO connection for incoming-call events
 *   3. Outgoing calls via `call.initiate`
 *   4. Incoming calls via `call.incoming`
 *   5. State machine driven by `call.state_changed`
 *   6. WebRTC negotiation via `rtc.offer / rtc.answer / rtc.candidate`
 *   7. In-call controls (mute, video, camera switch, speaker routing)
 *   8. Text chat: conversation list / history (`GET /conversations`,
 *      `GET /messages`), sending (`message.send`) with optimistic UI, unread
 *      tracking and read receipts (`POST /messages/read`), and the
 *      `call.media-state` relay used to mirror the peer's screen-share state.
 *
 * Identity persistence, session/auth, call history, chat, and presence/search
 * are each delegated to a dedicated hook (`useIdentity`, `useSession`,
 * `useCallHistory`, `useMessaging`, `usePresenceSearch`); this hook composes
 * them and owns only the call-lifecycle / signaling / WebRTC orchestration
 * that ties them together, so it stays true to a single, cohesive
 * responsibility rather than a grab-bag of every call-flow concern.
 *
 * The hook returns serialisable state and action callbacks so the UI remains
 * purely presentational.
 *
 * @param options persisted device
 *   preferences that influence call setup (see `useAppSettings`).
 */
export default function useCallFlow({
  speakerEnabledByDefault = false,
  iceTransportPolicy = ICE_TRANSPORT_POLICIES.ALL,
}: {
  speakerEnabledByDefault?: boolean;
  iceTransportPolicy?: IceTransportPolicy;
} = {}) {
  const activeIceTransportPolicy = normalizeIceTransportPolicy(iceTransportPolicy);
  // ─── Connection config ────────────────────────────────────────────────────
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [calleeId, setCalleeId] = useState('');

  // ─── Call lifecycle state ─────────────────────────────────────────────────
  // Single source of truth for the call lifecycle: every phase change goes
  // through the pure state machine in `src/call/callStateMachine`, so illegal
  // transitions (a late `rtc.answer` after hang-up, a second incoming call
  // while already connected, …) are ignored instead of corrupting the UI.
  const [callPhase, dispatchCallEvent] = useReducer(callStateReducer, INITIAL_CALL_STATE);
  
  const [activeCall, setActiveCall] = useState((null as CallRecord | null));
  
  const [incomingCall, setIncomingCall] = useState((null as CallRecord | null));

  // callId received from a push-notification deep link before the user identity
  // is fully established.  Cleared once rehydration is attempted.
  const [pendingPushCallId, setPendingPushCallId] = useState(
    (null as string | null),
  );

  // True from the moment `placeCall` is invoked until the call reaches
  // OUTGOING_RINGING (or fails). Lets chat-header call buttons show a brief
  // loading state instead of appearing to do nothing while the local camera
  // preview starts and the socket/`call.initiate` round-trip completes.
  const [isPlacingCall, setIsPlacingCall] = useState(false);

  // ─── UI state ─────────────────────────────────────────────────────────────
  // Raw state setter; callers use the `updateStatus(message, severity)` helper
  // declared below rather than setting the shape by hand.
  const [status, setStatus] = useState(
    ({ message: '', severity: 'info' } as CallStatus),
  );
  // Summary of the last connected call, shown once in the Lobby.
  const [callSummary, setCallSummary] = useState(
    (null as { durationSeconds: number | null, quality: string } | null),
  );

  // True while the remote participant is screen-sharing (relayed via the
  // `call.media-state` socket event).
  const [isRemoteScreenSharing, setIsRemoteScreenSharing] = useState(false);

  // ─── Media / WebRTC state ─────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState((null as WebrtcMediaStream | null));
  const [remoteStream, setRemoteStream] = useState((null as WebrtcMediaStream | null));
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  // Starts false: the route is picked automatically from the connected
  // devices (Bluetooth → wired → earpiece) and only becomes the loudspeaker
  // when nothing else is available or the user asks for it.
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(false);
  // Route the user explicitly picked; never overridden by automatic
  // re-evaluation for the rest of the call.
  const manualAudioRouteRef = useRef((null as string | null));
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [elapsedCallSeconds, setElapsedCallSeconds] = useState(0);
  const [audioDevices, setAudioDevices] = useState(
    ({
      available: [],
      selected: null,
    } as { available: any[], selected: any }),
  );
  const [connectionQuality, setConnectionQuality] = useState({
    bars: 0,
    label: 'No link',
  });
  const [isReconnecting, setIsReconnecting] = useState(false);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const socketRef = useRef((null as Socket | null));
  // Typed wrapper around `socketRef.current`: validates every payload against
  // the shared contract and queues fire-and-forget emits while offline.
  const signalingRef = useRef(
    (null as ReturnType<typeof createSignalingClient> | null),
  );
  const peerConnectionRef = useRef((null as PeerConnection | null));
  const pendingPeerConnectionRef = useRef((null as Promise<PeerConnection> | null));
  const localStreamRef = useRef((null as WebrtcMediaStream | null));
  const activeCallIdRef = useRef((null as string | null));
  const isCallerRef = useRef(false);
  // Synchronous mirror of isPlacingCall so `placeCall` can guard re-entrancy
  // (rapid double-tap) without waiting for the state update to flush.
  const isPlacingCallRef = useRef(false);
  const callConnectedAtRef = useRef((null as number | null));
  const elapsedTimerRef = useRef((null as ReturnType<typeof setInterval> | null));
  // Guards against re-emitting `call.connected` for the same call (both ICE
  // and connection-state callbacks fire, often more than once).
  const connectedReportedCallIdRef = useRef((null as string | null));
  // Periodic in-call liveness report to the server (see CALL_HEARTBEAT_INTERVAL_MS).
  const heartbeatTimerRef = useRef((null as ReturnType<typeof setInterval> | null));
  // Pending "media is gone" report, cancelled if ICE recovers in time.
  const iceFailureTimerRef = useRef((null as ReturnType<typeof setTimeout> | null));
  // Mirrors `isScreenSharing` so the heartbeat can carry the current flag
  // without re-creating the timer on every toggle.
  const isScreenSharingRef = useRef(false);
  const connectionQualityRef = useRef({ bars: 0, label: 'No link' });
  const connectionStatsRef = useRef(
    ({
      timestampMs: null,
      totalBytesReceived: 0,
    } as { timestampMs: number | null, totalBytesReceived: number }),
  );
  const selectedCandidatePairRef = useRef((null as string | null));
  const isInCallRef = useRef(false);
  // ICE candidates that arrive before the remote description is applied are
  // buffered here and flushed once setRemoteDescription succeeds.
  const iceCandidateBufferRef = useRef(([] as any[]));
  // Prevents concurrent offer/answer negotiations (glare guard).
  const isNegotiatingRef = useRef(false);
  // Refs that mirror activeCall / incomingCall state for use in any callback
  // where capturing the value via a React closure would otherwise be stale.
  const activeCallRef = useRef((null as CallRecord | null));
  const incomingCallRef = useRef((null as CallRecord | null));
  // Tracks callIds for which the incoming-call UI has already been shown so
  // duplicate socket or push events never trigger a second CallKeep display.
  const displayedIncomingCallIdsRef = useRef((new Set() as Set<string>));
  // Answer bookkeeping. The same tap can reach `acceptIncomingCall` through
  // several paths at once (CallKeep event, replayed queue entry, in-app
  // button), and a second accept for a call that is already up fails
  // server-side — so each callId is accepted at most once.
  const acceptInFlightCallIdRef = useRef((null as string | null));
  const answeredCallIdsRef = useRef(([] as string[]));
  // callIds whose queued answer has already been replayed, so the replay effect
  // stays a no-op when `acceptIncomingCall`'s identity changes.
  const replayedAnswerCallIdsRef = useRef((new Set() as Set<string>));

  const updateStatus: (message: string, severity?: CallStatus['severity']) => void = useCallback((message, severity = 'info') => {
    logVerbose('[CallFlow] Status updated', { message, severity });
    setStatus({ message, severity });
  }, []);

  // ─── Composed sub-hooks (identity / session / history / presence / chat) ──
  // Each owns a single, cohesive concern and is unit-testable in isolation;
  // this hook wires them together and layers the call-signaling/WebRTC
  // orchestration that ties them into one coherent call experience.
  const identity = useIdentity(updateStatus);
  const { userId, unregisterUser: identityUnregisterUser } = identity;

  const session = useSession({
    signalingUrl,
    userId,
    updateStatus,
  });
  const { sessionIdRef, deviceIdRef, authedFetchRef, createOrGetSession, refreshSession, authedFetch } = session;

  const callHistory = useCallHistory({
    authedFetchRef,
    sessionIdRef,
    signalingUrl,
    userId,
  });

  const blocks = useBlocks({ authedFetchRef, sessionIdRef, signalingUrl });
  const { fetchBlocks } = blocks;
  const { addToHistory } = callHistory;

  const presenceSearch = usePresenceSearch({
    signalingUrl,
    authedFetchRef,
    sessionIdRef,
    calleeId,
  });
  const {
    checkPresence,
    recordConnectSuccess,
    recordConnectError,
    resetOfflineTracking,
    markServerUnreachable,
  } = presenceSearch;

  const messaging = useMessaging({
    authedFetchRef,
    sessionIdRef,
    signalingRef,
    signalingUrl,
    socketRef,
    userId,
    updateStatus,
  });
  const {
    activeChatPeerId,
    fetchConversations,
    markConversationRead,
    resetTypingState,
    handleMessageReceived,
    handleMessageDeleted,
    handleMessageReaction,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
    handleSocketConnected,
    handleSocketDisconnected,
  } = messaging;

  const attachments = useAttachments({
    authedFetchRef,
    signalingUrl,
    sendMessage: messaging.sendMessage,
    updateStatus,
  });

  // Renegotiate the active peer connection (used when screen audio adds or
  // removes a sender). The remote peer answers renegotiation offers with the
  // same `rtc.offer` handler used for the initial negotiation.
  const renegotiate = useCallback(async () => {
    const pc = peerConnectionRef.current;
    const socket = socketRef.current;
    const callId = activeCallIdRef.current;
    if (!pc || !socket?.connected || !callId) return;
    if (isNegotiatingRef.current) {
      logWarn('[CallFlow] Skipping renegotiation while another is in flight');
      return;
    }
    isNegotiatingRef.current = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signalingRef.current?.emit(
        CLIENT_EVENTS.RTC_OFFER,
        {
          version: SIGNALING_VERSION,
          callId,
          sdp: pc.localDescription ?? offer,
        },
        ack => {
          if (!ack?.ok) logWarn('[CallFlow] renegotiation rtc.offer ack failed', ack?.error);
        },
      );
      logInfo('[CallFlow] Renegotiation offer sent');
    } catch (error) {
      logError('[CallFlow] Renegotiation failed', error);
    } finally {
      isNegotiatingRef.current = false;
    }
  }, []);

  const {
    isScreenSharing,
    isScreenAudioShared,
    isScreenAudioEnabled,
    isScreenShareSupported,
    handleScreenShareToggle,
    handleScreenAudioToggle,
    resetScreenShare,
  } = useScreenShare({
    peerConnectionRef,
    localStreamRef,
    setLocalStream,
    setStatus: updateStatus,
    renegotiate,
  });

  const isInCall = callPhase === CALL_PHASES.IN_CALL;
  const { isRegistered } = identity;

  // Closing the Picture-in-Picture window must end the call: leaving it running
  // invisibly gives the user no way back to it and no way to hang up.
  const { isCompactView, setIsCompactView } = useCompactCallView(isInCallRef, {
    onPictureInPictureClosed: () =>
      endActiveCallRef.current?.('Call ended', 'info', 'ended'),
  });

  /**
   * Clear the persisted identity and disconnect.  After this the app returns
   * to the RegistrationScreen on next launch.
   */
  const unregisterUser = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const trimmedUrl = (signalingUrl ?? '').trim();
    if (sessionId && trimmedUrl) {
      // Best-effort: drop the device push registration so a signed-out device
      // stops receiving incoming-call notifications.
      await unregisterPushToken({ sessionId, signalingUrl: trimmedUrl }).catch(() => {});
    }
    await identityUnregisterUser();
  }, [identityUnregisterUser, sessionIdRef, signalingUrl]);

  // `ended` is the machine's terminal state; `endActiveCall` has already run
  // the teardown by the time it is entered, so acknowledge it immediately and
  // return the machine to `idle` (which is what the lobby renders from).
  useEffect(() => {
    if (callPhase === CALL_STATES.ENDED) {
      dispatchCallEvent(CALL_EVENTS.RESET);
    }
  }, [callPhase]);

  useEffect(() => {
    isInCallRef.current = isInCall;
    logVerbose('[CallFlow] Phase changed', {
      callPhase,
      isInCall,
      activeCallId: activeCallRef.current?.callId ?? null,
      incomingCallId: incomingCallRef.current?.callId ?? null,
    });
  }, [callPhase, isInCall]);

  useEffect(() => {
    connectionQualityRef.current = connectionQuality;
  }, [connectionQuality]);

  // Track the OS "reduce motion" accessibility setting so call haptics stay
  // silent for users who asked for reduced motion.
  useEffect(() => initHaptics(), []);

  /** Stop the in-call liveness heartbeat (idempotent). */
  const stopCallHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  /**
   * Report call liveness to the server every `CALL_HEARTBEAT_INTERVAL_MS`.
   *
   * Reuses the existing `call.media-state` relay: the server stamps the call
   * on every inbound frame, which is how it tells a long healthy conversation
   * apart from one both devices silently abandoned.
   */
  const startCallHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) return;
    heartbeatTimerRef.current = setInterval(() => {
      const callId = activeCallIdRef.current;
      if (!callId || !socketRef.current?.connected) return;
      signalingRef.current
        ?.request(CLIENT_EVENTS.CALL_MEDIA_STATE, {
          version: SIGNALING_VERSION,
          callId,
          mediaState: { isScreenSharing: isScreenSharingRef.current, heartbeat: true },
        })
        .catch(error => {
          logWarn('[CallFlow] call heartbeat failed', { message: errorMessage(error) });
        });
    }, CALL_HEARTBEAT_INTERVAL_MS);
  }, []);

  /** Cancel a pending "media is gone" report because ICE recovered. */
  const clearMediaFailureReport = useCallback(() => {
    if (iceFailureTimerRef.current) {
      clearTimeout(iceFailureTimerRef.current);
      iceFailureTimerRef.current = null;
    }
  }, []);

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
      clearMediaFailureReport();
      startCallHeartbeat();
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
    [clearMediaFailureReport, startCallHeartbeat],
  );

  /**
   * Report that media was lost, after a grace period.
   *
   * ICE dips through `disconnected` on any network handoff and often recovers
   * (the caller also attempts an ICE restart on `failed`), so the report is
   * delayed and cancelled the moment the connection comes back — but once the
   * grace period lapses the server ends the call immediately instead of
   * leaving it stranded until a sweep notices.
   */
  const reportMediaFailure = useCallback(/** @param iceState */ (iceState: string) => {
    if (iceFailureTimerRef.current || !activeCallIdRef.current) return;
    iceFailureTimerRef.current = setTimeout(() => {
      iceFailureTimerRef.current = null;
      const callId = activeCallIdRef.current;
      const pc = peerConnectionRef.current;
      if (!callId || !pc) return;
      const currentState = pc.iceConnectionState ?? pc.connectionState;
      if (currentState === 'connected' || currentState === 'completed') return;
      logWarn('[CallFlow] Media did not recover; reporting failure', { callId, currentState });
      signalingRef.current?.emit(CLIENT_EVENTS.CALL_CONNECTED, {
        version: SIGNALING_VERSION,
        callId,
        iceState: iceState === 'failed' ? 'failed' : 'disconnected',
      });
    }, ICE_FAILURE_GRACE_MS);
  }, []);

  const markCallConnected = useCallback(() => {
    if (callConnectedAtRef.current) return;
    triggerHaptic('connect');
    callConnectedAtRef.current = Date.now();
    if (activeCallIdRef.current) {
      Telemetry.trackCallConnected(activeCallIdRef.current);
    }
    setElapsedCallSeconds(0);
    elapsedTimerRef.current = setInterval(() => {
      if (!callConnectedAtRef.current) return;
      setElapsedCallSeconds(Math.floor((Date.now() - callConnectedAtRef.current) / 1000));
    }, 1000);

    // Apply bitrate caps now that media is flowing; best-effort.
    const pc = peerConnectionRef.current;
    if (pc) {
      applyBitrateConstraints(pc).catch(() => {});
    }
  }, []);

  /**
   * Stop and drop the local camera/mic stream.
   *
   * Also blanks the local video view: an `RTCView` whose stream was torn down
   * keeps presenting its last decoded frame, which is exactly the frozen image
   * left behind in the Picture-in-Picture window after a call ends.
   */
  const releaseLocalMedia = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks?.().forEach(track => {
        try {
          track.stop();
        } catch {
          // Best-effort: the track may already have been ended by the OS.
        }
      });
      localStreamRef.current = null;
    }
    setLocalStream(null);
  }, []);

  const closePeerConnection = useCallback(() => {
    iceCandidateBufferRef.current = [];
    isNegotiatingRef.current = false;
    // A connection whose creation is still in flight must not survive teardown.
    const pending = pendingPeerConnectionRef.current;
    pendingPeerConnectionRef.current = null;
    if (pending) {
      pending
        .then(pc => {
          if (peerConnectionRef.current === pc) peerConnectionRef.current = null;
          pc?.close?.();
        })
        .catch(() => {});
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    setConnectionQuality({ bars: 0, label: 'No link' });
    connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
  }, []);

  const configurePeerConnection = useCallback(
    /** @param pc */
    async (pc: PeerConnection) => {
      const iceServers = await getIceServersForCall({
        signalingUrl,
        sessionId: sessionIdRef.current,
      });
      pc.setConfiguration?.({ iceServers, iceTransportPolicy: activeIceTransportPolicy });
      return pc;
    },
    [activeIceTransportPolicy, signalingUrl, sessionIdRef],
  );

  const createPeerConnection = useCallback(async () => {
    logInfo('[CallFlow] Creating RTCPeerConnection', {
      iceTransportPolicy: activeIceTransportPolicy,
    });
    // ICE servers must be known *before* construction: gathering starts as soon
    // as the connection is used, so applying relay servers afterwards can leave
    // relay candidates ungathered. getIceServersForCall never throws — it
    // degrades to build-time config and finally STUN-only.
    const iceServers = await getIceServersForCall({
      signalingUrl,
      sessionId: sessionIdRef.current,
    });
    const pc = (new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: activeIceTransportPolicy,
    }) as PeerConnection);

    const currentLocalStream = localStreamRef.current;
    if (currentLocalStream) {
      // Guard against double-adding tracks when ensurePeerConnection is called
      // more than once during renegotiation (idempotent attach).
      const attachedTracks = new Set((pc.getSenders?.() ?? []).map(s => s.track).filter(Boolean));
      currentLocalStream.getTracks().forEach(track => {
        if (!attachedTracks.has(track)) {
          pc.addTrack(track, currentLocalStream);
        }
      });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !socketRef.current?.connected) return;
      const summary = summarizeIceCandidate(candidate);
      logInfo('[CallFlow] ICE candidate sent', summary);
      signalingRef.current?.emit(CLIENT_EVENTS.RTC_CANDIDATE, {
        version: SIGNALING_VERSION,
        callId: activeCallIdRef.current,
        candidate,
      });
    };

    pc.ontrack = ({ streams }) => {
      const [stream] = streams;
      if (stream) {
        logInfo('[CallFlow] Remote stream connected');
        setRemoteStream(current => {
          // Screen sharing with screen audio adds a *second* stream that only
          // carries an audio track. Letting it replace the primary stream would
          // leave the remote video view with nothing to render (blank screen).
          if (current && stream.id !== current.id && !stream.getVideoTracks?.().length) {
            return current;
          }
          return stream;
        });
        if (activeCallIdRef.current) {
          Telemetry.trackFirstRemoteFrame(activeCallIdRef.current);
        }
        markCallConnected();
        updateStatus('Call connected', 'success');
      }
    };

    // The server has no other way of knowing media established: `connected`
    // here is what advances the call out of `connecting_media` and exempts it
    // from the media-connect sweep.
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      logInfo('[CallFlow] Peer connection state', { state });
      if (state === 'connected') {
        reportCallConnected(state);
      } else if (state === 'disconnected' || state === 'failed') {
        reportMediaFailure(state);
      }
    };

    // Trigger an ICE restart when the caller detects ICE failure so the call
    // can survive a network handoff without tearing down entirely.
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      logInfo('[CallFlow] ICE connection state', { state });
      if (state === 'connected' || state === 'completed') {
        reportCallConnected(state);
        return;
      }
      if (state === 'disconnected') {
        reportMediaFailure(state);
        return;
      }
      if (state !== 'failed') return;
      // A failed connection is reported too (after the grace period) so the
      // server ends the call promptly rather than waiting for a sweep; the
      // report is cancelled if the ICE restart below succeeds.
      reportMediaFailure(state);
      emitMetric('call.ice_failed', 1, { callId: activeCallIdRef.current });
      if (!isCallerRef.current || !socketRef.current?.connected) return;
      logWarn('[CallFlow] ICE failed; attempting restart');
      if (activeCallIdRef.current) {
        Telemetry.trackIceRestart(activeCallIdRef.current);
      }
      (async () => {
        try {
          await configurePeerConnection(pc);
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          signalingRef.current?.emit(
            CLIENT_EVENTS.RTC_OFFER,
            {
              version: SIGNALING_VERSION,
              callId: activeCallIdRef.current,
              sdp: pc.localDescription,
            },
            ack => {
              if (!ack?.ok) logWarn('[CallFlow] ICE restart rtc.offer ack failed', ack?.error);
            },
          );
        } catch (err) {
          logError('[CallFlow] ICE restart failed', err);
        }
      })();
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [
    activeIceTransportPolicy,
    configurePeerConnection,
    markCallConnected,
    reportCallConnected,
    reportMediaFailure,
    sessionIdRef,
    signalingUrl,
    updateStatus,
  ]);

  const ensurePeerConnection = useCallback(async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;
    // Creation is asynchronous (ICE servers are fetched first), so concurrent
    // callers must share the same in-flight connection.
    if (!pendingPeerConnectionRef.current) {
      const creation = createPeerConnection().finally(() => {
        if (pendingPeerConnectionRef.current === creation) {
          pendingPeerConnectionRef.current = null;
        }
      });
      pendingPeerConnectionRef.current = creation;
    }
    return pendingPeerConnectionRef.current;
  }, [createPeerConnection]);

  // ─── Local media ──────────────────────────────────────────────────────────

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;

    const permResult = await ensureCallPermissions();
    if (!permResult.ok) {
      updateStatus(permResult.message, 'error');
      return null;
    }
    if (permResult.warningMessage) {
      logWarn('[CallFlow] Optional permission denied', {
        message: permResult.warningMessage,
      });
    }

    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: 'user' },
      });
      logInfo('[CallFlow] Local media stream acquired', {
        audio: stream.getAudioTracks().length,
        video: stream.getVideoTracks().length,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(!isTrackEnabled(stream, 'audio'));
      setIsVideoEnabled(isTrackEnabled(stream, 'video'));
      return stream;
    } catch (error) {
      logError('[CallFlow] Failed to acquire media', error);
      updateStatus(getMediaAccessStatus(error), 'error');
      throw error;
    }
  }, [updateStatus]);

  // ─── Incoming call UI helper ──────────────────────────────────────────────

  /**
   * Show the system-level incoming-call UI for `call` (via CallKeep) and start
   * the JS ringtone fallback when CallKeep is unavailable.  Guards against
   * duplicate display for the same callId.
   *
   * Never throws; failures are logged and degraded gracefully.
   */
  const showIncomingCallUi = useCallback(
    /** @param call */
    async (call: { callId: string; callerId?: string | null; }) => {
    if (!call?.callId) return;
    if (displayedIncomingCallIdsRef.current.has(call.callId)) return;
    displayedIncomingCallIdsRef.current.add(call.callId);

    triggerHaptic('incomingRing');

    logInfo('[CallFlow] Requesting incoming-call UI', {
      callId: call.callId,
      callerId: call.callerId ?? null,
    });

    const displayResult = await displayIncomingCall({
      callId: call.callId,
      callerId: call.callerId,
    }).catch(error => {
      logWarn('[CallFlow] displayIncomingCall failed', {
        message: errorMessage(error),
      });
      return { shown: false, reason: 'telecom_threw', message: errorMessage(error) };
    });

    logInfo('[CallFlow] Incoming-call UI result', {
      callId: call.callId,
      ...displayResult,
    });

    if (!displayResult.shown) {
      // CallKeep is unavailable – fall back to a JS ringtone so the user still
      // hears an audible alert in the foreground.
      startIncomingRingtone();
    }
  }, []);

  // ─── Call teardown ────────────────────────────────────────────────────────

  /**
   * Wind down an active call.  Preserves the socket connection so the user
   * can receive subsequent incoming calls without reconnecting.
   *
   * @param [nextMessage='Call ended'] - Status message to display.
   * @param [severity='info']          - Status severity.
   * @param [endReason=null]      - Canonical end-reason code
   *   (one of the keys from CALL_END_REASON_LABELS) for history tracking.
   */
  const endActiveCall = useCallback(
    /**
     * @param [nextMessage='Call ended']
     * @param [severity='info']
     * @param [endReason=null]
     */
    (nextMessage: string = 'Call ended', severity: CallStatus['severity'] = 'info', endReason: string | null = null) => {
      // Capture call record before clearing – activeCallRef / incomingCallRef
      // are kept in sync with state throughout the call lifecycle.
      const callRecord = activeCallRef.current ?? incomingCallRef.current;
      const isCaller = isCallerRef.current;

      triggerHaptic('end');

      // Dismiss any OS-level call UI (CallKeep) shown for this call.
      if (callRecord?.callId) {
        endCallKeepCall(callRecord.callId);
        // Allow the same callId to show the incoming-call UI again if the user
        // receives a completely new call after this one ends.
        displayedIncomingCallIdsRef.current.delete(callRecord.callId);
      }

      // Stop any JS-layer fallback ringtone (idempotent).
      stopIncomingRingtone();
      stopOutgoingRingback();
      logInfo('[CallFlow] Ringing stopped');

      const durationSeconds = callConnectedAtRef.current
        ? Math.floor((Date.now() - callConnectedAtRef.current) / 1000)
        : null;

      if (callConnectedAtRef.current) {
        setCallSummary({
          durationSeconds,
          quality: connectionQualityRef.current?.label || 'No link',
        });
      }

      // Emit QoS summary telemetry for post-call diagnosis.
      if (callRecord?.callId) {
        const qos = Telemetry.trackCallEnd(callRecord.callId);
        if (qos) {
          emitEvent('info', 'call.qos', qos);
        }
      }

      // Record in call history whenever we have a call object to log.
      if (callRecord?.callId) {
        const resolvedReason = endReason ?? callRecord.endReason ?? null;
        const isMissed =
          resolvedReason === 'missed' ||
          resolvedReason === 'timeout' ||
          callRecord.status === 'missed';
        addToHistory({
          callId: callRecord.callId,
          callerId: callRecord.callerId,
          calleeId: callRecord.calleeId,
          direction: isCaller ? 'outgoing' : 'incoming',
          status: callRecord.status,
          endReason: resolvedReason,
          createdAt: callRecord.createdAt,
          durationSeconds,
          isRead: !isMissed,
        });
      }

      callConnectedAtRef.current = null;
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      stopCallHeartbeat();
      clearMediaFailureReport();
      connectedReportedCallIdRef.current = null;

      activeCallIdRef.current = null;
      isCallerRef.current = false;
      activeCallRef.current = null;
      incomingCallRef.current = null;

      dispatchCallEvent(CALL_EVENTS.END);
      setActiveCall(null);
      setIncomingCall(null);
      setIsReconnecting(false);
      setElapsedCallSeconds(0);
      setIsCompactView(false);
      setIsLocalPrimary(false);
      setAudioDevices({ available: [], selected: null });
      setIsRemoteScreenSharing(false);
      resetScreenShare();
      stopCallService();
      closePeerConnection();
      releaseLocalMedia();
      if (nextMessage) updateStatus(nextMessage, severity);
    },
    [
      addToHistory,
      clearMediaFailureReport,
      closePeerConnection,
      releaseLocalMedia,
      resetScreenShare,
      setIsCompactView,
      stopCallHeartbeat,
      updateStatus,
    ],
  );

  // ─── Socket connection ────────────────────────────────────────────────────

  /**
   * Disconnect and discard the current socket (if any).
   * Does NOT clear the session ID – sessions are reused across reconnects
   * until the userId or signalingUrl changes.
   */
  const disconnectSocket = useCallback(() => {
    if (socketRef.current) {
      logInfo('[CallFlow] Disconnecting socket');
      socketRef.current.off(); // remove all listeners before disconnect
      socketRef.current.disconnect();
      socketRef.current = null;
      signalingRef.current = null;
    }
    resetTypingState();
  }, [resetTypingState]);

  // Store mutable callbacks in refs so socket listeners always call the latest
  // version without the socket needing to be recreated.
  const endActiveCallRef = useRef(endActiveCall);
  useEffect(() => {
    endActiveCallRef.current = endActiveCall;
  }, [endActiveCall]);

  const ensurePeerConnectionRef = useRef(ensurePeerConnection);
  useEffect(() => {
    ensurePeerConnectionRef.current = ensurePeerConnection;
  }, [ensurePeerConnection]);

  const startLocalPreviewRef = useRef(startLocalPreview);
  useEffect(() => {
    startLocalPreviewRef.current = startLocalPreview;
  }, [startLocalPreview]);

  /**
   * Create and return a new authenticated Socket.IO connection.
   * All call-level and RTC-relay events are registered here.
   *
   * Uses ref-forwarded callbacks so the socket never needs to be recreated
   * simply because a callback identity changed.
   */
  const connectSocket = useCallback(
      (sessionId: string) => {
      disconnectSocket();

      logInfo('[CallFlow] Connecting socket', { signalingUrl });
      // The correlation id travels on the handshake so the server can stamp it
      // on its own signaling logs, making a failed call traceable end to end.
      const socket = io(signalingUrl.trim(), {
        ...getSocketOptions(),
        auth: { sessionId, correlationId: getCorrelationId() },
      });
      socketRef.current = socket;
      const signaling = createSignalingClient(socket);
      signalingRef.current = signaling;

      // ── Incoming call ──────────────────────────────────────────────────
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
        dispatchCallEvent(CALL_EVENTS.RECEIVE);
        updateStatus(`Incoming call from ${call.callerId}`);
        // Show system-level incoming-call UI (CallKeep) and start the JS
        // ringtone fallback when CallKeep is unavailable.  Runs async so UI
        // state updates are never blocked if CallKeep setup is slow.
        showIncomingCallUi(call).catch(error => {
          logWarn('[CallFlow] showIncomingCallUi unexpected error', {
            message: errorMessage(error),
          });
        });
      });

      // ── Call ringing (caller confirmation) ────────────────────────────
      signaling.on(SERVER_EVENTS.CALL_RINGING, ({ call }) => {
        logInfo('[CallFlow] Call ringing', { callId: call.callId });
        activeCallRef.current = call;
        setActiveCall(call);
      });

      // ── Call state changes ────────────────────────────────────────────
      signaling.on(
        SERVER_EVENTS.CALL_STATE_CHANGED,
        async ({ status: callStatus, call, reason }) => {
          logInfo('[CallFlow] call.state_changed', {
            callStatus,
            callId: call?.callId,
            reason,
          });
          const eventCallId = call?.callId ?? null;
          const knownCallId =
            activeCallIdRef.current ??
            activeCallRef.current?.callId ??
            incomingCallRef.current?.callId ??
            null;

          // A call that stops ringing — cancelled, declined, missed, timed out —
          // must take its OS notification with it, otherwise the shade keeps a
          // tappable ghost that answers a call nobody can join.
          if (eventCallId && TERMINAL_CALL_STATUSES.has(callStatus)) {
            logInfo('[CallFlow] Dismissing call UI for terminal transition', {
              callId: eventCallId,
              callStatus,
              reason: reason ?? null,
            });
            clearPendingAnswer(eventCallId, `state_${callStatus}`);
            displayedIncomingCallIdsRef.current.delete(eventCallId);
            endCallKeepCall(eventCallId);
          }

          // Transitions for a *different* call (a stale ring that ended while
          // this one is up) must not touch the call currently in progress.
          if (eventCallId && knownCallId && eventCallId !== knownCallId) {
            logInfo('[CallFlow] Ignoring state change for a non-current call', {
              callId: eventCallId,
              knownCallId,
              callStatus,
            });
            return;
          }

          if (call) {
            activeCallRef.current = call;
            setActiveCall(call);
          }

          switch (callStatus) {
            case 'accepted': {
              stopOutgoingRingback();
              updateStatus('Call accepted, connecting media…');
              // Caller is responsible for sending the initial RTC offer.
              if (isCallerRef.current && call) {
                activeCallIdRef.current = call.callId;
                try {
                  await startLocalPreviewRef.current?.();
                  const pc = await ensurePeerConnectionRef.current?.();
                  if (!pc) break;
                  const offer = await pc.createOffer();
                  await pc.setLocalDescription(offer);
                  signaling.emit(
                    CLIENT_EVENTS.RTC_OFFER,
                    {
                      version: SIGNALING_VERSION,
                      callId: call.callId,
                      sdp: pc.localDescription,
                    },
                    ack => {
                      if (!ack?.ok) logWarn('[CallFlow] rtc.offer ack failed', ack?.error);
                    },
                  );
                } catch (error) {
                  logError('[CallFlow] Failed to create/send RTC offer', error);
                  updateStatus('Failed to connect media', 'error');
                  endActiveCallRef.current?.('Failed to connect media', 'error');
                }
              }
              break;
            }

            case 'declined':
              endActiveCallRef.current?.('Call declined', 'info', 'declined');
              break;

            case 'missed':
              endActiveCallRef.current?.('Call not answered', 'error', 'missed');
              break;

            case 'busy': {
              // Self-heal: `busy` means the server still believes one of the
              // participants is in a call.  When this device holds no live call,
              // say so, so the server can clear the phantom that is blocking
              // every new call instead of the user being stuck forever.
              const liveCallIds = [
                activeCallIdRef.current,
                incomingCallRef.current?.callId,
              ].filter(id => id && id !== eventCallId);
              if (liveCallIds.length === 0) {
                reportOwnCallState(signaling, []);
              }
              endActiveCallRef.current?.('Callee is busy', 'error', 'busy');
              break;
            }

            case 'unreachable':
              endActiveCallRef.current?.('Callee is unreachable', 'error', 'unreachable');
              break;

            case 'ended':
              endActiveCallRef.current?.(
                reason === 'cancelled' ? 'Call cancelled' : 'Call ended',
                'info',
                reason ?? 'ended',
              );
              break;

            default:
              break;
          }
        },
      );

      // ── RTC offer (callee receives offer from caller) ─────────────────
      signaling.on(SERVER_EVENTS.RTC_OFFER, async ({ sdp, callId }) => {
        if (callId !== activeCallIdRef.current) {
          logWarn('[CallFlow] rtc.offer for unknown callId', { callId });
          return;
        }
        if (isNegotiatingRef.current) {
          logWarn('[CallFlow] Glare: ignoring concurrent rtc.offer');
          return;
        }
        isNegotiatingRef.current = true;
        logInfo('[CallFlow] RTC offer received');
        try {
          const pc = await ensurePeerConnectionRef.current?.();
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          // Flush any ICE candidates that arrived before the remote description.
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
          updateStatus('Connected', 'success');
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC offer', error);
          updateStatus('Failed to connect media', 'error');
          endActiveCallRef.current?.('Failed to connect media', 'error');
        } finally {
          isNegotiatingRef.current = false;
        }
      });

      // ── RTC answer (caller receives answer from callee) ───────────────
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
          // Flush any ICE candidates that arrived before the remote description.
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
          updateStatus('Connected', 'success');
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC answer', error);
          updateStatus('Failed to connect media', 'error');
          endActiveCallRef.current?.('Failed to connect media', 'error');
        }
      });

      // ── RTC ICE candidates ────────────────────────────────────────────
      signaling.on(SERVER_EVENTS.RTC_CANDIDATE, async ({ candidate, callId }) => {
        if (callId !== activeCallIdRef.current) return;
        const pc = peerConnectionRef.current;
        if (!pc) return;
        // Buffer the candidate until the remote description is applied; adding
        // a candidate without a remote description throws on all platforms.
        if (!pc.remoteDescription) {
          iceCandidateBufferRef.current.push(candidate);
          logInfo('[CallFlow] ICE candidate buffered (awaiting remote description)');
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

      // ── Chat ─────────────────────────────────────────────────────────
      signaling.on(SERVER_EVENTS.MESSAGE_RECEIVED, ({ message }) => {
        handleMessageReceived(message);
      });

      signaling.on(SERVER_EVENTS.MESSAGE_DELETED, payload => {
        handleMessageDeleted(payload);
      });

      signaling.on(SERVER_EVENTS.MESSAGE_REACTION, payload => {
        handleMessageReaction(payload);
      });

      signaling.on(SERVER_EVENTS.MESSAGE_DELIVERED, ({ message }) => {
        handleMessageDelivered(message);
      });

      signaling.on(SERVER_EVENTS.MESSAGE_READ, ({ readerId, readAt }) => {
        handleMessageRead({ readerId, readAt });
      });

      signaling.on(SERVER_EVENTS.MESSAGE_TYPING, ({ senderId, isTyping }) => {
        handleTypingEvent({ senderId, isTyping });
      });

      // ── In-call screen-share relay ──────────────────────────────────────
      signaling.on(SERVER_EVENTS.CALL_MEDIA_STATE, ({ callId, mediaState }) => {
        if (callId !== activeCallIdRef.current) return;
        // A liveness heartbeat that carries no sharing flag must not clear the
        // "they are presenting" banner.
        if (!mediaState || !('isScreenSharing' in mediaState)) return;
        setIsRemoteScreenSharing(Boolean(mediaState.isScreenSharing));
      });

      // ── Socket lifecycle ──────────────────────────────────────────────
      socket.on(TRANSPORT_EVENTS.CONNECT, async () => {
        logInfo('[CallFlow] Socket connected', { socketId: socket.id });
        // Clear offline indicator on successful connection.
        recordConnectSuccess();
        // Replay anything that was emitted while the socket was down.
        signaling.flushQueue();
        // Load the conversation list as soon as the session is actually
        // live. `sessionIdRef` is only populated once `createOrGetSession`
        // resolves, which happens asynchronously — a chat-sync effect keyed
        // only on `isRegistered` (which flips as soon as a stored userId
        // loads, before the session exists) can fire too early and silently
        // no-op, leaving old messages/conversations unloaded until the user
        // manually pulls to refresh. Firing here guarantees it runs once the
        // session/socket are actually ready, on cold start and on reconnect.
        fetchConversations();
        // The blocklist gates who can appear in the directory, the chat list
        // and search, so it is loaded on the same "session is live" signal.
        fetchBlocks();
        // Flush any chat message queued while the socket was down (including
        // one composed in a previous run of the app).
        handleSocketConnected();
        if (!isInCallRef.current) return;
        setIsReconnecting(false);
        if (activeCallIdRef.current) {
          Telemetry.trackReconnect(activeCallIdRef.current);
          emitMetric('call.reconnect', 1, { callId: activeCallIdRef.current });
        }
        // When the caller's socket reconnects mid-call, send an ICE-restart
        // offer so the peer connection can negotiate a new network path.
        if (isCallerRef.current) {
          const pc = peerConnectionRef.current;
          if (pc) {
            try {
              logInfo('[CallFlow] Sending ICE restart offer after socket reconnect');
              if (activeCallIdRef.current) {
                Telemetry.trackIceRestart(activeCallIdRef.current);
              }
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              signaling.emit(
                CLIENT_EVENTS.RTC_OFFER,
                {
                  version: SIGNALING_VERSION,
                  callId: activeCallIdRef.current,
                  sdp: pc.localDescription,
                },
                ack => {
                  if (!ack?.ok) logWarn('[CallFlow] ICE restart rtc.offer ack failed', ack?.error);
                },
              );
            } catch (err) {
              logError('[CallFlow] ICE restart after socket reconnect failed', err);
            }
          }
        }
      });

      socket.on(TRANSPORT_EVENTS.DISCONNECT, reason => {
        logWarn('[CallFlow] Socket disconnected', { reason });
        handleSocketDisconnected();
        if (isInCallRef.current) {
          setIsReconnecting(true);
          updateStatus('Reconnecting…');
        }
      });

      socket.on(TRANSPORT_EVENTS.CONNECT_ERROR, error => {
        logError('[CallFlow] Socket connect error', {
          message: errorMessage(error),
          description: (error as { description?: unknown })?.description,
        });
        recordConnectError();
      });

      // The server accepted the handshake but the presented sessionId no
      // longer resolves to a live session (server restart dropped the
      // in-memory table, TTL expiry, …) and downgraded this connection to a
      // guest. Re-mint a session and reconnect so the client re-authenticates
      // immediately, instead of silently operating as an unauthenticated
      // guest until some later authenticated action (e.g. `call.initiate`) is
      // rejected.
      signaling.on(SERVER_EVENTS.SESSION_INVALID, async ({ sessionId: staleSessionId } = {}) => {
        logWarn('[CallFlow] Session invalidated by server; re-minting session', {
          sessionId: staleSessionId,
        });
        sessionIdRef.current = null;
        try {
          const newSessionId = await createOrGetSession();
          // A newer socket may already have replaced this one (e.g. the
          // presence effect re-ran, or the user signed out) — don't race it.
          if (socketRef.current !== socket) return;
          connectSocket(newSessionId);
        } catch (error) {
          logError('[CallFlow] Failed to re-mint session after session.invalid', error);
          updateStatus('Session expired — please reconnect.', 'error');
        }
      });

      return socket;
    },
    [
      createOrGetSession,
      disconnectSocket,
      updateStatus,
      showIncomingCallUi,
      signalingUrl,
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
      sessionIdRef,
      deviceIdRef,
      fetchConversations,
      fetchBlocks,
    ],
  );

  // ─── Call rehydration (push-notification deep link) ───────────────────────

  /**
   * Fetch the current state of a call by ID and restore the appropriate UI.
   *
   * Called when the app is opened (or brought to the foreground) from a push
   * notification tap.  Handles the three possible outcomes:
   *  - `ringing`  → show the IncomingCallScreen so the user can accept/decline
   *  - terminal   → show a brief informational status message
   *  - not found  → notify the user gracefully
   *
   * If the user identity is not yet known (userId or signalingUrl not set), the
   * callId is stored in `pendingPushCallId` and rehydration is deferred until
   * the presence auto-connect effect fires with a valid identity.
   */
  const rehydrateCallFromPush = useCallback(
    /**
     *   what happened, so callers replaying a queued answer can tell "still
     *   waiting on an identity" apart from "this call is gone".
     */
    async (callId: string): Promise<'deferred'|'ringing'|'terminal'|'not_found'|'error'|'ignored'> => {
      if (!callId) return 'ignored';

      const trimmedUserId = (userId ?? '').trim();
      const trimmedUrl = (signalingUrl ?? '').trim();

      if (!trimmedUserId || !trimmedUrl) {
        logInfo('[CallFlow] Deferring push rehydration until identity is set', {
          callId,
        });
        setPendingPushCallId(callId);
        return 'deferred';
      }

      logInfo('[CallFlow] Rehydrating call from push', { callId });

      try {
        const sessionId = await createOrGetSession();

        const response = await fetch(
          `${trimmedUrl}${API_ROUTES.CALLS}/${encodeURIComponent(callId)}` +
            `?sessionId=${encodeURIComponent(sessionId)}`,
        );

        if (!response.ok) {
          if (response.status === 404) {
            updateStatus('Call no longer available', 'info');
            return 'not_found';
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const call = await response.json();

        if (call.status === 'ringing') {
          logInfo('[CallFlow] Rehydrated ringing call; showing incoming screen', {
            callId: call.callId,
          });
          incomingCallRef.current = call;
          setIncomingCall(call);
          dispatchCallEvent(CALL_EVENTS.RECEIVE);
          updateStatus(`Incoming call from ${call.callerId}`);
          showIncomingCallUi(call).catch(error => {
            logWarn('[CallFlow] showIncomingCallUi unexpected error', {
              message: errorMessage(error),
            });
          });

          // Ensure a socket is live so the user can accept / decline.
          if (!socketRef.current?.connected) {
            connectSocket(sessionId);
          }
          return 'ringing';
        } else {
          // Terminal or non-ringing state – inform the user and stay idle.
          const terminalMessages = {
            missed: 'Missed call',
            declined: 'Call was declined',
            ended: 'Call ended',
            busy: 'Line was busy',
            unreachable: 'Call unreachable',
          };
          const message =
            terminalMessages[(call.status as keyof typeof terminalMessages)] ??
            'Call no longer active';
          logInfo('[CallFlow] Push call already finished', {
            callId,
            status: call.status,
          });
          updateStatus(message, 'info');
          return 'terminal';
        }
      } catch (error) {
        logError('[CallFlow] rehydrateCallFromPush failed', error);
        updateStatus('Unable to retrieve call state', 'error');
        return 'error';
      }
    },
    // connectSocket and createOrGetSession are stable relative to userId/signalingUrl
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, signalingUrl, updateStatus],
  );

  // Store in a ref so deep-link effects always call the latest version.
  const rehydrateCallFromPushRef = useRef(rehydrateCallFromPush);
  useEffect(() => {
    rehydrateCallFromPushRef.current = rehydrateCallFromPush;
  }, [rehydrateCallFromPush]);

  // ─── Presence: auto-connect when userId + signalingUrl are set ────────────
  // Keeps a persistent socket open so the user can receive incoming calls even
  // while on the Lobby screen.

  useEffect(() => {
    const trimmedUserId = userId.trim();
    const trimmedUrl = signalingUrl.trim();

    if (!trimmedUserId || !trimmedUrl) {
      // No identity – drop any existing socket/session.
      sessionIdRef.current = null;
      disconnectSocket();
      return undefined;
    }

    let cancelled = false;
    // Reset session so a new one is created for the new identity/URL.
    sessionIdRef.current = null;

    const connect = async () => {
      try {
        const sessionId = await createOrGetSession();
        if (!cancelled) {
          connectSocket(sessionId);
          // Bind this device to the user for offline (push) delivery.  Runs in
          // the background and degrades to a no-op when the native messaging
          // library is not installed, so it never blocks presence connection.
          registerForPushNotifications({
            sessionId,
            signalingUrl: trimmedUrl,
          })
            .then(registered => {
              if (!registered) {
                // Without a push registration the server has no way to reach
                // this device while the app is backgrounded/killed, so incoming
                // calls will silently never ring. Usually means the Firebase
                // config (google-services.json / GoogleService-Info.plist) is
                // missing from the build, or notifications were denied.
                logWarn(
                  '[CallFlow] No push token registered; incoming calls will not ring while the app is closed',
                );
              }
            })
            .catch(error => {
              logWarn('[CallFlow] Push registration failed', {
                message: errorMessage(error),
              });
            });
        }
      } catch (error) {
        if (!cancelled) {
          logWarn('[CallFlow] Failed to establish presence socket', {
            message: errorMessage(error),
          });
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      sessionIdRef.current = null;
      disconnectSocket();
    };
  }, [connectSocket, createOrGetSession, disconnectSocket, signalingUrl, userId, sessionIdRef]);

  // ─── Upfront permission request ───────────────────────────────────────────
  // Ask for every runtime permission the app can use (camera, microphone,
  // Bluetooth audio routing, notifications) once, right after an identity is
  // established, instead of only prompting the first time each feature is
  // used. Extracted into its own hook so this startup concern stays isolated
  // from this hook's call-lifecycle/session/WebRTC responsibilities.
  useStartupPermissions(userId);

  // ─── Proactive session refresh ────────────────────────────────────────────
  // Rotate the session token every SESSION_REFRESH_INTERVAL_MS (50 min) while
  // the user is signed in, so the token never expires mid-call.  The server's
  // SESSION_TTL_MS should be set well above this interval (e.g. 3600000 = 1 h).

  useEffect(() => {
    if (!userId.trim() || !signalingUrl.trim()) return undefined;

    const timer = setInterval(async () => {
      if (!sessionIdRef.current) return;
      await refreshSession().catch(error => {
        logWarn('[CallFlow] Proactive session refresh failed', {
          message: errorMessage(error),
        });
        updateStatus(
          'Session refresh failed — your token may expire soon. Reconnect if calls stop working.',
          'warning',
        );
      });
    }, SESSION_REFRESH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [userId, signalingUrl, refreshSession, updateStatus, sessionIdRef]);

  /**
   * Block `peerId` and immediately drop them from the local conversation list:
   * the server hides a blocked peer from `GET /conversations`, so refetching
   * is what makes the block visible in both directions right away.
   */
  const blockPeer = useCallback(
    async (peerId: string): Promise<boolean> => {
      const applied = await blocks.blockUser(peerId);
      if (applied) await fetchConversations();
      return applied;
    },
    [blocks, fetchConversations],
  );

  /**
   * Reverse a block, restoring the peer's conversation and directory entry.
   */
  const unblockPeer = useCallback(
    async (peerId: string): Promise<boolean> => {
      const removed = await blocks.unblockUser(peerId);
      if (removed) await fetchConversations();
      return removed;
    },
    [blocks, fetchConversations],
  );

  /**
   * Manually retry the presence socket connection when the server appears
   * unreachable.  Resets the offline indicator, creates a fresh session, and
   * reconnects the socket.
   */
  const retryPresenceConnect = useCallback(async () => {
    if (!userId.trim() || !signalingUrl.trim()) return;
    resetOfflineTracking();
    sessionIdRef.current = null;
    try {
      const sessionId = await createOrGetSession();
      connectSocket(sessionId);
    } catch (error) {
      logWarn('[CallFlow] retryPresenceConnect failed', {
        message: errorMessage(error),
      });
      markServerUnreachable();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, signalingUrl]); // createOrGetSession and connectSocket are stable relative to these

  useEffect(() => {
    return () => {
      disconnectSocket();
      closePeerConnection();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      stopCallHeartbeat();
      clearMediaFailureReport();
      stopCallService();
    };
  }, [clearMediaFailureReport, closePeerConnection, disconnectSocket, stopCallHeartbeat]);

  // ─── Deep-link / push-notification entry points ───────────────────────────

  // 1. Check if the app was launched from a notification tap (cold start).
  useEffect(() => {
    getInitialCallLink()
      .then(descriptor => {
        if (descriptor?.callId) {
          logInfo('[CallFlow] App launched from push notification', descriptor);
          rehydrateCallFromPushRef.current(descriptor.callId);
        }
      })
      .catch(error => {
        logError('[CallFlow] Failed to read initial call link', error);
      });
    // Run only once on mount.
  }, []);

  // 2. Listen for deep links while the app is already running (background → foreground).
  useEffect(() => {
    const unlisten = addCallLinkListener(descriptor => {
      logInfo('[CallFlow] Deep-link received while running', descriptor);
      rehydrateCallFromPushRef.current(descriptor.callId);
    });
    return unlisten;
    // Run only once on mount.
  }, []);

  // 3. Deferred rehydration: once identity is set, process any pending push callId.
  useEffect(() => {
    if (!pendingPushCallId) return;
    if (!(userId ?? '').trim() || !(signalingUrl ?? '').trim()) return;

    const callId = pendingPushCallId;
    setPendingPushCallId(null);
    rehydrateCallFromPushRef.current(callId);
  }, [pendingPushCallId, userId, signalingUrl]);

  // ─── Place outgoing call ──────────────────────────────────────────────────

  const placeCall = useCallback(
    /** @param [explicitCalleeId] */
    async (explicitCalleeId?: string) => {
      if (isPlacingCallRef.current) return;

      const explicit = (typeof explicitCalleeId === 'string' ? explicitCalleeId : '').trim();
      const trimmedCalleeId = explicit || calleeId.trim();
      if (!trimmedCalleeId) {
        updateStatus('Enter a callee ID to call', 'error');
        return;
      }
      if (!userId.trim()) {
        updateStatus('Enter your user ID first', 'error');
        return;
      }

      isPlacingCallRef.current = true;
      setIsPlacingCall(true);
      try {
        setCallSummary(null);

        const stream = await startLocalPreview();
        if (!stream) return;

        // Ensure a session and socket exist.
        let socket = socketRef.current;
        if (!socket?.connected) {
          const sessionId = await createOrGetSession();
          socket = connectSocket(sessionId);
          const connectingSocket = socket;
          // Give the socket a moment to connect.
          await new Promise(/** @param resolve */ (resolve: (value?: unknown) => void, reject) => {
            const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8_000);
            connectingSocket.once('connect', () => {
              clearTimeout(timer);
              resolve();
            });
            connectingSocket.once('connect_error', err => {
              clearTimeout(timer);
              reject(err);
            });
          });
        }

        updateStatus(`Calling ${trimmedCalleeId}…`);
        const ack = await signalingRef.current?.request(CLIENT_EVENTS.CALL_INITIATE, {
          version: SIGNALING_VERSION,
          calleeId: trimmedCalleeId,
        });

        isCallerRef.current = true;
        activeCallIdRef.current = ack.call.callId;
        activeCallRef.current = ack.call;
        setActiveCall(ack.call);
        dispatchCallEvent(CALL_EVENTS.PLACE);
        updateStatus(`Ringing ${trimmedCalleeId}…`);
        startOutgoingRingback();
        Telemetry.trackCallStart(ack.call.callId, sessionIdRef.current);
        emitEvent('info', 'call.started', { callId: ack.call.callId, direction: 'outgoing' });
      } catch (error) {
        logError('[CallFlow] placeCall failed', error);
        updateStatus(`Failed to place call: ${errorMessage(error)}`, 'error');
        endActiveCall();
      } finally {
        isPlacingCallRef.current = false;
        setIsPlacingCall(false);
      }
    },
    [
      calleeId,
      connectSocket,
      createOrGetSession,
      endActiveCall,
      updateStatus,
      startLocalPreview,
      userId,
      sessionIdRef,
    ],
  );

  // ─── Cancel outgoing call ─────────────────────────────────────────────────

  const cancelOutgoingCall = useCallback(async () => {
    const callId = activeCallIdRef.current;

    if (callId && socketRef.current?.connected) {
      try {
        await signalingRef.current?.request(CLIENT_EVENTS.CALL_CANCEL, {
          version: SIGNALING_VERSION,
          callId,
        });
      } catch (error) {
        // Server may already have transitioned; log and continue cleanup.
        logWarn('[CallFlow] cancel ack failed (call may already be terminal)', {
          message: errorMessage(error),
        });
      }
    }

    endActiveCall('Call cancelled', 'info', 'cancelled');
  }, [endActiveCall]);

  // ─── Accept incoming call ─────────────────────────────────────────────────

  /**
   * Report an answer-path stage to the server as a push receipt so a call that
   * rings but cannot be picked up is diagnosable from server logs alone.
   * Never throws.
   */
  const reportAnswerStage = useCallback(
    /**
     * @param stage - a canonical stage name such as
     *   `answer_attempted`, `answer_failed`, `answer_accepted`, `accept_tapped`,
     *   `decline_tapped` or `answer_skipped_duplicate`.
     */
    (callId: string | null, stage: string, reason: string | null = null) => {
      if (!callId) return;
      sendPushReceipt({
        callId,
        stage,
        reason,
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

  // Latest `reportAnswerStage` for the mount-once CallKeep effect below.
  const reportAnswerStageRef = useRef(reportAnswerStage);
  useEffect(() => {
    reportAnswerStageRef.current = reportAnswerStage;
  }, [reportAnswerStage]);

  /**
   * Resolve a connected socket, waiting up to `timeoutMs` for one (creating it
   * when none exists).  Returns `null` — never throws — when the socket cannot
   * be connected in time, so the caller can fall back to HTTP.
   */
  const waitForConnectedSocket = useCallback(
    async (timeoutMs = ANSWER_SOCKET_WAIT_MS) => {
      if (socketRef.current?.connected) return socketRef.current;
      try {
        let socket = socketRef.current;
        if (!socket) {
          const sessionId = await createOrGetSession();
          socket = connectSocket(sessionId);
        }
        if (!socket) return null;
        const connectingSocket = socket;
        await new Promise(/** @param resolve */ (resolve: (value?: unknown) => void, reject) => {
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
    [connectSocket, createOrGetSession],
  );

  /**
   * Accept the call over the authenticated HTTP endpoint, used when the socket
   * is unavailable so answering never depends on socket timing.
   */
  const acceptCallOverHttp = useCallback(
    /**
     * @returns the updated call record
     */
    async (callId: string): Promise<CallRecord> => {
      const trimmedUrl = (signalingUrl ?? '').trim();
      const response = await authedFetchRef.current?.(sessionId => ({
        url: `${trimmedUrl}${API_ROUTES.CALLS}/${encodeURIComponent(callId)}/accept`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        },
      }));
      if (!response) {
        const error = (new Error('no session available to accept over HTTP') as AnswerError);
        error.answerFailureReason = 'no_session';
        throw error;
      }
      if (!response.ok) {
        const error = (new Error(`HTTP ${response.status}`) as AnswerError);
        error.answerFailureReason = 'http_accept_failed';
        throw error;
      }
      return response.json();
    },
    [authedFetchRef, signalingUrl],
  );

  /**
   * Tell the server the call is accepted, preferring the socket and falling
   * back to HTTP.  Retries the socket emit once before falling back.
   */
  const sendCallAccept = useCallback(
    async (callId: string): Promise<{ call: CallRecord; transport: 'socket' | 'http' }> => {
      const socket = await waitForConnectedSocket();
      if (socket) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const ack = await signalingRef.current?.request(CLIENT_EVENTS.CALL_ACCEPT, {
              version: SIGNALING_VERSION,
              callId,
            });
            return { call: ack.call, transport: 'socket' };
          } catch (error) {
            logWarn('[CallFlow] call.accept over socket failed', {
              callId,
              attempt,
              message: errorMessage(error),
            });
          }
        }
        // Both attempts failed on a connected socket: say so before falling
        // through to HTTP, so the fallback is never silent.
        logWarn('[CallFlow] Answering over HTTP', {
          callId,
          reason: 'socket_accept_failed',
        });
        updateStatus('Answering — retrying over a different connection…', 'warning');
      } else {
        logWarn('[CallFlow] Answering over HTTP', {
          callId,
          reason: 'socket_not_connected',
        });
        updateStatus('Answering — connection still starting…', 'warning');
      }

      const call = await acceptCallOverHttp(callId);
      return { call, transport: 'http' };
    },
    [acceptCallOverHttp, updateStatus, waitForConnectedSocket],
  );

  /**
   * Acquire local media for a call that has *already* been accepted.  Media
   * failures degrade the call (audio-only / no media) instead of preventing the
   * answer, and every failure is logged, surfaced and reported. Never throws.
   */
  const acquireMediaForAcceptedCall = useCallback(
    async (callId: string) => {
      const permissions = await getMissingCallPermissions().catch(() => null);
      if (permissions?.missing?.length) {
        logWarn('[CallFlow] Answering without granted media permissions', {
          callId,
          missing: permissions.missing,
          camera: permissions.camera,
          microphone: permissions.microphone,
        });
        // A push cold start has no foreground Activity, so the runtime prompt
        // that `startLocalPreview` triggers has nowhere to appear — raise the
        // app first rather than letting the request be dropped.
        bringAppToForeground();
      }

      let stream = null;
      try {
        stream = await startLocalPreview();
      } catch (error) {
        logError('[CallFlow] Local media failed after accepting call', error);
      }

      if (!stream) {
        const reason = permissions?.missing?.length
          ? 'media_permission_denied'
          : 'local_media_unavailable';
        logWarn('[CallFlow] Call accepted without local media', { callId, reason });
        updateStatus(
          permissions?.message
            ? `${permissions.message}. Call connected without local media.`
            : 'Call connected, but the camera/microphone is unavailable.',
          'warning',
        );
        reportAnswerStage(callId, 'answer_failed', reason);
      }

      try {
        // Make the peer connection now so tracks are added before the offer
        // arrives; a media-less connection still negotiates and can receive.
        await ensurePeerConnection();
      } catch (error) {
        logError('[CallFlow] Failed to prepare peer connection after accept', error);
        updateStatus('Failed to connect media', 'error');
        reportAnswerStage(callId, 'answer_failed', 'peer_connection_failed');
      }
    },
    [ensurePeerConnection, reportAnswerStage, startLocalPreview, updateStatus],
  );

  /** Remember a callId that must never be accepted twice (bounded). */
  const rememberAnsweredCall = useCallback(/** @param callId */ (callId: string) => {
    const history = answeredCallIdsRef.current;
    if (history.includes(callId)) return;
    history.push(callId);
    if (history.length > ANSWERED_CALL_HISTORY_LIMIT) history.shift();
  }, []);

  const acceptIncomingCall = useCallback(async () => {
    // Read from the ref first: on a push-originated answer the ref is set
    // before React has re-rendered with the new state, and a stale closure over
    // `incomingCall` would otherwise silently no-op.
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

    // ── Idempotency guard ───────────────────────────────────────────────────
    // A second accept for the same call is a logged no-op, never an error path:
    // the server has already left `ringing`, so it would fail and the old
    // failure handling tore down the call that had just connected.
    if (acceptInFlightCallIdRef.current === call.callId) {
      logInfo('[CallFlow] Ignoring duplicate acceptIncomingCall', {
        callId: call.callId,
        reason: 'accept_in_flight',
      });
      reportAnswerStage(call.callId, 'answer_skipped_duplicate', 'accept_in_flight');
      return;
    }
    if (answeredCallIdsRef.current.includes(call.callId)) {
      logInfo('[CallFlow] Ignoring duplicate acceptIncomingCall', {
        callId: call.callId,
        reason: 'already_accepted',
      });
      reportAnswerStage(call.callId, 'answer_skipped_duplicate', 'already_accepted');
      return;
    }

    // The call stopped ringing before the tap reached here (a stale
    // notification the OS still showed): dismiss it instead of answering a
    // call that no longer exists.
    if (call.status && call.status !== 'ringing') {
      logInfo('[CallFlow] Ignoring accept for a call that stopped ringing', {
        callId: call.callId,
        status: call.status,
      });
      reportAnswerStage(call.callId, 'accept_tapped', 'call_already_ended');
      clearPendingAnswer(call.callId, 'call_already_ended');
      endCallKeepCall(call.callId);
      return;
    }

    triggerHaptic('answer');
    logInfo('[CallFlow] Accepting incoming call', { callId: call.callId });
    acceptInFlightCallIdRef.current = call.callId;
    reportAnswerStage(call.callId, 'answer_attempted');

    try {
      isCallerRef.current = false;
      activeCallIdRef.current = call.callId;
      updateStatus('Answering…');

      // Signalling first: a call that connects with degraded media is far
      // better than one that cannot be answered, so `call.accept` is never
      // gated on local media or on the socket already being connected.
      const { call: acceptedCall, transport } = await sendCallAccept(call.callId);

      const nextCall = acceptedCall ?? call;
      rememberAnsweredCall(call.callId);
      activeCallRef.current = nextCall;
      setActiveCall(nextCall);
      incomingCallRef.current = null;
      setIncomingCall(null);
      clearPendingAnswer(call.callId, 'answered');
      updateStatus('Connecting…');
      Telemetry.trackCallStart(call.callId, sessionIdRef.current);
      emitEvent('info', 'call.started', { callId: call.callId, direction: 'incoming' });
      // Stop any ringing (CallKeep system UI transitions to in-call state;
      // JS fallback ringtone stops here in case CallKeep was unavailable).
      stopIncomingRingtone();
      logInfo('[CallFlow] Ringing stopped (call accepted)', {
        callId: call.callId,
        transport,
      });
      // Tell the OS call UI (CallKeep) the call is now active so any ringing
      // system UI shown by a background push transitions to the in-call state.
      reportCallKeepConnected(call.callId);
      reportAnswerStage(call.callId, 'answer_accepted', transport);

      // Media last, and never fatal to the answer itself.
      await acquireMediaForAcceptedCall(call.callId);
      // callPhase advances to in_call via the rtc.offer handler once the caller
      // sends its offer.
    } catch (error) {
      const reason = (error as AnswerError)?.answerFailureReason ?? 'accept_failed';
      logError('[CallFlow] acceptIncomingCall failed', error);
      reportAnswerStage(call.callId, 'answer_failed', reason);
      clearPendingAnswer(call.callId, reason);

      // Never tear down a call that is already up. The accept can fail simply
      // because it lost a race with an earlier accept for the same call, in
      // which case the call is connected and ending it here is exactly the
      // "cannot pick up" bug.
      const liveCall = activeCallRef.current;
      if (liveCall && LIVE_CALL_STATUSES.has(liveCall.status)) {
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
    acquireMediaForAcceptedCall,
    endActiveCall,
    incomingCall,
    rememberAnsweredCall,
    reportAnswerStage,
    sendCallAccept,
    updateStatus,
    sessionIdRef,
  ]);

  // ─── Decline incoming call ────────────────────────────────────────────────

  /**
   * Tell the server a call is declined, preferring the socket and falling back
   * to the authenticated HTTP endpoint so a decline tapped during a cold start
   * still reaches the server. Never throws.
   */
  const declineCallById = useCallback(
    /**
     * @returns whether the server was told
     */
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
        const trimmedUrl = (signalingUrl ?? '').trim();
        const response = await authedFetchRef.current?.(sessionId => ({
          url: `${trimmedUrl}${API_ROUTES.CALLS}/${encodeURIComponent(callId)}/decline`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
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
    [authedFetchRef, signalingUrl],
  );

  const declineIncomingCall = useCallback(async () => {
    // Mirror `acceptIncomingCall`: prefer the ref so a push-originated decline
    // is never dropped on a stale closure.
    const call = incomingCallRef.current ?? incomingCall;
    if (!call) {
      logWarn('[CallFlow] declineIncomingCall aborted', { reason: 'no_incoming_call' });
      return;
    }

    await declineCallById(call.callId);
    endActiveCall('Call declined', 'info', 'declined');
  }, [declineCallById, endActiveCall, incomingCall]);

  // ─── CallKeep: bridge OS answer/end buttons into the call flow ────────────
  // Keep refs to the latest accept/decline handlers so the (mount-once)
  // CallKeep listener effect always invokes the current versions.
  const acceptIncomingCallRef = useRef(acceptIncomingCall);
  const declineIncomingCallRef = useRef(declineIncomingCall);
  useEffect(() => {
    acceptIncomingCallRef.current = acceptIncomingCall;
    declineIncomingCallRef.current = declineIncomingCall;
  }, [acceptIncomingCall, declineIncomingCall]);

  // An `answerCall` can arrive for a call this hook doesn't know about yet —
  // either a headless answer replayed by `setCallActionHandlers` the instant
  // this effect attached (the push cold-start race: CallKeep's native listener
  // lives at module scope in index.js and can queue an answer before this hook
  // ever mounts), or the matching `call.incoming` simply hasn't landed yet.
  // Such answers are queued in `callKeep.js`'s *single* pending-answer queue
  // (never a second queue here, which is where an answer could previously be
  // lost in the hand-off) and replayed by the effect below as soon as the call
  // record is known, instead of requiring a second Accept tap in the app.

  /**
   * Queue an answered callId whose call record this hook doesn't know yet, and
   * immediately try to fetch that record (`GET /calls/:callId`) so the queued
   * answer can be drained without waiting on the socket to deliver
   * `call.incoming`. Drops the queue entry — loudly — when the call turns out
   * to be gone.
   */
  const queueAnswerForReplay = useCallback(
    (callUUID: string, source: string) => {
    if (!callUUID) return;
    recordPendingAnswer(callUUID, source);
    Promise.resolve(rehydrateCallFromPushRef.current?.(callUUID)).then(outcome => {
      // The call is gone (terminal/not found) or could not be fetched — drop
      // the queued answer loudly instead of leaving it stuck. A `deferred`
      // outcome is still in flight (no identity yet), so the queue must
      // survive until the deferred rehydration runs.
      if (outcome === 'deferred') return;
      if (peekPendingAnswer() !== callUUID || incomingCallRef.current?.callId === callUUID) return;

      if (outcome === 'terminal' || outcome === 'not_found') {
        // The tap was for a call that had already stopped ringing — the
        // notification outlived the call. Dismiss it silently rather than
        // failing an answer nobody can complete.
        logInfo('[CallFlow] Queued answer dropped; call already ended', {
          callUUID,
          source,
          outcome,
        });
        reportAnswerStageRef.current?.(callUUID, 'accept_tapped', 'call_already_ended');
        clearPendingAnswer(callUUID, 'call_already_ended');
        endCallKeepCall(callUUID);
        return;
      }

      logWarn('[CallFlow] Queued answer cannot be replayed; call unavailable', {
        callUUID,
        source,
      });
      reportAnswerStageRef.current?.(callUUID, 'answer_failed', 'call_unavailable');
      clearPendingAnswer(callUUID, 'call_unavailable');
    });
  }, []);

  // Latest `declineCallById` for the mount-once effects below.
  const declineCallByIdRef = useRef(declineCallById);
  useEffect(() => {
    declineCallByIdRef.current = declineCallById;
  }, [declineCallById]);

  // Drain the Accept / Decline the user tapped on the branded notification
  // while this JS context was not running. The pending-answer queue lives in a
  // JS module, so it cannot survive process death — the native side persists
  // the tap (`PendingCallStore`) and it is replayed here on mount, which is
  // what makes a cold-start answer work even when Telecom never created a
  // CallKeep connection to route it through.
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
    // Configure CallKeep up front so the system call UI is ready before the
    // first incoming push; degrades to a no-op when the native module is absent.
    setupCallKeep().catch(() => {});
    // Take over routing of the answer/end events already subscribed to at
    // module scope (`registerCallActionListeners`, wired once in index.js)
    // rather than re-registering with the native module — react-native-callkeep
    // tracks a single listener per event name and unsubscribes by name only,
    // so re-registering here would silently replace the module-scope handler
    // and this effect's cleanup would remove it entirely.
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
        if (incomingCallRef.current) {
          declineIncomingCallRef.current?.();
        } else {
          endActiveCallRef.current?.();
        }
      },
    });
    // `setBackgroundMessageHandler` (installed in index.js) only fires when the
    // app is backgrounded; this covers pushes that land while it is on screen,
    // e.g. when the socket is mid-reconnect and the call.incoming event is lost.
    const unsubscribeForegroundPush = installForegroundMessageHandler();
    return () => {
      unsubscribeForegroundPush();
      detachCallActionHandlers();
    };
    // Run once on mount; handlers are invoked via refs (`queueAnswerForReplay`
    // is stable and only touches refs, so it is safe to omit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replay a queued `answerCall` once the matching call becomes known to this
  // hook (via the `call.incoming` socket event or push rehydration).
  useEffect(() => {
    const callId = incomingCall?.callId;
    if (!callId) return;
    // The effect re-runs whenever `acceptIncomingCall`'s identity changes, so a
    // per-callId guard (not just the drained queue) keeps a replay from
    // triggering a second accept for the same call.
    if (replayedAnswerCallIdsRef.current.has(callId)) return;
    if (!consumePendingAnswer(callId)) return;
    // Bounded: callIds are unique, so the guard set would otherwise grow for
    // the lifetime of the app.
    if (replayedAnswerCallIdsRef.current.size >= ANSWERED_CALL_HISTORY_LIMIT) {
      replayedAnswerCallIdsRef.current.clear();
    }
    replayedAnswerCallIdsRef.current.add(callId);
    logInfo('[CallFlow] Replaying recorded answerCall', { callId });
    acceptIncomingCallRef.current?.();
  }, [incomingCall]);

  // ─── End active in-call ───────────────────────────────────────────────────

  const handleEndCall = useCallback(async () => {
    const callId = activeCallIdRef.current;

    if (callId && socketRef.current?.connected) {
      try {
        await signalingRef.current?.request(CLIENT_EVENTS.CALL_END, {
          version: SIGNALING_VERSION,
          callId,
        });
      } catch (error) {
        logWarn('[CallFlow] end call ack failed', { message: errorMessage(error) });
      }
    }

    endActiveCall('Call ended', 'info', 'ended');
  }, [endActiveCall]);

  // ─── Media controls ───────────────────────────────────────────────────────

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      updateStatus('Start preview to control audio', 'error');
      return;
    }
    triggerHaptic('tap');
    setIsMuted(nextMuted);
    updateStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isMuted, updateStatus]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      updateStatus('Start preview to control video', 'error');
      return;
    }
    setIsVideoEnabled(nextVideoEnabled);
    updateStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [isVideoEnabled, updateStatus]);

  const handleCameraSwitch = useCallback(async () => {
    try {
      const [videoTrack] = localStreamRef.current?.getVideoTracks?.() ?? [];

      // Fast path: react-native-webrtc provides an in-place camera flip that
      // keeps the same track object – no renegotiation required.
      if (typeof videoTrack?._switchCamera === 'function') {
        videoTrack._switchCamera();
        setIsFrontCamera(prev => !prev);
        updateStatus('Camera switched');
        return;
      }

      // Fallback: acquire a new stream with the opposite facing mode and call
      // replaceTrack on the active peer connection sender so the remote peer
      // receives the new camera source without requiring renegotiation.
      const nextFacingMode = isFrontCamera ? 'environment' : 'user';
      const newStream = await mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: nextFacingMode },
      });
      const [newVideoTrack] = newStream.getVideoTracks();
      if (!newVideoTrack) {
        newStream.getTracks().forEach(t => t.stop());
        updateStatus('Camera switch unavailable', 'error');
        return;
      }

      const pc = peerConnectionRef.current;
      if (pc) {
        const sender = pc.getSenders?.().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        }
      }

      videoTrack?.stop();
      if (localStreamRef.current) {
        if (videoTrack) localStreamRef.current.removeTrack(videoTrack);
        localStreamRef.current.addTrack(newVideoTrack);
      }
      setLocalStream(localStreamRef.current);
      setIsFrontCamera(prev => !prev);
      updateStatus('Camera switched');
    } catch (error) {
      logError('[CallFlow] Camera switch failed', error);
      updateStatus('Camera switch unavailable', 'error');
    }
  }, [isFrontCamera, updateStatus]);

  const handleSwapStreams = useCallback(() => {
    if (!remoteStream || !localStream) return;
    setIsLocalPrimary(prev => !prev);
  }, [localStream, remoteStream]);

  const handleRetryReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      updateStatus('No active socket', 'error');
      return;
    }
    setIsReconnecting(true);
    updateStatus('Reconnecting…');
    socket.disconnect();
    socket.connect();
  }, [updateStatus]);

  const chooseAudioOutput = useCallback(
    /** @param route */
    async (route: string) => {
      try {
        manualAudioRouteRef.current = route;
        const result = await chooseAudioRoute(route);
        if (!result.ok) {
          setAudioDevices({
            available: result.available,
            selected: result.selected,
          });
          setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
          updateStatus(result.message, 'error');
          return;
        }
        setAudioDevices({
          available: result.available,
          selected: result.selected,
        });
        setIsSpeakerEnabled(route === AUDIO_ROUTES.SPEAKER_PHONE);
        updateStatus(`Audio: ${route === AUDIO_ROUTES.SPEAKER_PHONE ? 'Speaker' : route}`);
      } catch (error) {
        logError('[CallFlow] chooseAudioOutput failed', error);
        updateStatus('Unable to switch audio output', 'error');
      }
    },
    [updateStatus],
  );

  const dismissCallSummary = useCallback(() => {
    setCallSummary(null);
  }, []);

  // ─── Screen-share presence relay ──────────────────────────────────────────
  // Tell the peer whenever the local screen-sharing state changes so their
  // CallStage can render a "they are presenting" banner. Best-effort: a
  // rejected/timed-out ack is logged and otherwise ignored.
  useEffect(() => {
    isScreenSharingRef.current = isScreenSharing;
    if (!socketRef.current?.connected || !activeCallIdRef.current) return;
    signalingRef.current
      ?.request(CLIENT_EVENTS.CALL_MEDIA_STATE, {
        version: SIGNALING_VERSION,
        callId: activeCallIdRef.current,
        mediaState: { isScreenSharing },
      })
      .catch(error => {
        logWarn('[CallFlow] call.media-state emit failed', {
          message: errorMessage(error),
        });
      });
  }, [isScreenSharing]);

  // ─── Connection quality polling ───────────────────────────────────────────

  useEffect(() => {
    if (!isInCall) {
      setConnectionQuality({ bars: 0, label: 'No link' });
      connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
      selectedCandidatePairRef.current = null;
      return undefined;
    }

    let cancelled = false;
    const pollStats = async () => {
      const pc = peerConnectionRef.current;
      if (!pc || typeof pc.getStats !== 'function') return;

      try {
        const report = await pc.getStats();
        if (cancelled) return;

        let rttMs;
        let totalPacketsLost = 0;
        let totalPacketsReceived = 0;
        let totalBytesReceived = 0;
        let selectedCandidatePair: any = null;

        report.forEach(/** @param stat */ (stat: any) => {
          if (
            stat.type === 'candidate-pair' &&
            stat.state === 'succeeded' &&
            (stat.nominated || stat.selected)
          ) {
            selectedCandidatePair = stat;
            if (typeof stat.currentRoundTripTime === 'number') {
              rttMs = stat.currentRoundTripTime * 1000;
            }
          }
          if (
            stat.type === 'inbound-rtp' &&
            !stat.isRemote &&
            (stat.kind === 'video' || stat.mediaType === 'video')
          ) {
            totalPacketsLost += Number(stat.packetsLost || 0);
            totalPacketsReceived += Number(stat.packetsReceived || 0);
            totalBytesReceived += Number(stat.bytesReceived || 0);
          }
        });

        if (selectedCandidatePair) {
          const localCandidate = report.get?.(selectedCandidatePair.localCandidateId);
          const remoteCandidate = report.get?.(selectedCandidatePair.remoteCandidateId);
          const localCandidateType = localCandidate?.candidateType ?? 'unknown';
          const remoteCandidateType = remoteCandidate?.candidateType ?? 'unknown';
          const candidatePairKey = `${localCandidateType}:${remoteCandidateType}`;
          if (candidatePairKey !== selectedCandidatePairRef.current) {
            selectedCandidatePairRef.current = candidatePairKey;
            logInfo('[CallFlow] Selected ICE candidate pair', {
              localCandidateType,
              remoteCandidateType,
              iceTransportPolicy: activeIceTransportPolicy,
            });
          }
        }

        const now = Date.now();
        const previous = connectionStatsRef.current;
        let bitrateKbps;
        if (
          previous.timestampMs &&
          now > previous.timestampMs &&
          totalBytesReceived >= previous.totalBytesReceived
        ) {
          bitrateKbps =
            ((totalBytesReceived - previous.totalBytesReceived) * 8) / (now - previous.timestampMs);
        }
        connectionStatsRef.current = { timestampMs: now, totalBytesReceived };

        const denominator = totalPacketsReceived + totalPacketsLost;
        const packetLossRatio = denominator > 0 ? totalPacketsLost / denominator : undefined;
        const nextQuality = getConnectionQuality({
          rttMs,
          packetLossRatio,
          bitrateKbps,
        });
        setConnectionQuality(nextQuality);

        // Surface a status warning when packet loss is severe enough to impair
        // the call.  Only update status on the downgrade crossing so the message
        // doesn't flicker; recovery is silent (the bars update speaks for itself).
        if (nextQuality.bars === 0 && Number.isFinite(packetLossRatio)) {
          updateStatus('Poor connection — high packet loss detected', 'error');
        }
      } catch (error) {
        logWarn('[CallFlow] Failed to read connection stats', {
          message: errorMessage(error),
        });
      }
    };

    pollStats();
    const intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activeIceTransportPolicy, isInCall, updateStatus]);

  // ─── Audio session & device routing ──────────────────────────────────────

  useEffect(() => {
    if (!isInCall) return undefined;

    const result = startAudioSession();
    if (!result.ok) {
      logWarn('[CallFlow] InCallManager start failed', {
        message: result.message,
      });
      updateStatus(result.message, 'error');
    }

    return () => {
      const stopResult = stopAudioSession();
      if (!stopResult.ok) {
        logWarn('[CallFlow] InCallManager stop failed', {
          message: stopResult.message,
        });
      }
    };
  }, [isInCall, updateStatus]);

  // Pick the best available output (Bluetooth → wired → earpiece → speaker)
  // unless the user already chose one explicitly during this call.
  const applyAutomaticAudioRoute = useCallback(
    /** @param available */
    async (available: string[]) => {
      if (manualAudioRouteRef.current) return;
      const result = await applyPreferredAudioRoute(available);
      // "Speaker on join": with no headset/Bluetooth device attached the
      // automatic pick is the earpiece; the persisted preference upgrades
      // that to speakerphone.
      if (result.ok && speakerEnabledByDefault && result.selected === AUDIO_ROUTES.EARPIECE) {
        const speakerResult = await chooseAudioRoute(AUDIO_ROUTES.SPEAKER_PHONE);
        if (speakerResult.ok) {
          setAudioDevices({
            available: speakerResult.available.length > 0 ? speakerResult.available : result.available,
            selected: speakerResult.selected,
          });
          setIsSpeakerEnabled(true);
          return;
        }
        logWarn('[CallFlow] Speaker default unavailable; keeping automatic route', {
          message: speakerResult.message,
        });
      }
      setAudioDevices({ available: result.available, selected: result.selected });
      setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
      if (!result.ok) {
        logWarn('[CallFlow] Automatic audio routing degraded', {
          message: result.message,
        });
      }
    },
    [speakerEnabledByDefault],
  );

  useEffect(() => {
    if (!isInCall) {
      manualAudioRouteRef.current = null;
      return undefined;
    }

    // The device list is discovered by the first selection (see
    // applyPreferredAudioRoute), so no list is needed here.
    applyAutomaticAudioRoute([]);
    // Re-evaluate whenever a device is plugged in or removed mid-call.
    return subscribeAudioDevices(nextDevices => {
      logInfo('[CallFlow] Audio devices changed', nextDevices);
      setAudioDevices(nextDevices);
      applyAutomaticAudioRoute(nextDevices.available);
    });
  }, [applyAutomaticAudioRoute, isInCall]);

  useEffect(() => {
    if (!isInCall || !isSpeakerEnabled) return;
    const result = setAudioRoute(true);
    if (!result.ok) {
      logWarn('[CallFlow] Audio route update failed', {
        message: result.message,
      });
    }
  }, [isInCall, isSpeakerEnabled]);

  // ─── Ringtone cleanup on unmount ─────────────────────────────────────────
  // Ensure the fallback ringtone never outlives the component tree in case the
  // hook is unmounted while an incoming call is still ringing.
  useEffect(() => {
    return () => {
      stopIncomingRingtone();
      stopOutgoingRingback();
    };
  }, []);

  // ─── Public interface ─────────────────────────────────────────────────────

  return {
    // Identity / connection config
    userId: identity.userId,
    setUserId: identity.setUserId,
    editUserId: identity.editUserId,
    isRegistered,
    isLoadingIdentity: identity.isLoadingIdentity,
    isAuthenticating: identity.isAuthenticating,
    canUseGoogleSignIn: identity.canUseGoogleSignIn,
    canUseMicrosoftSignIn: identity.canUseMicrosoftSignIn,
    registerUser: identity.registerUser,
    unregisterUser,
    updateUserId: identity.updateUserId,
    calleeId,
    setCalleeId,
    signalingUrl,
    setSignalingUrl,
    authedFetch,

    // Call lifecycle
    callPhase,
    activeCall,
    incomingCall,
    isPlacingCall,

    // UI status
    status,
    updateStatus,
    callSummary,
    calleePresence: presenceSearch.calleePresence,
    checkPresence,
    searchUsers: presenceSearch.searchUsers,
    isServerUnreachable: presenceSearch.isServerUnreachable,
    retryPresenceConnect,

    // Blocklist
    blockedUsers: blocks.blockedUsers,
    isUserBlocked: blocks.isUserBlocked,
    fetchBlocks,
    blockPeer,
    unblockPeer,

    // Call history
    callHistory: callHistory.callHistory,
    missedCallCount: callHistory.missedCallCount,
    markMissedCallsRead: callHistory.markMissedCallsRead,
    fetchCallHistory: callHistory.fetchCallHistory,

    // Chat
    conversations: messaging.conversations,
    messagesByPeer: messaging.messagesByPeer,
    unreadTotal: messaging.unreadTotal,
    activeChatPeerId,
    setActiveChatPeerId: messaging.setActiveChatPeerId,
    fetchConversations,
    fetchMessagesForPeer: messaging.fetchMessagesForPeer,
    searchMessages: messaging.searchMessages,
    sendMessage: messaging.sendMessage,
    retryMessage: messaging.retryMessage,
    discardMessage: messaging.discardMessage,
    deleteMessage: messaging.deleteMessage,
    reactToMessage: messaging.reactToMessage,
    drainOutbox: messaging.drainOutbox,
    isChatOffline: messaging.isOffline,
    pendingSendCount: messaging.pendingSendCount,
    markConversationRead,
    typingByPeer: messaging.typingByPeer,
    sendTypingIndicator: messaging.sendTypingIndicator,
    isRemoteScreenSharing,

    // Attachments (photo / camera / file / voice note)
    pickAndSendAttachment: attachments.pickAndSend,
    startRecordingVoiceNote: attachments.startRecordingVoiceNote,
    stopRecordingVoiceNoteAndSend: attachments.stopRecordingVoiceNoteAndSend,
    cancelRecordingVoiceNote: attachments.cancelRecordingVoiceNote,
    isUploadingAttachment: attachments.isUploading,
    attachmentUploadProgress: attachments.uploadProgress,
    isRecordingVoiceNote: attachments.isRecordingVoiceNote,
    attachmentsAvailable: attachments.attachmentsAvailable,
    isVoiceNoteSupported: attachments.isVoiceNoteSupported,

    // In-call media state
    localStream,
    remoteStream,
    isInCall,
    isMuted,
    isVideoEnabled,
    isSpeakerEnabled,
    isScreenSharing,
    isScreenAudioShared,
    isScreenAudioEnabled,
    isScreenShareSupported,
    isCompactView,
    isLocalPrimary,
    isFrontCamera,
    elapsedCallSeconds,
    audioDevices,
    connectionQuality,
    isReconnecting,
    iceTransportPolicy: activeIceTransportPolicy,

    // Call actions
    placeCall,
    cancelOutgoingCall,
    acceptIncomingCall,
    declineIncomingCall,
    handleEndCall,
    startLocalPreview,
    rehydrateCallFromPush,

    // In-call controls (the interface `CallScreen` renders against)
    handleMuteToggle,
    handleVideoToggle,
    handleScreenShareToggle,
    handleScreenAudioToggle,
    handleCameraSwitch,
    handleSwapStreams,
    handleRetryReconnect,
    chooseAudioOutput,
    dismissCallSummary,
  };
}
