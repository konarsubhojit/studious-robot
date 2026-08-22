// @ts-check
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing, typography } from '../theme';

/**
 * Shared failure surface: a short title, an explanation of what went wrong,
 * and at least one recovery action.  Raw red error strings leave a screen
 * reader user with nothing to act on, so every error path in the app renders
 * this component instead.
 *
 * The container is announced as an alert (and as a live region on Android, so
 * TalkBack speaks it when it appears mid-screen); the action is a real button
 * that always clears `sizes.minTouchTarget`.
 *
 * @param {object} props
 * @param {string} [props.title] - Short summary, e.g. "Can't reach the server"; nothing renders without it.
 * @param {string} [props.description] - Why it happened / what the user can do.
 * @param {string} [props.actionLabel] - Visible label of the recovery button.
 * @param {() => void} [props.onAction] - Recovery handler; the button is hidden without it.
 * @param {string} [props.actionHint] - Accessibility hint for the recovery button.
 * @param {'error'|'warning'} [props.severity]
 * @param {object} [props.style]
 * @param {string} [props.testID]
 */
export default function ErrorState({
  title,
  description,
  actionLabel = 'Retry',
  onAction,
  actionHint,
  severity = 'error',
  style,
  testID,
}) {
  const styles = useThemedStyles(createStyles);

  if (!title) {
    return null;
  }

  const isWarning = severity === 'warning';

  return (
    <View
      style={[styles.container, isWarning && styles.containerWarning, style]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      testID={testID}>
      <View style={styles.textWrap}>
        <Text style={[styles.title, isWarning && styles.titleWarning]}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityHint={actionHint}
          testID={testID ? `${testID}-action` : undefined}
          style={({ pressed }) => [
            styles.action,
            isWarning && styles.actionWarning,
            pressed && styles.actionPressed,
          ]}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    container: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: colors.tintDanger,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.md,
      gap: spacing.sm,
    },
    containerWarning: {
      borderColor: colors.warning,
      backgroundColor: colors.tintWarning,
    },
    textWrap: {
      gap: 2,
    },
    title: {
      ...typography.emphasis,
      color: colors.danger,
    },
    titleWarning: {
      color: colors.warning,
    },
    description: {
      ...typography.body,
      color: colors.textSecondary,
    },
    action: {
      minHeight: sizes.minTouchTarget,
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.danger,
    },
    actionWarning: {
      backgroundColor: colors.warning,
    },
    actionPressed: {
      opacity: 0.8,
    },
    actionText: {
      ...typography.emphasis,
      color: colors.textOnAccent,
    },
  });
