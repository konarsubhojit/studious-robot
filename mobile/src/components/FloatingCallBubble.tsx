import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { formatCallDuration } from '../callUx';
import { triggerHaptic } from '../haptics';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import IconButton from './IconButton';
import type { ThemeColors } from '../theme';

const BUBBLE_WIDTH = 180;
const BUBBLE_HEIGHT = 72;
const BUBBLE_MARGIN = 12;

/** Spring used when the bubble settles against the nearest screen edge. */
const SNAP_SPRING = { damping: 18, stiffness: 180, mass: 0.6 };

/** Horizontal fling speed (px/s) above which the bubble is dismissed. */
const FLING_DISMISS_VELOCITY = 1200;

/** Duration of the fling-out animation played before `onDismiss` fires. */
const DISMISS_DURATION_MS = 160;

export type FloatingCallBubbleProps = {
  participantLabel?: string | null;
  elapsedCallSeconds?: number;
  isMuted?: boolean;
  isScreenSharing?: boolean;
  onExpand: () => void;
  onMuteToggle?: () => void;
  onEndCall?: () => void;
  onStopScreenShare?: () => void;
  /** Called once the bubble has been flung off-screen. When omitted, fling-to-dismiss is disabled and a fling just springs the bubble back to the nearest edge. */
  onDismiss?: () => void;
};

/**
 * In-app floating call bubble: a small draggable "call in progress" pill,
 * shown when the user navigates away from the full-screen CallScreen while a
 * call stays active (e.g. taps a bottom tab, or the explicit minimize button
 * in CallTopBar).
 *
 * This is the in-app analogue of Teams/Slack's floating call bubble, and is
 * distinct from the OS-level Android Picture-in-Picture already handled by
 * `useCompactCallView` / `enterPictureInPicture`: OS PiP only ever fires when
 * the app is backgrounded, whereas this bubble only appears while the app is
 * foregrounded and the user has simply navigated to another in-app screen.
 *
 * The drag runs on react-native-gesture-handler + react-native-reanimated, so
 * every frame is computed on the UI thread (no JS round trip); on release the
 * bubble springs to the nearest horizontal screen edge, and a fast sideways
 * fling animates it off-screen and reports `onDismiss`.
 */
