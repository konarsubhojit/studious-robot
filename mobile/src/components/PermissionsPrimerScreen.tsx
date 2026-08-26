import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getPermissionPrimerItems } from '../permissionsPrimer';
import { useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing, touchSlop, typography } from '../theme';
import AppButton from './AppButton';
import { ListItem } from './primitives';
import type { ThemeColors } from '../theme';

export type PermissionsPrimerScreenProps = {
  /** Grant: dismisses the screen and opens the system dialogs. */
  onContinue: () => void;
  /** Decline: dismisses the screen without prompting. */
  onSkip: () => void;
  /** Injectable for tests; defaults to what this OS version will ask for. */
  items?: ReturnType<typeof getPermissionPrimerItems>;
};

/**
 * The reasons behind the system permission dialogs, shown once before they
 * appear.
 *
 * Registration used to hand straight over to `useStartupPermissions`, which
 * fires camera, microphone, Bluetooth and notification requests back to back —
 * so the app's first screen after sign-in was a stack of OS dialogs naming
 * permissions but not reasons. On Android 11+ a permission denied twice is
 * denied permanently, so an uninformed "Deny" is close to irreversible from
 * inside the app; the cost of explaining first is one screen.
 *
 * Declining here is a real option, not a dark pattern: the app continues, every
 * feature re-requests what it needs at the point of use, and the startup banner
 * still offers a route to the OS settings page.
 *
 * Purely presentational – all behaviour is supplied via props.
 */
function PermissionsPrimerScreen({
  onContinue,
  onSkip,
  items = getPermissionPrimerItems(),
}: PermissionsPrimerScreenProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.flex} testID="permissions-primer">
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Before your first call
        </Text>
        <Text style={styles.subtitle}>
          WeTalk is about to ask for a few permissions. Here is what each one is for.
        </Text>

        <View style={styles.card}>
          {items.map(item => (
            <ListItem
              key={item.key}
              title={item.title}
              subtitle={item.description}
              icon={item.icon}
              accessibilityLabel={`${item.title}. ${item.description}`}
              accessibilityRole="none"
              testID="permissions-primer-item"
            />
          ))}
        </View>

        <Text style={styles.footnote}>
          You can change any of these later in your device settings.
        </Text>
      </ScrollView>

      <View style={styles.actions}>
        <AppButton
          title="Continue"
          onPress={onContinue}
          accessibilityHint="Asks for the permissions listed above"
          testID="permissions-primer-continue"
        />
        {/* Deliberately a plain text button rather than a second pill: the
            two choices are not equally weighted, but declining must stay a
            first-class, obviously reachable option. */}
        <Pressable
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel="Not now"
          accessibilityHint="Skips the permission requests; the app asks again when a feature needs them"
          hitSlop={touchSlop(sizes.minTouchTarget)}
          testID="permissions-primer-skip"
          style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}>
          <Text style={styles.skipLabel}>Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: {
      ...typography.title,
      color: colors.textPrimary,
    },
    subtitle: {
      ...typography.body,
      color: colors.textSecondary,
      marginBottom: spacing.sm,
    },
    card: {
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    footnote: {
      ...typography.hint,
      color: colors.textSecondary,
      marginTop: spacing.sm,
    },
    actions: {
      padding: spacing.lg,
      gap: spacing.sm,
    },
    skipButton: {
      minHeight: sizes.minTouchTarget,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    skipLabel: {
      ...typography.label,
      color: colors.textSecondary,
    },
    pressed: {
      opacity: 0.7,
    },
  });

export default memo(PermissionsPrimerScreen);
