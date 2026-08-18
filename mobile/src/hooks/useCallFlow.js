import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import * as Telemetry from '../telemetry';
import {
  AUDIO_ROUTES,
  chooseAudioRoute,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../audioRouting';
import { startCallService, stopCallService } from '../callService';
import useCallHistory from './useCallHistory';
import useCompactCallView from './useCompactCallView';
import useIdentity from './useIdentity';
import useMessaging from './useMessaging';
import usePresenceSearch from './usePresenceSearch';
import useSession from './useSession';
import useStartupPermissions from './useStartupPermissions';
import { getConnectionQuality } from '../callUx';
import { getMediaAccessStatus, summarizeIceCandidate } from '../diagnostics';
import { isTrackEnabled, setTrackEnabled } from '../mediaControls';
import { ensureCallPermissions } from '../permissions';
import {
  addCallLinkListener,
  getInitialCallLink,
  installForegroundMessageHandler,
  registerForPushNotifications,
  unregisterPushToken,
} from '../pushNotifications';
import { getSocketOptions } from '../socketConfig';
import { emitWithAck, SIGNALING_VERSION } from '../socketProtocol';
import { getIceServers, getIceServersForCall, applyBitrateConstraints } from '../webrtcConfig';
import useScreenShare from './useScreenShare';
import {
  displayIncomingCall,
  endCall as endCallKeepCall,
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

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';

const STATS_POLL_INTERVAL_MS = 7000;

const HAPTIC_TAP_MS = 15;
const HAPTIC_CONNECT_MS = 30;

/**
 * How often to proactively rotate the session token.  Set well below typical
 * server-side TTLs (e.g. 1 h) so the token never expires mid-call.
 */
const SESSION_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Call phases that drive which screen the UI renders.
 *
 * idle             – no active call; show Lobby
 * outgoing_ringing – caller placed a call, waiting for callee to answer
 * incoming_ringing – callee received a call, waiting for user action
 * in_call          – call accepted and media connected
 */
export const CALL_PHASES = {
  IDLE: 'idle',
  OUTGOING_RINGING: 'outgoing_ringing',
  INCOMING_RINGING: 'incoming_ringing',
  IN_CALL: 'in_call',
};

/**
 * English display strings for server-side `endReason` codes.
 *
 * Each key mirrors a value that can appear in `call.endReason` from the
 * server.  The mapped string is the default English label shown in the UI.
 * Applications that support multiple languages should use these as fallback
 * defaults and provide translated overrides keyed by the same reason code.
 *
 * @type {Record<string, string>}
 */
export const CALL_END_REASON_LABELS = {
  ended: 'Call ended',
  declined: 'Call declined',
  cancelled: 'Call cancelled',
  timeout: 'Missed call',
  missed: 'Missed call',
  busy: 'Line was busy',
  unreachable: 'User unavailable',
  failed: 'Call failed',
};

function haptic(durationMs) {
  try {
    Vibration.vibrate(durationMs);
  } catch {
    // best-effort
  }
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
 */
export default function useCallFlow() {
  // ─── Connection config ────────────────────────────────────────────────────
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [calleeId, setCalleeId] = useState('');

  // ─── Call lifecycle state ─────────────────────────────────────────────────
  const [callPhase, setCallPhase] = useState(CALL_PHASES.IDLE);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);

  // callId received from a push-notification deep link before the user identity
  // is fully established.  Cleared once rehydration is attempted.
  const [pendingPushCallId, setPendingPushCallId] = useState(null);

  // True from the moment `placeCall` is invoked until the call reaches
  // OUTGOING_RINGING (or fails). Lets chat-header call buttons show a brief
  // loading state instead of appearing to do nothing while the local camera
  // preview starts and the socket/`call.initiate` round-trip completes.
  const [isPlacingCall, setIsPlacingCall] = useState(false);

  // ─── UI state ─────────────────────────────────────────────────────────────
  // Raw state setter; callers use the `updateStatus(message, severity)` helper
  // declared below rather than setting the shape by hand.
  const [status, setStatus] = useState({ message: '', severity: 'info' });
  const [callSummary, setCallSummary] = useState(null);

  // True while the remote participant is screen-sharing (relayed via the
  // `call.media-state` socket event).
  const [isRemoteScreenSharing, setIsRemoteScreenSharing] = useState(false);

  // ─── Media / WebRTC state ─────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [elapsedCallSeconds, setElapsedCallSeconds] = useState(0);
  const [audioDevices, setAudioDevices] = useState({
    available: [],
    selected: null,
  });
  const [connectionQuality, setConnectionQuality] = useState({
    bars: 0,
    label: 'No link',
  });
  const [isReconnecting, setIsReconnecting] = useState(false);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const activeCallIdRef = useRef(null);
  const isCallerRef = useRef(false);
  // Synchronous mirror of isPlacingCall so `placeCall` can guard re-entrancy
  // (rapid double-tap) without waiting for the state update to flush.
  const isPlacingCallRef = useRef(false);
  const callConnectedAtRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const connectionQualityRef = useRef({ bars: 0, label: 'No link' });
  const connectionStatsRef = useRef({
    timestampMs: null,
    totalBytesReceived: 0,
  });
  const isInCallRef = useRef(false);
  // ICE candidates that arrive before the remote description is applied are
  // buffered here and flushed once setRemoteDescription succeeds.
  const iceCandidateBufferRef = useRef([]);
  // Prevents concurrent offer/answer negotiations (glare guard).
  const isNegotiatingRef = useRef(false);
  // Refs that mirror activeCall / incomingCall state for use in any callback
  // where capturing the value via a React closure would otherwise be stale.
  const activeCallRef = useRef(null);
  const incomingCallRef = useRef(null);
  // Tracks callIds for which the incoming-call UI has already been shown so
  // duplicate socket or push events never trigger a second CallKeep display.
  const displayedIncomingCallIdsRef = useRef(new Set());

  const updateStatus = useCallback((message, severity = 'info') => {
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
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
  } = messaging;

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
      socket.emit(
        'rtc.offer',
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

  const { isCompactView, setIsCompactView } = useCompactCallView(isInCallRef);

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

  const markCallConnected = useCallback(() => {
    if (callConnectedAtRef.current) return;
    haptic(HAPTIC_CONNECT_MS);
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

  const closePeerConnection = useCallback(() => {
    iceCandidateBufferRef.current = [];
    isNegotiatingRef.current = false;
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    setRemoteStream(null);
    setConnectionQuality({ bars: 0, label: 'No link' });
    connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
  }, []);

  const configurePeerConnection = useCallback(
    async pc => {
      const iceServers = await getIceServersForCall({
        signalingUrl,
        sessionId: sessionIdRef.current,
      });
      pc.setConfiguration?.({ iceServers });
      return pc;
    },
    [signalingUrl, sessionIdRef],
  );

  const ensurePeerConnection = useCallback(async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    logInfo('[CallFlow] Creating RTCPeerConnection');
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });

    if (localStreamRef.current) {
      // Guard against double-adding tracks when ensurePeerConnection is called
      // more than once during renegotiation (idempotent attach).
      const attachedTracks = new Set((pc.getSenders?.() ?? []).map(s => s.track).filter(Boolean));
      localStreamRef.current.getTracks().forEach(track => {
        if (!attachedTracks.has(track)) {
          pc.addTrack(track, localStreamRef.current);
        }
      });
    }

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || !socketRef.current?.connected) return;
      const summary = summarizeIceCandidate(candidate);
      logInfo('[CallFlow] ICE candidate sent', summary);
      socketRef.current.emit('rtc.candidate', {
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

    // Trigger an ICE restart when the caller detects ICE failure so the call
    // can survive a network handoff without tearing down entirely.
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      logInfo('[CallFlow] ICE connection state', { state });
      if (state !== 'failed') return;
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
          socketRef.current?.emit(
            'rtc.offer',
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
    return configurePeerConnection(pc);
  }, [configurePeerConnection, markCallConnected, updateStatus]);

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
   *
   * @param {{ callId: string, callerId?: string | null }} call
   */
  const showIncomingCallUi = useCallback(async call => {
    if (!call?.callId) return;
    if (displayedIncomingCallIdsRef.current.has(call.callId)) return;
    displayedIncomingCallIdsRef.current.add(call.callId);

    haptic(400);

    logInfo('[CallFlow] Requesting incoming-call UI', {
      callId: call.callId,
      callerId: call.callerId ?? null,
    });

    const displayResult = await displayIncomingCall({
      callId: call.callId,
      callerId: call.callerId,
    }).catch(error => {
      logWarn('[CallFlow] displayIncomingCall failed', {
        message: error?.message,
      });
      return { shown: false, reason: 'telecom_threw', message: error?.message };
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
   * @param {string} [nextMessage='Call ended'] - Status message to display.
   * @param {string} [severity='info']          - Status severity.
   * @param {string|null} [endReason=null]      - Canonical end-reason code
   *   (one of the keys from CALL_END_REASON_LABELS) for history tracking.
   */
  const endActiveCall = useCallback(
    (nextMessage = 'Call ended', severity = 'info', endReason = null) => {
      // Capture call record before clearing – activeCallRef / incomingCallRef
      // are kept in sync with state throughout the call lifecycle.
      const callRecord = activeCallRef.current ?? incomingCallRef.current;
      const isCaller = isCallerRef.current;

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
          logInfo('[CallFlow] call QoS summary', qos);
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

      activeCallIdRef.current = null;
      isCallerRef.current = false;
      activeCallRef.current = null;
      incomingCallRef.current = null;

      setCallPhase(CALL_PHASES.IDLE);
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
      if (nextMessage) updateStatus(nextMessage, severity);
    },
    [addToHistory, closePeerConnection, resetScreenShare, setIsCompactView, updateStatus],
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
    sessionId => {
      disconnectSocket();

      logInfo('[CallFlow] Connecting socket', { signalingUrl });
      const socket = io(signalingUrl.trim(), {
        ...getSocketOptions(),
        auth: { sessionId },
      });
      socketRef.current = socket;

      // ── Incoming call ──────────────────────────────────────────────────
      socket.on('call.incoming', ({ call }) => {
        logInfo('[CallFlow] Incoming call', {
          callId: call.callId,
          callerId: call.callerId,
        });
        socket.emit(
          'call.incoming.ack',
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
        setCallPhase(CALL_PHASES.INCOMING_RINGING);
        updateStatus(`Incoming call from ${call.callerId}`);
        // Show system-level incoming-call UI (CallKeep) and start the JS
        // ringtone fallback when CallKeep is unavailable.  Runs async so UI
        // state updates are never blocked if CallKeep setup is slow.
        showIncomingCallUi(call).catch(error => {
          logWarn('[CallFlow] showIncomingCallUi unexpected error', {
            message: error?.message,
          });
        });
      });

      // ── Call ringing (caller confirmation) ────────────────────────────
      socket.on('call.ringing', ({ call }) => {
        logInfo('[CallFlow] Call ringing', { callId: call.callId });
        activeCallRef.current = call;
        setActiveCall(call);
      });

      // ── Call state changes ────────────────────────────────────────────
      socket.on('call.state_changed', async ({ status: callStatus, call, reason }) => {
        logInfo('[CallFlow] call.state_changed', {
          callStatus,
          callId: call?.callId,
          reason,
        });
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
                socket.emit(
                  'rtc.offer',
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

          case 'busy':
            endActiveCallRef.current?.('Callee is busy', 'error', 'busy');
            break;

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
      });

      // ── RTC offer (callee receives offer from caller) ─────────────────
      socket.on('rtc.offer', async ({ sdp, callId }) => {
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
                message: err?.message,
              });
            }
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit(
            'rtc.answer',
            {
              version: SIGNALING_VERSION,
              callId,
              sdp: pc.localDescription,
            },
            ack => {
              if (!ack?.ok) logWarn('[CallFlow] rtc.answer ack failed', ack?.error);
            },
          );
          setCallPhase(CALL_PHASES.IN_CALL);
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
      socket.on('rtc.answer', async ({ sdp, callId }) => {
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
                message: err?.message,
              });
            }
          }
          setCallPhase(CALL_PHASES.IN_CALL);
          updateStatus('Connected', 'success');
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC answer', error);
          updateStatus('Failed to connect media', 'error');
          endActiveCallRef.current?.('Failed to connect media', 'error');
        }
      });

      // ── RTC ICE candidates ────────────────────────────────────────────
      socket.on('rtc.candidate', async ({ candidate, callId }) => {
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
            message: error?.message,
          });
        }
      });

      // ── Chat ─────────────────────────────────────────────────────────
      socket.on('message.received', ({ message }) => {
        handleMessageReceived(message);
      });

      socket.on('message.delivered', ({ message }) => {
        handleMessageDelivered(message);
      });

      socket.on('message.read', ({ readerId, readAt }) => {
        handleMessageRead({ readerId, readAt });
      });

      socket.on('message.typing', ({ senderId, isTyping }) => {
        handleTypingEvent({ senderId, isTyping });
      });

      // ── In-call screen-share relay ──────────────────────────────────────
      socket.on('call.media-state', ({ callId, mediaState }) => {
        if (callId !== activeCallIdRef.current) return;
        setIsRemoteScreenSharing(Boolean(mediaState?.isScreenSharing));
      });

      // ── Socket lifecycle ──────────────────────────────────────────────
      socket.on('connect', async () => {
        logInfo('[CallFlow] Socket connected', { socketId: socket.id });
        // Clear offline indicator on successful connection.
        recordConnectSuccess();
        // Load the conversation list as soon as the session is actually
        // live. `sessionIdRef` is only populated once `createOrGetSession`
        // resolves, which happens asynchronously — a chat-sync effect keyed
        // only on `isRegistered` (which flips as soon as a stored userId
        // loads, before the session exists) can fire too early and silently
        // no-op, leaving old messages/conversations unloaded until the user
        // manually pulls to refresh. Firing here guarantees it runs once the
        // session/socket are actually ready, on cold start and on reconnect.
        fetchConversations();
        if (!isInCallRef.current) return;
        setIsReconnecting(false);
        if (activeCallIdRef.current) {
          Telemetry.trackReconnect(activeCallIdRef.current);
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
              socket.emit(
                'rtc.offer',
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

      socket.on('disconnect', reason => {
        logWarn('[CallFlow] Socket disconnected', { reason });
        if (isInCallRef.current) {
          setIsReconnecting(true);
          updateStatus('Reconnecting…');
        }
      });

      socket.on('connect_error', error => {
        logError('[CallFlow] Socket connect error', {
          message: error?.message,
          description: error?.description,
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
      socket.on('session.invalid', async ({ sessionId: staleSessionId } = {}) => {
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
      handleMessageDelivered,
      handleMessageRead,
      handleTypingEvent,
      recordConnectSuccess,
      recordConnectError,
      sessionIdRef,
      deviceIdRef,
      fetchConversations,
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
   *
   * @param {string} callId
   */
  const rehydrateCallFromPush = useCallback(
    async callId => {
      if (!callId) return;

      const trimmedUserId = (userId ?? '').trim();
      const trimmedUrl = (signalingUrl ?? '').trim();

      if (!trimmedUserId || !trimmedUrl) {
        logInfo('[CallFlow] Deferring push rehydration until identity is set', {
          callId,
        });
        setPendingPushCallId(callId);
        return;
      }

      logInfo('[CallFlow] Rehydrating call from push', { callId });

      try {
        const sessionId = await createOrGetSession();

        const response = await fetch(
          `${trimmedUrl}/calls/${encodeURIComponent(callId)}` +
            `?sessionId=${encodeURIComponent(sessionId)}`,
        );

        if (!response.ok) {
          if (response.status === 404) {
            updateStatus('Call no longer available', 'info');
            return;
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
          setCallPhase(CALL_PHASES.INCOMING_RINGING);
          updateStatus(`Incoming call from ${call.callerId}`);
          showIncomingCallUi(call).catch(error => {
            logWarn('[CallFlow] showIncomingCallUi unexpected error', {
              message: error?.message,
            });
          });

          // Ensure a socket is live so the user can accept / decline.
          if (!socketRef.current?.connected) {
            connectSocket(sessionId);
          }
        } else {
          // Terminal or non-ringing state – inform the user and stay idle.
          const terminalMessages = {
            missed: 'Missed call',
            declined: 'Call was declined',
            ended: 'Call ended',
            busy: 'Line was busy',
            unreachable: 'Call unreachable',
          };
          const message = terminalMessages[call.status] ?? 'Call no longer active';
          logInfo('[CallFlow] Push call already finished', {
            callId,
            status: call.status,
          });
          updateStatus(message, 'info');
        }
      } catch (error) {
        logError('[CallFlow] rehydrateCallFromPush failed', error);
        updateStatus('Unable to retrieve call state', 'error');
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
                message: error?.message,
              });
            });
        }
      } catch (error) {
        if (!cancelled) {
          logWarn('[CallFlow] Failed to establish presence socket', {
            message: error?.message,
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
          message: error?.message,
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
        message: error?.message,
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
      stopCallService();
    };
  }, [closePeerConnection, disconnectSocket]);

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
    async explicitCalleeId => {
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
          // Give the socket a moment to connect.
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8_000);
            socket.once('connect', () => {
              clearTimeout(timer);
              resolve();
            });
            socket.once('connect_error', err => {
              clearTimeout(timer);
              reject(err);
            });
          });
        }

        updateStatus(`Calling ${trimmedCalleeId}…`);
        const ack = await emitWithAck(socket, 'call.initiate', {
          version: SIGNALING_VERSION,
          calleeId: trimmedCalleeId,
        });

        isCallerRef.current = true;
        activeCallIdRef.current = ack.call.callId;
        activeCallRef.current = ack.call;
        setActiveCall(ack.call);
        setCallPhase(CALL_PHASES.OUTGOING_RINGING);
        updateStatus(`Ringing ${trimmedCalleeId}…`);
        startOutgoingRingback();
        Telemetry.trackCallStart(ack.call.callId, sessionIdRef.current);
      } catch (error) {
        logError('[CallFlow] placeCall failed', error);
        updateStatus(`Failed to place call: ${error.message}`, 'error');
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
        await emitWithAck(socketRef.current, 'call.cancel', {
          version: SIGNALING_VERSION,
          callId,
        });
      } catch (error) {
        // Server may already have transitioned; log and continue cleanup.
        logWarn('[CallFlow] cancel ack failed (call may already be terminal)', {
          message: error?.message,
        });
      }
    }

    endActiveCall('Call cancelled', 'info', 'cancelled');
  }, [endActiveCall]);

  // ─── Accept incoming call ─────────────────────────────────────────────────

  const acceptIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;

    try {
      const stream = await startLocalPreview();
      if (!stream) return;

      isCallerRef.current = false;
      activeCallIdRef.current = call.callId;

      // Make the peer connection now so tracks are added before the offer arrives.
      await ensurePeerConnection();

      const ack = await emitWithAck(socketRef.current, 'call.accept', {
        version: SIGNALING_VERSION,
        callId: call.callId,
      });

      activeCallRef.current = ack.call;
      setActiveCall(ack.call);
      incomingCallRef.current = null;
      setIncomingCall(null);
      updateStatus('Connecting…');
      Telemetry.trackCallStart(call.callId, sessionIdRef.current);
      // Stop any ringing (CallKeep system UI transitions to in-call state;
      // JS fallback ringtone stops here in case CallKeep was unavailable).
      stopIncomingRingtone();
      logInfo('[CallFlow] Ringing stopped (call accepted)');
      // Tell the OS call UI (CallKeep) the call is now active so any ringing
      // system UI shown by a background push transitions to the in-call state.
      reportCallKeepConnected(call.callId);
      // callPhase advances to in_call via the rtc.offer handler once the caller
      // sends its offer.
    } catch (error) {
      logError('[CallFlow] acceptIncomingCall failed', error);
      updateStatus(`Failed to accept call: ${error.message}`, 'error');
      endActiveCall();
    }
  }, [
    endActiveCall,
    ensurePeerConnection,
    incomingCall,
    updateStatus,
    startLocalPreview,
    sessionIdRef,
  ]);

  // ─── Decline incoming call ────────────────────────────────────────────────

  const declineIncomingCall = useCallback(async () => {
    const call = incomingCall;
    if (!call) return;

    if (socketRef.current?.connected) {
      try {
        await emitWithAck(socketRef.current, 'call.decline', {
          version: SIGNALING_VERSION,
          callId: call.callId,
        });
      } catch (error) {
        logWarn('[CallFlow] decline ack failed', { message: error?.message });
      }
    }

    endActiveCall('Call declined', 'info', 'declined');
  }, [endActiveCall, incomingCall]);

  // ─── CallKeep: bridge OS answer/end buttons into the call flow ────────────
  // Keep refs to the latest accept/decline handlers so the (mount-once)
  // CallKeep listener effect always invokes the current versions.
  const acceptIncomingCallRef = useRef(acceptIncomingCall);
  const declineIncomingCallRef = useRef(declineIncomingCall);
  useEffect(() => {
    acceptIncomingCallRef.current = acceptIncomingCall;
    declineIncomingCallRef.current = declineIncomingCall;
  }, [acceptIncomingCall, declineIncomingCall]);

  // The `callUUID` from an `answerCall` event that arrived for a call this
  // hook doesn't know about yet — either a headless answer replayed by
  // `setCallActionHandlers` the instant this effect attached (the push
  // cold-start race: CallKeep's native listener lives at module scope in
  // index.js and can queue an answer before this hook ever mounts), or the
  // matching `call.incoming` simply hasn't landed yet. The effect below
  // replays it as soon as `incomingCall` catches up, instead of requiring the
  // user to tap Accept a second time inside the app.
  const pendingAnsweredCallIdRef = useRef(null);

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
          pendingAnsweredCallIdRef.current = callUUID;
          return;
        }
        acceptIncomingCallRef.current?.();
      },
      onEnd: () => {
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
    // Run once on mount; handlers are invoked via refs.
  }, []);

  // Replay a recorded `answerCall` once the matching call becomes known to
  // this hook (via the `call.incoming` socket event or push rehydration).
  useEffect(() => {
    if (incomingCall && pendingAnsweredCallIdRef.current === incomingCall.callId) {
      pendingAnsweredCallIdRef.current = null;
      logInfo('[CallFlow] Replaying recorded answerCall', {
        callId: incomingCall.callId,
      });
      acceptIncomingCall();
    }
  }, [incomingCall, acceptIncomingCall]);

  // ─── End active in-call ───────────────────────────────────────────────────

  const handleEndCall = useCallback(async () => {
    const callId = activeCallIdRef.current;

    if (callId && socketRef.current?.connected) {
      try {
        await emitWithAck(socketRef.current, 'call.end', {
          version: SIGNALING_VERSION,
          callId,
        });
      } catch (error) {
        logWarn('[CallFlow] end call ack failed', { message: error?.message });
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
    haptic(HAPTIC_TAP_MS);
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
    async route => {
      try {
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
    if (!socketRef.current?.connected || !activeCallIdRef.current) return;
    emitWithAck(socketRef.current, 'call.media-state', {
      version: SIGNALING_VERSION,
      callId: activeCallIdRef.current,
      mediaState: { isScreenSharing },
    }).catch(error => {
      logWarn('[CallFlow] call.media-state emit failed', {
        message: error?.message,
      });
    });
  }, [isScreenSharing]);

  // ─── Connection quality polling ───────────────────────────────────────────

  useEffect(() => {
    if (!isInCall) {
      setConnectionQuality({ bars: 0, label: 'No link' });
      connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
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

        report.forEach(stat => {
          if (
            stat.type === 'candidate-pair' &&
            stat.state === 'succeeded' &&
            (stat.nominated || stat.selected)
          ) {
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
          message: error?.message,
        });
      }
    };

    pollStats();
    const intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isInCall, updateStatus]);

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

  useEffect(() => {
    if (!isInCall) return undefined;
    return subscribeAudioDevices(nextDevices => {
      logInfo('[CallFlow] Audio devices changed', nextDevices);
      setAudioDevices(nextDevices);
    });
  }, [isInCall]);

  useEffect(() => {
    if (!isInCall) return;
    const result = setAudioRoute(isSpeakerEnabled);
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
    callSummary,
    calleePresence: presenceSearch.calleePresence,
    checkPresence,
    searchUsers: presenceSearch.searchUsers,
    isServerUnreachable: presenceSearch.isServerUnreachable,
    retryPresenceConnect,

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
    sendMessage: messaging.sendMessage,
    markConversationRead,
    typingByPeer: messaging.typingByPeer,
    sendTypingIndicator: messaging.sendTypingIndicator,
    isRemoteScreenSharing,

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

    // Call actions
    placeCall,
    cancelOutgoingCall,
    acceptIncomingCall,
    declineIncomingCall,
    handleEndCall,
    startLocalPreview,
    rehydrateCallFromPush,

    // In-call controls (identical interface to useWebRTCCall for CallScreen compat)
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
