import { useState } from 'react';
import { Platform, SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { logError } from './src/appLogger';
import CallScreen from './src/components/CallScreen';
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
 *      CallScreen once media is connected.
 *   2. **Legacy room-join flow** (`useWebRTCCall`) – user shares a room ID.
 *      Drives the existing Lobby → CallScreen path.
 *
 * All behaviour lives in the hooks; the components are purely presentational.
 */
export default function App() {
  // ── New server-authoritative call flow ────────────────────────────────────
  const callFlow = useCallFlow();

  // ── Legacy direct room-join flow ──────────────────────────────────────────
  const call = useWebRTCCall();

  // Whether the account/connection Settings screen is showing (Lobby only).
  const [showSettings, setShowSettings] = useState(false);

  // Active call source: prefer callFlow when it has a live call/in-call session.
  const callFlowActive =
    callFlow.callPhase !== CALL_PHASES.IDLE || callFlow.isInCall;

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

  let screenContent;

  if (callFlow.isLoadingIdentity) {
    // Blank screen while identity is being loaded from storage; the app
    // transitions to the correct screen once loading completes.
    screenContent = null;
  } else if (!callFlow.isRegistered) {
    screenContent = (
      <RegistrationScreen
        onRegister={(newUserId) => {
          callFlow.registerUser(newUserId).catch((error) => {
            logError('registerUser failed', error);
          });
        }}
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
  } else if (callFlow.isInCall) {
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
        onMuteToggle={callFlow.handleMuteToggle}
        onVideoToggle={callFlow.handleVideoToggle}
        onChooseAudioOutput={callFlow.chooseAudioOutput}
        onCameraSwitch={callFlow.handleCameraSwitch}
        onLeave={callFlow.handleEndCall}
        status={callFlow.status}
        isCompact={callFlow.isCompactView}
      />
    );
  } else if (call.isInRoom) {
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
        onMuteToggle={call.handleMuteToggle}
        onVideoToggle={call.handleVideoToggle}
        onChooseAudioOutput={call.chooseAudioOutput}
        onCameraSwitch={call.handleCameraSwitch}
        onLeave={call.handleRoomButtonPress}
        status={call.status}
        isCompact={call.isCompactView}
      />
    );
  } else if (showSettings) {
    screenContent = (
      <SettingsScreen
        userId={callFlow.userId}
        onSaveUserId={callFlow.updateUserId}
        signalingUrl={callFlow.signalingUrl}
        onSaveSignalingUrl={callFlow.setSignalingUrl}
        onSignOut={() => {
          setShowSettings(false);
          callFlow.unregisterUser().catch((error) => {
            logError('unregisterUser failed', error);
          });
        }}
        onClose={() => setShowSettings(false)}
        onExportLogs={call.handleExportLogs}
        developerModeEnabled={call.settings.developerModeEnabled}
        onToggleDeveloperMode={call.handleDeveloperModeToggle}
      />
    );
  } else {
    screenContent = (
      <Lobby
        userId={callFlow.userId}
        onChangeUserId={callFlow.updateUserId}
        calleeId={callFlow.calleeId}
        onChangeCalleeId={callFlow.setCalleeId}
        onCall={() => {
          callFlow.placeCall().catch((error) => {
            logError('placeCall unhandled rejection', error);
          });
        }}
        calleePresence={callFlow.calleePresence}
        onOpenSettings={() => setShowSettings(true)}
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
        onRedial={(peerId) => {
          callFlow.setCalleeId(peerId);
          callFlow.placeCall(peerId).catch((error) => {
            logError('redial placeCall failed', error);
          });
        }}
      />
    );
  }

  // Compact (Android PiP) mode: replace SafeAreaView with a plain View so
  // system-inset padding is not applied.
  const isCompact = callFlowActive ? callFlow.isCompactView : call.isCompactView;

  return (
    <GestureHandlerRootView style={isCompact ? styles.containerCompact : styles.container}>
      {isCompact ? (
        <View style={styles.containerCompact}>
          {screenContent}
        </View>
      ) : (
        <SafeAreaView style={styles.container}>
          {screenContent}
          <StatusBar barStyle="light-content" backgroundColor={colors.background} translucent={false} />
        </SafeAreaView>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0,
  },
  containerCompact: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
