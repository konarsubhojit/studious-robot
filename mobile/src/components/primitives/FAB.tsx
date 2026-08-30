import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { elevation, fontScaleCaps, radius, sizes, spacing, typography } from '../../theme';
import Badge from './Badge';
import Icon from './Icon';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type FABProps = {
  /** Semantic `ICONS` key. */
  icon: string;
  /** Required: an icon-only control is unusable without an accessible name. */
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  /** Renders the extended variant, with the label beside the icon. */
  label?: string;
  /** Count pinned to the top-right, e.g. unread messages below the fold. */
  badgeCount?: number;
  /** `'surface'` is the quieter variant used over a scrolling list. */
  tone?: 'accent' | 'surface';
  size?: 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Floating action button: the primary action of a screen.
 *
 * The Chats and Calls tabs previously had *no* primary action at all — starting
 * a conversation meant typing into an inline search box, and starting a call
 * meant typing an id into a form — so this is the control that replaces both.
 * The conversation's scroll-to-bottom affordance is the same component with a
 * badge.
 *
 * Always at least `sizes.minTouchTarget` so it satisfies the touch-target rule
 * without each caller having to remember `touchSlop`.
 */
export default function FAB({
  icon,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  label,
  badgeCount,
  tone = 'accent',
  size = 'md',
  style,
  testID,
}: FABProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const diameter = size === 'sm' ? sizes.minTouchTarget : sizes.fab;
  const glyphColor = tone === 'accent' ? colors.textOnAccent : colors.onSurface;

  return (
    <View style={[styles.wrap, style]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={
          badgeCount && badgeCount > 0
            ? `${accessibilityLabel}, ${badgeCount}`
            : accessibilityLabel
        }
        accessibilityHint={accessibilityHint}
        testID={testID}
        android_ripple={{
          color: tone === 'accent' ? colors.rippleOnAccent : colors.ripple,
          borderless: false,
        }}
        style={({ pressed }) => [
          styles.fab,
          tone === 'accent' ? styles.fabAccent : styles.fabSurface,
          {
            minHeight: diameter,
            minWidth: diameter,
            borderRadius: diameter / 2,
          },
          label ? styles.fabExtended : null,
          pressed && styles.pressed,
        ]}>
        <Icon name={icon} size={size === 'sm' ? 20 : 24} color={glyphColor} />
        {label ? (
          <Text
            style={[styles.label, { color: glyphColor }]}
            maxFontSizeMultiplier={fontScaleCaps.control}
            numberOfLines={1}>
            {label}
          </Text>
        ) : null}
      </Pressable>
      {badgeCount && badgeCount > 0 ? (
        <Badge
          count={badgeCount}
          tone="negative"
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
      alignSelf: 'flex-end',
    },
    fab: {
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      ...elevation(colors.shadow).medium,
    },
    fabAccent: {
      backgroundColor: colors.accentButton,
    },
    fabSurface: {
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.outline,
    },
    fabExtended: {
      paddingHorizontal: spacing.lg,
      borderRadius: radius.pill,
    },
    label: {
      ...typography.label,
    },
    badge: {
      position: 'absolute',
      top: -4,
      right: -4,
    },
    pressed: {
      opacity: 0.85,
    },
  });
