import { Pressable, StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import useAutoHidingControls from '../hooks/useAutoHidingControls';
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
  // The control deck auto-hides during a call so the video has room to breathe;
  // tapping the stage (or interacting with a control) brings it back.
  const { visible: controlsVisible, reveal, hold } = useAutoHidingControls();

  return (
    <View style={styles.callScreen}>
      <CallTopBar
        elapsedCallSeconds={elapsedCallSeconds}
        connectionQuality={connectionQuality}
        participantLabel={participantLabel}
      />

      {isReconnecting ? <ReconnectBanner onRetry={onRetry} /> : null}

      <Pressable
        style={styles.stagePressable}
        onPress={reveal}
        accessibilityLabel="Show call controls"
        testID="call-stage-tap"
      >
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
      </Pressable>

      <View
        style={[styles.controlDeck, controlsVisible ? null : styles.controlDeckHidden]}
        pointerEvents={controlsVisible ? 'auto' : 'none'}
        onTouchStart={reveal}
        testID="control-deck"
      >
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
          onMenuOpenChange={hold}
        />
      </View>

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
  stagePressable: {
    flex: 1,
  },
  controlDeck: {
    opacity: 1,
  },
  controlDeckHidden: {
    opacity: 0,
  },
  status: {
    color: colors.textMuted,
  },
});
