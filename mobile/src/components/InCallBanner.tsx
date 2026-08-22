import { Pressable, StyleSheet, Text } from 'react-native';
import { formatCallDuration } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import type { ThemeColors } from '../theme';

export type InCallBannerProps = {
  /** e.g. "Call with bob"; falls back to a generic label when the remote party can't be determined yet. */
  participantLabel?: string | null;
  elapsedCallSeconds?: number;
  onExpand: () => void;
};

/**
 * Slim, persistent banner shown at the top of the tab shell whenever an
 * active call has been minimized (e.g. the user pressed the hardware back
 * button or a bottom tab while on a call) — the in-app analogue of the
 * "tap to return to call" bar iOS/WhatsApp show for an ongoing call, so it's
 * always obvious a call is still live and with whom, and tapping it restores
 * the full-screen `CallScreen` (mirrors `FloatingCallBubble`'s `onExpand`,
 * which stays available too for its quick mute/end controls).
 */
export default function InCallBanner({
  participantLabel = null,
  elapsedCallSeconds = 0,
  onExpand,
}: InCallBannerProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      onPress={onExpand}
      accessibilityRole="button"
      accessibilityLabel={`Return to call${participantLabel ? `: ${participantLabel}` : ''}`}
      testID="in-call-banner"
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
      <Text style={styles.glyph}>📞</Text>
      <Text style={styles.text} numberOfLines={1}>
        {participantLabel || 'Call in progress'}
      </Text>
      <Text style={styles.timer}>{formatCallDuration(elapsedCallSeconds)}</Text>
    </Pressable>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: colors.accentButton,
    },
    pressed: {
      opacity: 0.85,
    },
    glyph: {
      fontSize: 14,
    },
    text: {
      ...typography.hint,
      color: colors.textOnAccent,
      fontWeight: '700',
      flex: 1,
    },
    timer: {
      ...typography.hint,
      color: colors.textOnAccent,
    },
  });
