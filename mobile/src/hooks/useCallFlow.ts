import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { logError, logInfo, logVerbose, logWarn } from '../appLogger';
import {
  CALL_EVENTS,
  CALL_STATES,
  INITIAL_CALL_STATE,
  callStateReducer,
} from '../call/callStateMachine';
import * as Telemetry from '../telemetry';
import { emitEvent } from '../observability';
import { stopCallService } from '../callService';
import useAttachments from './useAttachments';
import useCallAudioRouting from './useCallAudioRouting';
import useConnectionQuality from './useConnectionQuality';
import useLocalMedia from './useLocalMedia';
import usePeerConnection from './usePeerConnection';
import useSignalingSocket from './useSignalingSocket';
import useAnswerPath from './useAnswerPath';
import useBlocks from './useBlocks';
import useCallHistory, { DEFAULT_CALL_MEDIA_TYPE } from './useCallHistory';
import useCompactCallView from './useCompactCallView';
import useIdentity from './useIdentity';
import useMessaging from './useMessaging';
import usePresenceSearch from './usePresenceSearch';
import useSession from './useSession';
import useStartupPermissions from './useStartupPermissions';
import { CALL_END_REASON_LABELS } from '../callUx';
import { triggerHaptic } from '../haptics';
import { shouldShowPermissionPrimer } from '../permissionsPrimer';
import {
  addCallLinkListener,
  getInitialCallLink,
  registerForPushNotifications,
  unregisterPushToken,
} from '../pushNotifications';
import { CLIENT_EVENTS, createSignalingClient } from '../signalingClient';
import { ERROR_CODES } from '../../../shared';
import { SIGNALING_VERSION } from '../socketProtocol';
import {
  ICE_TRANSPORT_POLICIES,
  prefetchIceServersForCall,
  applyBitrateConstraints,
  normalizeIceTransportPolicy,
} from '../webrtcConfig';
import type { RecoveryPauseReason, RecoveryTrigger } from '../call/recoveryEpisode';
import {
  buildCallEndSummary,
  callDurationSeconds,
  callPeerId,
  describeCallStateEnding,
  describeDialBlocked,
  evaluateCallOnAnotherDevice,
  isLiveCallStatus,
  isMissedCall,
  resolveOutgoingCallee,
  resolveCallEndReason,
  shouldSummariseCall,
} from '../call/callDecisions';
import type {
  CallDelivery,
  CallElsewhere,
  CallEndSummary,
  DeviceOwnedCall,
} from '../call/callDecisions';
import {
  SESSION_REFRESH_FAILED_MESSAGE,
  SESSION_REFRESH_INTERVAL_MS,
  parseCallStateReportAck,
  shouldScheduleSessionRefresh,
  shouldTearDownAfterResync,
} from '../call/sessionLifecycle';
import {
  classifyLookupFailure,
  describeRehydratedCall,
  isRehydratableCallId,
  shouldDeferRehydration,
} from '../call/pushRehydration';
import type { RehydrationOutcome } from '../call/pushRehydration';
import { buildCallActionUrl, buildCallLookupUrl } from '../call/callEndpoints';
import type { CallAction } from '../call/callEndpoints';
import { bearerAuthHeaders } from '../authHeaders';
import useScreenShare from './useScreenShare';
import useCallHeartbeat from './useCallHeartbeat';
import useCallRecovery from './useCallRecovery';
import type { CallMediaType } from '../settingsStorage';
import type { CallRecord } from '../../../shared/signaling/schemas';
import type { CallStatus } from '../components/StatusBanner';
import type { CallActivity } from '../messaging/types';
import type { Socket } from 'socket.io-client';
import type { IceTransportPolicy } from '../webrtcConfig';
import type { ReplaceOutgoingVideoTrack, WebrtcMediaStream } from './usePeerConnection';
import { errorMessage } from '../errors';
import { endAnswerTimeline } from '../call/answerTimeline';
import { clearPendingAnswer, displayIncomingCall, endCall as endCallKeepCall } from '../callKeep';
import { startIncomingRingtone, stopIncomingRingtone } from '../ringtone';
import { shouldVibrateForRing } from '../ringerMode';

export type { CallRecord };
export type {
  PeerConnection,
  PeerIceCandidateEvent,
  PeerTrackEvent,
  WebrtcMediaStream,
} from './usePeerConnection';

/**
 * An accept failure annotated with the canonical reason reported to the server,
 * and — when the server named one — its own error code.
 */
export type AnswerError = Error & { answerFailureReason?: string; code?: string | null };
export type { CallStatus };

function callTimelineStatus(call: CallRecord): string {
  return call.status === 'ended' && call.endReason === 'cancelled' ? 'cancelled' : call.status;
}

function projectCallTimelineActivity(
  call: CallRecord | null | undefined,
  userId: string | null | undefined,
  durationSeconds?: number | null,
): { peerId: string; activity: CallActivity } | null {
  if (!call?.callId) return null;
  const peerId = callPeerId(call, userId ?? '');
  if (!peerId) return null;
  return {
    peerId,
    activity: {
      type: 'call',
      callId: call.callId,
      direction: call.callerId === userId ? 'outgoing' : 'incoming',
      status: callTimelineStatus(call),
      endReason: call.endReason ?? null,
      durationSeconds:
        durationSeconds ?? (call as { durationSeconds?: number | null }).durationSeconds ?? null,
      createdAt: call.createdAt ?? new Date().toISOString(),
    },
  };
}

const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';

export const MEDIA_STATE_RELAY_DEBOUNCE_MS = 100;

/**
 * How long peer-connection setup will wait for a session to be minted before
 * giving up on TURN credentials. TURN is worth a short wait; a stalled network
 * must never stall the call itself.
 */
const ICE_SESSION_WAIT_MS = 5000;

/**
 * How long a placement waits for the server to confirm it reconciled this
 * device's call state. The ack is only sent on success, so a failed report
 * must not leave the user's call attempt hanging on it forever.
 */
const CALL_STATE_REPORT_ACK_TIMEOUT_MS = 2000;

// How long the answer path waits for a socket, how many times it retries over
// one, which HTTP failures mean what, how a media-less answer describes itself
// and what becomes of an answer queued before this hook knew the call all live
// in `call/answerPath.ts` — facts in, decision out.

// Which statuses mean a call is live or terminal, whether a tap is a duplicate
// accept, what an offer collision means, and how a finished call describes
// itself now live in `call/callDecisions.ts` — facts in, decision out, so each
// rule is a unit test rather than something reachable only by mounting this
// hook.

// Backoff, glare tie-break and precondition-retry timing for the ICE-restart
// ladder now live in `call/iceRestartLadder.ts`, alongside the rules that use
// them, so both can be unit-tested without mounting this hook.

/**
 * What prompted an ICE restart or opened a recovery episode; carried into every
 * log line about it.
 *
 * Shared with `call/recoveryEpisode.ts` so a trigger means the same thing to
 * the ladder and to the budget it runs against.
 */
type IceRestartTrigger = RecoveryTrigger;

/**
 * What the UI is told about an in-progress recovery.
 *
 * A media-only failure (ICE down, socket up — the common TURN-path case) used
 * to show no banner at all, and the banner that did show for socket loss never
 * said that the wait was bounded.
 */
export type CallRecoveryStatus = {
  trigger: IceRestartTrigger;
  attempts: number;
  remainingMs: number;
  isPaused: boolean;
  pauseReason: RecoveryPauseReason | null;
  /**
   * Whether a rung of the ladder is queued or in flight right now.
   *
   * The banner hides its manual "Retry" while one is: a button that duplicates
   * work already underway teaches the user that pressing it does nothing.
   */
  isAttemptPending: boolean;
};

