import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Vibration } from 'react-native';
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
import useCompactCallView from './useCompactCallView';
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
import { loadDeviceId, loadIdentity, saveIdentity } from '../settingsStorage';
import { getSocketOptions } from '../socketConfig';
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
import { generateVerificationCode, normalizeVerificationCode } from '../identityVerification';

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';

/** Server-side signaling protocol version required for call.* and rtc.* events. */
const SIGNALING_VERSION = 1;

const STATS_POLL_INTERVAL_MS = 7000;

const HAPTIC_TAP_MS = 15;
const HAPTIC_CONNECT_MS = 30;

/** Maximum number of call history entries to retain in memory. */
const MAX_CALL_HISTORY = 50;

/**
 * How often to proactively rotate the session token.  Set well below typical
 * server-side TTLs (e.g. 1 h) so the token never expires mid-call.
 */
const SESSION_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * How many consecutive socket `connect_error` events before the lobby is
 * considered offline and an offline banner is shown.
 */
const OFFLINE_ERROR_THRESHOLD = 3;

/**
 * Safety-net timeout for a peer's typing indicator: cleared automatically
 * this long after the last `isTyping: true` event, in case the corresponding
 * `isTyping: false` event is dropped (e.g. the peer's app is killed mid-type).
 */
const TYPING_INDICATOR_TIMEOUT_MS = 6000;

/** How often `sendTypingIndicator(peerId, true)` may be emitted while the
 * user keeps typing, so every keystroke doesn't trigger a socket emit. */
