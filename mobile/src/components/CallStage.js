import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import SafeRTCView from '../SafeRTCView';
import { colors } from '../theme';
import DraggablePip from './DraggablePip';

/**
 * The full-screen video stage: primary stream plus optional PiP self-view.
 *
 * @param {object} props
 * @param {(event: object) => void} props.onLayout
 * @param {string|null} props.mainStreamUrl
 * @param {boolean} props.hasMainStream
 * @param {string|null} props.pipStreamUrl
 * @param {boolean} props.hasPipStream
 * @param {boolean} props.mirrorPip
 * @param {boolean} [props.mirrorMain] - Mirror the main stream (true when local front camera is primary).
 * @param {object} props.pipGesture
 * @param {object} props.animatedPipStyle
 * @param {boolean} [props.isMuted] - Local microphone muted state (forwarded to PiP overlay).
 * @param {boolean} [props.isVideoEnabled] - Local camera on/off state (forwarded to PiP overlay).
 * @param {boolean} [props.isCompact]
 */
export default function CallStage({
  onLayout,
  mainStreamUrl,
  hasMainStream,
  pipStreamUrl,
  hasPipStream,
  mirrorPip,
  mirrorMain = false,
  pipGesture,
  animatedPipStyle,
  isMuted = false,
  isVideoEnabled = true,
  isCompact = false,
}) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  return (
    <View
      style={[
        styles.callStage,
        isCompact && styles.callStageCompact,
        isLandscape && styles.callStageLandscape,
      ]}
      onLayout={onLayout}
    >
      {hasMainStream ? (
        <SafeRTCView
          fallbackLabel="Call video unavailable"
          style={styles.remoteStream}
          streamURL={mainStreamUrl}
          objectFit="cover"
          mirror={mirrorMain}
          zOrder={0}
        />
      ) : (
        <View style={styles.remotePlaceholder}>
          <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
        </View>
      )}

      {!isCompact && hasPipStream ? (
        <DraggablePip
          gesture={pipGesture}
          animatedStyle={animatedPipStyle}
          streamURL={pipStreamUrl}
          mirror={mirrorPip}
          isMuted={isMuted}
          isVideoEnabled={isVideoEnabled}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  callStage: {
    flex: 1,
    minHeight: 0,
    borderRadius: 0,
    overflow: 'hidden',
    marginBottom: 0,
    backgroundColor: colors.stage,
    borderWidth: 0,
  },
  callStageCompact: {
    marginBottom: 0,
    minHeight: 0,
    borderRadius: 0,
    borderWidth: 0,
  },
  callStageLandscape: {
    minHeight: 120,
  },
  remoteStream: {
    flex: 1,
    backgroundColor: colors.stageDark,
  },
  remotePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundAlt,
  },
  remotePlaceholderText: {
    color: colors.textMuted,
    fontSize: 16,
  },
});
