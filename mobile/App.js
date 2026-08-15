import { useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from './src/appLogger';
import { deriveCallStreams } from './src/callStreamHelpers';
import AppTabBar from './src/components/AppTabBar';
import CallScreen from './src/components/CallScreen';
import ChatConversationScreen from './src/components/ChatConversationScreen';
import ChatListScreen from './src/components/ChatListScreen';
import FloatingCallBubble from './src/components/FloatingCallBubble';
import IncomingCallScreen from './src/components/IncomingCallScreen';
import Lobby from './src/components/Lobby';
import OutgoingCallScreen from './src/components/OutgoingCallScreen';
import RegistrationScreen from './src/components/RegistrationScreen';
import SettingsScreen from './src/components/SettingsScreen';
import { getStreamUrl } from './src/diagnostics';
import { CALL_PHASES } from './src/hooks/useCallFlow';
import useCallFlow from './src/hooks/useCallFlow';
import useCallInitiation from './src/hooks/useCallInitiation';
import useCallMinimize from './src/hooks/useCallMinimize';
import useChatSync from './src/hooks/useChatSync';
import usePictureInPicturePip from './src/hooks/usePictureInPicturePip';
import useWebRTCCall from './src/hooks/useWebRTCCall';
import { colors } from './src/theme';

/**
 * Thin composition root: wires the call hooks to the presentational screens.
 *
 * Two call paths are supported:
 *   1. **Server-authoritative call flow** (`useCallFlow`) – user places / receives
 *      calls by userId.  Drives OutgoingCallScreen, IncomingCallScreen, and
 *      CallScreen once media is connected.  Also owns text chat (conversations,
 *      messages) and the `call.media-state` screen-share relay.
 *   2. **Legacy direct room-join flow** (`useWebRTCCall`) – user shares a room ID.
 *      Drives the existing Lobby → CallScreen path.
 *
 * Navigation shell: once identity is registered and no call is ringing, the
 * app renders a lightweight hand-rolled tab shell (Chats / Calls / Settings)
 * built from plain state + View/Pressable — no react-navigation or other new
 * native dependency, so it stays verifiable with the existing Jest setup.
 * A connected call normally takes over the full screen (as before); pressing
 * the minimize button in `CallTopBar`, tapping a bottom tab, or the Android
 * hardware back button instead shrinks it to a small draggable
 * `FloatingCallBubble` overlaid on top of the tab shell, so the user can keep
 * chatting/browsing while the call continues in the background of the app
 * (distinct from the OS-level Android Picture-in-Picture, which only engages
 * when the app itself is backgrounded — see `useCompactCallView`).
 *
 * All behaviour lives in the hooks; the components are purely presentational.
 */
export default function App() {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

/**
 * Everything the composition root used to do, now nested inside
 * `SafeAreaProvider` so it can read real device insets (status bar / notch,
 * and the bottom gesture-navigation / 3-button bar) via `useSafeAreaInsets`
 * instead of the iOS-only, Android-no-op `SafeAreaView` from `react-native`.
 */
function AppShell() {
  // ── New server-authoritative call flow ────────────────────────────────────
  const callFlow = useCallFlow();

  // ── Legacy direct room-join flow ──────────────────────────────────────────
  const call = useWebRTCCall();

  // ── Navigation shell state ─────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('chats');
  // peerId of the conversation open within the Chats tab; null = chat list.
  const [chatPeerId, setChatPeerId] = useState(null);

  // Active call source: prefer callFlow when it has a live call/in-call session.
  const callFlowActive = callFlow.callPhase !== CALL_PHASES.IDLE || callFlow.isInCall;

  // True once either flow has a connected (post-ringing) call. Drives the
  // minimize affordances; ringing/dialing screens are never minimizable.
  const isCallConnected = callFlow.isInCall || call.isInRoom;

  // ── Call minimize / restore orchestration ─────────────────────────────────
  const { isCallMinimized, setIsCallMinimized } = useCallMinimize(isCallConnected);

  // Choose which hook provides PiP swap behaviour.
  const { stageSize, handleCallStageLayout, pipGesture, animatedPipStyle } = usePictureInPicturePip(
    {
      onTap: callFlowActive ? callFlow.handleSwapStreams : call.handleSwapStreams,
    },
  );
  void stageSize;

  // ── Stream helpers for active call ────────────────────────────────────────

  // Call-flow streams
  const {
    mainStream: cfMainStream,
    pipStream: cfPipStream,
    mainStreamUrl: cfMainStreamUrl,
    pipStreamUrl: cfPipStreamUrl,
    mirrorPip: cfMirrorPip,
    mirrorMain: cfMirrorMain,
  } = deriveCallStreams({
    isLocalPrimary: callFlow.isLocalPrimary,
    localStream: callFlow.localStream,
    remoteStream: callFlow.remoteStream,
    isFrontCamera: callFlow.isFrontCamera,
    mainLabel: 'cf main stream',
    pipLabel: 'cf pip stream',
  });

  // Legacy streams
  const {
    mainStream: legacyMainStream,
    pipStream: legacyPipStream,
    mainStreamUrl: legacyMainStreamUrl,
    pipStreamUrl: legacyPipStreamUrl,
    mirrorPip: legacyMirrorPip,
    mirrorMain: legacyMirrorMain,
  } = deriveCallStreams({
    isLocalPrimary: call.isLocalPrimary,
    localStream: call.localStream,
    remoteStream: call.remoteStream,
    isFrontCamera: call.isFrontCamera,
    mainLabel: 'main stream',
    pipLabel: 'picture-in-picture stream',
  });
  const localPreviewStreamUrl = getStreamUrl(call.localStream, 'local preview');

  // ── Chat wiring ────────────────────────────────────────────────────────────

  const { peerPresence, isRefreshingConversations, handleRefreshConversations, handleLoadOlderMessages } =
    useChatSync({
    chatPeerId,
    isRegistered: callFlow.isRegistered,
    messagesByPeer: callFlow.messagesByPeer,
    fetchConversations: callFlow.fetchConversations,
    setActiveChatPeerId: callFlow.setActiveChatPeerId,
    fetchMessagesForPeer: callFlow.fetchMessagesForPeer,
    markConversationRead: callFlow.markConversationRead,
    checkPresence: callFlow.checkPresence,
  });

  // ── Call initiation (video / audio-only) ──────────────────────────────────

  const { startVideoCallWith, startAudioCallWith } = useCallInitiation({
    isInCall: callFlow.isInCall,
    setCalleeId: callFlow.setCalleeId,
    placeCall: callFlow.placeCall,
    handleVideoToggle: callFlow.handleVideoToggle,
  });

  const handleChangeTab = tab => {
    if (isCallConnected && !isCallMinimized) {
      setIsCallMinimized(true);
    }
    setActiveTab(tab);
  };

  const handleEndCallFlowCall = () => {
    setIsCallMinimized(false);
    callFlow.handleEndCall();
  };

  const handleEndLegacyCall = () => {
    setIsCallMinimized(false);
    call.handleRoomButtonPress();
  };

  // ── Screen routing ────────────────────────────────────────────────────────

  /**
   * Derive the participant label shown in the call-flow CallScreen top bar.
   * Shows the remote party's userId: the callerId when the local user is the
   * callee (isLocalPrimary = false) and the calleeId when they are the caller.
   */
  function getCallFlowParticipantLabel() {
    const ac = callFlow.activeCall;
    if (!ac?.callerId || !ac?.calleeId) return null;
    const remoteId = callFlow.isLocalPrimary ? ac.calleeId : ac.callerId;
    return `Call with ${remoteId}`;
  }

  // Compact (Android PiP) mode: replace SafeAreaView with a plain View so
  // system-inset padding is not applied. OS PiP always short-circuits to the
  // compact CallScreen, taking precedence over the in-app minimize state.
  const isCompact = callFlowActive ? callFlow.isCompactView : call.isCompactView;

  const insets = useSafeAreaInsets();

  let screenContent;
  let floatingBubble = null;
  // True only for the tab-shell branch below; AppTabBar renders its own
  // bottom-safe-area padding in that case, so the outer container must not
  // *also* pad for it (that would leave a double gap under the tab bar).
  let isTabShellActive = false;

  if (callFlow.isLoadingIdentity) {
    // Blank screen while identity is being loaded from storage; the app
    // transitions to the correct screen once loading completes.
    screenContent = null;
  } else if (!callFlow.isRegistered) {
    screenContent = (
      <RegistrationScreen
        onRegister={(newUserId, verificationCode) => {
          callFlow.registerUser(newUserId, verificationCode).catch(error => {
            logError('registerUser failed', error);
          });
        }}
        status={callFlow.status}
      />
    );
  } else if (callFlow.callPhase === CALL_PHASES.OUTGOING_RINGING) {
    screenContent = (
      <OutgoingCallScreen
        calleeId={callFlow.calleeId}
        activeCall={callFlow.activeCall}
        status={callFlow.status}
        onCancel={callFlow.cancelOutgoingCall}
      />
    );
  } else if (callFlow.callPhase === CALL_PHASES.INCOMING_RINGING) {
    screenContent = (
      <IncomingCallScreen
        incomingCall={callFlow.incomingCall}
        status={callFlow.status}
        onAccept={callFlow.acceptIncomingCall}
        onDecline={callFlow.declineIncomingCall}
      />
    );
  } else if (callFlow.isInCall && (isCompact || !isCallMinimized)) {
    // In-call screen driven by the new call flow.
    screenContent = (
      <CallScreen
        elapsedCallSeconds={callFlow.elapsedCallSeconds}
        connectionQuality={callFlow.connectionQuality}
        participantLabel={getCallFlowParticipantLabel()}
        isReconnecting={callFlow.isReconnecting}
        onRetry={callFlow.handleRetryReconnect}
        onStageLayout={handleCallStageLayout}
        mainStreamUrl={cfMainStreamUrl}
        hasMainStream={Boolean(cfMainStream)}
        pipStreamUrl={cfPipStreamUrl}
        hasPipStream={Boolean(cfPipStream)}
        mirrorPip={cfMirrorPip}
        mirrorMain={cfMirrorMain}
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
        onLeave={handleEndCallFlowCall}
        onMinimize={() => setIsCallMinimized(true)}
        status={callFlow.status}
        isCompact={callFlow.isCompactView}
      />
    );
  } else if (call.isInRoom && (isCompact || !isCallMinimized)) {
    // In-call screen driven by the legacy room-join flow.
    screenContent = (
      <CallScreen
        elapsedCallSeconds={call.elapsedCallSeconds}
        connectionQuality={call.connectionQuality}
        participantLabel={call.roomId ? `Room ${call.roomId.trim()}` : null}
        isReconnecting={call.isReconnecting}
        onRetry={call.handleRetryReconnect}
        onStageLayout={handleCallStageLayout}
        mainStreamUrl={legacyMainStreamUrl}
        hasMainStream={Boolean(legacyMainStream)}
        pipStreamUrl={legacyPipStreamUrl}
        hasPipStream={Boolean(legacyPipStream)}
        mirrorPip={legacyMirrorPip}
        mirrorMain={legacyMirrorMain}
        pipGesture={pipGesture}
        animatedPipStyle={animatedPipStyle}
        isMuted={call.isMuted}
        isVideoEnabled={call.isVideoEnabled}
        hasLocalStream={Boolean(call.localStream)}
        audioDevices={call.audioDevices}
        isSpeakerEnabled={call.isSpeakerEnabled}
        isScreenSharing={call.isScreenSharing}
        isScreenAudioEnabled={call.isScreenAudioEnabled}
        isScreenAudioShared={call.isScreenAudioShared}
        isScreenShareSupported={call.isScreenShareSupported}
        onMuteToggle={call.handleMuteToggle}
        onVideoToggle={call.handleVideoToggle}
        onChooseAudioOutput={call.chooseAudioOutput}
        onCameraSwitch={call.handleCameraSwitch}
        onScreenShareToggle={call.handleScreenShareToggle}
        onScreenAudioToggle={call.handleScreenAudioToggle}
        onLeave={handleEndLegacyCall}
        onMinimize={() => setIsCallMinimized(true)}
        status={call.status}
        isCompact={call.isCompactView}
      />
    );
  } else {
    // No full-screen call to show: render the tab shell. A connected call
    // that has been explicitly minimized overlays a FloatingCallBubble on top.
    isTabShellActive = true;
    let tabContent;
    if (activeTab === 'chats') {
      tabContent = chatPeerId ? (
        <ChatConversationScreen
          peerId={chatPeerId}
          messages={callFlow.messagesByPeer[chatPeerId] ?? []}
          onSendMessage={body => callFlow.sendMessage(chatPeerId, body)}
          onLoadOlder={handleLoadOlderMessages}
          onBack={() => setChatPeerId(null)}
          currentUserId={callFlow.userId}
          peerPresence={peerPresence}
          onStartAudioCall={() => startAudioCallWith(chatPeerId)}
          onStartVideoCall={() => startVideoCallWith(chatPeerId)}
          isStartingCall={callFlow.isPlacingCall}
          isPeerTyping={Boolean(callFlow.typingByPeer[chatPeerId])}
          onTypingChange={isTyping => callFlow.sendTypingIndicator(chatPeerId, isTyping)}
        />
      ) : (
        <ChatListScreen
          conversations={callFlow.conversations}
          onOpenConversation={peerId => setChatPeerId(peerId)}
          onSearchUsers={callFlow.searchUsers}
          onRefresh={handleRefreshConversations}
          isRefreshing={isRefreshingConversations}
          onOpenSettings={() => setActiveTab('settings')}
        />
      );
    } else if (activeTab === 'calls') {
      tabContent = (
        <Lobby
          userId={callFlow.userId}
          onChangeUserId={callFlow.editUserId}
          calleeId={callFlow.calleeId}
          onChangeCalleeId={callFlow.setCalleeId}
          onCall={() => {
            callFlow.placeCall().catch(error => {
              logError('placeCall unhandled rejection', error);
            });
          }}
          calleePresence={callFlow.calleePresence}
          onOpenSettings={() => setActiveTab('settings')}
          isServerUnreachable={callFlow.isServerUnreachable}
          onRetryConnect={callFlow.retryPresenceConnect}
          onSearchUsers={callFlow.searchUsers}
          onSelectContact={callFlow.setCalleeId}
          developerMode={call.settings.developerModeEnabled}
          signalingUrl={call.signalingUrl}
          onChangeSignalingUrl={call.setSignalingUrl}
          roomId={call.roomId}
          onChangeRoomId={call.setRoomId}
          localPreviewStreamUrl={localPreviewStreamUrl}
          hasLocalStream={Boolean(call.localStream)}
          onStartPreview={() => {
            call.startLocalPreview().catch(error => {
              logError('startLocalPreview failed (permissions/device)', error);
            });
          }}
          onJoinRoom={call.handleRoomButtonPress}
          isSettingsVisible={call.isSettingsVisible}
          onToggleSettings={() => call.setIsSettingsVisible(previous => !previous)}
          onExportLogs={call.handleExportLogs}
          settings={call.settings}
          onToggleAutoLighting={call.handleAutoLightingToggle}
          onToggleSpeakerDefault={call.handleSpeakerDefaultToggle}
          status={callFlow.userId ? callFlow.status : call.status}
          callSummary={callFlow.callSummary ?? call.callSummary}
          onDismissSummary={
            callFlow.callSummary ? callFlow.dismissCallSummary : call.dismissCallSummary
          }
          callHistory={callFlow.callHistory}
          missedCallCount={callFlow.missedCallCount}
          onMarkMissedRead={callFlow.markMissedCallsRead}
          onRedial={peerId => startVideoCallWith(peerId)}
        />
      );
    } else {
      tabContent = (
        <SettingsScreen
          userId={callFlow.userId}
          onSaveUserId={callFlow.updateUserId}
          signalingUrl={callFlow.signalingUrl}
          onSaveSignalingUrl={callFlow.setSignalingUrl}
          verificationCode={callFlow.verificationCode}
          status={callFlow.status}
          onSignOut={() => {
            setActiveTab('chats');
            callFlow.unregisterUser().catch(error => {
              logError('unregisterUser failed', error);
            });
          }}
          onClose={() => setActiveTab('chats')}
          onExportLogs={call.handleExportLogs}
          developerModeEnabled={call.settings.developerModeEnabled}
          onToggleDeveloperMode={call.handleDeveloperModeToggle}
        />
      );
    }

    screenContent = (
      <View style={styles.tabShellRoot} testID="app-tab-shell">
        <View style={styles.tabShellContent}>{tabContent}</View>
        <AppTabBar
          activeTab={activeTab}
          onChangeTab={handleChangeTab}
          unreadCount={callFlow.unreadTotal}
          bottomInset={insets.bottom}
        />
      </View>
    );

    if (isCallConnected && isCallMinimized) {
      const isCallFlowActive = callFlow.isInCall;
      floatingBubble = (
        <FloatingCallBubble
          participantLabel={
            isCallFlowActive
              ? getCallFlowParticipantLabel()
              : call.roomId
              ? `Room ${call.roomId.trim()}`
              : null
          }
          elapsedCallSeconds={
            isCallFlowActive ? callFlow.elapsedCallSeconds : call.elapsedCallSeconds
          }
          isMuted={isCallFlowActive ? callFlow.isMuted : call.isMuted}
          isScreenSharing={isCallFlowActive ? callFlow.isScreenSharing : call.isScreenSharing}
          onExpand={() => setIsCallMinimized(false)}
          onMuteToggle={isCallFlowActive ? callFlow.handleMuteToggle : call.handleMuteToggle}
          onEndCall={isCallFlowActive ? handleEndCallFlowCall : handleEndLegacyCall}
          onStopScreenShare={
            isCallFlowActive ? callFlow.handleScreenShareToggle : call.handleScreenShareToggle
          }
        />
      );
    }
  }

  const shouldShowRecoveryCodeNotice =
    !isCompact && !callFlow.isLoadingIdentity && Boolean(callFlow.pendingVerificationCode);

  // Padding depends on runtime-only values (measured safe-area insets, and
  // whether the tab shell — which pads its own bottom edge — is active), so
  // it can't live in the static StyleSheet below; computed once per render
  // instead of as an inline object literal in JSX.
  const rootContainerStyle = {
    paddingTop: insets.top,
    paddingBottom: isTabShellActive ? 0 : insets.bottom,
  };

  return (
    <GestureHandlerRootView style={isCompact ? styles.containerCompact : styles.container}>
      {isCompact ? (
        <View style={styles.containerCompact}>{screenContent}</View>
      ) : (
        <View style={[styles.container, rootContainerStyle]}>
          {screenContent}
          {floatingBubble}
          {shouldShowRecoveryCodeNotice ? (
            <View
              style={[
                styles.recoveryNotice,
                { bottom: 16 + (isTabShellActive ? 0 : insets.bottom) },
              ]}
              testID="recovery-code-notice">
              <Text style={styles.recoveryNoticeTitle}>Your recovery code</Text>
              <Text style={styles.recoveryNoticeCode}>{callFlow.pendingVerificationCode}</Text>
              <Text style={styles.recoveryNoticeText}>
                Save this code. You’ll need it to use this username on another device.
              </Text>
              <Pressable
                onPress={callFlow.dismissVerificationCodeNotice}
                accessibilityRole="button"
                accessibilityLabel="I saved it"
                testID="recovery-code-dismiss"
                style={({ pressed }) => [styles.recoveryNoticeButton, pressed && styles.pressed]}>
                <Text style={styles.recoveryNoticeButtonText}>I saved it</Text>
              </Pressable>
            </View>
          ) : null}
          <StatusBar
            barStyle="light-content"
            backgroundColor={colors.background}
            translucent={false}
          />
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  containerCompact: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tabShellRoot: {
    flex: 1,
  },
  tabShellContent: {
    flex: 1,
  },
  recoveryNotice: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  recoveryNoticeTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  recoveryNoticeCode: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 8,
  },
  recoveryNoticeText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  recoveryNoticeButton: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: colors.accentButton,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recoveryNoticeButtonText: {
    color: colors.textOnAccent,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.82,
  },
});