const TYPING_INDICATOR_THROTTLE_MS = 2000;

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
 * Wrap a socket.io emit-with-ack in a Promise.
 * Rejects if the server responds with `ok: false` or after a 10 s timeout.
 */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket ack timeout')), 10_000);
    socket.emit(event, payload, ack => {
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
 *   8. Text chat: conversation list / history (`GET /conversations`,
 *      `GET /messages`), sending (`message.send`) with optimistic UI, unread
 *      tracking and read receipts (`POST /messages/read`), and the
 *      `call.media-state` relay used to mirror the peer's screen-share state.
 *
 * The hook returns serialisable state and action callbacks so the UI remains
 * purely presentational.
 */
export default function useCallFlow() {
  // ─── Identity / connection ────────────────────────────────────────────────
  const [signalingUrl, setSignalingUrl] = useState(DEFAULT_SIGNALING_URL);
  const [userId, setUserId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingVerificationCode, setPendingVerificationCode] = useState('');
  const [calleeId, setCalleeId] = useState('');

  // true while the identity is being loaded from persistent storage on mount.
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(true);

  // ─── Call lifecycle state ─────────────────────────────────────────────────
  const [callPhase, setCallPhase] = useState(CALL_PHASES.IDLE);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);

  // callId received from a push-notification deep link before the user identity
  // is fully established.  Cleared once rehydration is attempted.
  const [pendingPushCallId, setPendingPushCallId] = useState(null);

  // ─── UI state ─────────────────────────────────────────────────────────────
  // Raw state setter; callers use the `updateStatus(message, severity)` helper
  // declared below rather than setting the shape by hand.
  const [status, setStatus] = useState({ message: '', severity: 'info' });
  const [callSummary, setCallSummary] = useState(null);

  // Presence of the user currently entered in `calleeId`, or `null` while
  // unknown / not yet checked.  Shape: { status: 'online'|'offline', online }.
  const [calleePresence, setCalleePresence] = useState(null);

  /**
   * `true` when repeated socket connect errors suggest the signaling server is
   * unreachable.  Cleared automatically on a successful connection.  Drives the
   * persistent offline banner + retry button in the Lobby.
   */
  const [isServerUnreachable, setIsServerUnreachable] = useState(false);

  // ─── Call history ─────────────────────────────────────────────────────────
  // Each entry: { callId, callerId, calleeId, direction, status, endReason,
  //               createdAt, durationSeconds, isRead }
  const [callHistory, setCallHistory] = useState([]);

  // ─── Chat / messaging state ───────────────────────────────────────────────
  // One entry per conversation the user participates in: { conversationId,
  // peerId, lastMessage, unreadCount }, newest-activity first.
  const [conversations, setConversations] = useState([]);
  // Keyed by peerId → array of message objects, newest-first (matches the
  // server's ordering). Optimistic (pending/failed) sends are tagged inline.
  const [messagesByPeer, setMessagesByPeer] = useState({});
  // peerId of the conversation currently open in the UI, or null. Drives
  // auto-mark-read for incoming messages from that peer.
  const [activeChatPeerId, setActiveChatPeerId] = useState(null);
  // True from the moment `placeCall` is invoked until the call reaches
  // OUTGOING_RINGING (or fails). Lets chat-header call buttons show a brief
  // loading state instead of appearing to do nothing while the local camera
  // preview starts and the socket/`call.initiate` round-trip completes.
  const [isPlacingCall, setIsPlacingCall] = useState(false);
  // Keyed by peerId → boolean. True while that peer is actively typing in the
  // open conversation (relayed via the ephemeral `message.typing` socket
  // event). Cleared on receipt of isTyping:false or after a short timeout, in
  // case a "stopped typing" event is dropped.
  const [typingByPeer, setTypingByPeer] = useState({});
  const typingTimeoutsRef = useRef({});
  const typingSentAtRef = useRef({});
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
  const sessionIdRef = useRef(null);
  // Stable per-install device id, lazily loaded from disk on first session.
  const deviceIdRef = useRef(null);
  const verificationCodeRef = useRef('');
  const committedIdentityRef = useRef({ userId: '', verificationCode: '' });
  // Holds the latest authedFetch implementation so the call-history / contact
  // helpers (declared earlier in this hook) can issue 401-recovering requests
  // without referencing the later-declared authedFetch useCallback directly.
  const authedFetchRef = useRef(null);
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
  // Mirrors activeChatPeerId so the message.received socket handler never
  // reads a stale value through a captured closure.
  const activeChatPeerIdRef = useRef(null);
  const calleePresenceRequestIdRef = useRef(0);
  // Counts consecutive socket connect_error events; resets on a successful
  // connect.  Used to flip isServerUnreachable after OFFLINE_ERROR_THRESHOLD.
  const connectErrorCountRef = useRef(0);
  // Tracks callIds for which the incoming-call UI has already been shown so
  // duplicate socket or push events never trigger a second CallKeep display.
  const displayedIncomingCallIdsRef = useRef(new Set());

  const updateStatus = useCallback((message, severity = 'info') => {
    logVerbose('[CallFlow] Status updated', { message, severity });
    setStatus({ message, severity });
  }, []);

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

  /** True once a userId has been persisted (i.e. the user has registered). */
  const isRegistered = userId.trim().length > 0;

  const { isCompactView, setIsCompactView } = useCompactCallView(isInCallRef);

  const dismissVerificationCodeNotice = useCallback(() => {
    setPendingVerificationCode('');
  }, []);

  const commitIdentity = useCallback(
    async (nextUserId, nextVerificationCode, { announceVerificationCode = false } = {}) => {
      const identity = {
        userId: (nextUserId ?? '').trim(),
        verificationCode: normalizeVerificationCode(nextVerificationCode),
      };

      committedIdentityRef.current = identity;
      verificationCodeRef.current = identity.verificationCode;
      setUserId(identity.userId);
      setVerificationCode(identity.verificationCode);
      setPendingVerificationCode(announceVerificationCode ? identity.verificationCode : '');
      await saveIdentity(identity);
      return identity;
    },
    [],
  );

  const editUserId = useCallback(nextUserId => {
    const rawUserId = typeof nextUserId === 'string' ? nextUserId : '';
    const trimmedUserId = rawUserId.trim();
    const committedIdentity = committedIdentityRef.current;
    const isCommittedIdentity = trimmedUserId === committedIdentity.userId;

    setUserId(rawUserId);
    if (isCommittedIdentity) {
      verificationCodeRef.current = committedIdentity.verificationCode;
      setVerificationCode(committedIdentity.verificationCode);
    } else {
      verificationCodeRef.current = '';
      setVerificationCode('');
    }
    setPendingVerificationCode('');
  }, []);

  // ─── Load persisted identity on mount ────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const initialiseIdentity = async () => {
      try {
        const storedIdentity = await loadIdentity();
        if (cancelled) return;

        const savedId = (storedIdentity?.userId ?? '').trim();
        let savedVerificationCode = normalizeVerificationCode(storedIdentity?.verificationCode);

        if (savedId) {
          const shouldGenerateVerificationCode = !savedVerificationCode;
          if (shouldGenerateVerificationCode) {
            savedVerificationCode = generateVerificationCode();
          }

          committedIdentityRef.current = {
            userId: savedId,
            verificationCode: savedVerificationCode,
          };
          verificationCodeRef.current = savedVerificationCode;
          setUserId(savedId);
          setVerificationCode(savedVerificationCode);

          if (shouldGenerateVerificationCode) {
            setPendingVerificationCode(savedVerificationCode);
            updateStatus(
              'Save your recovery code. You’ll need it to use this username on another device.',
              'info',
            );
            void saveIdentity({
              userId: savedId,
              verificationCode: savedVerificationCode,
            });
            logInfo('[CallFlow] Recovery code generated for stored identity', {
              userId: savedId,
              hasVerificationCode: true,
            });
          }
        }
      } finally {
        if (!cancelled) setIsLoadingIdentity(false);
      }
    };

    initialiseIdentity().catch(() => {
      if (!cancelled) setIsLoadingIdentity(false);
    });
    return () => {
      cancelled = true;
    };
  }, [updateStatus]);

  /**
   * Register the local user with the given userId.  Persists the identity to
   * disk and updates the in-memory state so the presence socket connects.
   *
   * @param {string} newUserId
   * @param {string} [existingVerificationCode]
   */
  const registerUser = useCallback(
    async (newUserId, existingVerificationCode = '') => {
      const trimmed = (newUserId ?? '').trim();
      if (!trimmed) return;
      const nextVerificationCode =
        normalizeVerificationCode(existingVerificationCode) || generateVerificationCode();
      const identity = await commitIdentity(trimmed, nextVerificationCode, {
        announceVerificationCode: true,
      });
      updateStatus(
        'Save your recovery code. You’ll need it to use this username on another device.',
        'success',
      );
      logInfo('[CallFlow] User registered', {
        userId: identity.userId,
        hasVerificationCode: true,
      });
    },
    [commitIdentity, updateStatus],
  );

  /**
   * Update the active userId and persist the new value.
   * Use this when the user edits their username in the Lobby so the new
   * identity survives app restarts.
   *
   * @param {string} newUserId
   */
  const updateUserId = useCallback(
    async newUserId => {
      const trimmed = (newUserId ?? '').trim();
      if (!trimmed || trimmed === committedIdentityRef.current.userId) return;

      const identity = await commitIdentity(trimmed, generateVerificationCode(), {
        announceVerificationCode: true,
      });
      updateStatus('Username updated. Save your new recovery code.', 'success');
      logInfo('[CallFlow] Username updated', {
        userId: identity.userId,
        hasVerificationCode: true,
      });
    },
    [commitIdentity, updateStatus],
  );

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
    committedIdentityRef.current = { userId: '', verificationCode: '' };
    verificationCodeRef.current = '';
    setUserId('');
    setVerificationCode('');
    setPendingVerificationCode('');
    await saveIdentity({ userId: '', verificationCode: '' });
    logInfo('[CallFlow] User unregistered');
  }, [signalingUrl]);

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

  // ─── Call history helpers ─────────────────────────────────────────────────

  /**
   * Number of incoming calls that ended as 'missed' and have not yet been
   * acknowledged by the user.
   */
  const missedCallCount = useMemo(
    () =>
      callHistory.filter(
        e =>
          e.direction === 'incoming' &&
          (e.status === 'missed' || e.endReason === 'timeout') &&
          !e.isRead,
      ).length,
    [callHistory],
  );

  /** Append or update a call history entry (deduplicates by callId). */
  const addToHistory = useCallback(entry => {
    setCallHistory(prev => {
      const without = prev.filter(e => e.callId !== entry.callId);
      return [entry, ...without].slice(0, MAX_CALL_HISTORY);
    });
  }, []);

  /** Mark all missed-call entries as read (clears the badge counter). */
  const markMissedCallsRead = useCallback(() => {
    setCallHistory(prev => prev.map(e => ({ ...e, isRead: true })));
  }, []);

  /**
   * Fetch the authenticated user's recent call history from the server and
   * populate `callHistory`.  Safe to call repeatedly; silently swallows
   * network errors so it never disrupts other call-flow operations.
   *
   * @param {number} [limit=20]
   */
  const fetchCallHistory = useCallback(
    async (limit = 20) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const trimmedUserId = userId.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}/calls?sessionId=${encodeURIComponent(sid)}&limit=${limit}`,
        }));
        if (!response?.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.calls)) return;
        const entries = data.calls.map(call => ({
          callId: call.callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          direction: call.callerId === trimmedUserId ? 'outgoing' : 'incoming',
          status: call.status,
          endReason: call.endReason,
          createdAt: call.createdAt,
          durationSeconds: null,
          isRead: call.status !== 'missed',
        }));
        setCallHistory(entries);
      } catch (error) {
        logWarn('[CallFlow] fetchCallHistory failed', {
          message: error?.message,
        });
      }
    },
    [signalingUrl, userId],
  );

  /**
   * Query the signaling server for the online/offline presence of a userId.
   * Returns the presence snapshot, or `null` when the user is unknown (404) or
   * the request fails.  Never throws.
   *
   * @param {string} targetUserId
   * @returns {Promise<{ status: string, online: boolean, unknown?: boolean } | null>}
   */
  const checkPresence = useCallback(
    async targetUserId => {
      const trimmedId = (targetUserId ?? '').trim();
      const trimmedUrl = (signalingUrl ?? '').trim();
      if (!trimmedId || !trimmedUrl) return null;
      try {
        const response = await fetch(`${trimmedUrl}/presence/${encodeURIComponent(trimmedId)}`);
        if (response.status === 404) return { status: 'offline', online: false, unknown: true };
        if (!response.ok) return null;
        const data = await response.json();
        return { status: data.status, online: Boolean(data.online) };
      } catch (error) {
        logWarn('[CallFlow] checkPresence failed', { message: error?.message });
        return null;
      }
    },
    [signalingUrl],
  );

  /**
   * Search the server's contact directory (`GET /users`) for known users whose
   * userId matches `query` (case-insensitive substring).  Returns an array of
   * `{ userId, status, online, lastSeen }` entries, or an empty array when the
   * request fails or no session exists.  Never throws.
   *
   * @param {string} [query] optional substring filter
   * @param {number} [limit=20] max results
   * @returns {Promise<Array<{ userId: string, status: string, online: boolean, lastSeen?: string | null }>>}
   */
  const searchUsers = useCallback(
    async (query = '', limit = 20) => {
      const sessionId = sessionIdRef.current;
      const trimmedUrl = (signalingUrl ?? '').trim();
      if (!sessionId || !trimmedUrl) return [];
      try {
        const trimmedQuery = (query ?? '').trim();
        const response = await authedFetchRef.current?.(sid => {
          const params = new URLSearchParams({
            sessionId: sid,
            limit: String(limit),
          });
          if (trimmedQuery) params.set('search', trimmedQuery);
          return { url: `${trimmedUrl}/users?${params.toString()}` };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        return Array.isArray(data.users) ? data.users : [];
      } catch (error) {
        logWarn('[CallFlow] searchUsers failed', { message: error?.message });
        return [];
      }
    },
    [signalingUrl],
  );

  // Keep a ref mirror of activeChatPeerId so socket handlers declared once
  // (inside connectSocket) always see the current value.
  useEffect(() => {
    activeChatPeerIdRef.current = activeChatPeerId;
  }, [activeChatPeerId]);

  /**
   * Fetch the authenticated user's conversation list (`GET /conversations`)
   * and populate `conversations`.  Safe to call repeatedly; silently
   * swallows network errors, mirroring `fetchCallHistory`.
   */
  const fetchConversations = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const trimmedUrl = signalingUrl.trim();
      const response = await authedFetchRef.current?.(sid => ({
        url: `${trimmedUrl}/conversations?sessionId=${encodeURIComponent(sid)}`,
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.conversations)) return;
      setConversations(data.conversations);
    } catch (error) {
      logWarn('[CallFlow] fetchConversations failed', {
        message: error?.message,
      });
    }
  }, [signalingUrl]);

  /**
   * Fetch a page of message history with `peerId` (`GET /messages`) and merge
   * it into `messagesByPeer`.  Pass `{ before }` (an ISO cursor, the oldest
   * held message's `createdAt`) to page further back; omit it for the first
   * page, which replaces any existing entry for that peer.
   *
   * @param {string} peerId
   * @param {{ before?: string }} [options]
   * @returns {Promise<Array>} the fetched page (empty on failure)
   */
  const fetchMessagesForPeer = useCallback(
    async (peerId, { before } = {}) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const sessionId = sessionIdRef.current;
      if (!sessionId || !trimmedPeerId) return [];
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => {
          const params = new URLSearchParams({
            sessionId: sid,
            peerId: trimmedPeerId,
          });
          if (before) params.set('before', before);
          return { url: `${trimmedUrl}/messages?${params.toString()}` };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        const messages = Array.isArray(data.messages) ? data.messages : [];
        setMessagesByPeer(prev => {
          const existing = prev[trimmedPeerId] ?? [];
          if (!before) {
            return { ...prev, [trimmedPeerId]: messages };
          }
          // Pagination: append older messages, deduping by messageId.
          const existingIds = new Set(existing.map(m => m.messageId));
          const merged = [...existing, ...messages.filter(m => !existingIds.has(m.messageId))];
          return { ...prev, [trimmedPeerId]: merged };
        });
        return messages;
      } catch (error) {
        logWarn('[CallFlow] fetchMessagesForPeer failed', {
          message: error?.message,
        });
        return [];
      }
    },
    [signalingUrl],
  );

  /**
   * Send a chat message to `peerId`, appending an optimistic (pending) local
   * copy immediately and reconciling it with the server-confirmed message (or
   * marking it failed) once `message.send` acks.
   *
   * @param {string} peerId
   * @param {string} body
   */
  const sendMessage = useCallback(
    async (peerId, body) => {
      const trimmedPeerId = (peerId ?? '').trim();
      const trimmedBody = (body ?? '').trim();
      if (!trimmedPeerId || !trimmedBody) return;

      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const optimisticMessage = {
        messageId: tempId,
        conversationId: null,
        senderId: userId,
        recipientId: trimmedPeerId,
        body: trimmedBody,
        createdAt: new Date().toISOString(),
        deliveredTo: [],
        readAt: null,
        pending: true,
      };

      setMessagesByPeer(prev => ({
        ...prev,
        [trimmedPeerId]: [optimisticMessage, ...(prev[trimmedPeerId] ?? [])],
      }));

      const markFailed = () => {
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: (prev[trimmedPeerId] ?? []).map(m =>
            m.messageId === tempId ? { ...m, pending: false, failed: true } : m,
          ),
        }));
        updateStatus('Message failed to send', 'error');
      };

      if (!socketRef.current?.connected) {
        markFailed();
        return;
      }

      try {
        const ack = await emitWithAck(socketRef.current, 'message.send', {
          version: SIGNALING_VERSION,
          recipientId: trimmedPeerId,
          body: trimmedBody,
        });
        const confirmed = ack?.message;
        setMessagesByPeer(prev => ({
          ...prev,
          [trimmedPeerId]: (prev[trimmedPeerId] ?? []).map(m =>
            m.messageId === tempId ? { ...(confirmed ?? m), pending: false } : m,
          ),
        }));
      } catch (error) {
        logWarn('[CallFlow] sendMessage failed', { message: error?.message });
        markFailed();
      }
    },
    [userId, updateStatus],
  );

  /**
   * Mark every message from `peerId` as read (`POST /messages/read`) and
   * locally zero out that conversation's unread badge without waiting for a
   * refetch.
   *
   * @param {string} peerId
   */
  const markConversationRead = useCallback(
    async peerId => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}/messages/read`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, peerId: trimmedPeerId }),
          },
        }));
        if (!response?.ok) return;
        setConversations(prev =>
          prev.map(c => (c.peerId === trimmedPeerId ? { ...c, unreadCount: 0 } : c)),
        );
      } catch (error) {
        logWarn('[CallFlow] markConversationRead failed', {
          message: error?.message,
        });
      }
    },
    [signalingUrl],
  );

  /**
   * Notify `peerId` that the local user is (or has stopped) typing in their
   * conversation, via the ephemeral `message.typing` socket event. Silently a
   * no-op when there is no connected socket — typing indicators are a
   * best-effort UI nicety, never worth surfacing an error for.
   *
   * Emits are throttled to at most once per {@link TYPING_INDICATOR_THROTTLE_MS}
   * per peer while `isTyping` stays true, so a fast typist doesn't flood the
   * socket; the final `isTyping: false` (composer cleared/blurred) always
   * goes out immediately so the peer's indicator doesn't linger.
   *
   * @param {string} peerId
   * @param {boolean} isTyping
   */
  const sendTypingIndicator = useCallback((peerId, isTyping) => {
    const trimmedPeerId = (peerId ?? '').trim();
    if (!trimmedPeerId) return;
    const socket = socketRef.current;
    if (!socket?.connected) return;

    const now = Date.now();
    if (isTyping) {
      const lastSentAt = typingSentAtRef.current[trimmedPeerId] ?? 0;
      if (now - lastSentAt < TYPING_INDICATOR_THROTTLE_MS) return;
    }
    typingSentAtRef.current[trimmedPeerId] = now;

    socket.emit('message.typing', {
      version: SIGNALING_VERSION,
      recipientId: trimmedPeerId,
      isTyping: Boolean(isTyping),
    });
  }, []);

  /** Sum of unreadCount across every conversation; drives the tab badge. */
  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations],
  );

  // can show whether the callee is online before the user presses Call.
  useEffect(() => {
    const trimmedId = calleeId.trim();
    if (!trimmedId) {
      calleePresenceRequestIdRef.current += 1;
      setCalleePresence(null);
      return undefined;
    }
    let cancelled = false;
    const requestId = calleePresenceRequestIdRef.current + 1;
    calleePresenceRequestIdRef.current = requestId;
    const timer = setTimeout(async () => {
      const presence = await checkPresence(trimmedId);
      if (!cancelled && calleePresenceRequestIdRef.current === requestId) {
        setCalleePresence(presence);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [calleeId, checkPresence]);

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
    [signalingUrl],
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

    const shown = await displayIncomingCall({
      callId: call.callId,
      callerId: call.callerId,
    }).catch(error => {
      logWarn('[CallFlow] displayIncomingCall failed', {
        message: error?.message,
      });
      return false;
    });

    logInfo('[CallFlow] Incoming-call UI result', {
      callId: call.callId,
      shown,
    });

    if (!shown) {
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

  // ─── Session management ───────────────────────────────────────────────────

  const createOrGetSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    const trimmedUrl = signalingUrl.trim();
    const trimmedVerificationCode = normalizeVerificationCode(verificationCodeRef.current);
    // Reuse this install's device id so the server keeps a single device record
    // (and a single push registration) instead of minting a new random one on
    // every session.
    if (!deviceIdRef.current) {
      deviceIdRef.current = await loadDeviceId();
    }
    const requestBody = {
      userId: userId.trim() || undefined,
      deviceId: deviceIdRef.current,
      platform: Platform.OS,
    };
    if (trimmedVerificationCode) {
      requestBody.verificationCode = trimmedVerificationCode;
    }
    const response = await fetch(`${trimmedUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      if (response.status === 409 && errorPayload?.code === 'identity_conflict') {
        updateStatus(
          'This username is already claimed. Sign out and choose another username, or enter the recovery code.',
          'error',
        );
      }
      throw new Error(`Session creation failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    sessionIdRef.current = data.sessionId;
    logInfo('[CallFlow] Session created', {
      sessionId: data.sessionId,
      userId: data.userId,
    });
    return data.sessionId;
  }, [updateStatus, signalingUrl, userId]);

  /**
   * Refresh the current session via `POST /session/refresh`, rotating the
   * sessionId. On success the new id is stored in `sessionIdRef`; on failure the
   * stale id is cleared so the next request mints a fresh session. Never throws.
   *
   * @returns {Promise<string | null>} the new sessionId, or `null` on failure
   */
  const refreshSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const trimmedUrl = (signalingUrl ?? '').trim();
    if (!sessionId || !trimmedUrl) return null;
    try {
      const response = await fetch(`${trimmedUrl}/session/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) {
        // The session is gone (e.g. server restart with in-memory store, or TTL
        // expiry): drop it so the next authed request creates a new session.
        sessionIdRef.current = null;
        logWarn('[CallFlow] session refresh failed', {
          status: response.status,
        });
        return null;
      }
      const data = await response.json();
      sessionIdRef.current = data.sessionId;
      logInfo('[CallFlow] Session refreshed', { sessionId: data.sessionId });
      return data.sessionId;
    } catch (error) {
      logWarn('[CallFlow] session refresh threw', { message: error?.message });
      return null;
    }
  }, [signalingUrl]);

  /**
   * Perform an authenticated request with automatic 401 recovery. `buildRequest`
   * receives the current sessionId and returns `{ url, options? }`. On a 401 the
   * session is refreshed (or recreated) once and the request is retried with the
   * new id. Returns the `Response` (possibly still 401), or `null` when no
   * session could be established. Never throws on refresh; fetch errors
   * propagate to the caller's existing try/catch.
   *
   * @param {(sessionId: string) => { url: string, options?: object }} buildRequest
   * @returns {Promise<Response | null>}
   */
  const authedFetch = useCallback(
    async buildRequest => {
      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        sessionId = await createOrGetSession().catch(() => null);
      }
      if (!sessionId) return null;

      let request = buildRequest(sessionId);
      let response = await fetch(request.url, request.options);

      if (response.status === 401) {
        // Session expired or was invalidated server-side: refresh once and retry.
        const refreshedId = await refreshSession();
        const nextId = refreshedId || (await createOrGetSession().catch(() => null));
        if (!nextId) return response;
        request = buildRequest(nextId);
        response = await fetch(request.url, request.options);
      }

      return response;
    },
    [createOrGetSession, refreshSession],
  );

  // Expose authedFetch through a ref for helpers defined earlier in the hook.
  useEffect(() => {
    authedFetchRef.current = authedFetch;
  }, [authedFetch]);

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
    Object.values(typingTimeoutsRef.current).forEach(clearTimeout);
    typingTimeoutsRef.current = {};
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
        if (!message?.senderId) return;
        const senderId = message.senderId;

        setMessagesByPeer(prev => {
          const existing = prev[senderId] ?? [];
          if (existing.some(m => m.messageId === message.messageId)) {
            return prev;
          }
          return { ...prev, [senderId]: [message, ...existing] };
        });

        if (activeChatPeerIdRef.current === senderId) {
          // The conversation is currently open: auto-mark-read, no unread bump.
          markConversationRead(senderId).catch(() => {});
          return;
        }

        setConversations(prev => {
          const index = prev.findIndex(c => c.peerId === senderId);
          if (index === -1) {
            // Brand-new conversation: refetch the authoritative list.
            fetchConversations();
            return prev;
          }
          const next = [...prev];
          next[index] = {
            ...next[index],
            lastMessage: message,
            unreadCount: (next[index].unreadCount || 0) + 1,
          };
          return next;
        });
      });

      socket.on('message.delivered', ({ message }) => {
        if (!message?.recipientId) return;
        const peerId = message.recipientId;
        setMessagesByPeer(prev => {
          const existing = prev[peerId] ?? [];
          if (existing.some(m => m.messageId === message.messageId)) {
            return prev;
          }
          return { ...prev, [peerId]: [message, ...existing] };
        });
      });

      socket.on('message.read', ({ readerId, readAt }) => {
        if (!readerId) return;
        // `readerId` is the peer who just read our messages; messagesByPeer
        // is keyed by the other participant regardless of send direction, so
        // it doubles as the lookup key here.
        setMessagesByPeer(prev => {
          const existing = prev[readerId];
          if (!existing) return prev;
          let changed = false;
          const updated = existing.map(m => {
            if (m.senderId === userId && !m.readAt) {
              changed = true;
              return { ...m, readAt: readAt ?? new Date().toISOString() };
            }
            return m;
          });
          return changed ? { ...prev, [readerId]: updated } : prev;
        });
      });

      socket.on('message.typing', ({ senderId, isTyping }) => {
        if (!senderId) return;
        clearTimeout(typingTimeoutsRef.current[senderId]);
        setTypingByPeer(prev => ({ ...prev, [senderId]: Boolean(isTyping) }));
        if (isTyping) {
          // Safety net: auto-clear if a "stopped typing" event never arrives.
          typingTimeoutsRef.current[senderId] = setTimeout(() => {
            setTypingByPeer(prev => ({ ...prev, [senderId]: false }));
          }, TYPING_INDICATOR_TIMEOUT_MS);
        }
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
        connectErrorCountRef.current = 0;
        setIsServerUnreachable(false);
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
        connectErrorCountRef.current += 1;
        if (connectErrorCountRef.current >= OFFLINE_ERROR_THRESHOLD) {
          setIsServerUnreachable(true);
        }
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
      markConversationRead,
      fetchConversations,
      userId,
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
  }, [connectSocket, createOrGetSession, disconnectSocket, signalingUrl, userId]);

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
  }, [userId, signalingUrl, refreshSession, updateStatus]);

  /**
   * Manually retry the presence socket connection when the server appears
   * unreachable.  Resets the offline indicator, creates a fresh session, and
   * reconnects the socket.
   */
  const retryPresenceConnect = useCallback(async () => {
    if (!userId.trim() || !signalingUrl.trim()) return;
    setIsServerUnreachable(false);
    connectErrorCountRef.current = 0;
    sessionIdRef.current = null;
    try {
      const sessionId = await createOrGetSession();
      connectSocket(sessionId);
    } catch (error) {
      logWarn('[CallFlow] retryPresenceConnect failed', {
        message: error?.message,
      });
      setIsServerUnreachable(true);
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
  }, [endActiveCall, ensurePeerConnection, incomingCall, updateStatus, startLocalPreview]);

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
    userId,
    verificationCode,
    setUserId,
    editUserId,
    isRegistered,
    isLoadingIdentity,
    pendingVerificationCode,
    dismissVerificationCodeNotice,
    registerUser,
    unregisterUser,
    updateUserId,
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
    calleePresence,
    checkPresence,
    searchUsers,
    isServerUnreachable,
    retryPresenceConnect,

    // Call history
    callHistory,
    missedCallCount,
    markMissedCallsRead,
    fetchCallHistory,

    // Chat
    conversations,
    messagesByPeer,
    unreadTotal,
    activeChatPeerId,
    setActiveChatPeerId,
    fetchConversations,
    fetchMessagesForPeer,
    sendMessage,
    markConversationRead,
    typingByPeer,
    sendTypingIndicator,
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
