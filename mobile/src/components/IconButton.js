import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

/**
 * Circular icon-only button for call action controls (accept, decline, mute, etc.).
 *
 * Renders a large touchable circle with an icon glyph (emoji or unicode) and an
 * optional small label underneath.  All semantic / accessibility attributes are
 * first-class props.
 *
 * @param {object}   props
 * @param {string}   props.icon              - Icon glyph to render (emoji or unicode).
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
        <Text style={[styles.icon, { fontSize: Math.round(size * 0.42) }]}>{icon}</Text>
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
