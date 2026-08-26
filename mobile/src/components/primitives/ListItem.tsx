import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, sizes, spacing, typography } from '../../theme';
import Icon from './Icon';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type ListItemProps = {
  title: string;
  subtitle?: string | null;
  /** Trailing value text, e.g. the current setting or a timestamp. */
  value?: string | null;
  /** Semantic `ICONS` key rendered in the leading slot. */
  icon?: string;
  /** Arbitrary leading content (an `Avatar`); takes precedence over `icon`. */
  leading?: ReactNode;
  /** Arbitrary trailing content (a `Badge`, a call button). */
  trailing?: ReactNode;
  /** Draws a disclosure chevron, marking the row as opening a sub-screen. */
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Paints the title in the negative colour, for a destructive row. */
  destructive?: boolean;
  /** Screen readers announce the whole row; give it the full sentence. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'switch' | 'link' | 'none';
  accessibilityState?: { checked?: boolean; selected?: boolean; disabled?: boolean };
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The app's one row.
 *
 * Conversation rows, call-log rows, settings rows, blocked-people rows and
 * people-picker rows were each authored separately in their screen's
 * `createStyles`, at four different heights and three different text
 * hierarchies. They are all this component now, so a row is the same object
 * wherever it appears and its touch target is guaranteed once rather than per
 * screen.
 *
 * A row without `onPress` renders as a plain `View`, so a read-only row is not
 * announced as a button.
 */
export default function ListItem({
  title,
  subtitle,
  value,
  icon,
  leading,
  trailing,
  chevron = false,
  onPress,
  onLongPress,
  disabled = false,
  destructive = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  style,
  testID,
}: ListItemProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const content = (
    <>
      {leading ?? (icon ? (
        <View style={styles.iconSlot}>
          <Icon name={icon} size={20} color={colors.onSurfaceVariant} />
        </View>
      ) : null)}
      <View style={styles.text}>
        {/* Reflow, not a cap: the row is `minHeight`, not `height`, and this
            column is `flex: 1`, so it has somewhere to go. A row title is the
            row's subject — a truncated setting name or peer id is a row you
            can no longer identify — so it wraps rather than being clipped or
            shrunk. */}
        <Text style={[styles.title, destructive && styles.titleDestructive]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        // Capped: unlike the title, this is boxed into `maxWidth: '40%'` — the
        // constraint that keeps the title readable — so it is the one text in
        // the row that cannot be given more width. It is trailing metadata (the
        // current setting, a timestamp), so a modest cap costs nothing.
        <Text style={styles.value} maxFontSizeMultiplier={fontScaleCaps.meta} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {trailing}
      {chevron ? <Icon name="disclosure" size={20} color={colors.textMuted} /> : null}
    </>
  );

  if (!onPress && !onLongPress) {
    // A read-only row is still one thing, not two texts that happen to be
    // adjacent: given a label, it is announced as a single element, and never
    // with the `button` role a row without a handler has no business claiming.
    return (
      <View
        style={[styles.row, style]}
        accessible={accessibilityLabel ? true : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityLabel ? accessibilityHint : undefined}
        accessibilityRole={accessibilityRole === 'button' ? 'text' : accessibilityRole}
        testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...accessibilityState }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.rowDisabled, style]}
      testID={testID}>
      {content}
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
    iconSlot: {
      width: sizes.avatar.sm,
      alignItems: 'center',
    },
    text: {
      flex: 1,
      gap: 2,
    },
    title: {
      ...typography.subtitle,
      color: colors.onSurface,
    },
    titleDestructive: {
      color: colors.negative,
    },
    subtitle: {
      ...typography.body,
      color: colors.onSurfaceVariant,
    },
    value: {
      ...typography.body,
      color: colors.textMuted,
      maxWidth: '40%',
      textAlign: 'right',
    },
  });
