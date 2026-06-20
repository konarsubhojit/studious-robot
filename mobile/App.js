import { Platform, SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { logError } from './src/appLogger';
import CallScreen from './src/components/CallScreen';
import Lobby from './src/components/Lobby';
import { getStreamUrl } from './src/diagnostics';
import usePictureInPicturePip from './src/hooks/usePictureInPicturePip';
import useWebRTCCall from './src/hooks/useWebRTCCall';
import { colors } from './src/theme';

/**
 * Thin composition root: wires the call + picture-in-picture hooks to the
 * presentational Lobby / CallScreen components.  All call behaviour lives in
 * `useWebRTCCall`; all draggable-PiP behaviour lives in `usePictureInPicturePip`.
 */
export default function App() {
  const call = useWebRTCCall();
  const { stageSize, handleCallStageLayout, pipGesture, animatedPipStyle } = usePictureInPicturePip({
    onTap: call.handleSwapStreams,
  });
  void stageSize;

  const mainStream = call.isLocalPrimary ? call.localStream : call.remoteStream;
  const pipStream = call.isLocalPrimary ? call.remoteStream : call.localStream;
  const localPreviewStreamUrl = getStreamUrl(call.localStream, 'local preview');
  const mainStreamUrl = getStreamUrl(mainStream, 'main stream');
  const pipStreamUrl = getStreamUrl(pipStream, 'picture-in-picture stream');

  // Mirror only the local stream, and only when the front camera is active.
  // Back-camera output must not be mirrored or it appears spatially inverted.
  const mirrorPip = !call.isLocalPrimary && call.isFrontCamera;
  const mirrorMain = call.isLocalPrimary && call.isFrontCamera;

  // In compact (Android PiP) mode replace SafeAreaView with a plain View so
  // system-inset padding is not applied — the PiP window has no status bar or
  // navigation bar, so those insets would create blank black margins.
  const screenContent = call.isInRoom ? (
    <CallScreen
      elapsedCallSeconds={call.elapsedCallSeconds}
      connectionQuality={call.connectionQuality}
      participantLabel={call.roomId ? `Room ${call.roomId.trim()}` : null}
      isReconnecting={call.isReconnecting}
      onRetry={call.handleRetryReconnect}
      onStageLayout={handleCallStageLayout}
      mainStreamUrl={mainStreamUrl}
      hasMainStream={Boolean(mainStream)}
      pipStreamUrl={pipStreamUrl}
      hasPipStream={Boolean(pipStream)}
      mirrorPip={mirrorPip}
      mirrorMain={mirrorMain}
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
  ) : (
    <Lobby
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
      status={call.status}
      callSummary={call.callSummary}
      onDismissSummary={call.dismissCallSummary}
    />
  );

  return (
    <GestureHandlerRootView style={call.isCompactView ? styles.containerCompact : styles.container}>
      {call.isCompactView ? (
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
