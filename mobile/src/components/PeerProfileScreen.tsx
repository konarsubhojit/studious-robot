import { memo, useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  callDirectionIcon,
  callMediaIcon,
  describeCallEntryForA11y,
  describeCallOutcome,
  formatCallTimeOfDay,
  groupCallsByDay,
  isMissedCall,
} from '../callLog';
import { formatCallDuration } from '../callUx';
import { useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import { Avatar, Icon, IconAction, ListItem, SectionHeader, Switch } from './primitives';
import type { CallHistoryEntry } from '../hooks/useCallHistory';
import type { ThemeColors } from '../theme';
import type { PeerPresence } from '../types/directory';

export type { CallHistoryEntry };

/** How many recent calls with this peer are listed; the Calls tab has them all. */
const MAX_RECENT_CALLS = 5;

/** Diameter of the three primary action buttons. */
const PRIMARY_ACTION_SIZE = 56;

/**
 * Peer of a call-history entry, relative to the signed-in user.
 *
 * Deliberately not `callLog.callPeerId`: that one trusts `direction`, and this
 * screen must still attribute an entry whose direction the server omitted.
 */
function callPeerOf(entry: CallHistoryEntry, currentUserId: string | null | undefined) {
  if (entry?.direction === 'outgoing') return entry?.calleeId ?? '';
  if (entry?.direction === 'incoming') return entry?.callerId ?? '';
  return entry?.callerId === currentUserId ? (entry?.calleeId ?? '') : (entry?.callerId ?? '');
}

/**
 * One of the three primary actions: a circular icon button with its label
 * underneath. The label is hidden from screen readers because the button
 * already carries the whole sentence.
 */
function PrimaryAction({
  icon,
  label,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabled,
  testID,
}: {
  icon: string;
  label: string;
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress?: () => void;
  disabled?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.primaryAction}>
      <IconAction
        icon={icon}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        disabled={disabled}
        size={PRIMARY_ACTION_SIZE}
        testID={testID}
      />
      <Text
        style={[styles.primaryActionLabel, disabled && styles.primaryActionLabelDisabled]}
        accessibilityElementsHidden
        importantForAccessibility="no">
        {label}
      </Text>
    </View>
  );
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
};

function PeerActions({
  peerId,
  isBlocked,
  onMessage,
  onAudioCall,
  onVideoCall,
  styles,
}: Pick<PeerProfileScreenProps, 'peerId' | 'isBlocked' | 'onMessage' | 'onAudioCall' |
  'onVideoCall'> & { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.actions}>
      <PrimaryAction
        icon="tabChats"
        label="Message"
        accessibilityLabel={`Message ${peerId}`}
        accessibilityHint="Opens the conversation"
        onPress={onMessage ? () => onMessage(peerId) : undefined}
        disabled={isBlocked || !onMessage}
        testID="peer-profile-message"
      />
      <PrimaryAction
        icon="chatAudioCall"
        label="Audio"
        accessibilityLabel={`Audio call ${peerId}`}
        accessibilityHint="Starts an audio call"
        onPress={onAudioCall ? () => onAudioCall(peerId) : undefined}
        disabled={isBlocked || !onAudioCall}
        testID="peer-profile-audio-call"
      />
      <PrimaryAction
        icon="chatVideoCall"
        label="Video"
        accessibilityLabel={`Video call ${peerId}`}
        accessibilityHint="Starts a video call"
        onPress={onVideoCall ? () => onVideoCall(peerId) : undefined}
        disabled={isBlocked || !onVideoCall}
        testID="peer-profile-video-call"
      />
    </View>
  );
}

function PeerRecentCalls({
  peerId,
  recentCalls,
  sections,
  styles,
}: {
  peerId: string;
  recentCalls: CallHistoryEntry[];
  sections: ReturnType<typeof groupCallsByDay>;
  styles: ReturnType<typeof createStyles>;
}) {
  if (recentCalls.length === 0) {
    return (
      <Text style={styles.empty} testID="peer-profile-no-calls">
        No calls with {peerId} yet
      </Text>
    );
  }
  return (
    <>
      {sections.map(section => (
        <View key={section.key}>
          <SectionHeader title={section.title} />
          {section.entries.map(entry => {
            const durationLabel =
              entry.durationSeconds != null ? formatCallDuration(entry.durationSeconds) : '';
            const subtitle = [formatCallTimeOfDay(entry.createdAt), durationLabel]
              .filter(Boolean)
              .join(' · ');
            return (
              <ListItem
                key={entry.callId}
                title={describeCallOutcome(entry)}
                subtitle={subtitle || null}
                destructive={isMissedCall(entry)}
                icon={callDirectionIcon(entry)}
                // Read-only: the primary actions above are how a call starts
                // here, so a history row can never dial by surprise.
                accessibilityRole="none"
                accessibilityLabel={describeCallEntryForA11y(entry, durationLabel)}
                trailing={
                  <Icon name={callMediaIcon(entry)} size={16} color={styles.rowGlyph.color} />
                }
                testID="peer-profile-call-row"
              />
            );
          })}
        </View>
      ))}
    </>
  );
}

