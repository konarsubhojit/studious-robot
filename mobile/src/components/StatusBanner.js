// @ts-check
import { StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';

/**
 * Tinted background style for a severity, or `null` for plain 'info'.
 *
 * @param {ReturnType<typeof createStyles>} styles
 * @param {string} severity
 */
const severityTint = (styles, severity) =>
  ({
    success: styles.containerSuccess,
    error: styles.containerError,
    warning: styles.containerWarning,
  }[severity] ?? null);

/**
 * Text colour for a severity.
 *
 * @param {import('../theme').ThemeColors} colors
 * @param {string} severity
 */
const severityColor = (colors, severity) =>
  ({
    info: colors.textMuted,
    success: colors.success,
    error: colors.danger,
    warning: colors.warning,
  }[severity] ?? colors.textMuted);

/**
 * A status line shown to the user: the message plus how severe it is.
 *
 * @typedef {object} CallStatus
 * @property {string} message
 * @property {'info'|'success'|'warning'|'error'} [severity]
 */

/**
 * Single-line status message whose colour reflects severity (info / success /
 * warning / error). Non-info messages gain a tinted background so they stand
 * out at a glance, making call state transitions easier to notice.
 *
 * @param {object} props
 * @param {CallStatus} [props.status]
 * @param {object} [props.style]
 * @param {object} [props.textStyle]
 */
export default function StatusBanner({ status, style, textStyle }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const message = status?.message || '';
  const severity = status?.severity || 'info';
  const tint = severityTint(styles, severity);

  if (!message) {
    return null;
  }

  return (
    <View style={[styles.container, tint, style]} accessibilityLiveRegion="polite">
      <Text
        testID="status-banner"
        accessibilityRole="text"
        style={[styles.status, { color: severityColor(colors, severity) }, textStyle]}
        numberOfLines={2}>
        {message}
      </Text>
    </View>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    container: {
      borderRadius: radius.sm,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
      marginBottom: spacing.xs,
    },
    containerSuccess: {
      backgroundColor: colors.tintSuccess,
    },
    containerError: {
      backgroundColor: colors.tintDanger,
    },
    containerWarning: {
      backgroundColor: colors.tintWarning,
    },
    status: {
      textAlign: 'center',
    },
  });
