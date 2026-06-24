import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Vibration } from 'react-native';
import { io } from 'socket.io-client';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { logError, logInfo, logWarn } from '../appLogger';
import {
  AUDIO_ROUTES,
  chooseAudioRoute,
  setAudioRoute,
  startAudioSession,
  stopAudioSession,
  subscribeAudioDevices,
} from '../audioRouting';
import { startCallService, stopCallService } from '../callService';
import useCompactCallView from './useCompactCallView';
import { getConnectionQuality } from '../callUx';
import { getMediaAccessStatus, summarizeIceCandidate } from '../diagnostics';
import { isTrackEnabled, setTrackEnabled } from '../mediaControls';
import { ensureCallPermissions } from '../permissions';
import { addCallLinkListener, getInitialCallLink } from '../pushNotifications';
import { getSocketOptions } from '../socketConfig';
import { getIceServers } from '../webrtcConfig';

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';

/** Server-side signaling protocol version required for call.* and rtc.* events. */
const SIGNALING_VERSION = 1;

const STATS_POLL_INTERVAL_MS = 7000;

const HAPTIC_TAP_MS = 15;
const HAPTIC_CONNECT_MS = 30;

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

function haptic(durationMs) {
  try {
    Vibration.vibrate(durationMs);
  } catch {
    // best-effort
  }
}

/**
 * Wrap a socket.io emit-with-ack in a Promise.
 * Rejects if the server responds with `ok: false` or after a 10 s timeout.
 */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket ack timeout')), 10_000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      if (ack?.ok) {
        resolve(ack);
      } else {
        reject(new Error(ack?.error?.message || 'server error'));
      }
    });
  });
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
 *
 * The hook returns serialisable state and action callbacks so the UI remains
 * purely presentational.
 */
