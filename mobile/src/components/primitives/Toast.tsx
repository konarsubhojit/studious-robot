import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import useReducedMotion from '../../hooks/useReducedMotion';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { elevation, motion, radius, spacing, typography } from '../../theme';
import Icon from './Icon';
import type { ThemeColors } from '../../theme';

/** How long a toast stays on screen before dismissing itself. */
export const TOAST_DURATION_MS = 3200;

export type ToastTone = 'info' | 'success' | 'error';

export type ToastProps = {
  message?: string | null;
  tone?: ToastTone;
  /** Optional single action, e.g. "Retry". */
  actionLabel?: string;
  onAction?: () => void;
  /** Called when the auto-dismiss timer elapses. */
  onDismiss?: () => void;
  testID?: string;
};

const TONE_ICONS: Record<ToastTone, string | null> = {
  info: null,
  success: 'check',
  error: 'messageFailed',
};

/**
 * Transient confirmation that fades itself away.
 *
 * `StatusBanner` was doing two incompatible jobs: reporting a *condition* that
 * persists ("Server unreachable") and confirming an *event* that has already
 * happened ("Speaker default enabled"). The second kind should not occupy
 * layout permanently, and should not have to be dismissed by hand — that is
 * this. Persistent conditions stay with the inline banner; blocking failures
 * stay with `ErrorState`.
 *
 * `accessibilityLiveRegion="polite"` announces the message without stealing
 * focus, so a toast never interrupts what the user is doing.
 */
export default function Toast({
  message,
  tone = 'info',
  actionLabel,
  onAction,
  onDismiss,
  testID = 'toast',
}: ToastProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reduceMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!message) return undefined;
    // A reduced-motion user gets the toast at full opacity immediately; the
    // dismissal timer is unchanged, since it is information, not decoration.
    Animated.timing(opacity, {
      toValue: 1,
      duration: reduceMotion ? 0 : motion.duration.fast,
      useNativeDriver: true,
    }).start();

    const timer = setTimeout(() => onDismiss?.(), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss, opacity, reduceMotion]);

  if (!message) return null;

  return (
    <Animated.View
      style={[styles.toast, styles[tone], { opacity }]}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      pointerEvents="box-none"
      testID={testID}>
      {TONE_ICONS[tone] ? (
        <Icon name={(TONE_ICONS[tone] as string)} size={16} color={toneColor(colors, tone)} />
      ) : null}
      <Text style={[styles.message, { color: toneColor(colors, tone) }]} numberOfLines={3}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          testID={`${testID}-action`}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Text style={styles.actionLabel}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

/** Foreground colour for a tone. */
function toneColor(colors: ThemeColors, tone: ToastTone): string {
  if (tone === 'success') return colors.positive;
  if (tone === 'error') return colors.negative;
  return colors.onSurface;
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    toast: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      ...elevation(colors.shadow).medium,
    },
    info: {},
    success: {
      backgroundColor: colors.tintSuccess,
    },
    error: {
      backgroundColor: colors.tintDanger,
    },
    message: {
      ...typography.body,
      flex: 1,
    },
    action: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    actionLabel: {
      ...typography.label,
      color: colors.accentValue,
    },
    pressed: {
      opacity: 0.7,
    },
  });
