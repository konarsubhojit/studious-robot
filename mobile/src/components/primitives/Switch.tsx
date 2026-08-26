import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../../ThemeContext';
import { radius, sizes, spacing, typography } from '../../theme';
import type { ThemeColors } from '../../theme';

export type SwitchProps = {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

/** Track dimensions; the thumb is inset by `THUMB_INSET` on each side. */
const TRACK_WIDTH = 46;
const TRACK_HEIGHT = 28;
const THUMB_INSET = 3;

/**
 * Labelled on/off row.
 *
 * Every toggle in the app previously rendered its state as the *word* "On" or
 * "Off" in the accent colour (`SettingsCard`, `SettingsScreen`'s developer-mode
 * row, the peer profile's mute row), which reads as a value rather than a
 * control and gives no affordance that it can be tapped. This draws a real
 * switch, keeps the full row tappable, and reports `checked` so assistive
 * technology announces the state rather than the label alone.
 *
 * React Native's own `Switch` is deliberately not used: it cannot be themed to
 * the app palette on Android without platform-specific props, and the whole row
 * — not just the thumb — needs to be the touch target.
 */
export default function Switch({
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: SwitchProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      onPress={() => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint ?? hint}
      accessibilityState={{ checked: value, disabled }}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled]}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View
        style={[styles.track, value && styles.trackOn]}
        accessibilityElementsHidden
        importantForAccessibility="no">
        <View style={[styles.thumb, value && styles.thumbOn]} />
      </View>
    </Pressable>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      minHeight: sizes.minTouchTarget,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    rowPressed: {
      backgroundColor: colors.surfaceRaised,
    },
    rowDisabled: {
      opacity: 0.5,
    },
    text: {
      flex: 1,
      gap: 2,
    },
    label: {
      ...typography.subtitle,
      color: colors.onSurface,
    },
    hint: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
    },
    track: {
      width: TRACK_WIDTH,
      height: TRACK_HEIGHT,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceControl,
      borderWidth: 1,
      borderColor: colors.outline,
      justifyContent: 'center',
    },
    trackOn: {
      backgroundColor: colors.accentButton,
      borderColor: colors.accentButton,
    },
    thumb: {
      height: TRACK_HEIGHT - THUMB_INSET * 2 - 2,
      width: TRACK_HEIGHT - THUMB_INSET * 2 - 2,
      borderRadius: radius.pill,
      backgroundColor: colors.onSurfaceVariant,
      marginLeft: THUMB_INSET,
    },
    thumbOn: {
      backgroundColor: colors.textOnAccent,
      marginLeft: TRACK_WIDTH - (TRACK_HEIGHT - THUMB_INSET * 2 - 2) - THUMB_INSET - 2,
    },
  });
