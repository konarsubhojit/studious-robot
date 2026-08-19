import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from './appLogger';
import { CALL_STATES } from './call/callStateMachine';
import { useCall } from './call/CallProvider';
import CallScreen from './components/CallScreen';
import FloatingCallBubble from './components/FloatingCallBubble';
import InCallBanner from './components/InCallBanner';
import IncomingCallScreen from './components/IncomingCallScreen';
import OutgoingCallScreen from './components/OutgoingCallScreen';
import RegistrationScreen from './components/RegistrationScreen';
import TabShell from './components/TabShell';
import { getDegradations } from './observability';
import { useTheme, useThemedStyles } from './ThemeContext';

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
  const { callFlow, callState, isBubbleDismissed, isCallConnected, isCallMinimized, isCompact } =
    useCall();
  const insets = useSafeAreaInsets();
  const { colors, scheme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const startupIssues = getDegradations();

  // OS PiP always short-circuits to the compact CallScreen, taking precedence
  // over the in-app minimize state.
  const isCallFullScreen = callState === CALL_STATES.IN_CALL && (isCompact || !isCallMinimized);
  const isTabShellActive =
    callFlow.isRegistered &&
    !callFlow.isLoadingIdentity &&
    !isCallFullScreen &&
    callState !== CALL_STATES.OUTGOING_RINGING &&
    callState !== CALL_STATES.INCOMING_RINGING;
  const isCallMinimizedInShell = isTabShellActive && isCallConnected && isCallMinimized;
  // The bubble can be flung away; the banner above the tab shell always stays
  // so a minimized call is never invisible.
  const isBubbleVisible = isCallMinimizedInShell && !isBubbleDismissed;

  let screenContent;
  if (callFlow.isLoadingIdentity) {
    // Blank screen while identity is being loaded from storage; the app
    // transitions to the correct screen once loading completes.
    screenContent = null;
  } else if (!callFlow.isRegistered) {
    screenContent = (
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
  } else if (callState === CALL_STATES.OUTGOING_RINGING) {
    screenContent = (
      <OutgoingCallScreen
        calleeId={callFlow.calleeId}
        activeCall={callFlow.activeCall}
        status={callFlow.status}
        onCancel={callFlow.cancelOutgoingCall}
      />
    );
  } else if (callState === CALL_STATES.INCOMING_RINGING) {
    screenContent = (
      <IncomingCallScreen
        incomingCall={callFlow.incomingCall}
        status={callFlow.status}
        onAccept={callFlow.acceptIncomingCall}
        onDecline={callFlow.declineIncomingCall}
      />
    );
  } else if (isCallFullScreen) {
    screenContent = <ActiveCallScreen />;
  } else {
    screenContent = <TabShell />;
  }

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
      {startupIssues.length > 0 ? (
        <View style={styles.degradedBanner} testID="startup-degraded-banner">
          <Text style={styles.degradedBannerText}>
            {`Calling degraded: ${startupIssues.map(issue => issue.message).join('; ')}`}
          </Text>
        </View>
      ) : null}
      {isCallMinimizedInShell ? <MinimizedCallBanner /> : null}
      {screenContent}
      {isBubbleVisible ? <MinimizedCallBubble /> : null}
      <StatusBar
        barStyle={scheme === 'light' ? 'dark-content' : 'light-content'}
        backgroundColor={colors.background}
        translucent={false}
      />
    </View>
  );
}

/** Full-screen view of the connected call. */
function ActiveCallScreen() {
  const {
    callFlow,
    isCompact,
    participantLabel,
    streams,
    handleCallStageLayout,
    pipGesture,
    animatedPipStyle,
    minimizeCall,
    endCall,
  } = useCall();

  return (
    <CallScreen
      elapsedCallSeconds={callFlow.elapsedCallSeconds}
      connectionQuality={callFlow.connectionQuality}
      participantLabel={participantLabel}
      isReconnecting={callFlow.isReconnecting}
      onRetry={callFlow.handleRetryReconnect}
      onStageLayout={handleCallStageLayout}
      mainStreamUrl={streams.mainStreamUrl}
      hasMainStream={Boolean(streams.mainStream)}
      pipStreamUrl={streams.pipStreamUrl}
      hasPipStream={Boolean(streams.pipStream)}
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
      isScreenAudioEnabled={callFlow.isScreenAudioEnabled}
      isScreenAudioShared={callFlow.isScreenAudioShared}
      isScreenShareSupported={callFlow.isScreenShareSupported}
      isRemoteScreenSharing={callFlow.isRemoteScreenSharing}
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

/** Banner shown above the tab shell while a call is minimized. */
function MinimizedCallBanner() {
  const { callFlow, participantLabel, expandCall } = useCall();

  return (
    <InCallBanner
      participantLabel={participantLabel}
      elapsedCallSeconds={callFlow.elapsedCallSeconds}
      onExpand={expandCall}
    />
  );
}

/** Draggable bubble overlaying the tab shell while a call is minimized. */
function MinimizedCallBubble() {
  const { callFlow, participantLabel, expandCall, endCall, dismissBubble } = useCall();

  return (
    <FloatingCallBubble
      participantLabel={participantLabel}
      elapsedCallSeconds={callFlow.elapsedCallSeconds}
      isMuted={callFlow.isMuted}
      isScreenSharing={callFlow.isScreenSharing}
      onExpand={expandCall}
      onMuteToggle={callFlow.handleMuteToggle}
      onEndCall={endCall}
      onStopScreenShare={callFlow.handleScreenShareToggle}
      onDismiss={dismissBubble}
    />
  );
}

const createStyles = colors =>
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
      backgroundColor: colors.danger,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    degradedBannerText: {
      color: colors.textOnAccent,
      fontSize: 13,
      fontWeight: '700',
    },
  });
