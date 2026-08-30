import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, sizes, spacing, typography } from '../../theme';
import Icon from './Icon';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

/**
 * Longest value still shown as trailing text beside the title.
 *
 * Long enough for the values the right-hand slot was designed for — `On`,
 * `English`, `1.2 GB`, a timestamp — and short enough that an email address or
 * a signed-in-with sentence falls through to the wrapping block below the
 * title instead of being ellipsized into uselessness.
 */
const INLINE_VALUE_MAX_CHARS = 12;

export type ListItemProps = {
  title: string;
  subtitle?: string | null;
  /**
   * Value text. Short values sit beside the title; anything longer wraps
   * full-width beneath it, because a row whose whole purpose is to state a
   * value must not truncate that value.
   */
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
  accessibilityState?: { checked?: boolean; selected?: boolean; disabled?: boolean; busy?: boolean };
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

type ListItemStyles = ReturnType<typeof createStyles>;

function ListItemContent({
  title,
  subtitle,
  icon,
  leading,
  trailing,
  chevron,
  destructive,
  inlineValue,
  blockValue,
  valueTestID,
  styles,
  colors,
}: Pick<ListItemProps, 'title' | 'subtitle' | 'icon' | 'leading' | 'trailing' | 'chevron' |
  'destructive'> & {
  inlineValue: string | null | undefined;
  blockValue: string | null | undefined;
  valueTestID?: string;
  styles: ListItemStyles;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <>
      {leading ?? (icon ? (
        <View style={styles.iconSlot}>
          <Icon name={icon} size={20} color={colors.onSurfaceVariant} />
        </View>
      ) : null)}
      <View style={styles.text}>
        <View style={styles.titleRow}>
          {/* Reflow, not a cap: the row is `minHeight`, not `height`, and this
              column is `flex: 1`, so it has somewhere to go. A row title is the
              row's subject — a truncated setting name or peer id is a row you
              can no longer identify — so it wraps rather than being clipped or
              shrunk. */}
          <Text style={[styles.title, destructive && styles.titleDestructive]} numberOfLines={2}>
            {title}
          </Text>
          {inlineValue ? (
            // Capped: unlike the title, this is boxed into `maxWidth: '40%'` —
            // the constraint that keeps the title readable — so it is the one
            // text in the row that cannot be given more width. It only ever
            // holds a short value ("On", "English", a timestamp), so a modest
            // cap costs nothing.
            <Text style={styles.value} maxFontSizeMultiplier={fontScaleCaps.meta} numberOfLines={1}>
              {inlineValue}
            </Text>
          ) : null}
        </View>
        {blockValue ? (
          <Text style={styles.blockValue} testID={valueTestID}>
            {blockValue}
          </Text>
        ) : null}
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon name="disclosure" size={20} color={colors.textMuted} /> : null}
    </>
  );
}

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

  // Short values keep the trailing treatment they were designed for; long ones
  // move under the title, where they have the full width of the row to wrap
  // into. The old layout gave every value the same 40%-wide right-hand slot,
  // which turned "Signed in with" into `koner.subhojit@g…`.
  const isInlineValue = Boolean(value) && (value as string).length <= INLINE_VALUE_MAX_CHARS;
  const inlineValue = isInlineValue ? value : null;
  const blockValue = value && !isInlineValue ? value : null;
  const valueTestID = testID ? `${testID}-value` : undefined;
  // Material 3 sizes a one-line row at 56dp and a two-line one at 72dp; a row
  // carrying a description or a wrapped value is the two-line case.
  const isTwoLine = Boolean(subtitle || blockValue);
  const contentProps = {
    title,
    subtitle,
    icon,
    leading,
    trailing,
    chevron,
    destructive,
    inlineValue,
    blockValue,
    styles,
    colors,
    valueTestID,
  };

  if (!onPress && !onLongPress) {
    // A read-only row is still one thing, not two texts that happen to be
    // adjacent: given a label, it is announced as a single element, and never
    // with the `button` role a row without a handler has no business claiming.
    return (
      <View
        style={[styles.row, isTwoLine && styles.rowTwoLine, style]}
        accessible={accessibilityLabel ? true : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityLabel ? accessibilityHint : undefined}
        accessibilityRole={accessibilityRole === 'button' ? 'text' : accessibilityRole}
        testID={testID}>
        <ListItemContent {...contentProps} />
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
      android_ripple={{ color: colors.ripple }}
      style={({ pressed }) => [
        styles.row,
        isTwoLine && styles.rowTwoLine,
        pressed && styles.rowPressed,
        disabled && styles.rowDisabled,
        style,
      ]}
      testID={testID}>
      <ListItemContent {...contentProps} />
    </Pressable>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      minHeight: sizes.row.singleLine,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    rowTwoLine: {
      minHeight: sizes.row.twoLine,
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
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    title: {
      ...typography.subtitle,
      color: colors.onSurface,
      flexShrink: 1,
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
      marginLeft: 'auto',
      textAlign: 'right',
    },
    // Deliberately uncapped: this is the value the row exists to state, so it
    // wraps across the full width rather than ellipsizing.
    blockValue: {
      ...typography.body,
      color: colors.onSurfaceVariant,
    },
  });
