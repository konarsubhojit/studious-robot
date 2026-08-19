import { useMemo, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { triggerHaptic } from '../haptics';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';

/** Width (dp) of a single revealed action button. */
const ACTION_WIDTH = 84;
/** Horizontal movement (dp) before the row claims the gesture from the list. */
const GESTURE_ACTIVATION_DX = 12;
/** Fraction of the action tray that must be revealed to snap it open. */
const OPEN_THRESHOLD = 0.5;

/**
 * A list row that reveals action buttons when dragged to the left, closing
 * again once an action is tapped or the row is dragged back.
 *
 * Built on the core `PanResponder`/`Animated` APIs rather than a gesture
 * library so it works inside the existing virtualized lists (and their tests)
 * without pulling in a new dependency.
 *
 * @param {object} props
 * @param {Array<{ key: string, label: string, accessibilityLabel?: string,
 *   testID?: string, onPress: () => void, destructive?: boolean }>} [props.actions]
 * @param {React.ReactNode} props.children
 */
export default function SwipeableRow({ actions = [], children }) {
  const styles = useThemedStyles(createStyles);
  const translateX = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0);
  const trayWidth = actions.length * ACTION_WIDTH;

  const panResponder = useMemo(() => {
    const settle = toValue => {
      // A short tick when the tray latches open, so the row confirms itself
      // without the user having to look away from the list.
      if (toValue !== 0 && offsetRef.current !== toValue) {
        triggerHaptic('tap');
      }
      offsetRef.current = toValue;
      Animated.spring(translateX, {
        toValue,
        useNativeDriver: true,
        bounciness: 0,
      }).start();
    };

    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        trayWidth > 0 &&
        Math.abs(gesture.dx) > GESTURE_ACTIVATION_DX &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_event, gesture) => {
        const next = Math.min(0, Math.max(-trayWidth, offsetRef.current + gesture.dx));
        translateX.setValue(next);
      },
      onPanResponderRelease: (_event, gesture) => {
        const next = offsetRef.current + gesture.dx;
        settle(next < -trayWidth * OPEN_THRESHOLD ? -trayWidth : 0);
      },
      onPanResponderTerminate: () => settle(offsetRef.current),
    });
  }, [trayWidth, translateX]);

  const close = () => {
    offsetRef.current = 0;
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
  };

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
        style={[styles.row, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const createStyles = colors =>
  StyleSheet.create({
    container: {
      position: 'relative',
      overflow: 'hidden',
    },
    actions: {
      ...StyleSheet.absoluteFillObject,
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