export default function useCallFlow() {
  // ─── Identity / connection ────────────────────────────────────────────────
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [userId, setUserId] = useState('');
  const [calleeId, setCalleeId] = useState('');

  // ─── Call lifecycle state ─────────────────────────────────────────────────
  const [callPhase, setCallPhase] = useState(CALL_PHASES.IDLE);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);

  // callId received from a push-notification deep link before the user identity
  // is fully established.  Cleared once rehydration is attempted.
  const [pendingPushCallId, setPendingPushCallId] = useState(null);

  // ─── UI state ─────────────────────────────────────────────────────────────
  const [status, setStatusState] = useState({ message: '', severity: 'info' });
  const [callSummary, setCallSummary] = useState(null);

  // ─── Media / WebRTC state ─────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true);
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  const [elapsedCallSeconds, setElapsedCallSeconds] = useState(0);
  const [audioDevices, setAudioDevices] = useState({ available: [], selected: null });
  const [connectionQuality, setConnectionQuality] = useState({ bars: 0, label: 'No link' });
  const [isReconnecting, setIsReconnecting] = useState(false);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const sessionIdRef = useRef(null);
  const activeCallIdRef = useRef(null);
  const isCallerRef = useRef(false);
  const callConnectedAtRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const connectionQualityRef = useRef({ bars: 0, label: 'No link' });
  const connectionStatsRef = useRef({ timestampMs: null, totalBytesReceived: 0 });
  const isInCallRef = useRef(false);
  // ICE candidates that arrive before the remote description is applied are
  // buffered here and flushed once setRemoteDescription succeeds.
  const iceCandidateBufferRef = useRef([]);
  // Prevents concurrent offer/answer negotiations (glare guard).
  const isNegotiatingRef = useRef(false);

  const setStatus = useCallback((message, severity = 'info') => {
    setStatusState({ message, severity });
  }, []);

  const isInCall = callPhase === CALL_PHASES.IN_CALL;

  const { isCompactView, setIsCompactView } = useCompactCallView(isInCallRef);

  useEffect(() => {
    isInCallRef.current = isInCall;
  }, [isInCall]);

  useEffect(() => {
    connectionQualityRef.current = connectionQuality;
  }, [connectionQuality]);

  // ─── Peer connection ──────────────────────────────────────────────────────

  const markCallConnected = useCallback(() => {
    if (callConnectedAtRef.current) return;
    haptic(HAPTIC_CONNECT_MS);
    callConnectedAtRef.current = Date.now();
    setElapsedCallSeconds(0);
    elapsedTimerRef.current = setInterval(() => {
      if (!callConnectedAtRef.current) return;
      setElapsedCallSeconds(Math.floor((Date.now() - callConnectedAtRef.current) / 1000));
    }, 1000);
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

  const ensurePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    logInfo('[CallFlow] Creating RTCPeerConnection');
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });

    if (localStreamRef.current) {
      // Guard against double-adding tracks when ensurePeerConnection is called
      // more than once during renegotiation (idempotent attach).
      const existingSenders = pc.getSenders?.() ?? [];
      const attachedTracks = existingSenders.map((s) => s.track);
      localStreamRef.current.getTracks().forEach((track) => {
        if (!attachedTracks.includes(track)) {
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
        setRemoteStream(stream);
        markCallConnected();
        setStatus('Call started', 'success');
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
      (async () => {
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          socketRef.current?.emit('rtc.offer', {
            version: SIGNALING_VERSION,
            callId: activeCallIdRef.current,
            sdp: pc.localDescription,
          }, (ack) => {
            if (!ack?.ok) logWarn('[CallFlow] ICE restart rtc.offer ack failed', ack?.error);
          });
        } catch (err) {
          logError('[CallFlow] ICE restart failed', err);
        }
      })();
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [markCallConnected, setStatus]);

  // ─── Local media ──────────────────────────────────────────────────────────

  const startLocalPreview = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;

    const permResult = await ensureCallPermissions();
    if (!permResult.ok) {
      setStatus(permResult.message, 'error');
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
      setStatus(getMediaAccessStatus(error), 'error');
      throw error;
    }
  }, [setStatus]);

  // ─── Call teardown ────────────────────────────────────────────────────────

  /**
   * Wind down an active call.  Preserves the socket connection so the user
   * can receive subsequent incoming calls without reconnecting.
   */
  const endActiveCall = useCallback(
    (nextMessage = 'Call ended', severity = 'info') => {
      if (callConnectedAtRef.current) {
        const durationSeconds = Math.floor(
          (Date.now() - callConnectedAtRef.current) / 1000,
        );
        setCallSummary({
          durationSeconds,
          quality: connectionQualityRef.current?.label || 'No link',
        });
      }

      callConnectedAtRef.current = null;
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }

      activeCallIdRef.current = null;
      isCallerRef.current = false;

      setCallPhase(CALL_PHASES.IDLE);
      setActiveCall(null);
      setIncomingCall(null);
      setIsReconnecting(false);
      setElapsedCallSeconds(0);
      setIsCompactView(false);
      setIsLocalPrimary(false);
      setAudioDevices({ available: [], selected: null });
      stopCallService();
      closePeerConnection();
      if (nextMessage) setStatus(nextMessage, severity);
    },
    [closePeerConnection, setIsCompactView, setStatus],
  );

  // ─── Session management ───────────────────────────────────────────────────

  const createOrGetSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    const trimmedUrl = signalingUrl.trim();
    const response = await fetch(`${trimmedUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId.trim() || undefined,
        platform: Platform.OS,
      }),
    });

    if (!response.ok) {
      throw new Error(`Session creation failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    sessionIdRef.current = data.sessionId;
    logInfo('[CallFlow] Session created', { sessionId: data.sessionId, userId: data.userId });
    return data.sessionId;
  }, [signalingUrl, userId]);

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
  }, []);

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
    (sessionId) => {
      disconnectSocket();

      logInfo('[CallFlow] Connecting socket', { signalingUrl });
      const socket = io(signalingUrl.trim(), {
        ...getSocketOptions(),
        auth: { sessionId },
      });
      socketRef.current = socket;

      // ── Incoming call ──────────────────────────────────────────────────
      socket.on('call.incoming', ({ call }) => {
        logInfo('[CallFlow] Incoming call', { callId: call.callId, callerId: call.callerId });
        haptic(400);
        setIncomingCall(call);
        setCallPhase(CALL_PHASES.INCOMING_RINGING);
        setStatus(`Incoming call from ${call.callerId}`);
      });

      // ── Call ringing (caller confirmation) ────────────────────────────
      socket.on('call.ringing', ({ call }) => {
        logInfo('[CallFlow] Call ringing', { callId: call.callId });
        setActiveCall(call);
      });

      // ── Call state changes ────────────────────────────────────────────
      socket.on('call.state_changed', async ({ status: callStatus, call, reason }) => {
        logInfo('[CallFlow] call.state_changed', { callStatus, callId: call?.callId, reason });
        if (call) setActiveCall(call);

        switch (callStatus) {
          case 'accepted': {
            setStatus('Call accepted, connecting media…');
            // Caller is responsible for sending the initial RTC offer.
            if (isCallerRef.current && call) {
              activeCallIdRef.current = call.callId;
              try {
                await startLocalPreviewRef.current?.();
                const pc = ensurePeerConnectionRef.current?.();
                if (!pc) break;
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('rtc.offer', {
                  version: SIGNALING_VERSION,
                  callId: call.callId,
                  sdp: pc.localDescription,
                }, (ack) => {
                  if (!ack?.ok) logWarn('[CallFlow] rtc.offer ack failed', ack?.error);
                });
              } catch (error) {
                logError('[CallFlow] Failed to create/send RTC offer', error);
                setStatus('Failed to connect media', 'error');
                endActiveCallRef.current?.('Failed to connect media', 'error');
              }
            }
            break;
          }

          case 'declined':
            endActiveCallRef.current?.('Call declined');
            break;

          case 'missed':
            endActiveCallRef.current?.('Call not answered', 'error');
            break;

          case 'busy':
            endActiveCallRef.current?.('Callee is busy', 'error');
            break;

          case 'unreachable':
            endActiveCallRef.current?.('Callee is unreachable', 'error');
            break;

          case 'ended':
            endActiveCallRef.current?.(
              reason === 'cancelled' ? 'Call cancelled' : 'Call ended',
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
          const pc = ensurePeerConnectionRef.current?.();
          if (!pc) return;
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          // Flush any ICE candidates that arrived before the remote description.
          const buffered = iceCandidateBufferRef.current.splice(0);
          for (const c of buffered) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch (err) {
              logWarn('[CallFlow] Failed to add buffered ICE candidate', { message: err?.message });
            }
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc.answer', {
            version: SIGNALING_VERSION,
            callId,
            sdp: pc.localDescription,
          }, (ack) => {
            if (!ack?.ok) logWarn('[CallFlow] rtc.answer ack failed', ack?.error);
          });
          setCallPhase(CALL_PHASES.IN_CALL);
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC offer', error);
          setStatus('Failed to connect media', 'error');
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
          const buffered = iceCandidateBufferRef.current.splice(0);
          for (const c of buffered) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            } catch (err) {
              logWarn('[CallFlow] Failed to add buffered ICE candidate', { message: err?.message });
            }
          }
          setCallPhase(CALL_PHASES.IN_CALL);
          startCallService();
        } catch (error) {
          logError('[CallFlow] Failed to handle RTC answer', error);
          setStatus('Failed to connect media', 'error');
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
          logWarn('[CallFlow] Failed to add ICE candidate', { message: error?.message });
        }
      });

      // ── Socket lifecycle ──────────────────────────────────────────────
      socket.on('connect', async () => {
        logInfo('[CallFlow] Socket connected', { socketId: socket.id });
        if (!isInCallRef.current) return;
        setIsReconnecting(false);
        // When the caller's socket reconnects mid-call, send an ICE-restart
        // offer so the peer connection can negotiate a new network path.
        if (isCallerRef.current) {
          const pc = peerConnectionRef.current;
          if (pc) {
            try {
              logInfo('[CallFlow] Sending ICE restart offer after socket reconnect');
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              socket.emit('rtc.offer', {
                version: SIGNALING_VERSION,
                callId: activeCallIdRef.current,
                sdp: pc.localDescription,
              }, (ack) => {
                if (!ack?.ok) logWarn('[CallFlow] ICE restart rtc.offer ack failed', ack?.error);
              });
            } catch (err) {
              logError('[CallFlow] ICE restart after socket reconnect failed', err);
            }
          }
        }
      });

      socket.on('disconnect', (reason) => {
        logWarn('[CallFlow] Socket disconnected', { reason });
        if (isInCallRef.current) {
          setIsReconnecting(true);
          setStatus('Reconnecting…');
        }
      });

      socket.on('connect_error', (error) => {
        logError('[CallFlow] Socket connect error', {
          message: error?.message,
          description: error?.description,
        });
      });

      return socket;
    },
    [disconnectSocket, setStatus, signalingUrl],
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
    async (callId) => {
      if (!callId) return;

      const trimmedUserId = (userId ?? '').trim();
      const trimmedUrl = (signalingUrl ?? '').trim();

      if (!trimmedUserId || !trimmedUrl) {
        logInfo('[CallFlow] Deferring push rehydration until identity is set', { callId });
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
            setStatus('Call no longer available', 'info');
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const call = await response.json();

        if (call.status === 'ringing') {
          logInfo('[CallFlow] Rehydrated ringing call; showing incoming screen', {
            callId: call.callId,
          });
          haptic(400);
          setIncomingCall(call);
          setCallPhase(CALL_PHASES.INCOMING_RINGING);
          setStatus(`Incoming call from ${call.callerId}`);

          // Ensure a socket is live so the user can accept / decline.
          if (!socketRef.current?.connected) {
            connectSocket(sessionId);
          }
        } else {
          // Terminal or non-ringing state – inform the user and stay idle.
          const terminalMessages = {
            missed:      'Missed call',
            declined:    'Call was declined',
            ended:       'Call ended',
            busy:        'Line was busy',
            unreachable: 'Call unreachable',
          };
          const message = terminalMessages[call.status] ?? 'Call no longer active';
          logInfo('[CallFlow] Push call already finished', {
            callId,
            status: call.status,
          });
          setStatus(message, 'info');
        }
      } catch (error) {
        logError('[CallFlow] rehydrateCallFromPush failed', error);
        setStatus('Unable to retrieve call state', 'error');
      }
    },
    // connectSocket and createOrGetSession are stable relative to userId/signalingUrl
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, signalingUrl, setStatus],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // createOrGetSession and connectSocket are stable relative to userId/signalingUrl
    // – they update exactly when those values change, so listing them would cause
    // a redundant effect cycle but not a correctness problem.
  }, [userId, signalingUrl]); // intentionally omitting createOrGetSession, connectSocket, disconnectSocket

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      disconnectSocket();
      closePeerConnection();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
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
      .then((descriptor) => {
        if (descriptor?.callId) {
          logInfo('[CallFlow] App launched from push notification', descriptor);
          rehydrateCallFromPushRef.current(descriptor.callId);
        }
      })
      .catch((error) => {
        logError('[CallFlow] Failed to read initial call link', error);
      });
    // Run only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Listen for deep links while the app is already running (background → foreground).
  useEffect(() => {
    const unlisten = addCallLinkListener((descriptor) => {
      logInfo('[CallFlow] Deep-link received while running', descriptor);
      rehydrateCallFromPushRef.current(descriptor.callId);
    });
    return unlisten;
    // Run only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const placeCall = useCallback(async () => {
    const trimmedCalleeId = calleeId.trim();
    if (!trimmedCalleeId) {
      setStatus('Enter a callee ID to call', 'error');
      return;
    }
    if (!userId.trim()) {
      setStatus('Enter your user ID first', 'error');
      return;
    }

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
          socket.once('connect', () => { clearTimeout(timer); resolve(); });
          socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
        });
      }

      setStatus(`Calling ${trimmedCalleeId}…`);
      const ack = await emitWithAck(socket, 'call.initiate', {
        version: SIGNALING_VERSION,
        calleeId: trimmedCalleeId,
      });

      isCallerRef.current = true;
      activeCallIdRef.current = ack.call.callId;
      setActiveCall(ack.call);
      setCallPhase(CALL_PHASES.OUTGOING_RINGING);
      setStatus(`Ringing ${trimmedCalleeId}…`);
    } catch (error) {
      logError('[CallFlow] placeCall failed', error);
      setStatus(`Failed to place call: ${error.message}`, 'error');
      endActiveCall();
    }
  }, [calleeId, connectSocket, createOrGetSession, endActiveCall, setStatus, startLocalPreview, userId]);

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

    endActiveCall('Call cancelled');
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
      ensurePeerConnection();

      const ack = await emitWithAck(socketRef.current, 'call.accept', {
        version: SIGNALING_VERSION,
        callId: call.callId,
      });

      setActiveCall(ack.call);
      setIncomingCall(null);
      setStatus('Connecting…');
      // callPhase advances to in_call via the rtc.offer handler once the caller
      // sends its offer.
    } catch (error) {
      logError('[CallFlow] acceptIncomingCall failed', error);
      setStatus(`Failed to accept call: ${error.message}`, 'error');
      endActiveCall();
    }
  }, [endActiveCall, ensurePeerConnection, incomingCall, setStatus, startLocalPreview]);

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

    endActiveCall('Call declined');
  }, [endActiveCall, incomingCall]);

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

    endActiveCall('Call ended');
  }, [endActiveCall]);

  // ─── Media controls ───────────────────────────────────────────────────────

  const handleMuteToggle = useCallback(() => {
    const nextMuted = !isMuted;
    if (!setTrackEnabled(localStreamRef.current, 'audio', !nextMuted)) {
      setStatus('Start preview to control audio', 'error');
      return;
    }
    haptic(HAPTIC_TAP_MS);
    setIsMuted(nextMuted);
    setStatus(nextMuted ? 'Muted microphone' : 'Unmuted microphone');
  }, [isMuted, setStatus]);

  const handleVideoToggle = useCallback(() => {
    const nextVideoEnabled = !isVideoEnabled;
    if (!setTrackEnabled(localStreamRef.current, 'video', nextVideoEnabled)) {
      setStatus('Start preview to control video', 'error');
      return;
    }
    setIsVideoEnabled(nextVideoEnabled);
    setStatus(nextVideoEnabled ? 'Camera enabled' : 'Camera disabled');
  }, [isVideoEnabled, setStatus]);

  const handleCameraSwitch = useCallback(async () => {
    try {
      const [videoTrack] = localStreamRef.current?.getVideoTracks?.() ?? [];

      // Fast path: react-native-webrtc provides an in-place camera flip that
      // keeps the same track object – no renegotiation required.
      if (typeof videoTrack?._switchCamera === 'function') {
        videoTrack._switchCamera();
        setIsFrontCamera((prev) => !prev);
        setStatus('Camera switched');
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
        newStream.getTracks().forEach((t) => t.stop());
        setStatus('Camera switch unavailable', 'error');
        return;
      }

      const pc = peerConnectionRef.current;
      if (pc) {
        const sender = pc.getSenders?.().find((s) => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        }
      }

      videoTrack?.stop();
      if (localStreamRef.current) {
        localStreamRef.current.removeTrack(videoTrack);
        localStreamRef.current.addTrack(newVideoTrack);
      }
      setLocalStream(localStreamRef.current);
      setIsFrontCamera((prev) => !prev);
      setStatus('Camera switched');
    } catch (error) {
      logError('[CallFlow] Camera switch failed', error);
      setStatus('Camera switch unavailable', 'error');
    }
  }, [isFrontCamera, setStatus]);

  const handleSwapStreams = useCallback(() => {
    if (!remoteStream || !localStream) return;
    setIsLocalPrimary((prev) => !prev);
  }, [localStream, remoteStream]);

  const handleRetryReconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      setStatus('No active socket', 'error');
      return;
    }
    setIsReconnecting(true);
    setStatus('Reconnecting…');
    socket.disconnect();
    socket.connect();
  }, [setStatus]);

  const chooseAudioOutput = useCallback(
    async (route) => {
      try {
        const result = await chooseAudioRoute(route);
        if (!result.ok) {
          setAudioDevices({ available: result.available, selected: result.selected });
          setIsSpeakerEnabled(result.selected === AUDIO_ROUTES.SPEAKER_PHONE);
          setStatus(result.message, 'error');
          return;
        }
        setAudioDevices({ available: result.available, selected: result.selected });
        setIsSpeakerEnabled(route === AUDIO_ROUTES.SPEAKER_PHONE);
        setStatus(`Audio: ${route === AUDIO_ROUTES.SPEAKER_PHONE ? 'Speaker' : route}`);
      } catch (error) {
        logError('[CallFlow] chooseAudioOutput failed', error);
        setStatus('Unable to switch audio output', 'error');
      }
    },
    [setStatus],
  );

  const dismissCallSummary = useCallback(() => {
    setCallSummary(null);
  }, []);

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

        report.forEach((stat) => {
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
            ((totalBytesReceived - previous.totalBytesReceived) * 8) /
            (now - previous.timestampMs);
        }
        connectionStatsRef.current = { timestampMs: now, totalBytesReceived };

        const denominator = totalPacketsReceived + totalPacketsLost;
        const packetLossRatio =
          denominator > 0 ? totalPacketsLost / denominator : undefined;
        setConnectionQuality(
          getConnectionQuality({ rttMs, packetLossRatio, bitrateKbps }),
        );
      } catch (error) {
        logWarn('[CallFlow] Failed to read connection stats', { message: error?.message });
      }
    };

    pollStats();
    const intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [isInCall]);

  // ─── Audio session & device routing ──────────────────────────────────────

  useEffect(() => {
    if (!isInCall) return undefined;

    const result = startAudioSession();
    if (!result.ok) {
      logWarn('[CallFlow] InCallManager start failed', { message: result.message });
      setStatus(result.message, 'error');
    }

    return () => {
      const stopResult = stopAudioSession();
      if (!stopResult.ok) {
        logWarn('[CallFlow] InCallManager stop failed', { message: stopResult.message });
      }
    };
  }, [isInCall, setStatus]);

  useEffect(() => {
    if (!isInCall) return undefined;
    return subscribeAudioDevices((nextDevices) => {
      logInfo('[CallFlow] Audio devices changed', nextDevices);
      setAudioDevices(nextDevices);
    });
  }, [isInCall]);

  useEffect(() => {
    if (!isInCall) return;
    const result = setAudioRoute(isSpeakerEnabled);
    if (!result.ok) {
      logWarn('[CallFlow] Audio route update failed', { message: result.message });
    }
  }, [isInCall, isSpeakerEnabled]);

  // ─── Public interface ─────────────────────────────────────────────────────

  return {
    // Identity / connection config
    userId,
    setUserId,
    calleeId,
    setCalleeId,
    signalingUrl,
    setSignalingUrl,

    // Call lifecycle
    callPhase,
    activeCall,
    incomingCall,

    // UI status
    status,
    callSummary,

    // In-call media state
    localStream,
    remoteStream,
    isInCall,
    isMuted,
    isVideoEnabled,
    isSpeakerEnabled,
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
    handleCameraSwitch,
    handleSwapStreams,
    handleRetryReconnect,
    chooseAudioOutput,
    dismissCallSummary,
  };
}
