import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { triggerHaptic } from '../haptics';
import useReducedMotion from '../hooks/useReducedMotion';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import type { ThemeColors } from '../theme';

/** Width (dp) of a single revealed action button (content area only). */
export const ACTION_WIDTH = 84;
/** Left margin each action button carries; `styles.action` derives from this. */
export const ACTION_MARGIN_LEFT = spacing.xs;
/** Total width each action occupies in the tray, including its margin. */
export const ACTION_SLOT_WIDTH = ACTION_WIDTH + ACTION_MARGIN_LEFT;
/** Horizontal movement (dp) before the row claims the gesture from the list. */
const GESTURE_ACTIVATION_DX = 10;
/**
 * Vertical movement (dp) that hands the gesture back to the list's scroll.
 *
 * It must stay *above* {@link GESTURE_ACTIVATION_DX}: when the two are equal a
 * drag that is only slightly off-horizontal can cross both thresholds within
 * the same touch batch, and the pan then loses the arbitration it should have
 * won.  That is felt most on a short target — a chat bubble, where the drag is
 * a flick rather than the long sweep a full-width list row invites — as a
 * swipe that simply does nothing.
 */
const GESTURE_FAIL_DY = 24;
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
 * A row that also wants a long press must route it through `onLongPress`
 * rather than wrapping its content in a `Pressable`: RN's own touch responder
 * and the native gesture system arbitrate poorly against each other, so a
 * `Pressable` covering the drag surface can hold the touch for its long-press
 * timer and starve the pan of the movement that would have activated it. Given
 * to this component the two are one native gesture race instead.
 *
 * @param [props.actions]
 * @param [props.onLongPress] Long press on the row surface, raced against the
 *   swipe so a press-and-drag still swipes.
 * @param [props.longPressLabel] How assistive technology announces the long
 *   press, which it performs as an accessibility action rather than a hold.
 */
export default function SwipeableRow({ actions = [], onLongPress, longPressLabel = 'Long press', children }: {
        actions?: Array<{
            key: string; label: string; accessibilityLabel?: string;
            testID?: string; onPress: () => void; destructive?: boolean;
        }>;
        onLongPress?: () => void;
        longPressLabel?: string;
        children: React.ReactNode;
    }) {
  const styles = useThemedStyles(createStyles);
  const reduceMotion = useReducedMotion();
  const translateX = useSharedValue(0);
  // The offset the current drag started from, so a second swipe continues
  // from wherever the tray was left rather than snapping back to zero.
  const startX = useSharedValue(0);
  const trayWidth = actions.length * ACTION_SLOT_WIDTH;

  // A short tick when the tray latches open, so the row confirms itself
  // without the user having to look away from the list.
  const notifyOpened = useCallback(() => triggerHaptic('tap'), []);

  // Reduced motion takes the row straight to its resting position instead of
  // springing there. The tray still opens and closes — the state change is
  // what the gesture means; only the travel is dropped.
  const settle = useCallback(
    (toValue: number) => {
      'worklet';
      return reduceMotion ? toValue : withSpring(toValue, SETTLE_SPRING);
    },
    [reduceMotion],
  );

  // Tray width and pan enablement are different questions, and conflating
  // them is what made this row silently stop swiping: `trayWidth` only bounds
  // how far a drag can travel to reveal actions, while whether the pan should
  // run at all is decided once, below, by the early return — if execution
  // reaches here the component *chose* to wrap `children` in a
  // `GestureDetector`, because there is either a tray or a long press to
  // race it against. A wrapped row must stay draggable, so the pan is never
  // gated on `trayWidth` again; a genuinely empty tray still clamps the drag
  // to zero via the `Math.min`/`Math.max` below, which is enough to keep an
  // actionless, long-press-only row visually still without disabling the
  // gesture that carries the long press.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-GESTURE_ACTIVATION_DX, GESTURE_ACTIVATION_DX])
        .failOffsetY([-GESTURE_FAIL_DY, GESTURE_FAIL_DY])
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
          translateX.value = settle(shouldOpen ? -trayWidth : 0);
        }),
    [notifyOpened, settle, startX, trayWidth, translateX],
  );

  // Raced, not composed simultaneously: whichever of the two the finger
  // describes first wins outright, so a press that turns into a drag swipes
  // and a press that stays put opens whatever the long press is bound to.
  const gesture = useMemo(
    () =>
      onLongPress
        ? Gesture.Race(
            panGesture,
            Gesture.LongPress().onStart(() => {
              runOnJS(onLongPress)();
            }),
          )
        : panGesture,
    [onLongPress, panGesture],
  );

  const animatedRowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const close = useCallback(() => {
    translateX.value = settle(0);
  }, [settle, translateX]);

  if (actions.length === 0 && !onLongPress) {
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
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessibilityActions={[
            ...actions.map(action => ({
              name: action.key,
              label: action.accessibilityLabel ?? action.label,
            })),
            // Assistive technology performs a long press as a named action,
            // never as a hold, so the gesture has to be published as one.
            ...(onLongPress ? [{ name: 'longpress', label: longPressLabel }] : []),
          ]}
          onAccessibilityAction={event => {
            const actionName = event.nativeEvent.actionName;
            if (actionName === 'longpress' && onLongPress) {
              onLongPress();
              return;
            }
            const action = actions.find(candidate => candidate.key === actionName);
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
      // Derived, not restated: `trayWidth` is computed from ACTION_SLOT_WIDTH,
      // so a literal here could drift from the maths and re-hide the leftmost
      // button — which is exactly the bug this constant was introduced to fix.
      marginLeft: ACTION_MARGIN_LEFT,
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