/**
 * Re-exported from `call/callDecisions` so existing importers keep working;
 * they live there because the rules that build and classify them need no React.
 */
export type { CallDelivery, CallEndSummary };

// Session rotation timing, the re-mint budget and how a `call.state.report`
// ack is read now live in `call/sessionLifecycle.ts`, next to the rules that
// use them.

/**
 * Call phases that drive which screen the UI renders.  Alias of the state
 * machine's `CALL_STATES` (see `src/call/callStateMachine`), kept under the
 * historical name for the hook's consumers.
 *
 * idle             – no active call; show the tabs
 * outgoing_ringing – caller placed a call, waiting for callee to answer
 * incoming_ringing – callee received a call, waiting for user action
 * in_call          – call accepted and media connected
 * ended            – transient terminal state; teardown then returns to idle
 */
export const CALL_PHASES = CALL_STATES;

/**
 * English display strings for server-side `endReason` codes.
 *
 * Re-exported from `callUx` so existing importers keep working; it lives there
 * because the call log's pure helpers need it without the WebRTC stack.
 */
export { CALL_END_REASON_LABELS };

/**
 * Tell the server which calls this device still considers live, and hear back
 * which ones it holds.
 *
 * Two callers: a `busy` rejection (a call the server thinks is in progress but
 * no client is holding is a phantom the server closes out on hearing this),
 * and every reconnect — after which neither side used to confirm the other's
 * view, so a client could keep rendering a call the server had already ended.
 *
 * @param options.reason - why the report was sent; logged.
 * @param options.onServerState - called with the server's own answer.
 */
function reportOwnCallState(
  signaling: ReturnType<typeof createSignalingClient>,
  activeCallIds: string[],
  options: {
    reason?: string;
    onServerState?: (state: { clearedCallIds: string[]; activeCallIds: string[] | null }) => void;
  } = {},
) {
  logInfo('[CallFlow] Reporting own call state', {
    activeCallIds,
    reason: options.reason ?? 'busy-rejection',
  });
  signaling.emit(
    CLIENT_EVENTS.CALL_STATE_REPORT,
    { version: SIGNALING_VERSION, activeCallIds },
    ack => {
      const report = parseCallStateReportAck(ack);
      if (!report) {
        logWarn('[CallFlow] call.state.report ack failed', ack?.error);
        return;
      }
      logInfo('[CallFlow] Server call state', {
        clearedCallIds: report.clearedCallIds,
        serverCallIds: report.activeCallIds,
      });
      options.onServerState?.(report);
    },
  );
}

/**
 * `reportOwnCallState`, awaited.
 *
 * The report is a fire-and-forget emit whose ack is only delivered on success,
 * so a caller that must not act until the server has reconciled needs both the
 * ack and a bound on waiting for one.
 */
function reportOwnCallStateAsync(
  signaling: ReturnType<typeof createSignalingClient>,
  activeCallIds: string[],
  reason: string,
): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logWarn('[CallFlow] call.state.report ack timed out', { reason });
      settle();
    }, CALL_STATE_REPORT_ACK_TIMEOUT_MS);
    reportOwnCallState(signaling, activeCallIds, { reason, onServerState: settle });
  });
}

/**
 * Whether a rejection is the server refusing to place a call because this user
 * is already in one.
 *
 * Read structurally rather than by class so a rejection that crossed a module
 * or test boundary is still recognised for what it is.
 */
function isCallInProgressRejection(error: unknown): boolean {
  return (error as { code?: unknown })?.code === ERROR_CODES.CALL_IN_PROGRESS;
}

/**
 * What to tell the user when a placement fails.
 *
 * "Already in a call" is only useful with the peer's name attached, which the
 * rejection itself does not carry — the device knows it from the call events it
 * has been receiving all along.
 */
