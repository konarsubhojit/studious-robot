import { StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, spacing } from '../../theme';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

/** Counts above this render as "99+" rather than widening the pill. */
const MAX_DISPLAYED_COUNT = 99;

export type BadgeProps = {
  /** Numeric count; the badge renders nothing at zero. */
  count?: number;
  /** Text badge (e.g. "Missed"); takes precedence over `count`. */
  label?: string;
  tone?: 'accent' | 'negative' | 'neutral';
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Count or short-label pill.
 *
 * There used to be three of these with three geometries: the tab bar's
 * `18dp/radius 12` badge, the Lobby's missed-call `24dp/radius 12` badge and
 * the chat list's unread pill. A badge is decorative to assistive technology —
 * the count belongs in the *host* control's `accessibilityLabel`, which is why
 * this deliberately does not carry one of its own.
 */
export default function Badge({
  count,
  label,
  tone = 'negative',
  size = 'md',
  style,
  testID,
}: BadgeProps) {
  const styles = useThemedStyles(createStyles);

  const text = label ?? (typeof count === 'number' && count > 0
    ? count > MAX_DISPLAYED_COUNT
      ? `${MAX_DISPLAYED_COUNT}+`
      : String(count)
    : null);
  if (!text) return null;

  return (
    <View
      style={[styles.badge, styles[tone], size === 'sm' && styles.badgeSmall, style]}
      accessibilityElementsHidden
      importantForAccessibility="no"
      testID={testID}>
      <Text
        style={[styles.text, size === 'sm' && styles.textSmall]}
        maxFontSizeMultiplier={fontScaleCaps.badge}
        numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.xs + 2,
    },
    badgeSmall: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: spacing.xs,
    },
    accent: {
      backgroundColor: colors.accentButton,
    },
    negative: {
      backgroundColor: colors.negative,
    },
    neutral: {
      backgroundColor: colors.surfaceControl,
    },
    text: {
      color: colors.textOnAccent,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '700',
    },
    textSmall: {
      fontSize: 10,
      lineHeight: 14,
    },
  });
