import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';
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
  size = 64,
  testID,
  accessibilityLabel,
}) {
  const bgColor = VARIANT_COLORS[variant] ?? colors.surfaceControl;
  const iconSize = Math.round(size * 0.42);

  // Resolve the glyph: try ICONS map first, then render raw.
  const iconDef = ICONS[icon];
  const MCIcon = loadVectorIcons();
  let iconContent;
  if (iconDef && MCIcon) {
    iconContent = (
      <MCIcon
        name={iconDef.icon}
        size={iconSize}
        color={ICON_COLORS[variant] ?? colors.textPrimary}
      />
    );
  } else {
    const glyph = iconDef ? iconDef.emoji : icon;
    iconContent = (
      <Text style={[styles.icon, { fontSize: iconSize }]}>{glyph}</Text>
    );
  }

  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label ?? icon}
        accessibilityState={{ disabled }}
        testID={testID}
        style={({ pressed }) => [
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor },
          disabled && styles.disabled,
          pressed && styles.pressed,
        ]}
      >
        {iconContent}
      </Pressable>
      {label ? <Text style={styles.label} numberOfLines={1}>{label}</Text> : null}
    </View>
  );
}

const VARIANT_COLORS = {
  default: colors.surfaceControl,
  danger:  colors.danger,
  success: colors.success,
  active:  colors.accentButton,
  muted:   colors.surfaceBanner,
};

/** Foreground colour for vector icon glyphs per variant. */
const ICON_COLORS = {
  default: colors.textPrimary,
  danger:  '#fff',
  success: '#fff',
  active:  colors.textOnAccent,
  muted:   colors.textSecondary,
};

const styles = StyleSheet.create({
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
