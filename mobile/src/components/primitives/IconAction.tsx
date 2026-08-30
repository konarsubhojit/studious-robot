import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { radius, sizes, spacing, touchSlop } from '../../theme';
import Badge from './Badge';
import Icon from './Icon';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type IconActionProps = {
  /** Semantic `ICONS` key. */
  icon: string;
  /** Required: an icon-only control is unusable without an accessible name. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress?: () => void;
  /** `'plain'` drops the circular background, for a back chevron in a header. */
  variant?: 'filled' | 'plain';
  tone?: 'default' | 'negative';
  /** Announced as "selected", for a control that stays engaged. */
  selected?: boolean;
  disabled?: boolean;
  size?: number;
  badgeCount?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Rendered diameter of the control; `touchSlop` grows it to the touch target. */
const DEFAULT_SIZE = 44;

/**
 * Header / toolbar icon button.
 *
 * `IconButton` is the large, labelled circle the call control deck is built
 * from; this is its small sibling for screen chrome — back, search, dismiss,
 * overflow. Those were previously a bare `<Pressable><Text>‹</Text></Pressable>`
 * re-authored in five screens, each with its own diameter and its own guess at
 * `hitSlop`.
 */
export default function IconAction({
  icon,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  variant = 'filled',
  tone = 'default',
  selected,
  disabled = false,
  size = DEFAULT_SIZE,
  badgeCount,
  style,
  testID,
}: IconActionProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const glyphColor = tone === 'negative' ? colors.negative : colors.onSurface;

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        onPress={onPress}
        disabled={disabled || !onPress}
        accessibilityRole="button"
        accessibilityLabel={
          badgeCount && badgeCount > 0
            ? `${accessibilityLabel}, ${badgeCount}`
            : accessibilityLabel
        }
        accessibilityHint={accessibilityHint}
        accessibilityState={{ selected, disabled: disabled || !onPress }}
        hitSlop={touchSlop(size)}
        testID={testID}
        android_ripple={{ color: colors.ripple, borderless: true, radius: size / 2 }}
        style={({ pressed }) => [
          styles.button,
          { height: size, width: size, borderRadius: size / 2 },
          variant === 'filled' && styles.filled,
          pressed && styles.pressed,
          disabled && styles.disabled,
        ]}>
        <Icon name={icon} size={Math.round(size * 0.46)} color={glyphColor} />
      </Pressable>
      {badgeCount && badgeCount > 0 ? (
        <Badge
          count={badgeCount}
          size="sm"
          style={styles.badge}
          testID={testID ? `${testID}-badge` : undefined}
        />
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      position: 'relative',
      minHeight: sizes.minTouchTarget - spacing.md,
      justifyContent: 'center',
    },
    button: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    filled: {
      backgroundColor: colors.surfaceControl,
    },
    pressed: {
      opacity: 0.7,
    },
    disabled: {
      opacity: 0.4,
    },
    badge: {
      position: 'absolute',
      top: -2,
      right: -2,
    },
  });
