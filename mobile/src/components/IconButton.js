import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';

/**
 * Circular icon-only button for call action controls (accept, decline, mute, etc.).
 *
 * Renders a large touchable circle with an icon glyph and an optional small
 * label underneath.  When `react-native-vector-icons` is installed the icon is
 * rendered as a crisp vector glyph; otherwise it degrades to the emoji/unicode
 * fallback so the app works in CI and before native fonts are linked.
 *
 * @param {object}   props
 * @param {string}   props.icon              - Semantic icon key from ICONS map,
 *                                            OR a raw emoji/unicode glyph string.
 * @param {string}   [props.label]           - Optional text label displayed below the circle.
 * @param {Function} props.onPress
 * @param {'default'|'danger'|'success'|'active'|'muted'} [props.variant='default']
 * @param {boolean}  [props.disabled=false]
 * @param {boolean}  [props.loading=false]   - Shows a spinner in place of the icon and
 *                                            implies `disabled` (e.g. call being initiated).
 * @param {number}   [props.size=64]         - Diameter of the circle in dp.
 * @param {string}   [props.testID]
 * @param {string}   [props.accessibilityLabel]
 */
export default function IconButton({
  icon,
  label,
  onPress,
  variant = 'default',
  disabled = false,
  loading = false,
  size = 64,
  testID,
  accessibilityLabel,
}) {
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
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        testID={testID}
        style={({ pressed }) => [
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor },
          isDisabled && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {iconContent}
      </Pressable>
      {label ? (
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

/** Circle background colour per variant, resolved from the active palette. */
const variantColor = (colors, variant) =>
  ({
    default: colors.surfaceControl,
    danger: colors.danger,
    success: colors.success,
    active: colors.accentButton,
    muted: colors.surfaceBanner,
  }[variant] ?? colors.surfaceControl);

/** Foreground colour for vector icon glyphs per variant. */
const iconColor = (colors, variant) =>
  ({
    default: colors.textPrimary,
    danger: '#fff',
    success: '#fff',
    active: colors.textOnAccent,
    muted: colors.textSecondary,
  }[variant] ?? colors.textPrimary);

const createStyles = colors =>
  StyleSheet.create({
    wrapper: {
      alignItems: 'center',
      gap: spacing.xs,
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
      color: colors.textSecondary,
      fontSize: 11,
      textAlign: 'center',
      marginTop: 2,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.78,
    },
  });
