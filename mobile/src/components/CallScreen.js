import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import CallControls from './CallControls';
import CallStage from './CallStage';
import CallTopBar from './CallTopBar';
import ReconnectBanner from './ReconnectBanner';
import StatusBanner from './StatusBanner';

/**
 * Full in-call screen: top bar, reconnect banner, video stage, control deck,
 * and the status line.  Purely presentational — all behaviour is supplied via
 * props from the useWebRTCCall / usePictureInPicturePip hooks.
 */
export default function CallScreen({
  elapsedCallSeconds,
  connectionQuality,
  participantLabel,
  isReconnecting,
  onRetry,
  onStageLayout,
  mainStreamUrl,
  hasMainStream,
  pipStreamUrl,
  hasPipStream,
  mirrorPip,
  pipGesture,
  animatedPipStyle,
  isMuted,
  isVideoEnabled,
  hasLocalStream,
  audioDevices,
  isSpeakerEnabled,
  onMuteToggle,
  onVideoToggle,
  onChooseAudioOutput,
  onCameraSwitch,
  onLeave,
  status,
}) {
  return (
    <View style={styles.callScreen}>
      <CallTopBar
        elapsedCallSeconds={elapsedCallSeconds}
        connectionQuality={connectionQuality}
        participantLabel={participantLabel}
      />

      {isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}

      <CallStage
        onLayout={onStageLayout}
        mainStreamUrl={mainStreamUrl}
        hasMainStream={hasMainStream}
        pipStreamUrl={pipStreamUrl}
        hasPipStream={hasPipStream}
        mirrorPip={mirrorPip}
        pipGesture={pipGesture}
        animatedPipStyle={animatedPipStyle}
      />

      <CallControls
        isMuted={isMuted}
        isVideoEnabled={isVideoEnabled}
        hasLocalStream={hasLocalStream}
        audioDevices={audioDevices}
        isSpeakerEnabled={isSpeakerEnabled}
        onMuteToggle={onMuteToggle}
        onVideoToggle={onVideoToggle}
        onChooseAudioOutput={onChooseAudioOutput}
        onCameraSwitch={onCameraSwitch}
        onLeave={onLeave}
      />

      <StatusBanner status={status} style={styles.status} />
    </View>
  );
}

const styles = StyleSheet.create({
  callScreen: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  status: {
    color: colors.textMuted,
  },
});
