// @ts-check
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import SafeRTCView from '../SafeRTCView';
import { PIP_HEIGHT, PIP_WIDTH } from '../pipConstants';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';

/**
 * Draggable picture-in-picture self-view. Tap swaps streams; drag repositions
 * (gesture supplied by the usePictureInPicturePip hook).
 *
 * When the PiP represents the local user (`mirror=true`), visual overlays are
 * shown to communicate muted and camera-off states at a glance.
 *
 * @param {object} props
 * @param {ReturnType<typeof import('react-native-gesture-handler').Gesture.Race>} props.gesture
 *   Composed gesture from the PiP hook.
 * @param {object} props.animatedStyle - Animated transform style.
 * @param {string|null} props.streamURL
 * @param {boolean} props.mirror - True when this tile shows the local stream.
 * @param {boolean} [props.isMuted] - Local microphone is muted.
 * @param {boolean} [props.isVideoEnabled] - Local camera is on.
 */
export default function DraggablePip({
  gesture,
  animatedStyle,
  streamURL,
  mirror,
  isMuted = false,
  isVideoEnabled = true,
}) {
  const styles = useThemedStyles(createStyles);

  const showVideoOff = mirror && !isVideoEnabled;
  const showMutedBadge = mirror && isMuted;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.localPip, animatedStyle]}
        accessibilityRole="adjustable"
        accessibilityLabel="Self view. Tap to swap, drag to move.">
        <SafeRTCView
          fallbackLabel="Self-view unavailable"
          style={styles.localPipStream}
          streamURL={streamURL}
          objectFit="cover"
          mirror={mirror}
          zOrder={2}
        />

        {showVideoOff ? (
          <View style={styles.videoOffOverlay} accessibilityLabel="Camera off">
            <Text style={styles.videoOffText}>Camera off</Text>
          </View>
        ) : null}

        {showMutedBadge ? (
          <View style={styles.muteBadge} accessibilityLabel="Microphone muted">
            <Text style={styles.muteBadgeText}>Muted</Text>
          </View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    localPip: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
      borderRadius: radius.md,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: colors.accent,
      backgroundColor: colors.pipBackground,
    },
    localPipStream: {
      flex: 1,
    },
    videoOffOverlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.72)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xs,
    },
    videoOffText: {
      color: colors.textPrimary,
      ...typography.hint,
      fontWeight: '600',
      textAlign: 'center',
    },
    muteBadge: {
      position: 'absolute',
      bottom: spacing.xs,
      left: spacing.xs,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.xs + 2,
      paddingVertical: 2,
      backgroundColor: 'rgba(0,0,0,0.65)',
    },
    muteBadgeText: {
      color: colors.textPrimary,
      fontSize: 11,
      fontWeight: '700',
    },
  });
