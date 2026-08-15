import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { logError } from './src/appLogger';
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
  // Presence snapshot for the currently open conversation's peer.
  const [peerPresence, setPeerPresence] = useState(null);
  // True once the user has explicitly (or automatically, via tab switch /
  // hardware back) shrunk an active call down to the FloatingCallBubble.
  const [isCallMinimized, setIsCallMinimized] = useState(false);
  const [isRefreshingConversations, setIsRefreshingConversations] = useState(false);

  // Set by onStartAudioCall; consumed by the effect below once the call
  // connects, since there is no dedicated audio-only call type server-side.
  const pendingAudioOnlyCallRef = useRef(false);

  // Active call source: prefer callFlow when it has a live call/in-call session.
  const callFlowActive =
    callFlow.callPhase !== CALL_PHASES.IDLE || callFlow.isInCall;

  // True once either flow has a connected (post-ringing) call. Drives the
  // minimize affordances; ringing/dialing screens are never minimizable.
  const isCallConnected = callFlow.isInCall || call.isInRoom;

  // Choose which hook provides PiP swap behaviour.
  const { stageSize, handleCallStageLayout, pipGesture, animatedPipStyle } =
    usePictureInPicturePip({
      onTap: callFlowActive ? callFlow.handleSwapStreams : call.handleSwapStreams,
    });
  void stageSize;

  // ── Stream helpers for active call ────────────────────────────────────────

  // Call-flow streams
  const cfMainStream = callFlow.isLocalPrimary ? callFlow.localStream : callFlow.remoteStream;
  const cfPipStream = callFlow.isLocalPrimary ? callFlow.remoteStream : callFlow.localStream;
  const cfMainStreamUrl = getStreamUrl(cfMainStream, 'cf main stream');
  const cfPipStreamUrl = getStreamUrl(cfPipStream, 'cf pip stream');
  const cfMirrorPip = !callFlow.isLocalPrimary && callFlow.isFrontCamera;
  const cfMirrorMain = callFlow.isLocalPrimary && callFlow.isFrontCamera;

  // Legacy streams
  const legacyMainStream = call.isLocalPrimary ? call.localStream : call.remoteStream;
  const legacyPipStream = call.isLocalPrimary ? call.remoteStream : call.localStream;
  const legacyMainStreamUrl = getStreamUrl(legacyMainStream, 'main stream');
  const legacyPipStreamUrl = getStreamUrl(legacyPipStream, 'picture-in-picture stream');
  const legacyMirrorPip = !call.isLocalPrimary && call.isFrontCamera;
  const legacyMirrorMain = call.isLocalPrimary && call.isFrontCamera;
  const localPreviewStreamUrl = getStreamUrl(call.localStream, 'local preview');

  // ── Chat wiring ────────────────────────────────────────────────────────────

  // Fetch the conversation list once identity is established.
  useEffect(() => {
    if (callFlow.isRegistered) {
      callFlow.fetchConversations();
    }
    // Only re-run when registration status flips; fetchConversations is
    // stable for a given signalingUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callFlow.isRegistered]);

  // Keep the hook's activeChatPeerId mirror in sync with the locally open
  // conversation, and load history + mark it read whenever one is opened.
  useEffect(() => {
    callFlow.setActiveChatPeerId(chatPeerId);
    if (chatPeerId) {
      callFlow.fetchMessagesForPeer(chatPeerId);
      callFlow.markConversationRead(chatPeerId);
    }
    return () => {
      callFlow.setActiveChatPeerId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPeerId]);

  // Fetch presence for the peer of the currently open conversation.
  useEffect(() => {
    let cancelled = false;
    if (!chatPeerId) {
      setPeerPresence(null);
      return undefined;
    }
    callFlow.checkPresence(chatPeerId).then((presence) => {
      if (!cancelled) setPeerPresence(presence);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPeerId]);

  const handleRefreshConversations = async () => {
    setIsRefreshingConversations(true);
    try {
      await callFlow.fetchConversations();
    } finally {
      setIsRefreshingConversations(false);
    }
  };

  const handleLoadOlderMessages = () => {
    if (!chatPeerId) return;
    const existing = callFlow.messagesByPeer[chatPeerId] ?? [];
    const oldest = existing[existing.length - 1];
    if (oldest?.createdAt) {
      callFlow.fetchMessagesForPeer(chatPeerId, { before: oldest.createdAt });
    }
  };

  /**
   * Start a video call with `peerId` (used by both the Lobby redial action and
   * the Chats tab's video-call header button).
   */
  const startVideoCallWith = (peerId) => {
    callFlow.setCalleeId(peerId);
    callFlow.placeCall(peerId).catch((error) => {
      logError('placeCall (video) failed', error);
    });
  };

  /**
   * Start an "audio call" with `peerId`. There is no dedicated audio-only call
   * type server-side yet, so this places a normal video call and then turns
   * the local camera off once it connects (see the effect below).
   */
  const startAudioCallWith = (peerId) => {
    pendingAudioOnlyCallRef.current = true;
    callFlow.setCalleeId(peerId);
    callFlow.placeCall(peerId).catch((error) => {
      logError('placeCall (audio) failed', error);
    });
  };

  useEffect(() => {
    if (callFlow.isInCall && pendingAudioOnlyCallRef.current) {
      pendingAudioOnlyCallRef.current = false;
      callFlow.handleVideoToggle();
    }
  }, [callFlow.isInCall, callFlow]);

  // ── Call minimize / restore orchestration ─────────────────────────────────

  // Android hardware back: minimize an active connected call instead of
  // letting the OS pop the screen / exit the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    if (!isCallConnected || isCallMinimized) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setIsCallMinimized(true);
      return true;
    });
    return () => subscription.remove();
  }, [isCallConnected, isCallMinimized]);

  const handleChangeTab = (tab) => {
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
          callFlow.registerUser(newUserId, verificationCode).catch((error) => {
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
          onSendMessage={(body) => callFlow.sendMessage(chatPeerId, body)}
          onLoadOlder={handleLoadOlderMessages}
          onBack={() => setChatPeerId(null)}
          currentUserId={callFlow.userId}
          peerPresence={peerPresence}
          onStartAudioCall={() => startAudioCallWith(chatPeerId)}
          onStartVideoCall={() => startVideoCallWith(chatPeerId)}
          isStartingCall={callFlow.isPlacingCall}
          isPeerTyping={Boolean(callFlow.typingByPeer[chatPeerId])}
          onTypingChange={(isTyping) => callFlow.sendTypingIndicator(chatPeerId, isTyping)}
        />
      ) : (
        <ChatListScreen
          conversations={callFlow.conversations}
          onOpenConversation={(peerId) => setChatPeerId(peerId)}
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
            callFlow.placeCall().catch((error) => {
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
            call.startLocalPreview().catch((error) => {
              logError('startLocalPreview failed (permissions/device)', error);
            });
          }}
          onJoinRoom={call.handleRoomButtonPress}
          isSettingsVisible={call.isSettingsVisible}
          onToggleSettings={() => call.setIsSettingsVisible((previous) => !previous)}
          onExportLogs={call.handleExportLogs}
          settings={call.settings}
          onToggleAutoLighting={call.handleAutoLightingToggle}
          onToggleSpeakerDefault={call.handleSpeakerDefaultToggle}
          status={callFlow.userId ? callFlow.status : call.status}
          callSummary={callFlow.callSummary ?? call.callSummary}
          onDismissSummary={callFlow.callSummary ? callFlow.dismissCallSummary : call.dismissCallSummary}
          callHistory={callFlow.callHistory}
          missedCallCount={callFlow.missedCallCount}
          onMarkMissedRead={callFlow.markMissedCallsRead}
          onRedial={(peerId) => startVideoCallWith(peerId)}
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
            callFlow.unregisterUser().catch((error) => {
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
    !isCompact &&
    !callFlow.isLoadingIdentity &&
    Boolean(callFlow.pendingVerificationCode);

  return (
    <GestureHandlerRootView style={isCompact ? styles.containerCompact : styles.container}>
      {isCompact ? (
        <View style={styles.containerCompact}>
          {screenContent}
        </View>
      ) : (
        <View
          style={[
            styles.container,
            { paddingTop: insets.top, paddingBottom: isTabShellActive ? 0 : insets.bottom },
          ]}
        >
          {screenContent}
          {floatingBubble}
          {shouldShowRecoveryCodeNotice ? (
            <View
              style={[styles.recoveryNotice, { bottom: 16 + (isTabShellActive ? 0 : insets.bottom) }]}
              testID="recovery-code-notice"
            >
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
                style={({ pressed }) => [styles.recoveryNoticeButton, pressed && styles.pressed]}
              >
                <Text style={styles.recoveryNoticeButtonText}>I saved it</Text>
              </Pressable>
            </View>
          ) : null}
          <StatusBar barStyle="light-content" backgroundColor={colors.background} translucent={false} />
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
