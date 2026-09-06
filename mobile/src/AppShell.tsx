import { useEffect, useRef } from 'react';
import { Linking, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  announceForAccessibility,
  describeCallEnd,
  describeCallState,
  describeRecoveryTransition,
} from './accessibilityAnnouncer';
import { logError } from './appLogger';
import { CALL_STATES } from './call/callStateMachine';
import { useCall, useCallSelector } from './call/CallProvider';
import useCallElapsedSeconds from './hooks/useCallElapsedSeconds';
import usePermissionsPrimer from './hooks/usePermissionsPrimer';
import CallEndSummary from './components/CallEndSummary';
import CallScreen from './components/CallScreen';
import { Banner } from './components/primitives';
import FloatingCallBubble from './components/FloatingCallBubble';
import InCallBanner from './components/InCallBanner';
import IncomingCallScreen from './components/IncomingCallScreen';
import OutgoingCallScreen from './components/OutgoingCallScreen';
import PermissionsPrimerScreen from './components/PermissionsPrimerScreen';
import RegistrationScreen from './components/RegistrationScreen';
import TabShell from './components/TabShell';
import { getDegradations } from './observability';
import { useTheme, useThemedStyles } from './ThemeContext';
import { spacing } from './theme';
import type { RecoveryAnnouncementState } from './accessibilityAnnouncer';
import type { StyleProp, ViewStyle } from 'react-native';
import type { CallContextValue } from './call/CallProvider';
import type { CallEndSummary as CallEndSummaryData } from './hooks/useCallFlow';
import type { ThemeColors } from './theme';

/**
 * What the screen router itself reads: registration, the state machine's phase
 * and the flags that decide which screen is on top.
 *
 * @param state the call snapshot
 * @returns the router's slice of it
 */
const selectShellSlice = (state: CallContextValue) => ({
  callState: state.callState,
  isBubbleDismissed: state.isBubbleDismissed,
  isCallConnected: state.isCallConnected,
  isCallMinimized: state.isCallMinimized,
  isCompact: state.isCompact,
  isLoadingIdentity: state.callFlow.isLoadingIdentity,
  isRegistered: state.callFlow.isRegistered,
  callSummary: state.callFlow.callSummary,
  dismissCallSummary: state.callFlow.dismissCallSummary,
  callerId: state.callFlow.incomingCall?.callerId ?? null,
  calleeId: state.callFlow.calleeId,
  isReconnecting: state.callFlow.isReconnecting,
  recoveryStatus: state.callFlow.recoveryStatus,
  isConnectionLost: state.callFlow.isConnectionLost,
});

/**
 * What the pre-call screens (registration, ringing) read.
 *
 * Selected here rather than handed down from `AppShell`, so the router does not
 * have to subscribe to the whole call flow on their behalf.
 *
 * @param state the call snapshot
 * @returns the pre-call screens' slice of it
 */
const selectScreenContentSlice = (state: CallContextValue) => ({
  isLoadingIdentity: state.callFlow.isLoadingIdentity,
  isRegistered: state.callFlow.isRegistered,
  isAuthenticating: state.callFlow.isAuthenticating,
  registerUser: state.callFlow.registerUser,
  canUseGoogleSignIn: state.callFlow.canUseGoogleSignIn,
  canUseMicrosoftSignIn: state.callFlow.canUseMicrosoftSignIn,
  status: state.callFlow.status,
  calleeId: state.callFlow.calleeId,
  activeCall: state.callFlow.activeCall,
  callDelivery: state.callFlow.callDelivery,
  cancelOutgoingCall: state.callFlow.cancelOutgoingCall,
  incomingCall: state.callFlow.incomingCall,
  acceptIncomingCall: state.callFlow.acceptIncomingCall,
  declineIncomingCall: state.callFlow.declineIncomingCall,
  handleEndCall: state.callFlow.handleEndCall,
});

