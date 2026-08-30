import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import type { ThemeColors } from '../theme';

export type IconButtonProps = {
  icon: string;
  label?: string;
  /** Omitted for a decorative button; the press is then a no-op. */
  onPress?: () => void;
  variant?: 'default' | 'danger' | 'success' | 'active' | 'muted';
  /**
   * Marks a toggle button as currently engaged.  Assistive technologies
   * announce this as "selected"; without it a screen-reader user can only
   * hear the *next* action ("Unmute microphone") and never the current state.
   */
  selected?: boolean;
  disabled?: boolean;
  loading?: boolean;
  size?: number;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/**
 * Circular icon-only button for call action controls (accept, decline, mute, etc.).
 *
 * Renders a large touchable circle with an icon glyph and an optional small
 * label underneath.  When `react-native-vector-icons` is installed the icon is
 * rendered as a crisp vector glyph; otherwise it degrades to the emoji/unicode
 * fallback so the app works in CI and before native fonts are linked.
 *
 *                                            OR a raw emoji/unicode glyph string.
 *                                            implies `disabled` (e.g. call being initiated).
 */
export default function IconButton({
  icon,
  label,
  onPress,
  variant = 'default',
  selected,
  disabled = false,
  loading = false,
  size = 64,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: IconButtonProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const bgColor = variantColor(colors, variant);
  const glyphColor = iconColor(colors, variant);
  const iconSize = Math.round(size * 0.42);
  const isDisabled = disabled || loading;

  // Resolve the glyph: try ICONS map first, then render raw.
  const iconDef = ICONS[icon];
  const MCIcon = loadVectorIcons();
  let iconContent;
  if (loading) {
    iconContent = (
      <ActivityIndicator
        size="small"
        color={glyphColor}
        testID={testID ? `${testID}-loading` : undefined}
      />
    );
  } else if (iconDef && MCIcon) {
    iconContent = <MCIcon name={iconDef.icon} size={iconSize} color={glyphColor} />;
  } else {
    const glyph = iconDef ? iconDef.emoji : icon;
    iconContent = <Text style={[styles.icon, { fontSize: iconSize }]}>{glyph}</Text>;
  }

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label ?? icon}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: isDisabled, busy: loading, selected }}
        testID={testID}
        android_ripple={{
          color: variant === 'default' || variant === 'muted' ? colors.ripple : colors.rippleOnAccent,
          borderless: true,
          radius: size / 2,
        }}
        style={({ pressed }) => [
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor },
          isDisabled && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {iconContent}
      </Pressable>
      {label ? (
        <Text
          style={styles.label}
          numberOfLines={1}
          importantForAccessibility="no"
          accessibilityElementsHidden>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Circle background colour per variant, resolved from the active palette.
 */
const variantColor = (colors: ThemeColors, variant: string) =>
  ({
    default: colors.surfaceControl,
    danger: colors.danger,
    success: colors.success,
    active: colors.accentButton,
    muted: colors.surfaceBanner,
  }[variant] ?? colors.surfaceControl);

/**
 * Foreground colour for vector icon glyphs per variant.
 */
const iconColor = (colors: ThemeColors, variant: string) =>
  ({
    default: colors.textPrimary,
    danger: colors.textOnAccent,
    success: colors.textOnAccent,
    active: colors.textOnAccent,
    muted: colors.textSecondary,
  }[variant] ?? colors.textPrimary);

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrapper: {
      alignItems: 'center',
    },
    circle: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    icon: {
      textAlign: 'center',
      includeFontPadding: false,
      lineHeight: undefined,
    },
    label: {
      ...typography.caption,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: spacing.xs,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.78,
    },
  });
