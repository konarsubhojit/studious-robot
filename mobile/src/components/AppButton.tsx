import { Pressable, StyleSheet, Text } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing } from '../theme';

/**
 * Unified pill button used across both the lobby and the in-call controls so
 * the app speaks a single visual language.  Accessibility roles/labels/state
 * are first-class props rather than afterthoughts.
 *
 * @param {object} props
 * @param {string} props.title - Visible button label (also the default a11y label).
 * @param {() => void} [props.onPress]
 * @param {boolean} [props.active] - Highlights the button (e.g. muted / video-off).
 * @param {boolean} [props.disabled]
 * @param {object} [props.style] - Extra container style(s).
 * @param {string} [props.accessibilityLabel]
 * @param {string} [props.accessibilityHint]
 * @param {string} [props.testID]
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
}: { title: string; onPress?: () => void; active?: boolean; disabled?: boolean; style?: object; accessibilityLabel?: string; accessibilityHint?: string; testID?: string; }) {
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

/** @param {import('../theme').ThemeColors} colors */
const createStyles = (colors: import('../theme').ThemeColors) =>
  StyleSheet.create({
    button: {
      flex: 1,
      minHeight: sizes.minTouchTarget,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentButton,
      shadowColor: '#000',
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