function AppScreenContent({
  callState,
  isPrimerVisible,
  isCallFullScreen,
  acceptPrimer,
  skipPrimer,
}: {
  callState: string;
  isPrimerVisible: boolean;
  isCallFullScreen: boolean;
  acceptPrimer: () => Promise<void>;
  skipPrimer: () => Promise<void>;
}) {
  const callFlow = useCallSelector(selectScreenContentSlice);
  if (callFlow.isLoadingIdentity) return null;
  if (!callFlow.isRegistered) {
    return (
      <RegistrationScreen
        onRegister={registration => {
          callFlow.registerUser(registration).catch(error => {
            logError('registerUser failed', error);
          });
        }}
        isLoading={callFlow.isAuthenticating}
        status={callFlow.status}
        isGoogleSignInAvailable={callFlow.canUseGoogleSignIn}
        isMicrosoftSignInAvailable={callFlow.canUseMicrosoftSignIn}
      />
    );
  }
  if (isPrimerVisible && callState === CALL_STATES.IDLE) {
    // Only from a standing start: a call arriving during first run outranks an
    // explanation, and the primer would otherwise cover the ringing screen.
    return (
      <PermissionsPrimerScreen
        onContinue={() => {
          acceptPrimer().catch(error => {
            logError('permissions primer accept failed', error);
          });
        }}
        onSkip={() => {
          skipPrimer().catch(error => {
            logError('permissions primer skip failed', error);
          });
        }}
      />
    );
  }
  if (callState === CALL_STATES.OUTGOING_RINGING) {
    return (
      <OutgoingCallScreen
        calleeId={callFlow.calleeId}
        activeCall={callFlow.activeCall}
        delivery={callFlow.callDelivery}
        status={callFlow.status}
        onCancel={callFlow.cancelOutgoingCall}
      />
    );
  }
  if (callState === CALL_STATES.INCOMING_RINGING) {
    // Answering clears `incomingCall` immediately, but the call state only
    // reaches `in_call` once media negotiation completes — so for that second
    // or two this screen is still on top. Fall back to the active call record
    // for the caller's identity, or the screen announces the call as being
    // from "Unknown" the instant the user accepts it.
    const ringingCall = callFlow.incomingCall ?? callFlow.activeCall;
    return (
      <IncomingCallScreen
        incomingCall={ringingCall}
        isAnswering={!callFlow.incomingCall && Boolean(callFlow.activeCall)}
        status={callFlow.status}
        onAccept={callFlow.acceptIncomingCall}
        onDecline={callFlow.declineIncomingCall}
        onCancelAnswer={callFlow.handleEndCall}
      />
    );
  }
  return isCallFullScreen ? <ActiveCallScreen /> : <TabShell />;
}

/**
 * Screen router: picks what the app shows for the current call state and
 * registration status.  All behaviour lives in the providers
 * (`CallProvider` / `ChatProvider`); this component only composes screens.
 *
 * A connected call normally takes over the full screen; minimizing it (via the
 * call top bar, a bottom tab, or the Android hardware back button) shrinks it
 * to a draggable `FloatingCallBubble` over the tab shell, so the user can keep
 * chatting while the call continues (distinct from the OS-level Android
 * Picture-in-Picture, which only engages when the app is backgrounded — see
 * `useCompactCallView`).
 */