function describePlacementFailure(error: unknown, callElsewhere: CallElsewhere | null): string {
  if (!isCallInProgressRejection(error)) {
    return `Failed to place call: ${errorMessage(error)}`;
  }
  return callElsewhere
    ? `You are in a call with ${callElsewhere.peerId} on another device`
    : 'You are already in a call';
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

  const [activeCall, setActiveCall] = useState(null as CallRecord | null);

  const [incomingCall, setIncomingCall] = useState(null as CallRecord | null);

  // A call this user is on, on one of their *other* devices. Every call event
  // reaches every device of a participant, so this device knows about the
  // conversation without being part of it — and must say so rather than
  // silently refusing to dial.
  const [callElsewhere, setCallElsewhere] = useState(null as CallElsewhere | null);

  // callId received from a push-notification deep link before the user identity
  // is fully established.  Cleared once rehydration is attempted.
  const [pendingPushCallId, setPendingPushCallId] = useState(null as string | null);

  // True from the moment `placeCall` is invoked until the call reaches
  // OUTGOING_RINGING (or fails). Lets chat-header call buttons show a brief
  // loading state instead of appearing to do nothing while the local camera
  // preview starts and the socket/`call.initiate` round-trip completes.
  const [isPlacingCall, setIsPlacingCall] = useState(false);

  // ─── UI state ─────────────────────────────────────────────────────────────
  // Raw state setter; callers use the `updateStatus(message, severity)` helper
  // declared below rather than setting the shape by hand.
  const [status, setStatus] = useState({ message: '', severity: 'info' } as CallStatus);
  // Summary of the last connected call, surfaced by the conversation timeline.
  const [callSummary, setCallSummary] = useState(null as CallEndSummary | null);

  // True while the remote participant is screen-sharing (relayed via the
  // `call.media-state` socket event).
  const [isRemoteScreenSharing, setIsRemoteScreenSharing] = useState(false);
  // Whether the remote participant's camera is on, relayed over the same
  // event. Defaults to `true` because that is what an older peer — one that
  // never sends the flag — effectively claims, and because a video call starts
  // with both cameras live. `track.enabled = false` neither removes the track
  // nor tells the peer anything, so this relay is the only way the receiving
  // side can distinguish "a picture" from "a black rectangle".
  const [isRemoteVideoEnabled, setIsRemoteVideoEnabled] = useState(true);

  // ─── Media / WebRTC state ─────────────────────────────────────────────────
  const [remoteStream, setRemoteStream] = useState(null as WebrtcMediaStream | null);
  const [isMuted, setIsMuted] = useState(false);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  /**
   * Epoch milliseconds at which the current call connected, or `null`.
   *
   * Published instead of a ticking `elapsedCallSeconds` so this hook's result —
   * and therefore the call/chat context identity derived from it — changes
   * exactly twice per call rather than once per second. Components that show a
   * duration derive it locally with `useCallElapsedSeconds`.
   */
  const [callConnectedAtMs, setCallConnectedAtMs] = useState(null as number | null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Non-null while a recovery episode is open, so the call screen can show what
  // is happening (and how much budget is left) instead of a static spinner.
  const [recoveryStatus, setRecoveryStatus] = useState(null as CallRecoveryStatus | null);
  // True from the moment the recovery budget is spent with media still down,
  // until the call is torn down. The ladder ending used to be invisible: the
  // banner vanished with the episode and the call simply stopped.
  const [isConnectionLost, setIsConnectionLost] = useState(false);
  const isConnectionLostRef = useRef(false);
  const markCallConnectedRef = useRef(() => {});
  const reportCallConnectedBridgeRef = useRef((_state: string) => {});
  const noteRecoverySymptomBridgeRef = useRef((_trigger: RecoveryTrigger, _state?: string) => {});
  const beginIceRecoveryBridgeRef = useRef((_trigger: RecoveryTrigger) => {});
  const cancelIceRestartsBridgeRef = useRef((_reason: string) => {});
  const replaceOutgoingVideoTrackRef = useRef(null as ReplaceOutgoingVideoTrack | null);
  // How the callee is being reached for an outgoing call: a device that can
  // ring now, or one a push still has to wake. Null until the server says.
  const [callDelivery, setCallDelivery] = useState(null as CallDelivery | null);

  // ─── Refs ─────────────────────────────────────────────────────────────────
  const socketRef = useRef(null as Socket | null);
  // Typed wrapper around `socketRef.current`: validates every payload against
  // the shared contract and queues fire-and-forget emits while offline.
  const signalingRef = useRef(null as ReturnType<typeof createSignalingClient> | null);
  const activeCallIdRef = useRef(null as string | null);
  const isCallerRef = useRef(false);
  // Synchronous mirror of isPlacingCall so `placeCall` can guard re-entrancy
  // (rapid double-tap) without waiting for the state update to flush.
  const isPlacingCallRef = useRef(false);
  const callConnectedAtRef = useRef(null as number | null);
  // Guards against re-emitting `call.connected` for the same call (both ICE
  // and connection-state callbacks fire, often more than once).
  const connectedReportedCallIdRef = useRef(null as string | null);
  const detachManagerPingRef = useRef(null as (() => void) | null);
  // Set below; the socket `connect` handler reconciles this device's calls with
  // the server's before anything queued offline is replayed.
  const resyncCallStateRef = useRef(null as (() => void) | null);
  // Mirrors `isScreenSharing` so the heartbeat can carry the current flag
  // without re-creating the timer on every toggle.
  const isScreenSharingRef = useRef(false);
  const mediaStateRelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionQualityRef = useRef({ bars: 0, label: 'No link' });
  const isInCallRef = useRef(false);
  // ICE candidates that arrive before the remote description is applied are
  // buffered here and flushed once setRemoteDescription succeeds.
  // Refs that mirror activeCall / incomingCall state for use in any callback
  // where capturing the value via a React closure would otherwise be stale.
  const activeCallRef = useRef(null as CallRecord | null);
  const incomingCallRef = useRef(null as CallRecord | null);
  const callElsewhereRef = useRef(null as CallElsewhere | null);
  // Tracks callIds for which the incoming-call UI has already been shown so
  // duplicate socket or push events never trigger a second CallKeep display.
  const displayedIncomingCallIdsRef = useRef(new Set() as Set<string>);
  const recordTimelineCallRef = useRef(
    (_call: CallRecord | null | undefined, _durationSeconds?: number | null) => {},
  );
  const refreshCallTimelineRef = useRef(() => {});
  // Answer bookkeeping. The same tap can reach `acceptIncomingCall` through
  // several paths at once (CallKeep event, replayed queue entry, in-app
  // button), and a second accept for a call that is already up fails
  // server-side — so each callId is accepted at most once.
  const acceptInFlightCallIdRef = useRef(null as string | null);
  const answeredCallIdsRef = useRef(new Set<string>());
  // callIds whose queued answer has already been replayed, so the replay effect
  // stays a no-op when `acceptIncomingCall`'s identity changes.
  const replayedAnswerCallIdsRef = useRef(new Set() as Set<string>);

  const updateStatus: (message: string, severity?: CallStatus['severity']) => void = useCallback(
    (message, severity = 'info') => {
      logVerbose('[CallFlow] Status updated', { message, severity });
      setStatus({ message, severity });
    },
    [],
  );

  // ─── Composed sub-hooks (identity / session / history / presence / chat) ──
  // Each owns a single, cohesive concern and is unit-testable in isolation;
  // this hook wires them together and layers the call-signaling/WebRTC
  // orchestration that ties them into one coherent call experience.
  const identity = useIdentity(updateStatus);
  const { userId, unregisterUser: identityUnregisterUser } = identity;
  // The tie-break compares userIds inside callbacks that must not be rebuilt
  // whenever the identity re-renders.
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  const session = useSession({
    signalingUrl,
    userId,
    updateStatus,
  });
  const {
    sessionIdRef,
    deviceIdRef,
    authedFetchRef,
    createOrGetSession,
    refreshSession,
    authedFetch,
    verifyIdentity,
  } = session;

  // `useIdentity` runs before `useSession` and knows nothing about it, so the
  // verifier is handed over through the ref it exposes for the purpose — the
  // same seam, and the same effect-driven hand-off, as `authedFetchRef`.
  const { verifyIdentityRef } = identity;
  useEffect(() => {
    verifyIdentityRef.current = verifyIdentity;
  }, [verifyIdentityRef, verifyIdentity]);

  const callHistory = useCallHistory({
    authedFetchRef,
    sessionIdRef,
    signalingUrl,
    userId,
    storageUserId: identity.isRegistered ? identity.authUser?.uid ?? '' : '',
  });

  const blocks = useBlocks({
    authedFetchRef, sessionIdRef, signalingUrl, userId: identity.isRegistered ? identity.authUser?.uid ?? '' : '',
  });
  const { fetchBlocks } = blocks;
  const { addToHistory, fetchCallHistory: refreshCallHistory } = callHistory;

  /**
   * Modality the local user asked for when placing the *next* outgoing call.
   *
   * There is no audio-only call type on the wire, so this intent is the only
   * place the distinction exists; it is stamped onto the history entry at
   * teardown so the call log can show the right type icon and redial in the
   * same modality. Incoming calls keep the default, since the local user never
   * chose one.
   */
  const outgoingCallMediaTypeRef = useRef(DEFAULT_CALL_MEDIA_TYPE as CallMediaType);
  const setOutgoingCallMediaType = useCallback((mediaType: CallMediaType) => {
    outgoingCallMediaTypeRef.current = mediaType;
  }, []);

  const presenceSearch = usePresenceSearch({
    signalingUrl,
    authedFetchRef,
    sessionIdRef,
    calleeId,
    userId: identity.isRegistered ? identity.authUser?.uid ?? '' : '',
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
    storageUserId: identity.isRegistered ? identity.authUser?.uid ?? '' : '',
    updateStatus,
  });
  const {
    activeChatPeerId,
    fetchConversations,
    markConversationRead,
    recordCallActivity,
    resetTypingState,
    handleMessageReceived,
    handleMessageDeleted,
    handleMessageReaction,
    handleMessageDelivered,
    handleMessageRead,
    handleTypingEvent,
    handleSocketConnected: handleMessagingConnected,
    handleSocketDisconnected,
  } = messaging;
  const handleSocketConnected = useCallback(() => {
    handleMessagingConnected();
    void refreshCallHistory();
  }, [handleMessagingConnected, refreshCallHistory]);

  const resetTypingStateRef = useRef(resetTypingState);
  useEffect(() => {
    resetTypingStateRef.current = resetTypingState;
  }, [resetTypingState]);

  useEffect(() => {
    recordTimelineCallRef.current = (call, durationSeconds) => {
      const projected = projectCallTimelineActivity(call, userIdRef.current, durationSeconds);
      if (projected) recordCallActivity(projected.peerId, projected.activity);
    };
    refreshCallTimelineRef.current = () => {
      void fetchConversations();
      void refreshCallHistory();
    };
  }, [fetchConversations, recordCallActivity, refreshCallHistory]);

  const attachments = useAttachments({
    authedFetchRef,
    signalingUrl,
    beginAttachmentUpload: messaging.beginAttachmentUpload,
    updateAttachmentUploadProgress: messaging.updateAttachmentUploadProgress,
    finishAttachmentUpload: messaging.finishAttachmentUpload,
    failAttachmentUpload: messaging.failAttachmentUpload,
    updateStatus,
  });

  const {
    handleCameraSwitch,
    handleVideoToggle,
    isFrontCamera,
    isVideoEnabled,
    localStream,
    localStreamRef,
    releaseLocalMedia,
    setLocalStream,
    startLocalPreview,
  } = useLocalMedia({
    replaceOutgoingVideoTrackRef,
    setIsMuted,
    updateStatus,
  });

  const isInCall = callPhase === CALL_PHASES.IN_CALL;
  const { isRegistered } = identity;
  const { audioDevices, chooseAudioOutput, handleMuteToggle, isSpeakerEnabled, resetAudioRouting } =
    useCallAudioRouting({
      isInCall,
      isInCallRef,
      isMuted,
      localStreamRef,
      setIsMuted,
      speakerEnabledByDefault,
      updateStatus,
    });

  // Closing the Picture-in-Picture window must end the call: leaving it running
  // invisibly gives the user no way back to it and no way to hang up. The mute
  // and hang-up controls the window itself offers are routed back here too —
  // they are drawn by the system, since a PiP window cannot deliver touches to
  // the app's own views.
  const { isCompactView, setIsCompactView } = useCompactCallView(isInCallRef, {
    onPictureInPictureClosed: () => endActiveCallRef.current?.('Call ended', 'info', 'ended'),
    onToggleMute: () => handleMuteToggleRef.current?.(),
    onEndCall: () => {
      handleEndCallRef.current?.().catch(error =>
        logWarn('[CallFlow] Picture-in-Picture hang up failed', {
          message: errorMessage(error),
        }),
      );
    },
    isMuted,
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
  // return the machine to `idle` (which is what the tab shell renders from).
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

  /**
   * The session id TURN credentials are minted against.
   *
   * `sessionIdRef` is populated asynchronously by `createOrGetSession`, and a
   * call answered from a background push builds its peer connection about a
   * second after rehydration — early enough to read a null ref and fetch no
   * TURN credentials at all, leaving the call with a STUN-only ICE list. So
   * the session is *ensured* here rather than read optimistically; a failure
   * still degrades (never blocks) call setup, and says why.
   */
  const ensureIceSessionId = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const minted = createOrGetSession().catch(error => {
      logWarn('[CallFlow] Session mint failed; ICE will have no TURN servers', {
        message: errorMessage(error),
      });
      return null;
    });
    const deadline = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), ICE_SESSION_WAIT_MS);
    });

    try {
      const sessionId = await Promise.race([minted, deadline]);
      if (!sessionId) {
        logWarn('[CallFlow] No session id for TURN credentials', {
          waitedMs: ICE_SESSION_WAIT_MS,
        });
      }
      return sessionId ?? null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [createOrGetSession, sessionIdRef]);

  const { startCallHeartbeat, stopCallHeartbeat, wakeCallHeartbeat } = useCallHeartbeat({
    activeCallIdRef,
    socketRef,
    signalingRef,
    isScreenSharingRef,
  });

  const {
    closePeerConnection,
    ensurePeerConnection,
    iceCandidateBufferRef,
    isNegotiatingRef,
    peerConnectionRef,
    replaceOutgoingVideoTrack,
    remoteStreamRef,
    renegotiate,
  } = usePeerConnection({
    activeCallIdRef,
    activeIceTransportPolicy,
    isCallerRef,
    localStreamRef,
    signalingRef,
    signalingUrl,
    socketRef,
    setRemoteStream,
    ensureIceSessionId,
    updateStatus,
    recoveryCallbacks: {
      markCallConnected: markCallConnectedRef,
      reportCallConnected: reportCallConnectedBridgeRef,
      noteRecoverySymptom: noteRecoverySymptomBridgeRef,
      beginIceRecovery: beginIceRecoveryBridgeRef,
      cancelIceRestarts: cancelIceRestartsBridgeRef,
    },
  });

  useEffect(() => {
    replaceOutgoingVideoTrackRef.current = replaceOutgoingVideoTrack;
  }, [replaceOutgoingVideoTrack]);

  const {
    isScreenSharing,
    isTogglingScreenShare,
    isScreenAudioShared,
    isScreenAudioEnabled,
    screenShareDelivery,
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

  const { connectionQuality, selectedCandidatePair } = useConnectionQuality({
    activeCallIdRef,
    activeIceTransportPolicy,
    isInCall,
    peerConnectionRef,
    remoteStreamRef,
    updateStatus,
  });
  useEffect(() => {
    connectionQualityRef.current = connectionQuality;
  }, [connectionQuality]);

  const {
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
  } = useCallRecovery({
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
    sessionIdRef,
    signalingUrl,
    activeIceTransportPolicy,
    ensureIceSessionId,
    startCallHeartbeat,
    setRecoveryStatus,
    setIsReconnecting,
    setIsConnectionLost,
  });

  const markCallConnected = useCallback(() => {
    if (callConnectedAtRef.current) return;
    triggerHaptic('connect');
    callConnectedAtRef.current = Date.now();
    if (activeCallIdRef.current) {
      Telemetry.trackCallConnected(activeCallIdRef.current);
    }
    setCallConnectedAtMs(callConnectedAtRef.current);

    // Apply bitrate caps now that media is flowing; best-effort.
    const pc = peerConnectionRef.current;
    if (pc) {
      applyBitrateConstraints(pc).catch(() => {});
    }
  }, [peerConnectionRef]);

  useEffect(() => {
    markCallConnectedRef.current = markCallConnected;
  }, [markCallConnected]);

  useEffect(() => {
    reportCallConnectedBridgeRef.current = reportCallConnected;
    noteRecoverySymptomBridgeRef.current = noteRecoverySymptom;
    beginIceRecoveryBridgeRef.current = beginIceRecovery;
    cancelIceRestartsBridgeRef.current = cancelIceRestarts;
  }, [beginIceRecovery, cancelIceRestarts, noteRecoverySymptom, reportCallConnected]);

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
    async (call: { callId: string; callerId?: string | null }) => {
      if (!call?.callId) return;
      if (displayedIncomingCallIdsRef.current.has(call.callId)) return;
      displayedIncomingCallIdsRef.current.add(call.callId);

      // A phone on silent must stay still as well as quiet; vibrate mode still
      // buzzes.  Reading the ringer state is a native round trip, so it never
      // gates the incoming-call UI: alerting the user comes first, the haptic
      // follows as soon as the answer arrives.
      shouldVibrateForRing()
        .then(mayVibrate => {
          if (mayVibrate) triggerHaptic('incomingRing');
        })
        .catch(error => {
          logWarn('[CallFlow] Ringer state unavailable; skipping incoming-call haptic', {
            message: errorMessage(error),
          });
        });

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
        // hears an audible alert in the foreground (unless the device ringer is
        // silent, which the fallback honours itself).
        await startIncomingRingtone();
      }
    },
    [],
  );

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
    (
      nextMessage: string = 'Call ended',
      severity: CallStatus['severity'] = 'info',
      endReason: string | null = null,
    ) => {
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
      logInfo('[CallFlow] Ringing stopped');

      const durationSeconds = callDurationSeconds(callConnectedAtRef.current, Date.now());

      const resolvedReason = resolveCallEndReason({
        isConnectionLost: isConnectionLostRef.current,
        requestedReason: endReason,
        recordEndReason: callRecord?.endReason,
      });

      if (
        shouldSummariseCall({
          hasConnected: Boolean(callConnectedAtRef.current),
          endReason: resolvedReason,
        })
      ) {
        setCallSummary(
          buildCallEndSummary({
            durationSeconds,
            qualityLabel: connectionQualityRef.current?.label,
            endReason: resolvedReason,
            isCaller,
            call: callRecord,
          }),
        );
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
        const isMissed = isMissedCall({
          endReason: resolvedReason,
          status: callRecord.status,
        });
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
          mediaType: isCaller ? outgoingCallMediaTypeRef.current : DEFAULT_CALL_MEDIA_TYPE,
        });
        recordTimelineCallRef.current(callRecord, durationSeconds);
      }

      callConnectedAtRef.current = null;
      setCallConnectedAtMs(null);
      isConnectionLostRef.current = false;
      setIsConnectionLost(false);
      setCallDelivery(null);
      stopCallHeartbeat(endReason ? `call-ended:${endReason}` : 'call-ended');
      closeRecoveryEpisode(endReason ? `call-ended:${endReason}` : 'call-ended');
      cancelIceRestartsRef.current?.('call-ended');
      connectedReportedCallIdRef.current = null;
      // A call that was accepted but never connected — the
      // `media_connect_timeout` case — would otherwise leave its answer clock
      // to be evicted silently by a later call.
      endAnswerTimeline(callRecord?.callId);

      activeCallIdRef.current = null;
      isCallerRef.current = false;
      activeCallRef.current = null;
      incomingCallRef.current = null;

      dispatchCallEvent(CALL_EVENTS.END);
      setActiveCall(null);
      setIncomingCall(null);
      setIsReconnecting(false);
      setCallConnectedAtMs(null);
      setIsCompactView(false);
      setIsLocalPrimary(false);
      resetAudioRouting();
      setIsRemoteScreenSharing(false);
      setIsRemoteVideoEnabled(true);
      resetScreenShare();
      stopCallService();
      closePeerConnection();
      releaseLocalMedia();
      if (callRecord?.callId) refreshCallTimelineRef.current();
      if (nextMessage) updateStatus(nextMessage, severity);
    },
    [
      addToHistory,
      cancelIceRestartsRef,
      closeRecoveryEpisode,
      closePeerConnection,
      releaseLocalMedia,
      resetScreenShare,
      resetAudioRouting,
      setIsCompactView,
      stopCallHeartbeat,
      updateStatus,
    ],
  );

  /**
   * Take down this device's incoming-call UI for a call another of the user's
   * devices answered.
   *
   * Deliberately *not* `endActiveCall`: the call is not over, it simply is not
   * this device's. Ending it here would write a duplicate history entry and
   * show a call-summary card for a conversation still in progress across the
   * room.
   */
  const dismissIncomingCallElsewhere = useCallback(
    (callId: string, peerId: string) => {
      logInfo('[CallFlow] Incoming call answered on another device', { callId, peerId });
      clearPendingAnswer(callId, 'answered_elsewhere');
      displayedIncomingCallIdsRef.current.delete(callId);
      endCallKeepCall(callId);
      stopIncomingRingtone();
      incomingCallRef.current = null;
      setIncomingCall(null);
      dispatchCallEvent(CALL_EVENTS.END);
      updateStatus('Answered on another device', 'info');
    },
    [updateStatus],
  );

  /**
   * Deal with a transition for a call one of this user's *other* devices
   * holds, if that is what this is.
   *
   * Every call event fans out to all of a user's devices, so an idle one sees
   * the whole lifecycle of a call it has no part in. Acting on those events is
   * what tore down a live conversation from an idle device and painted call
   * results on a screen with no call.
   *
   * @param call - the call the transition is about
   * @param eventCallId - its id, or `null` when the event named no call
   * @param knownCallId - the call *this* device is in, if any
   * @returns whether the event was consumed and must not be acted on further
   */
  const consumeForeignDeviceCallEvent = useCallback(
    (
      call: DeviceOwnedCall | null | undefined,
      eventCallId: string | null,
      knownCallId: string | null,
    ): boolean => {
      const evaluation = evaluateCallOnAnotherDevice({
        call,
        userId: userIdRef.current,
        deviceId: deviceIdRef.current,
      });
      const elsewhere = evaluation.elsewhere;
      if (elsewhere) {
        logInfo('[CallFlow] Call is held by another device of this user', elsewhere);
        callElsewhereRef.current = elsewhere;
        setCallElsewhere(elsewhere);
        // The incoming-call UI on this device is for a call it can no longer
        // answer: another device picked it up.
        if (incomingCallRef.current?.callId === elsewhere.callId) {
          dismissIncomingCallElsewhere(elsewhere.callId, elsewhere.peerId);
        }
        return true;
      }

      if (callElsewhereRef.current?.callId === eventCallId) {
        callElsewhereRef.current = null;
        setCallElsewhere(null);
      }

      // A call that ended on another of this user's devices, seen by a device
      // that was never in it. Its verdict — "Callee is busy", "Call ended" —
      // belongs on the device that placed the call, not on this one's idle
      // screen. `knownCallId` is the test for "was never in it": a device still
      // ringing for this call keeps the verdict, so the ring always stops.
      if (!knownCallId && evaluation.isOwnedByAnotherDevice) {
        logInfo("[CallFlow] Ignoring a transition for another device's call", {
          callId: eventCallId,
        });
        return true;
      }
      return false;
    },
    [deviceIdRef, dismissIncomingCallElsewhere],
  );

  // ─── Socket connection ────────────────────────────────────────────────────

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
   * Start local media and send the caller's initial RTC offer.
   *
   * The negotiation half of the `accepted` transition, lifted out of the
   * `call.state_changed` handler so that handler is dispatch and this is the
   * peer connection it drives. A failure here ends the call: an offer that was
   * never sent means media that will never arrive.
   */
  const sendInitialOffer = useCallback(
    async (signaling: ReturnType<typeof createSignalingClient>, callId: string) => {
      try {
        await startLocalPreviewRef.current?.();
        const pc = await ensurePeerConnectionRef.current?.();
        if (!pc) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signaling.emit(
          CLIENT_EVENTS.RTC_OFFER,
          {
            version: SIGNALING_VERSION,
            callId,
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
    },
    [updateStatus],
  );

  /**
   * Reconcile this device's calls with the server's after a reconnect.
   *
   * Without this neither side confirms the other's view once the socket comes
   * back: a client can keep rendering (and paying media for) a call the server
   * ended while it was away, or hold one the server has since forgotten.
   */
  const resyncCallState = useCallback(() => {
    const signaling = signalingRef.current;
    const activeCallId = activeCallIdRef.current;
    if (!signaling || !activeCallId) return;
    reportOwnCallState(signaling, [activeCallId], {
      reason: 'socket-reconnect',
      onServerState: ({ clearedCallIds, activeCallIds }) => {
        const currentCallId = activeCallIdRef.current;
        if (!currentCallId) return;
        if (!shouldTearDownAfterResync({ currentCallId, clearedCallIds, activeCallIds })) {
          logInfo('[CallFlow] Server still holds this call after reconnect', {
            callId: currentCallId,
          });
          return;
        }
        logWarn('[CallFlow] Server no longer holds this call; tearing down locally', {
          callId: currentCallId,
        });
        endActiveCallRef.current?.('Call ended', 'info', 'ended');
      },
    });
  }, []);

  useEffect(() => {
    resyncCallStateRef.current = resyncCallState;
  }, [resyncCallState]);

  const { connectSocket, disconnectSocket } = useSignalingSocket({
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
  });

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
    async (callId: string): Promise<RehydrationOutcome> => {
      if (!isRehydratableCallId(callId)) return 'ignored';

      if (shouldDeferRehydration({ userId, signalingUrl })) {
        logInfo('[CallFlow] Deferring push rehydration until identity is set', {
          callId,
        });
        setPendingPushCallId(callId);
        return 'deferred';
      }

      logInfo('[CallFlow] Rehydrating call from push', { callId });

      try {
        const sessionId = await createOrGetSession();
        // A push cold start does not connect its socket until after this lookup,
        // so warm ICE credentials here rather than delaying until the answer.
        prefetchIceServersForCall({ signalingUrl, sessionId });

        const response = await fetch(buildCallLookupUrl({ signalingUrl, callId }), {
          headers: bearerAuthHeaders(sessionId),
        });

        if (!response.ok) {
          const failure = classifyLookupFailure(response.status);
          if (failure.outcome === 'not_found') {
            updateStatus(failure.message, 'info');
            return 'not_found';
          }
          throw new Error(`HTTP ${response.status}`);
        }

        const call = await response.json();
        const rehydrated = describeRehydratedCall(call.status);

        if (rehydrated.outcome === 'terminal') {
          // Terminal or non-ringing state – inform the user and stay idle.
          logInfo('[CallFlow] Push call already finished', {
            callId,
            status: call.status,
          });
          updateStatus(rehydrated.message, 'info');
          return 'terminal';
        }

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
  // while the user is anywhere in the tabs.

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
  //
  // Where a first-run primer applies (Android, which is the only platform with
  // runtime permission dialogs to explain), the primer performs the request
  // itself after stating the reasons — see `usePermissionsPrimer`. Requesting
  // here as well would put the dialogs on screen before the explanation.
  useStartupPermissions(userId, { enabled: !shouldShowPermissionPrimer() });

  // ─── Proactive session refresh ────────────────────────────────────────────
  // Rotate the session token every SESSION_REFRESH_INTERVAL_MS (50 min) while
  // the user is signed in, so the token never expires mid-call.  The server's
  // SESSION_TTL_MS should be set well above this interval (e.g. 3600000 = 1 h).

  useEffect(() => {
    if (!shouldScheduleSessionRefresh({ userId, signalingUrl })) return undefined;

    const timer = setInterval(async () => {
      if (!sessionIdRef.current) return;
      await refreshSession().catch(error => {
        logWarn('[CallFlow] Proactive session refresh failed', {
          message: errorMessage(error),
        });
        updateStatus(SESSION_REFRESH_FAILED_MESSAGE, 'warning');
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

  // ─── Unmount teardown ────────────────────────────────────────────────────
  //
  // The teardown callbacks are ref-forwarded so the effect below can hold an
  // empty dependency array. Listing them as dependencies made this an
  // *unmount* cleanup that React would also run mid-call whenever any of them
  // changed identity — stopping the camera and microphone tracks, closing the
  // peer connection and dropping the socket underneath a live call. Their
  // stability is not something this file can enforce (Fast Refresh breaks it
  // by design), so the cleanup reads the current identities at teardown time
  // instead.
  const teardownRef = useRef({
    disconnectSocket,
    closePeerConnection,
    releaseLocalMedia,
    stopCallHeartbeat,
    closeRecoveryEpisode,
    stopCallService,
  });
  useEffect(() => {
    teardownRef.current = {
      disconnectSocket,
      closePeerConnection,
      releaseLocalMedia,
      stopCallHeartbeat,
      closeRecoveryEpisode,
      stopCallService,
    };
  });

  useEffect(() => {
    return () => {
      const teardown = teardownRef.current;
      teardown.disconnectSocket();
      teardown.closePeerConnection();
      teardown.releaseLocalMedia();
      teardown.stopCallHeartbeat('unmount');
      teardown.closeRecoveryEpisode('unmount');
      teardown.stopCallService();
    };
    // Runs exactly once, on unmount: every callback is read from `teardownRef`
    // at teardown time, so there is nothing for this effect to depend on.
  }, []);

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

  /**
   * Ask the server to ring `calleeIdToRing`, self-healing once from a stale
   * call this device left behind.
   *
   * A `call_in_progress` rejection means the server has a call for this user
   * that this device is not holding. When no other device claims one either,
   * that call is a phantom — the usual cause is a cancel that never reached
   * the server, which then blocked every subsequent call. Reporting this
   * device's (empty) call state clears the calls it owns, and the placement is
   * retried exactly once.
   */
  const requestCallPlacement = useCallback(async (calleeIdToRing: string) => {
    const initiate = () =>
      signalingRef.current?.request(CLIENT_EVENTS.CALL_INITIATE, {
        version: SIGNALING_VERSION,
        calleeId: calleeIdToRing,
      });

    try {
      return await initiate();
    } catch (error) {
      const signaling = signalingRef.current;
      if (!isCallInProgressRejection(error) || callElsewhereRef.current || !signaling) {
        throw error;
      }
      logWarn('[CallFlow] Placement blocked by a call this device does not hold', {
        calleeId: calleeIdToRing,
      });
      await reportOwnCallStateAsync(signaling, [], 'placement-blocked');
      return await initiate();
    }
  }, []);

  const placeCall = useCallback(
    /** @param [explicitCalleeId] */
    async (explicitCalleeId?: string) => {
      if (isPlacingCallRef.current) return;

      // One call at a time — including one held by another of this user's
      // devices. Dialling over a live call used to be accepted locally and then
      // collide with the call already up.
      const blocked = describeDialBlocked({
        activeCall: activeCallRef.current,
        callElsewhere: callElsewhereRef.current,
        incomingCall: incomingCallRef.current,
      });
      if (blocked) {
        logWarn('[CallFlow] placeCall refused', { reason: blocked });
        updateStatus(blocked, 'error');
        return;
      }

      const callee = resolveOutgoingCallee({
        explicitCalleeId,
        typedCalleeId: calleeId,
        userId,
      });
      if (!callee.ok) {
        updateStatus(callee.message, 'error');
        return;
      }
      const trimmedCalleeId = callee.calleeId;

      isPlacingCallRef.current = true;
      setIsPlacingCall(true);
      try {
        setCallSummary(null);
        setCallDelivery(null);

        const stream = await startLocalPreview();
        if (!stream) return;

        // Ensure a session and socket exist.
        let socket = socketRef.current;
        if (!socket?.connected) {
          const sessionId = await createOrGetSession();
          socket = connectSocket(sessionId);
          const connectingSocket = socket;
          // Give the socket a moment to connect.
          await new Promise(
            /** @param resolve */ (resolve: (value?: unknown) => void, reject) => {
              const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8_000);
              connectingSocket.once('connect', () => {
                clearTimeout(timer);
                resolve();
              });
              connectingSocket.once('connect_error', err => {
                clearTimeout(timer);
                reject(err);
              });
            },
          );
        }

        updateStatus(`Calling ${trimmedCalleeId}…`);
        const ack = await requestCallPlacement(trimmedCalleeId);

        isCallerRef.current = true;
        activeCallIdRef.current = ack.call.callId;
        activeCallRef.current = ack.call;
        setActiveCall(ack.call);
        recordTimelineCallRef.current(ack.call);

        // The server answers a placement with a verdict, and `busy` /
        // `unreachable` are answers, not ringing calls. Painting "Ringing…"
        // over them is what left the user watching a call screen for a call
        // that was already refused, with no message at all.
        const verdict = describeCallStateEnding({
          status: ack.call.status,
          reason: ack.call.endReason,
        });
        if (verdict) {
          logInfo('[CallFlow] Call rejected at placement', {
            callId: ack.call.callId,
            status: ack.call.status,
          });
          dispatchCallEvent(CALL_EVENTS.PLACE);
          endActiveCall(verdict.message, verdict.severity, verdict.endReason);
          return;
        }

        dispatchCallEvent(CALL_EVENTS.PLACE);
        updateStatus(`Ringing ${trimmedCalleeId}…`);
        Telemetry.trackCallStart(ack.call.callId, sessionIdRef.current);
        emitEvent('info', 'call.started', { callId: ack.call.callId, direction: 'outgoing' });
      } catch (error) {
        logError('[CallFlow] placeCall failed', error);
        // The message must outlive the teardown: `endActiveCall`'s own status
        // used to overwrite it, so a failed placement said "Call ended" and
        // never why.
        endActiveCall('', 'info', null);
        updateStatus(describePlacementFailure(error, callElsewhereRef.current), 'error');
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
      requestCallPlacement,
      updateStatus,
      startLocalPreview,
      userId,
      sessionIdRef,
    ],
  );

  // ─── Cancel outgoing call ─────────────────────────────────────────────────

  /**
   * Tell the server a call is over, preferring the socket and falling back to
   * the authenticated HTTP endpoint. Never throws.
   *
   * The fallback is the whole point: a cancel or hang-up sent over a socket
   * that is not actually connected reached nobody, so the call went on ringing
   * server-side for its full two-minute window and made the caller "busy" —
   * against their own dead call — for every attempt in between.
   *
   * @param action - `cancel` for an unanswered outgoing call, `end` otherwise.
   * @returns whether the server was told
   */
  const releaseCallOnServer = useCallback(
    async (callId: string, action: Extract<CallAction, 'cancel' | 'end'>): Promise<boolean> => {
      if (!callId) return false;
      const event = action === 'cancel' ? CLIENT_EVENTS.CALL_CANCEL : CLIENT_EVENTS.CALL_END;

      if (socketRef.current?.connected) {
        try {
          await signalingRef.current?.request(event, { version: SIGNALING_VERSION, callId });
          return true;
        } catch (error) {
          // The server may already have transitioned the call; log and fall
          // through so a genuinely undelivered request still gets its retry.
          logWarn('[CallFlow] call release ack failed (call may already be terminal)', {
            action,
            message: errorMessage(error),
          });
        }
      }

      try {
        const response = await authedFetchRef.current?.(sessionId => ({
          url: buildCallActionUrl({
            signalingUrl: signalingUrl ?? '',
            callId,
            action,
          }),
          options: {
            method: 'POST',
            headers: bearerAuthHeaders(sessionId, { 'Content-Type': 'application/json' }),
            body: '{}',
          },
        }));
        if (response?.ok) return true;
        logWarn('[CallFlow] HTTP call release failed', {
          callId,
          action,
          status: response?.status ?? null,
        });
      } catch (error) {
        logWarn('[CallFlow] HTTP call release threw', {
          callId,
          action,
          message: errorMessage(error),
        });
      }
      return false;
    },
    [authedFetchRef, signalingUrl],
  );

  const cancelOutgoingCall = useCallback(async () => {
    const callId = activeCallIdRef.current;
    if (callId) {
      await releaseCallOnServer(callId, 'cancel');
    }

    endActiveCall('Call cancelled', 'info', 'cancelled');
  }, [endActiveCall, releaseCallOnServer]);

  // ─── Accept / decline incoming call ──────────────────────────────────────

  const { acceptIncomingCall, declineIncomingCall } = useAnswerPath({
    acceptInFlightCallIdRef,
    activeCallIdRef,
    activeCallRef,
    authedFetchRef,
    answeredCallIdsRef,
    connectSocket,
    createOrGetSession,
    dismissIncomingCallElsewhere,
    endActiveCall,
    endActiveCallRef,
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
  });

  // ─── End active in-call ───────────────────────────────────────────────────

  const handleEndCall = useCallback(async () => {
    const callId = activeCallIdRef.current;
    if (callId) {
      await releaseCallOnServer(callId, 'end');
    }

    endActiveCall('Call ended', 'info', 'ended');
  }, [endActiveCall, releaseCallOnServer]);

  // ─── Media controls ───────────────────────────────────────────────────────

  // The Picture-in-Picture window's controls are wired up long before these
  // handlers exist (the hook that owns them runs near the top of this one), so
  // they are reached through refs that always hold the current versions.
  const handleMuteToggleRef = useRef(handleMuteToggle);
  const handleEndCallRef = useRef(handleEndCall);
  useEffect(() => {
    handleMuteToggleRef.current = handleMuteToggle;
    handleEndCallRef.current = handleEndCall;
  }, [handleEndCall, handleMuteToggle]);

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

  const dismissCallSummary = useCallback(() => {
    setCallSummary(null);
  }, []);

  // ─── Local media presence relay ───────────────────────────────────────────
  // Tell the peer whenever the local screen-sharing or camera state changes:
  // their CallStage renders a "they are presenting" banner off the first, and
  // decides between the video stage and the ambient canvas off the second.
  //
  // The camera flag has to be relayed because it is not observable on the
  // wire — turning the camera off sets `track.enabled = false`, which keeps
  // the track and keeps transmitting, so a receiver that only counted tracks
  // showed a black rectangle and called it a video call.
  //
  // Both flags travel in one frame rather than two relays, so the peer can
  // never apply half an update. Best-effort: a rejected/timed-out ack is
  // logged and otherwise ignored.
  //
  // The active call id is a dependency, not just a guard, because the flags
  // move independently of the call: local media starts — and therefore sets
  // `isVideoEnabled` — before an outgoing call has an id, and a toggle made
  // while there is no id to address is dropped by the guard below and never
  // retried. Re-emitting when the id appears sends the peer one explicit
  // snapshot per call, so their view can never be stale by a whole call.
  // The call *status* matters for the same reason: an outgoing call has an id
  // from the moment it is placed, but the server only accepts RTC frames —
  // `call.media-state` among them — once the call has left `ringing`, and
  // rejects the rest with `stale_call_state`. Emitting on the id alone
  // therefore both lost the snapshot (there is no peer listening yet anyway)
  // and logged an error ack on every ordinary call.
  //
  // The dependency is the *boolean*, not the status: a live call still walks
  // `accepted` → `connecting_media` → `in_call`, and depending on the status
  // itself would relay the same unchanged snapshot three times per call.
  const activeCallId = activeCall?.callId ?? null;
  const canRelayMediaState = activeCallId !== null && isLiveCallStatus(activeCall?.status);
  useEffect(() => {
    if (mediaStateRelayTimerRef.current) {
      clearTimeout(mediaStateRelayTimerRef.current);
      mediaStateRelayTimerRef.current = null;
    }
    isScreenSharingRef.current = isScreenSharing;
    if (!socketRef.current?.connected || !activeCallId) return;
    if (!canRelayMediaState) return;
    mediaStateRelayTimerRef.current = setTimeout(() => {
      mediaStateRelayTimerRef.current = null;
      if (!socketRef.current?.connected) return;
      signalingRef.current
        ?.request(CLIENT_EVENTS.CALL_MEDIA_STATE, {
          version: SIGNALING_VERSION,
          callId: activeCallId,
          mediaState: { isScreenSharing, isVideoEnabled },
        })
        .catch(error => {
          logWarn('[CallFlow] call.media-state emit failed', {
            message: errorMessage(error),
          });
        });
    }, MEDIA_STATE_RELAY_DEBOUNCE_MS);
  }, [activeCallId, canRelayMediaState, isScreenSharing, isVideoEnabled]);
  useEffect(
    () => () => {
      if (mediaStateRelayTimerRef.current) clearTimeout(mediaStateRelayTimerRef.current);
    },
    [],
  );

  // ─── Ringtone cleanup on unmount ─────────────────────────────────────────
  // Ensure the fallback ringtone never outlives the component tree in case the
  // hook is unmounted while an incoming call is still ringing.
  useEffect(() => {
    return () => {
      stopIncomingRingtone();
    };
  }, []);

  // ─── Public interface ─────────────────────────────────────────────────────

  const callFlowState = useMemo(
    () => ({
      // Identity / connection config
      userId: identity.userId,
      // Surfaced so Settings can name the account behind the username. Read
      // straight off the Firebase user rather than persisted, because it is only
      // ever displayed and must not outlive the session it came from.
      accountEmail: identity.authUser?.email ?? null,
      accountProviderId: identity.authUser?.providerData?.[0]?.providerId ?? null,
      isRegistered,
      isLoadingIdentity: identity.isLoadingIdentity,
      isAuthenticating: identity.isAuthenticating,
      canUseGoogleSignIn: identity.canUseGoogleSignIn,
      canUseMicrosoftSignIn: identity.canUseMicrosoftSignIn,
      calleeId,
      signalingUrl,

      // Call lifecycle
      callPhase,
      activeCall,
      incomingCall,
      callElsewhere,
      isPlacingCall,

      // UI status
      status,
      callSummary,
      calleePresence: presenceSearch.calleePresence,
      isServerUnreachable: presenceSearch.isServerUnreachable,

      // Blocklist
      blockedUsers: blocks.blockedUsers,

      // Call history
      callHistory: callHistory.callHistory,
      missedCallCount: callHistory.missedCallCount,

      // Chat
      conversations: messaging.conversations,
      messagesByPeer: messaging.messagesByPeer,
      drafts: messaging.drafts,
      unreadTotal: messaging.unreadTotal,
      activeChatPeerId,
      isChatOffline: messaging.isOffline,
      pendingSendCount: messaging.pendingSendCount,
      typingByPeer: messaging.typingByPeer,
      isRemoteScreenSharing,

      // Attachments (photo / camera / file / voice note)
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
      isRemoteVideoEnabled,
      isSpeakerEnabled,
      isScreenSharing,
      isTogglingScreenShare,
      isScreenAudioShared,
      isScreenAudioEnabled,
      screenShareDelivery,
      isScreenShareSupported,
      isCompactView,
      isLocalPrimary,
      isFrontCamera,
      callConnectedAtMs,
      audioDevices,
      connectionQuality,
      selectedCandidatePair,
      isReconnecting,
      recoveryStatus,
      isConnectionLost,
      callDelivery,
      iceTransportPolicy: activeIceTransportPolicy,
    }),
    [
      activeCall,
      activeChatPeerId,
      activeIceTransportPolicy,
      attachments.attachmentsAvailable,
      attachments.isRecordingVoiceNote,
      attachments.isUploading,
      attachments.isVoiceNoteSupported,
      attachments.uploadProgress,
      audioDevices,
      blocks.blockedUsers,
      callConnectedAtMs,
      callDelivery,
      callElsewhere,
      callHistory.callHistory,
      callHistory.missedCallCount,
      callPhase,
      callSummary,
      calleeId,
      connectionQuality,
      identity.authUser?.email,
      identity.authUser?.providerData,
      identity.canUseGoogleSignIn,
      identity.canUseMicrosoftSignIn,
      identity.isAuthenticating,
      identity.isLoadingIdentity,
      identity.userId,
      incomingCall,
      isCompactView,
      isConnectionLost,
      isFrontCamera,
      isInCall,
      isLocalPrimary,
      isMuted,
      isPlacingCall,
      isReconnecting,
      isRegistered,
      isRemoteScreenSharing,
      isRemoteVideoEnabled,
      isScreenAudioEnabled,
      isScreenAudioShared,
      isScreenShareSupported,
      isScreenSharing,
      isSpeakerEnabled,
      isTogglingScreenShare,
      isVideoEnabled,
      localStream,
      messaging.conversations,
      messaging.drafts,
      messaging.messagesByPeer,
      messaging.isOffline,
      messaging.pendingSendCount,
      messaging.typingByPeer,
      messaging.unreadTotal,
      presenceSearch.calleePresence,
      presenceSearch.isServerUnreachable,
      recoveryStatus,
      remoteStream,
      screenShareDelivery,
      selectedCandidatePair,
      signalingUrl,
      status,
    ],
  );

  const callFlowActions = useMemo(
    () => ({
      // Identity / connection config
      setUserId: identity.setUserId,
      editUserId: identity.editUserId,
      registerUser: identity.registerUser,
      unregisterUser,
      updateUserId: identity.updateUserId,
      setCalleeId,
      setSignalingUrl,
      authedFetch,

      // UI status
      updateStatus,
      checkPresence,
      searchUsers: presenceSearch.searchUsers,
      retryPresenceConnect,

      // Blocklist
      isUserBlocked: blocks.isUserBlocked,
      fetchBlocks,
      blockPeer,
      unblockPeer,

      // Call history
      markMissedCallsRead: callHistory.markMissedCallsRead,
      fetchCallHistory: callHistory.fetchCallHistory,
      setOutgoingCallMediaType,

      // Chat
      saveDraft: messaging.saveDraft,
      clearDraft: messaging.clearDraft,
      setActiveChatPeerId: messaging.setActiveChatPeerId,
      fetchConversations,
      fetchMessagesForPeer: messaging.fetchMessagesForPeer,
      searchMessages: messaging.searchMessages,
      recordCallActivity: messaging.recordCallActivity,
      sendMessage: messaging.sendMessage,
      retryMessage: messaging.retryMessage,
      retryAttachmentUpload: attachments.retryUpload,
      discardMessage: messaging.discardMessage,
      deleteMessage: messaging.deleteMessage,
      reactToMessage: messaging.reactToMessage,
      drainOutbox: messaging.drainOutbox,
      markConversationRead,
      sendTypingIndicator: messaging.sendTypingIndicator,

      // Attachments (photo / camera / file / voice note)
      pickAndSendAttachment: attachments.pickAndSend,
      startRecordingVoiceNote: attachments.startRecordingVoiceNote,
      stopRecordingVoiceNoteAndSend: attachments.stopRecordingVoiceNoteAndSend,
      cancelRecordingVoiceNote: attachments.cancelRecordingVoiceNote,
      cancelAttachmentUpload: attachments.cancelUpload,

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
    }),
    [
      acceptIncomingCall,
      attachments.cancelUpload,
      attachments.cancelRecordingVoiceNote,
      attachments.pickAndSend,
      attachments.retryUpload,
      attachments.startRecordingVoiceNote,
      attachments.stopRecordingVoiceNoteAndSend,
      authedFetch,
      blockPeer,
      blocks.isUserBlocked,
      callHistory.fetchCallHistory,
      callHistory.markMissedCallsRead,
      cancelOutgoingCall,
      checkPresence,
      chooseAudioOutput,
      declineIncomingCall,
      dismissCallSummary,
      fetchBlocks,
      fetchConversations,
      handleCameraSwitch,
      handleEndCall,
      handleMuteToggle,
      handleRetryReconnect,
      handleScreenAudioToggle,
      handleScreenShareToggle,
      handleSwapStreams,
      handleVideoToggle,
      identity.editUserId,
      identity.registerUser,
      identity.setUserId,
      identity.updateUserId,
      markConversationRead,
      messaging.clearDraft,
      messaging.deleteMessage,
      messaging.discardMessage,
      messaging.drainOutbox,
      messaging.fetchMessagesForPeer,
      messaging.reactToMessage,
      messaging.recordCallActivity,
      messaging.retryMessage,
      messaging.saveDraft,
      messaging.searchMessages,
      messaging.sendMessage,
      messaging.sendTypingIndicator,
      messaging.setActiveChatPeerId,
      placeCall,
      presenceSearch.searchUsers,
      rehydrateCallFromPush,
      retryPresenceConnect,
      setCalleeId,
      setOutgoingCallMediaType,
      setSignalingUrl,
      startLocalPreview,
      unblockPeer,
      unregisterUser,
      updateStatus,
    ],
  );

  return useMemo(
    () => ({
      ...callFlowState,
      ...callFlowActions,
    }),
    [callFlowActions, callFlowState],
  );
}
