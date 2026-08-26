import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import useReducedMotion from '../../hooks/useReducedMotion';
import { useThemedStyles } from '../../ThemeContext';
import { radius, sizes, spacing } from '../../theme';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

/** Opacity range of the shimmer pulse. */
const PULSE_MIN = 0.4;
const PULSE_MAX = 1;

/** One full dim→bright→dim cycle, in ms. */
const PULSE_DURATION_MS = 900;

export type SkeletonProps = {
  width?: number | `${number}%`;
  height?: number;
  /** Defaults to a rounded rectangle; `'circle'` matches an avatar. */
  shape?: 'rect' | 'circle';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Neutral placeholder block for content that has not loaded yet.
 *
 * The chat list already drew static grey blocks while its first fetch was in
 * flight; this generalises them so the call log, the people picker and the
 * person hub can show the shape of what is coming instead of an empty screen.
 *
 * Hidden from assistive technology: a screen-reader user should hear the list's
 * "loading" state once, not six anonymous rectangles. The pulse honours reduced
 * motion by simply not animating.
 */
export default function Skeleton({
  width = '100%',
  height = 12,
  shape = 'rect',
  style,
  testID,
}: SkeletonProps) {
  const styles = useThemedStyles(createStyles);
  const reduceMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(PULSE_MAX)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(PULSE_MAX);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: PULSE_MIN,
          duration: PULSE_DURATION_MS / 2,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: PULSE_MAX,
          duration: PULSE_DURATION_MS / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  return (
    <Animated.View
      style={[
        styles.block,
        { width, height, opacity: pulse },
        shape === 'circle' && { borderRadius: height / 2 },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={testID}
    />
  );
}

/**
 * A skeleton shaped like a `ListItem`: avatar circle, title bar, subtitle bar.
 */
export function SkeletonRow({ testID }: { testID?: string }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.row} testID={testID}>
      <Skeleton width={sizes.avatar.md} height={sizes.avatar.md} shape="circle" />
      <View style={styles.rowText}>
        <Skeleton width="55%" height={12} />
        <Skeleton width="80%" height={10} />
      </View>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    block: {
      backgroundColor: colors.surfaceControl,
      borderRadius: radius.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: sizes.minTouchTarget,
    },
    rowText: {
      flex: 1,
      gap: spacing.sm,
    },
  });