export default function AppShell() {
  const {
    callState,
    isBubbleDismissed,
    isCallConnected,
    isCallMinimized,
    isCompact,
    isLoadingIdentity,
    isRegistered,
    callSummary,
    dismissCallSummary,
    callerId,
    calleeId,
    isReconnecting,
    recoveryStatus,
    isConnectionLost,
  } = useCallSelector(selectShellSlice);
  const insets = useSafeAreaInsets();
  const { colors, scheme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const startupIssues = getDegradations();
  const { isPrimerVisible, acceptPrimer, skipPrimer } = usePermissionsPrimer(
    isRegistered && !isLoadingIdentity,
  );

  // Only once the call is over and the tab shell is back: a summary shown over
  // a ringing or connected call would be describing a different call.
  const callEndSummary = callState === CALL_STATES.IDLE ? callSummary : null;

  useCallStateAnnouncements(callState, callerId, calleeId);
  useRecoveryAnnouncements(callState === CALL_STATES.IN_CALL, {
    isRecovering: Boolean(isReconnecting || recoveryStatus),
    attempts: recoveryStatus?.attempts ?? 0,
    isConnectionLost: Boolean(isConnectionLost),
  });
  useCallEndAnnouncements(callEndSummary);

  // OS PiP always short-circuits to the compact CallScreen, taking precedence
  // over the in-app minimize state.
  const isCallFullScreen = callState === CALL_STATES.IN_CALL && (isCompact || !isCallMinimized);
  const isTabShellActive =
    isRegistered &&
    !isLoadingIdentity &&
    !isCallFullScreen &&
    // The primer takes the tab shell's place on first run, and unlike the shell
    // it does not pad its own bottom edge.
    !isPrimerVisible &&
    callState !== CALL_STATES.OUTGOING_RINGING &&
    callState !== CALL_STATES.INCOMING_RINGING;
  const isCallMinimizedInShell = isTabShellActive && isCallConnected && isCallMinimized;
  // The bubble can be flung away; the banner above the tab shell always stays
  // so a minimized call is never invisible.
  const isBubbleVisible = isCallMinimizedInShell && !isBubbleDismissed;

  const screenContent = (
    <AppScreenContent
      callState={callState}
      isPrimerVisible={isPrimerVisible}
      isCallFullScreen={isCallFullScreen}
      acceptPrimer={acceptPrimer}
      skipPrimer={skipPrimer}
    />
  );

  // Padding depends on runtime-only values (measured safe-area insets, and
  // whether the tab shell — which pads its own bottom edge — is active), so it
  // can't live in the static StyleSheet below.
  const rootContainerStyle = {
    paddingTop: insets.top,
    paddingBottom: isTabShellActive ? 0 : insets.bottom,
  };

  if (isCompact) {
    // Compact (Android PiP) mode: no system-inset padding, no chrome.
    return <View style={styles.containerCompact}>{screenContent}</View>;
  }

  return (
    <View style={[styles.container, rootContainerStyle]}>
      {/* A *persistent condition*, not a blocking failure: the app works, and
          the user can keep using it, so this is a banner rather than the
          full-screen `ErrorState` card it used to be. */}
      {startupIssues.length > 0 ? (
        <Banner
          tone="warning"
          icon="settingsNotifications"
          message={`Calling may not work reliably: ${startupIssues
            .map(issue => issue.message)
            .join('; ')}`}
          actionLabel="Fix"
          actionHint="Opens WeTalk's permissions in the device settings app"
          onAction={openDeviceSettings}
          accessibilityRole="alert"
          style={styles.degradedBanner}
          testID="startup-degraded-banner"
        />
      ) : null}
      {callEndSummary ? (
        <CallEndSummary summary={callEndSummary} onDismiss={dismissCallSummary} />
      ) : null}
      <CallElsewhereBanner isVisible={isTabShellActive} style={styles.degradedBanner} />
      {isCallMinimizedInShell ? <MinimizedCallBanner /> : null}
      {screenContent}
      {isBubbleVisible ? <MinimizedCallBubble /> : null}
      {/* System chrome follows the palette, including the variants: a
          high-contrast or true-black background reaches the status bar too,
          because the colour is read from the active palette rather than from
          the scheme name. A full-screen call is the exception — the video stage
          is fixed-dark in *both* schemes (see `stage`), so a light-scheme user
          would otherwise get a white status bar with dark icons sitting on top
          of black video. This changes only the bar's colour, never the layout:
          `translucent={false}` keeps it out of the safe-area inset this view
          already pads for. */}
      <StatusBar
        barStyle={isCallFullScreen || scheme !== 'light' ? 'light-content' : 'dark-content'}
        backgroundColor={isCallFullScreen ? colors.stage : colors.background}
        translucent={false}
      />
    </View>
  );
}

/**
 * Announce every call state transition to screen readers, so an incoming call
 * or a connected/ended call is spoken rather than only shown.
 */
function useCallStateAnnouncements(callState: string, callerId: string | null | undefined, calleeId: string | null | undefined) {
  const previousStateRef = useRef((null as string | null));

  useEffect(() => {
    if (previousStateRef.current === callState) return;
    previousStateRef.current = callState;
    const message = describeCallState(callState, { callerId, calleeId });
    if (message) announceForAccessibility(message);
    // The peer ids are read at announcement time only: a peer changing while
    // the state stays put must not re-announce the same transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);
}

/** No recovery in progress, and nothing yet announced about one. */
const IDLE_RECOVERY: RecoveryAnnouncementState = {
  isRecovering: false,
  attempts: 0,
  isConnectionLost: false,
};

/**
 * Announce the course of a recovery episode: its start, each further attempt,
 * whether it succeeded, and — the one the user most needs — that it did not.
 *
 * Only while a call is up: the recovery flags can settle after the call has
 * already ended, and "Reconnected" after "Call ended" is a lie.
 */
function useRecoveryAnnouncements(
  isInCall: boolean,
  { isRecovering, attempts, isConnectionLost }: RecoveryAnnouncementState,
) {
  const previousRef = useRef(IDLE_RECOVERY);

  useEffect(() => {
    if (!isInCall) {
      previousRef.current = IDLE_RECOVERY;
      return;
    }
    const next = { isRecovering, attempts, isConnectionLost };
    const message = describeRecoveryTransition(previousRef.current, next);
    previousRef.current = next;
    if (message) announceForAccessibility(message);
  }, [attempts, isConnectionLost, isInCall, isRecovering]);
}

/**
 * Announce the end-of-call summary once, as it appears.
 *
 * The summary is a banner above a tab shell the user has just been dropped
 * back into, so nothing moves focus to it.
 */
function useCallEndAnnouncements(summary: CallEndSummaryData | null) {
  const announcedRef = useRef((null as typeof summary));

  useEffect(() => {
    if (announcedRef.current === summary) return;
    announcedRef.current = summary;
    const message = describeCallEnd(summary);
    if (message) announceForAccessibility(message);
  }, [summary]);
}

/** Open the OS settings page for the app so the user can grant what's missing. */
function openDeviceSettings() {
  Promise.resolve(Linking.openSettings?.()).catch(error => {
    logError('openSettings failed', error);
  });
}

/** Full-screen view of the connected call. */
function ActiveCallScreen() {
  const {
    callFlow,
    settings,
    isCompact,
    participantLabel,
    streams,
    handleCallStageLayout,
    handleTopChromeLayout,
    handleBottomChromeLayout,
    pipGesture,
    animatedPipStyle,
    minimizeCall,
    endCall,
  } = useCall();
  // Ticked here rather than in the call flow, so the per-second update
  // re-renders only this screen instead of every mounted screen in the app.
  const elapsedCallSeconds = useCallElapsedSeconds(callFlow.callConnectedAtMs);

  return (
    <CallScreen
      elapsedCallSeconds={elapsedCallSeconds}
      connectionQuality={callFlow.connectionQuality}
      participantLabel={participantLabel}
      isReconnecting={callFlow.isReconnecting}
      recoveryStatus={callFlow.recoveryStatus}
      isConnectionLost={callFlow.isConnectionLost}
      onRetry={callFlow.handleRetryReconnect}
      onStageLayout={handleCallStageLayout}
      onTopChromeLayout={handleTopChromeLayout}
      onBottomChromeLayout={handleBottomChromeLayout}
      mainStreamUrl={streams.mainStreamUrl}
      hasMainStream={Boolean(streams.mainStream)}
      // Audio call, or a peer with their camera off: a stream exists and has a
      // URL, but there is no picture in it, so the stage draws the ambient
      // canvas rather than a black rectangle. Both halves matter — an audio
      // call has no video track, while a camera that has been switched off
      // keeps its track and says so over `call.media-state`.
      isAudioOnly={Boolean(streams.mainStream) && !streams.mainHasVideo}
      pipStreamUrl={streams.pipStreamUrl}
      // Same question for the small tile. A self-view of a camera the user has
      // just turned off is a black square that follows them around the screen,
      // so the tile goes away with the picture rather than with the stream.
      hasPipStream={Boolean(streams.pipStream) && streams.pipHasVideo}
      mirrorPip={streams.mirrorPip}
      mirrorMain={streams.mirrorMain}
      pipGesture={pipGesture}
      animatedPipStyle={animatedPipStyle}
      isMuted={callFlow.isMuted}
      isVideoEnabled={callFlow.isVideoEnabled}
      hasLocalStream={Boolean(callFlow.localStream)}
      audioDevices={callFlow.audioDevices}
      isSpeakerEnabled={callFlow.isSpeakerEnabled}
      isScreenSharing={callFlow.isScreenSharing}
      isTogglingScreenShare={callFlow.isTogglingScreenShare}
      isScreenAudioEnabled={callFlow.isScreenAudioEnabled}
      isScreenAudioShared={callFlow.isScreenAudioShared}
      screenShareDelivery={callFlow.screenShareDelivery}
      isScreenShareSupported={callFlow.isScreenShareSupported}
      isRemoteScreenSharing={callFlow.isRemoteScreenSharing}
      iceTransportPolicy={settings.iceTransportPolicy}
      onMuteToggle={callFlow.handleMuteToggle}
      onVideoToggle={callFlow.handleVideoToggle}
      onChooseAudioOutput={callFlow.chooseAudioOutput}
      onCameraSwitch={callFlow.handleCameraSwitch}
      onScreenShareToggle={callFlow.handleScreenShareToggle}
      onScreenAudioToggle={callFlow.handleScreenAudioToggle}
      onLeave={endCall}
      onMinimize={minimizeCall}
      status={callFlow.status}
      isCompact={isCompact}
    />
  );
}

/**
 * What the minimized-call banner reads: who is on the call, since when, and the
 * two controls it offers. Nothing else — it sits over the tab shell, so it must
 * not wake for connection stats, recovery attempts or the screen-share flag it
 * does not show.
 *
 * @param state the call snapshot
 * @returns the banner's slice of it
 */
const selectBannerSlice = (state: CallContextValue) => ({
  callConnectedAtMs: state.callFlow.callConnectedAtMs,
  isMuted: state.callFlow.isMuted,
  handleMuteToggle: state.callFlow.handleMuteToggle,
  participantLabel: state.participantLabel,
  expandCall: state.expandCall,
  endCall: state.endCall,
});

/**
 * The banner's slice plus what the bubble additionally shows: it carries a
 * screen-share glyph and can be flung away.
 *
 * @param state the call snapshot
 * @returns the bubble's slice of it
 */
const selectBubbleSlice = (state: CallContextValue) => ({
  ...selectBannerSlice(state),
  isScreenSharing: state.callFlow.isScreenSharing,
  handleScreenShareToggle: state.callFlow.handleScreenShareToggle,
  dismissBubble: state.dismissBubble,
});

/**
 * What the "call elsewhere" banner reads: the call another of this user's
 * devices is holding, and this device's own phase — the banner is for a device
 * with no call of its own to show.
 *
 * @param state the call snapshot
 * @returns the banner's slice of it
 */
const selectCallElsewhereSlice = (state: CallContextValue) => ({
  callElsewhere: state.callFlow.callElsewhere,
  callState: state.callState,
});

/**
 * A call this user is on, on one of their *other* devices.
 *
 * This device is not in that call and cannot place one of its own while it
 * runs, so it says who the call is with rather than leaving the user to work
 * that out from a refused dial attempt. Read-only by nature: there is nothing
 * to mute, time or hang up from here.
 *
 * @param props.isVisible whether the tab shell — which this sits above — is up
 * @param props.style layout for the banner
 */
function CallElsewhereBanner({ isVisible, style }: { isVisible: boolean; style: StyleProp<ViewStyle>; }) {
  const { callElsewhere, callState } = useCallSelector(selectCallElsewhereSlice);
  if (!isVisible || !callElsewhere || callState !== CALL_STATES.IDLE) return null;

  return (
    <Banner
      tone="accent"
      icon="callActive"
      message={`In a call with ${callElsewhere.peerId} on another device`}
      accessibilityRole="alert"
      style={style}
      testID="call-elsewhere-banner"
    />
  );
}

/** Banner shown above the tab shell while a call is minimized. */
function MinimizedCallBanner() {
  const { callConnectedAtMs, isMuted, handleMuteToggle, participantLabel, expandCall, endCall } =
    useCallSelector(selectBannerSlice);
  const elapsedCallSeconds = useCallElapsedSeconds(callConnectedAtMs);

  return (
    <InCallBanner
      participantLabel={participantLabel}
      elapsedCallSeconds={elapsedCallSeconds}
      onExpand={expandCall}
      isMuted={isMuted}
      onMuteToggle={handleMuteToggle}
      onEndCall={endCall}
    />
  );
}

/** Draggable bubble overlaying the tab shell while a call is minimized. */
function MinimizedCallBubble() {
  const {
    callConnectedAtMs,
    isMuted,
    isScreenSharing,
    handleMuteToggle,
    handleScreenShareToggle,
    participantLabel,
    expandCall,
    endCall,
    dismissBubble,
  } = useCallSelector(selectBubbleSlice);
  const elapsedCallSeconds = useCallElapsedSeconds(callConnectedAtMs);

  return (
    <FloatingCallBubble
      participantLabel={participantLabel}
      elapsedCallSeconds={elapsedCallSeconds}
      isMuted={isMuted}
      isScreenSharing={isScreenSharing}
      onExpand={expandCall}
      onMuteToggle={handleMuteToggle}
      onEndCall={endCall}
      onStopScreenShare={handleScreenShareToggle}
      onDismiss={dismissBubble}
    />
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    containerCompact: {
      flex: 1,
      backgroundColor: colors.background,
    },
    degradedBanner: {
      marginHorizontal: spacing.md,
      marginTop: spacing.sm,
    },
  });
