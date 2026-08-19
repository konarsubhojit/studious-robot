import { StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';

const severityColor = (colors, severity) =>
  ({
    info: colors.textMuted,
    success: colors.success,
    error: colors.danger,
    warning: colors.warning,
  }[severity] ?? colors.textMuted);

const SEVERITY_BG = {
  info: null,
  success: 'rgba(139,231,165,0.12)',
  error: 'rgba(240,141,137,0.15)',
  warning: 'rgba(255,210,122,0.15)',
};

/**
 * Single-line status message whose colour reflects severity (info / success /
 * warning / error). Non-info messages gain a tinted background so they stand
 * out at a glance, making call state transitions easier to notice.
 *
 * @param {object} props
 * @param {{ message: string, severity?: 'info'|'success'|'warning'|'error' }} props.status
 * @param {object} [props.style]
 * @param {object} [props.textStyle]
 */
export default function StatusBanner({ status, style, textStyle }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const message = status?.message || '';
  const severity = status?.severity || 'info';
  const bg = SEVERITY_BG[severity];

  if (!message) {
    return null;
  }

  return (
    <View
      style={[styles.container, bg ? { backgroundColor: bg } : null, style]}
      accessibilityLiveRegion="polite">
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

const createStyles = colors =>
  StyleSheet.create({
    container: {
      borderRadius: radius.sm,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
      marginBottom: spacing.xs,
    },
    status: {
      textAlign: 'center',
    },
  });
