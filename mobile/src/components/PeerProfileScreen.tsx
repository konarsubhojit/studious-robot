import { memo, useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import AppButton from './AppButton';
import { Icon } from './primitives';
import type { CallHistoryEntry } from '../hooks/useCallHistory';
import type { ThemeColors } from '../theme';
import type { PeerPresence } from '../types/directory';

export type { CallHistoryEntry };

/** How many recent calls with this peer are listed. */
const MAX_RECENT_CALLS = 5;

/**
 * Up to two uppercase initials derived from a userId, for the avatar circle.
 */
function getInitials(id: string | null | undefined) {
  const trimmed = (id ?? '').trim();
  if (!trimmed) return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Peer of a call-history entry, relative to the signed-in user.
 */
function callPeerOf(entry: CallHistoryEntry, currentUserId: string | null | undefined) {
  if (entry?.direction === 'outgoing') return entry?.calleeId ?? '';
  if (entry?.direction === 'incoming') return entry?.callerId ?? '';
  return entry?.callerId === currentUserId ? (entry?.calleeId ?? '') : (entry?.callerId ?? '');
}

/** @param entry */
function describeCall(entry: CallHistoryEntry) {
  if (entry?.status === 'missed' && entry?.direction === 'incoming') return 'Missed call';
  return entry?.direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
}

/** @param isoString */
function formatTimestamp(isoString: string | null | undefined) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export type PeerProfileScreenProps = {
  peerId: string;
  presence?: PeerPresence | null;
  isBlocked?: boolean;
  isMuted?: boolean;
  /** Full history; filtered to this peer here. */
  callHistory?: CallHistoryEntry[];
  currentUserId?: string | null;
  onBack?: () => void;
  onMessage?: (peerId: string) => void;
  onAudioCall?: (peerId: string) => void;
  onVideoCall?: (peerId: string) => void;
  onToggleMute?: (peerId: string) => void;
  onBlock?: (peerId: string) => Promise<boolean> | void;
  onUnblock?: (peerId: string) => Promise<boolean> | void;
  onReport?: (peerId: string) => void;
};

/**
 * Per-contact screen, reachable from the chat header, a call-log row or a
 * search result.
 *
 * It is where the relationship-level actions live: message, audio/video call,
 * mute notifications, and — for the first time in the UI — block/unblock.
 * Blocking is enforced server-side in both directions (the peer disappears
 * from the directory, the conversation list and search, and can no longer
 * call or message), and the same control reverses it.
 */
function PeerProfileScreen({
  peerId,
  presence = null,
  isBlocked = false,
  isMuted = false,
  callHistory = [],
  currentUserId = null,
  onBack,
  onMessage,
  onAudioCall,
  onVideoCall,
  onToggleMute,
  onBlock,
  onUnblock,
  onReport,
}: PeerProfileScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [isUpdatingBlock, setIsUpdatingBlock] = useState(false);

  const recentCalls = useMemo(
    () =>
      callHistory
        .filter(entry => callPeerOf(entry, currentUserId) === peerId)
        .slice(0, MAX_RECENT_CALLS),
    [callHistory, currentUserId, peerId],
  );

  const handleBlockPress = useCallback(async () => {
    if (isUpdatingBlock) return;
    setIsUpdatingBlock(true);
    try {
      if (isBlocked) {
        await onUnblock?.(peerId);
      } else {
        await onBlock?.(peerId);
      }
    } finally {
      setIsUpdatingBlock(false);
    }
  }, [isBlocked, isUpdatingBlock, onBlock, onUnblock, peerId]);

  const handleReportPress = useCallback(() => {
    if (onReport) {
      onReport(peerId);
      return;
    }
    Alert.alert('Report user', `Thanks — we'll review reports about ${peerId}.`);
  }, [onReport, peerId]);

  const presenceLabel = presence ? (presence.online ? 'Online' : 'Offline') : 'Presence unknown';

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} testID="peer-profile-root">
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={touchSlop(36)}
          testID="peer-profile-back"
          style={styles.backButton}>
          <Icon name="back" size={26} color={colors.onSurface} />
        </Pressable>
      </View>

      <View style={styles.identity}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>{getInitials(peerId)}</Text>
        </View>
        <Text style={styles.name} accessibilityRole="header" numberOfLines={1}>
          {peerId}
        </Text>
        <Text style={styles.presence} testID="peer-profile-presence">
          {presenceLabel}
        </Text>
      </View>

      {isBlocked ? (
        <Text style={[styles.blockedNote, { color: colors.danger }]} testID="peer-profile-blocked-note">
          Blocked — they can't call or message you, and you won't see them in search.
        </Text>
      ) : null}

      <View style={styles.actions}>
        <AppButton
          title="Message"
          onPress={() => onMessage?.(peerId)}
          disabled={isBlocked || !onMessage}
          style={styles.actionButton}
          testID="peer-profile-message"
        />
        <AppButton
          title="Audio call"
          onPress={() => onAudioCall?.(peerId)}
          disabled={isBlocked || !onAudioCall}
          style={styles.actionButton}
          testID="peer-profile-audio-call"
        />
        <AppButton
          title="Video call"
          onPress={() => onVideoCall?.(peerId)}
          disabled={isBlocked || !onVideoCall}
          style={styles.actionButton}
          testID="peer-profile-video-call"
        />
      </View>

      <Text style={styles.sectionTitle} accessibilityRole="header">
        Recent calls
      </Text>
      {recentCalls.length === 0 ? (
        <Text style={styles.empty} testID="peer-profile-no-calls">
          No calls with {peerId} yet
        </Text>
      ) : (
        recentCalls.map(entry => (
          <View key={entry.callId} style={styles.row} testID="peer-profile-call-row">
            <Text style={styles.rowTitle}>{describeCall(entry)}</Text>
            <Text style={styles.rowMeta}>{formatTimestamp(entry.createdAt)}</Text>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle} accessibilityRole="header">
        Privacy
      </Text>
      {onToggleMute ? (
        <Pressable
          onPress={() => onToggleMute(peerId)}
          accessibilityRole="switch"
          accessibilityState={{ checked: isMuted }}
          accessibilityLabel={
            isMuted ? `Unmute notifications from ${peerId}` : `Mute notifications from ${peerId}`
          }
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          testID="peer-profile-mute">
          <Text style={styles.rowTitle}>Mute notifications</Text>
          <Text style={styles.rowMeta}>{isMuted ? 'On' : 'Off'}</Text>
        </Pressable>
      ) : null}

      <AppButton
        title={isBlocked ? 'Unblock' : 'Block'}
        onPress={handleBlockPress}
        disabled={isUpdatingBlock}
        // `active` paints the button in the danger colour: blocking is a
        // destructive action, and an applied block stays visibly "on".
        active={!isBlocked}
        style={styles.actionButton}
        accessibilityLabel={isBlocked ? `Unblock ${peerId}` : `Block ${peerId}`}
        accessibilityHint={
          isBlocked
            ? `Lets ${peerId} call and message you again`
            : `Stops ${peerId} from calling or messaging you`
        }
        testID="peer-profile-block"
      />
      <Pressable
        onPress={handleReportPress}
        accessibilityRole="button"
        accessibilityLabel={`Report ${peerId}`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID="peer-profile-report">
        <Text style={styles.rowTitle}>Report</Text>
      </Pressable>
    </ScrollView>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    content: {
      padding: spacing.lg,
      paddingBottom: spacing.xl,
      gap: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    backButton: {
      height: 36,
      width: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    identity: {
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    avatarCircle: {
      height: 88,
      width: 88,
      borderRadius: 44,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    avatarText: {
      ...typography.title,
      color: colors.textPrimary,
    },
    name: {
      ...typography.sectionTitle,
      color: colors.textPrimary,
    },
    presence: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    blockedNote: {
      ...typography.hint,
      textAlign: 'center',
    },
    actions: {
      gap: spacing.sm,
    },
    // `AppButton` stretches by default (it is designed for rows); in this
    // stacked layout each button keeps its own height instead.
    actionButton: {
      flex: 0,
    },
    sectionTitle: {
      ...typography.sectionTitle,
      color: colors.textSecondary,
      marginTop: spacing.lg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      backgroundColor: colors.surface,
    },
    rowPressed: {
      opacity: 0.6,
    },
    rowTitle: {
      ...typography.body,
      color: colors.textPrimary,
    },
    rowMeta: {
      ...typography.hint,
      color: colors.textMuted,
    },
    empty: {
      ...typography.hint,
      color: colors.textSecondary,
    },
  });

/**
 * Memoized: the peer profile screen re-renders only when its own props change, not merely
 * because an ancestor re-rendered.
 */
export default memo(PeerProfileScreen);