/**
 * The person hub: everything the app knows about one person, and every
 * relationship-level decision about them, in one place.
 *
 * Reached from the chat header, a call-log row, a search result and the people
 * picker — every person-shaped tap in the app routes here rather than to a
 * screen-specific menu.
 *
 * Two controls that used to be decorative are real here. **Mute** silences that
 * person's message notifications through `notificationPreferences`, which the
 * headless push handler consults before it rings; the row was previously drawn
 * only when an `onToggleMute` prop was supplied, and nothing ever supplied one.
 * **Block** is enforced server-side in both directions (the peer disappears
 * from the directory, the conversation list and search, and can no longer call
 * or message), and the same control reverses it.
 *
 * There is deliberately no "Report" row: nothing on the server accepts a
 * report, and the row used to answer with an `Alert` promising that the report
 * would be reviewed. It comes back when there is somewhere to send it.
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
}: PeerProfileScreenProps) {
  const styles = useThemedStyles(createStyles);
  const [isUpdatingBlock, setIsUpdatingBlock] = useState(false);

  const recentCalls = useMemo(
    () =>
      callHistory
        .filter(entry => callPeerOf(entry, currentUserId) === peerId)
        .slice(0, MAX_RECENT_CALLS),
    [callHistory, currentUserId, peerId],
  );

  // The same day grouping the Calls tab uses, so a call reads identically
  // wherever it is listed.
  const sections = useMemo(() => groupCallsByDay(recentCalls), [recentCalls]);

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

  const handleToggleMute = useCallback(() => {
    onToggleMute?.(peerId);
  }, [onToggleMute, peerId]);

  const presenceLabel = presence ? (presence.online ? 'Online' : 'Offline') : 'Presence unknown';

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} testID="peer-profile-root">
      <View style={styles.header}>
        <IconAction
          icon="back"
          variant="plain"
          accessibilityLabel="Back"
          accessibilityHint="Returns to the previous screen"
          onPress={onBack}
          testID="peer-profile-back"
        />
      </View>

      <View style={styles.identity}>
        <Avatar
          id={peerId}
          size="xl"
          // Omitted rather than `false` when presence is unknown: the dot means
          // "they are offline", not "we never asked".
          online={presence ? Boolean(presence.online) : undefined}
          testID="peer-profile-avatar"
        />
        <Text style={styles.name} accessibilityRole="header" numberOfLines={1}>
          {peerId}
        </Text>
        <Text style={styles.presence} testID="peer-profile-presence">
          {presenceLabel}
        </Text>
      </View>

      {isBlocked ? (
        <Text style={styles.blockedNote} testID="peer-profile-blocked-note">
          Blocked — they can't call or message you, and you won't see them in search.
        </Text>
      ) : null}

      <PeerActions
        peerId={peerId}
        isBlocked={isBlocked}
        onMessage={onMessage}
        onAudioCall={onAudioCall}
        onVideoCall={onVideoCall}
        styles={styles}
      />

      <SectionHeader title="Calls" icon="tabCalls" variant="section" />
      <PeerRecentCalls
        peerId={peerId}
        recentCalls={recentCalls}
        sections={sections}
        styles={styles}
      />

      <SectionHeader title="Privacy" icon="settingsPrivacy" variant="section" />
      <Switch
        label="Mute notifications"
        hint={`Messages from ${peerId} arrive silently. Calls still ring.`}
        value={isMuted}
        onValueChange={handleToggleMute}
        accessibilityLabel={
          isMuted ? `Unmute notifications from ${peerId}` : `Mute notifications from ${peerId}`
        }
        testID="peer-profile-mute"
      />
      <ListItem
        title={isBlocked ? 'Unblock' : 'Block'}
        subtitle={
          isBlocked
            ? `Lets ${peerId} call and message you again`
            : `Stops ${peerId} from calling or messaging you`
        }
        icon="block"
        // An applied block is a state, not a destructive action to repeat; the
        // negative colour belongs on the control that would apply one.
        destructive={!isBlocked}
        disabled={isUpdatingBlock}
        onPress={handleBlockPress}
        accessibilityLabel={isBlocked ? `Unblock ${peerId}` : `Block ${peerId}`}
        testID="peer-profile-block"
      />
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
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    identity: {
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    name: {
      ...typography.title,
      color: colors.onSurface,
    },
    presence: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
    },
    blockedNote: {
      ...typography.caption,
      color: colors.negative,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: spacing.xl,
      marginBottom: spacing.sm,
    },
    primaryAction: {
      alignItems: 'center',
      gap: spacing.xs,
    },
    primaryActionLabel: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
    },
    primaryActionLabelDisabled: {
      opacity: 0.55,
    },
    // Read back by the trailing modality glyph: `designTokens.test.ts` forbids
    // a colour literal anywhere under `src/components`.
    rowGlyph: {
      color: colors.onSurfaceVariant,
    },
    empty: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
      paddingHorizontal: spacing.md,
    },
  });

/**
 * Memoized: the peer profile screen re-renders only when its own props change, not merely
 * because an ancestor re-rendered.
 */
export default memo(PeerProfileScreen);
