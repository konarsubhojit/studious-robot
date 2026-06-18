import { StyleSheet, Text, View } from 'react-native';
import SafeRTCView from '../SafeRTCView';
import { colors, radius, spacing } from '../theme';
import DraggablePip from './DraggablePip';

/**
 * The video stage: cozy background blobs, the primary remote (or swapped local)
 * stream with a waiting placeholder, and the draggable PiP self-view overlay.
 *
 * @param {object} props
 * @param {(event: object) => void} props.onLayout
 * @param {string|null} props.mainStreamUrl
 * @param {boolean} props.hasMainStream
 * @param {string|null} props.pipStreamUrl
 * @param {boolean} props.hasPipStream
 * @param {boolean} props.mirrorPip
 * @param {object} props.pipGesture
 * @param {object} props.animatedPipStyle
 * @param {boolean} [props.isCompact]
 */
export default function CallStage({
  onLayout,
  mainStreamUrl,
  hasMainStream,
  pipStreamUrl,
  hasPipStream,
  mirrorPip,
  pipGesture,
  animatedPipStyle,
  isCompact = false,
}) {
  return (
    <View style={[styles.callStage, isCompact && styles.callStageCompact]} onLayout={onLayout}>
      <View style={[styles.cozyBlob, styles.cozyBlobTop]} />
      <View style={[styles.cozyBlob, styles.cozyBlobBottom]} />
      {hasMainStream ? (
        <SafeRTCView
          fallbackLabel="Call video unavailable"
          style={styles.remoteStream}
          streamURL={mainStreamUrl}
          objectFit="cover"
          zOrder={0}
        />
      ) : (
        <View style={styles.remotePlaceholder}>
          <Text style={styles.remotePlaceholderText}>Waiting for someone to join…</Text>
        </View>
      )}

      {hasPipStream ? (
        <DraggablePip
          gesture={pipGesture}
          animatedStyle={animatedPipStyle}
          streamURL={pipStreamUrl}
          mirror={mirrorPip}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  callStage: {
    flex: 1,
    minHeight: 280,
    borderRadius: radius.xl,
    overflow: 'hidden',
    marginBottom: spacing.md,
    backgroundColor: colors.stage,
    borderWidth: 1,
    borderColor: colors.borderStage,
  },
  callStageCompact: {
    marginBottom: 0,
  },
  cozyBlob: {
    position: 'absolute',
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: colors.blob,
    opacity: 0.14,
  },
  cozyBlobTop: {
    top: -70,
    left: -45,
  },
  cozyBlobBottom: {
    bottom: -90,
    right: -45,
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
