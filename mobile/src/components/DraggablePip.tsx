import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import SafeRTCView from '../SafeRTCView';
import { PIP_HEIGHT, PIP_WIDTH } from '../pipConstants';
import { useThemedStyles } from '../ThemeContext';
import { overlay, radius, spacing, typography } from '../theme';
import type { Gesture } from 'react-native-gesture-handler';
import type { ThemeColors } from '../theme';

export type DraggablePipProps = {
  /** Composed gesture from the PiP hook. */
  gesture: ReturnType<typeof Gesture.Race>;
  /** Animated transform style. */
  animatedStyle: object;
  streamURL: string | null;
  /** True when this tile shows the local stream. */
  mirror: boolean;
  /** Local microphone is muted. */
  isMuted?: boolean;
  /** Local camera is on. */
  isVideoEnabled?: boolean;
};

/**
 * Draggable picture-in-picture self-view. Tap swaps streams; drag repositions
 * (gesture supplied by the usePictureInPicturePip hook).
 *
 * When the PiP represents the local user (`mirror=true`), visual overlays are
 * shown to communicate muted and camera-off states at a glance.
 */
export default function DraggablePip({
  gesture,
  animatedStyle,
  streamURL,
  mirror,
  isMuted = false,
  isVideoEnabled = true,
}: DraggablePipProps) {
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

/** @param colors */
const createStyles = (colors: ThemeColors) =>
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
      backgroundColor: overlay.scrimStrong,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xs,
    },
    videoOffText: {
      color: colors.onOverlay,
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
      backgroundColor: overlay.scrimMedium,
    },
    muteBadgeText: {
      color: colors.onOverlay,
      fontSize: 11,
      fontWeight: '700',
    },
  });
