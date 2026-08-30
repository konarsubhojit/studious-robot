import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../../theme';
import Icon from './Icon';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ThemeColors } from '../../theme';

export type BannerTone = 'neutral' | 'warning' | 'accent' | 'negative';

export type BannerProps = {
  /** The condition, in one sentence, in the present tense. */
  message: string;
  /** Semantic `ICONS` key. Defaults to one implied by `tone`. */
  icon?: string;
  tone?: BannerTone;
  /** Inline action, e.g. "Retry". Rendered as text, not a filled button. */
  actionLabel?: string;
  onAction?: () => void;
  actionHint?: string;
  /** Defaults to `${testID}-action`, matching `ErrorState`. */
  actionTestID?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Defaults to `${testID}-dismiss`. */
  dismissTestID?: string;
  /**
   * `alert` for a condition the user must know about now; `progressbar` when
   * paired with `accessibilityValue`. Defaults to plain text.
   */
  accessibilityRole?: 'text' | 'alert' | 'progressbar';
  accessibilityValue?: { now: number; min: number; max: number };
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Icon implied by a tone, when the caller does not name one. */
const TONE_ICONS: Record<BannerTone, string> = {
  neutral: 'info',
  warning: 'offline',
  accent: 'info',
  negative: 'messageFailed',
};

/**
 * The app's one *persistent* status surface.
 *
 * The three status levels are: transient → `Toast`, persistent → this banner,
 * blocking → `ErrorState` with a next action. Persistent conditions were the
 * level with no shared component, so the same "you are offline" fact appeared
 * as a full `ErrorState` card on Calls, a line of grey body text on Search, a
 * bespoke row in the conversation, and a themed `StatusBanner` in a call — four
 * weights for one condition, which reads as four different severities.
 *
 * A banner states a *condition* and stays for as long as it holds; it never
 * takes the screen over, which is what separates it from `ErrorState`. Its
 * action is inline text rather than a filled button for the same reason.
 */
export default function Banner({
  message,
  icon,
  tone = 'neutral',
  actionLabel,
  onAction,
  actionHint,
  actionTestID,
  onDismiss,
  dismissLabel,
  dismissTestID,
  accessibilityRole = 'text',
  accessibilityValue,
  style,
  testID,
}: BannerProps) {
  const styles = useThemedStyles(createStyles);

  const containerTone = {
    neutral: null,
    warning: styles.bannerWarning,
    accent: styles.bannerAccent,
    negative: styles.bannerNegative,
  }[tone];
  const textStyle = {
    neutral: styles.text,
    warning: styles.textWarning,
    accent: styles.text,
    negative: styles.textNegative,
  }[tone];
  // Tinting from the resolved text colour rather than naming a palette entry
  // keeps the glyph and the sentence the same colour by construction.
  const foreground = StyleSheet.flatten(textStyle).color as string;

  return (
    <View
      style={[styles.banner, containerTone, style]}
      accessibilityLiveRegion="polite"
      accessibilityRole={accessibilityRole}
      accessibilityValue={accessibilityValue}
      testID={testID}>
      <Icon name={icon ?? TONE_ICONS[tone]} size={14} color={foreground} />
      {/* Reflow, not a cap: a banner is padding-only and every caller stacks it
          in a column that grows, so the two-line clamp this used to carry was
          insurance against a long message that instead became the thing that
          broke it — at 200% "Calling may not work reliably: Microphone
          permission is denied" clipped mid-condition. A tall banner is a
          nuisance; a truncated one is a condition the user never learns. */}
      <Text style={[textStyle, styles.message]}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityHint={actionHint}
          hitSlop={touchSlop(20)}
          testID={actionTestID ?? (testID ? `${testID}-action` : undefined)}>
          <Text style={[textStyle, styles.action]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel ?? 'Dismiss'}
          hitSlop={touchSlop(20)}
          testID={dismissTestID ?? (testID ? `${testID}-dismiss` : undefined)}>
          <Icon name="dismiss" size={18} color={foreground} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.sm,
      backgroundColor: colors.surfaceRaised,
    },
    bannerWarning: {
      backgroundColor: colors.tintWarning,
    },
    bannerNegative: {
      backgroundColor: colors.tintDanger,
    },
    bannerAccent: {
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
    },
    message: {
      flex: 1,
    },
    text: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    textWarning: {
      ...typography.hint,
      color: colors.warning,
    },
    textNegative: {
      ...typography.hint,
      color: colors.danger,
    },
    action: {
      ...typography.hint,
      fontWeight: '700',
      textDecorationLine: 'underline',
    },
  });
