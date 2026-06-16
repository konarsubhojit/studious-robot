import { StyleSheet, Text } from 'react-native';
import { colors, spacing } from '../theme';

const SEVERITY_COLOR = {
  info: colors.textMuted,
  success: colors.success,
  error: colors.danger,
};

/**
 * Single-line status message whose colour reflects severity (info / success /
 * error), replacing the previously undifferentiated status text.
 *
 * @param {object} props
 * @param {{ message: string, severity?: 'info'|'success'|'error' }} props.status
 * @param {object} [props.style]
 */
export default function StatusBanner({ status, style }) {
  const severity = status?.severity || 'info';
  return (
    <Text
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      testID="status-banner"
      style={[styles.status, { color: SEVERITY_COLOR[severity] || colors.textMuted }, style]}
    >
      {status?.message || ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  status: {
    marginBottom: spacing.md,
  },
});
