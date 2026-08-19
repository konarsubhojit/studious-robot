import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';

/**
 * Banner shown during a transient disconnect, with a manual "Retry" action.
 *
 * @param {object} props
 * @param {() => void} props.onRetry
 */
export default function ReconnectBanner({ onRetry }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.reconnectBanner} accessibilityRole="alert">
      <Text style={styles.reconnectBannerText}>Reconnecting… keeping your call alive</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry reconnection"
        testID="retry-reconnect"
        style={styles.retryButton}>
        <Text style={styles.retryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

const createStyles = colors =>
  StyleSheet.create({
    reconnectBanner: {
      marginBottom: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: '#ffd9a8',
      backgroundColor: colors.surfaceBanner,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm + 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    reconnectBannerText: {
      flex: 1,
      color: colors.warning,
      fontWeight: '600',
    },
    retryButton: {
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 6,
      backgroundColor: colors.accent,
    },
    retryButtonText: {
      color: colors.textOnAccent,
      fontWeight: '700',
      fontSize: 12,
    },
  });