export default function FloatingCallBubble({
  participantLabel = null,
  elapsedCallSeconds = 0,
  isMuted = false,
  isScreenSharing = false,
  onExpand,
  onMuteToggle,
  onEndCall,
  onStopScreenShare,
  onDismiss,
}: FloatingCallBubbleProps) {
  const styles = useThemedStyles(createStyles);

  const { width, height } = useWindowDimensions();

  const maxX = Math.max(BUBBLE_MARGIN, width - BUBBLE_WIDTH - BUBBLE_MARGIN);
  const maxY = Math.max(BUBBLE_MARGIN, height - BUBBLE_HEIGHT - BUBBLE_MARGIN);

  // Bounds are shared values as well, so the UI-thread drag worklets can read
  // them without crossing back to the JS thread.
  const boundMaxX = useSharedValue(maxX);
  const boundMaxY = useSharedValue(maxY);

  const translateX = useSharedValue(maxX);
  const translateY = useSharedValue(maxY);
  const startX = useSharedValue(maxX);
  const startY = useSharedValue(maxY);
  const opacity = useSharedValue(1);
  // Readable from the drag worklet, which must not dismiss the bubble when no
  // caller is listening (it would animate away with no way to bring it back).
  const canDismiss = useSharedValue(Boolean(onDismiss));

  useEffect(() => {
    boundMaxX.value = maxX;
    boundMaxY.value = maxY;
    translateX.value = Math.min(Math.max(translateX.value, BUBBLE_MARGIN), maxX);
    translateY.value = Math.min(Math.max(translateY.value, BUBBLE_MARGIN), maxY);
  }, [boundMaxX, boundMaxY, maxX, maxY, translateX, translateY]);

  // Keeps the latest dismiss callback reachable from the stable JS function
  // the drag worklet hands to runOnJS.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
    canDismiss.value = Boolean(onDismiss);
  }, [canDismiss, onDismiss]);

  const handleDismiss = useCallback(() => {
    triggerHaptic('tap');
    onDismissRef.current?.();
  }, []);

  const gesture = Gesture.Pan()
    .minDistance(2)
    .onStart(() => {
      'worklet';
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate(event => {
      'worklet';
      translateX.value = Math.min(
        Math.max(startX.value + event.translationX, BUBBLE_MARGIN),
        boundMaxX.value,
      );
      translateY.value = Math.min(
        Math.max(startY.value + event.translationY, BUBBLE_MARGIN),
        boundMaxY.value,
      );
    })
    .onEnd(event => {
      'worklet';
      if (canDismiss.value && Math.abs(event.velocityX) > FLING_DISMISS_VELOCITY) {
        const exitX = event.velocityX > 0 ? boundMaxX.value + BUBBLE_WIDTH : -BUBBLE_WIDTH;
        opacity.value = withTiming(0, { duration: DISMISS_DURATION_MS });
        translateX.value = withTiming(exitX, { duration: DISMISS_DURATION_MS }, finished => {
          if (finished) {
            runOnJS(handleDismiss)();
          }
        });
        return;
      }

      // Otherwise settle against whichever horizontal edge is closest.
      const snapTarget =
        translateX.value < (BUBBLE_MARGIN + boundMaxX.value) / 2 ? BUBBLE_MARGIN : boundMaxX.value;
      translateX.value = withSpring(snapTarget, SNAP_SPRING);
      translateY.value = withSpring(
        Math.min(Math.max(translateY.value, BUBBLE_MARGIN), boundMaxY.value),
        SNAP_SPRING,
      );
    });

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  const handleExpand = useCallback(() => {
    triggerHaptic('tap');
    onExpand?.();
  }, [onExpand]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        entering={ZoomIn.springify()}
        exiting={ZoomOut}
        style={[styles.bubble, animatedStyle]}
        testID="floating-call-bubble">
        <Pressable
          onPress={handleExpand}
          style={styles.body}
          accessibilityRole="button"
          accessibilityLabel="Expand call"
          testID="floating-call-bubble-expand">
          <Text style={styles.glyph}>📞</Text>
          <View style={styles.textWrap}>
            <Text style={styles.label} numberOfLines={1}>
              {participantLabel || 'Call in progress'}
            </Text>
            <Text style={styles.timer}>{formatCallDuration(elapsedCallSeconds)}</Text>
          </View>
        </Pressable>

        <View style={styles.actions}>
          <IconButton
            icon={isMuted ? 'micOff' : 'micOn'}
            onPress={onMuteToggle}
            variant={isMuted ? 'active' : 'default'}
            size={32}
            accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            testID="floating-call-bubble-mute"
          />
          {isScreenSharing ? (
            <IconButton
              icon="stopShare"
              onPress={onStopScreenShare}
              variant="active"
              size={32}
              accessibilityLabel="Stop sharing your screen"
              testID="floating-call-bubble-stop-share"
            />
          ) : null}
          <IconButton
            icon="callEnd"
            onPress={onEndCall}
            variant="danger"
            size={32}
            accessibilityLabel="End call"
            testID="floating-call-bubble-end"
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bubble: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: BUBBLE_WIDTH,
      height: BUBBLE_HEIGHT,
      borderRadius: radius.lg,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.border,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      gap: spacing.xs,
      shadowColor: colors.shadow,
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 8,
      zIndex: 999,
    },
    body: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      gap: spacing.xs,
    },
    glyph: {
      fontSize: 20,
    },
    textWrap: {
      flexShrink: 1,
    },
    label: {
      ...typography.hint,
      color: colors.textPrimary,
      fontWeight: '700',
    },
    timer: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
  });
