import { StyleSheet, View } from 'react-native';
import { spacing } from '../theme';
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
  isCompact = false,
}) {
  return (
    <View style={[styles.callScreen, isCompact && styles.callScreenCompact]}>
      {!isCompact ? (
        <CallTopBar
          elapsedCallSeconds={elapsedCallSeconds}
          connectionQuality={connectionQuality}
          participantLabel={participantLabel}
        />
      ) : null}

      {!isCompact && isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}

      <CallStage
        onLayout={onStageLayout}
        mainStreamUrl={mainStreamUrl}
        hasMainStream={hasMainStream}
        pipStreamUrl={pipStreamUrl}
        hasPipStream={hasPipStream}
        mirrorPip={mirrorPip}
        pipGesture={pipGesture}
        animatedPipStyle={animatedPipStyle}
        isMuted={isMuted}
        isVideoEnabled={isVideoEnabled}
        isCompact={isCompact}
      />

      {!isCompact ? (
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
      ) : null}

      {!isCompact ? <StatusBanner status={status} /> : null}
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
  callScreenCompact: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
});
