import { Pressable, StyleSheet, Text } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing } from '../theme';
import type { ThemeColors } from '../theme';

export type AppButtonProps = {
  /** Visible button label (also the default a11y label). */
  title: string;
  onPress?: () => void;
  /** Highlights the button (e.g. muted / video-off). */
  active?: boolean;
  disabled?: boolean;
  /** Extra container style(s). */
  style?: object;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

/**
 * Unified pill button used across both the lobby and the in-call controls so
 * the app speaks a single visual language.  Accessibility roles/labels/state
 * are first-class props rather than afterthoughts.
 */
export default function AppButton({
  title,
  onPress,
  active = false,
  disabled = false,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: AppButtonProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected: active }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        active && styles.buttonActive,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      flex: 1,
      minHeight: sizes.minTouchTarget,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentButton,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.24,
      shadowRadius: 4,
      elevation: 3,
    },
    buttonActive: {
      backgroundColor: colors.danger,
    },
    buttonDisabled: {
      opacity: 0.55,
    },
    buttonPressed: {
      opacity: 0.88,
    },
    buttonText: {
      color: colors.textOnAccent,
      fontWeight: '700',
    },
  });
