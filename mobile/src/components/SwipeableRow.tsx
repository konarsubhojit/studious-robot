import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { triggerHaptic } from '../haptics';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import type { ThemeColors } from '../theme';

/** Width (dp) of a single revealed action button. */
const ACTION_WIDTH = 84;
/** Horizontal movement (dp) before the row claims the gesture from the list. */
const GESTURE_ACTIVATION_DX = 12;
/** Fraction of the action tray that must be revealed to snap it open. */
const OPEN_THRESHOLD = 0.5;
/** Spring used when the tray latches open or springs shut. */
const SETTLE_SPRING = { damping: 20, stiffness: 220, mass: 0.5 };

/**
 * A list row that reveals action buttons when dragged to the left, closing
 * again once an action is tapped or the row is dragged back.
 *
 * The drag runs on react-native-gesture-handler + react-native-reanimated, so
 * the row tracks the finger entirely on the UI thread.  Under `PanResponder`
 * every frame crossed the bridge, which is exactly the wrong place for a
 * gesture that happens while a virtualized list is also busy recycling rows.
 *
 * `activeOffsetX` / `failOffsetY` hand the horizontal/vertical arbitration to
 * the native gesture system instead of the hand-rolled dx-vs-dy comparison the
 * `PanResponder` version used, so the parent list keeps its vertical scroll.
 *
 * @param [props.actions]
 */
export default function SwipeableRow({ actions = [], children }: {
        actions?: Array<{
            key: string; label: string; accessibilityLabel?: string;
            testID?: string; onPress: () => void; destructive?: boolean;
        }>; children: React.ReactNode;
    }) {
  const styles = useThemedStyles(createStyles);
  const translateX = useSharedValue(0);
  // The offset the current drag started from, so a second swipe continues
  // from wherever the tray was left rather than snapping back to zero.
  const startX = useSharedValue(0);
  const trayWidth = actions.length * ACTION_WIDTH;

  // A short tick when the tray latches open, so the row confirms itself
  // without the user having to look away from the list.
  const notifyOpened = useCallback(() => triggerHaptic('tap'), []);

  const panGesture = Gesture.Pan()
    .enabled(trayWidth > 0)
    .activeOffsetX([-GESTURE_ACTIVATION_DX, GESTURE_ACTIVATION_DX])
    .failOffsetY([-GESTURE_ACTIVATION_DX, GESTURE_ACTIVATION_DX])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate(event => {
      translateX.value = Math.min(0, Math.max(-trayWidth, startX.value + event.translationX));
    })
    .onEnd(() => {
      const shouldOpen = translateX.value < -trayWidth * OPEN_THRESHOLD;
      if (shouldOpen && startX.value !== -trayWidth) {
        runOnJS(notifyOpened)();
      }
      translateX.value = withSpring(shouldOpen ? -trayWidth : 0, SETTLE_SPRING);
    });

  const animatedRowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const close = useCallback(() => {
    translateX.value = withSpring(0, SETTLE_SPRING);
  }, [translateX]);

  if (actions.length === 0) {
    return children;
  }

  return (
    <View style={styles.container}>
      <View style={styles.actions} pointerEvents="box-none">
        {actions.map(action => (
          <Pressable
            key={action.key}
            onPress={() => {
              close();
              action.onPress?.();
            }}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            testID={action.testID}
            style={[styles.action, action.destructive && styles.actionDestructive]}>
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
      {/* Every swipe action is also an accessibility action, so the row is
          fully operable by assistive tech that cannot perform the drag. */}
      <GestureDetector gesture={panGesture}>
        <Animated.View
          accessibilityActions={actions.map(action => ({
            name: action.key,
            label: action.accessibilityLabel ?? action.label,
          }))}
          onAccessibilityAction={event => {
            const action = actions.find(candidate => candidate.key === event.nativeEvent.actionName);
            if (!action) return;
            close();
            action.onPress?.();
          }}
          style={[styles.row, animatedRowStyle]}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      position: 'relative',
      overflow: 'hidden',
    },
    actions: {
      ...StyleSheet.absoluteFill,
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
    action: {
      width: ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
      borderRadius: radius.sm,
      marginVertical: 2,
      marginLeft: spacing.xs,
    },
    actionDestructive: {
      backgroundColor: colors.danger,
    },
    actionLabel: {
      ...typography.hint,
      color: colors.textPrimary,
      fontWeight: '600',
      textAlign: 'center',
    },
    row: {
      backgroundColor: colors.background,
    },
  });
