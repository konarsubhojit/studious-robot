import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatCallDuration } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import { Avatar } from './primitives';
import IconButton from './IconButton';
import type { ThemeColors } from '../theme';

export type InCallBannerProps = {
  /** e.g. "Call with bob"; falls back to a generic label when the remote party can't be determined yet. */
  participantLabel?: string | null;
  elapsedCallSeconds?: number;
  onExpand: () => void;
  isMuted?: boolean;
  /** Omit to render the banner without its mute control. */
  onMuteToggle?: () => void;
  /** Omit to render the banner without its end-call control. */
  onEndCall?: () => void;
};

/**
 * Slim, persistent banner shown at the top of the tab shell whenever an
 * active call has been minimized (e.g. the user pressed the hardware back
 * button or a bottom tab while on a call) — the in-app analogue of the
 * "tap to return to call" bar iOS/WhatsApp show for an ongoing call, so it's
 * always obvious a call is still live and with whom, and tapping it restores
 * the full-screen `CallScreen`.
 *
 * The three minimized call surfaces — this banner, `FloatingCallBubble` and
 * the OS PiP window — present the same three things in the same order: who
 * (avatar + label), how long (running timer), and mute/end. The banner used to
 * be the odd one out, showing who and how long but offering no way to mute or
 * hang up without first restoring the call.
 */
export default function InCallBanner({
  participantLabel = null,
  elapsedCallSeconds = 0,
  onExpand,
  isMuted = false,
  onMuteToggle,
  onEndCall,
}: InCallBannerProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      onPress={onExpand}
      accessibilityRole="button"
      accessibilityLabel={`Return to call${participantLabel ? `: ${participantLabel}` : ''}`}
      testID="in-call-banner"
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}>
      <Avatar id={participantLabel || ''} size="xs" />
      <Text style={styles.text} numberOfLines={1}>
        {participantLabel || 'Call in progress'}
      </Text>
      <Text style={styles.timer}>{formatCallDuration(elapsedCallSeconds)}</Text>
      {onMuteToggle || onEndCall ? (
        <View style={styles.actions}>
          {onMuteToggle ? (
            <IconButton
              icon={isMuted ? 'micOff' : 'micOn'}
              onPress={onMuteToggle}
              variant={isMuted ? 'active' : 'default'}
              size={32}
              accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              testID="in-call-banner-mute"
            />
          ) : null}
          {onEndCall ? (
            <IconButton
              icon="callEnd"
              onPress={onEndCall}
              variant="danger"
              size={32}
              accessibilityLabel="End call"
              testID="in-call-banner-end"
            />
          ) : null}
        </View>
      ) : null}
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
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
  });
