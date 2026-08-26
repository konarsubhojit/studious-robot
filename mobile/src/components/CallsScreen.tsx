import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import {
  CALL_FILTERS,
  callDirectionIcon,
  callMediaIcon,
  callMediaType,
  callPeerId,
  describeCallEntryForA11y,
  describeCallOutcome,
  filterCallLog,
  formatCallTimeOfDay,
  groupCallsByDay,
  isMissedCall,
} from '../callLog';
import { formatCallDuration } from '../callUx';
import { describeOffline, OFFLINE_CONSEQUENCE, OFFLINE_ICON } from '../connectivityUx';
import { announceForAccessibility } from '../accessibilityAnnouncer';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import PeoplePickerSheet from './PeoplePickerSheet';
import StatusBanner from './StatusBanner';
import {
  Avatar,
  Banner,
  EmptyState,
  FAB,
  Icon,
  IconAction,
  ListItem,
  SectionHeader,
  SegmentedControl,
  Sheet,
  SkeletonRow,
} from './primitives';
import type { CallFilter } from '../callLog';
import type { CallHistoryEntry } from '../hooks/useCallHistory';
import type { CallStatus } from './StatusBanner';
import type { ThemeColors } from '../theme';
import type { ContactRow, ConversationRow } from '../types/directory';

export type CallsScreenProps = {
  callHistory?: CallHistoryEntry[];
  missedCallCount?: number;
  onMarkMissedRead?: () => void;
  /** Person-hub navigation; every person-shaped tap routes here. */
  onOpenProfile?: (peerId: string) => void;
  onAudioCall?: (peerId: string) => void;
  onVideoCall?: (peerId: string) => void;
  onOpenSearch?: () => void;
  onSearchUsers?: (query: string) => Promise<ContactRow[]>;
  conversations?: ConversationRow[];
  isServerUnreachable?: boolean;
  onRetryConnect?: () => void;
  isLoading?: boolean;
  status?: CallStatus;
};

const FILTER_OPTIONS = [
  { value: CALL_FILTERS.ALL, label: 'All' },
  { value: CALL_FILTERS.MISSED, label: 'Missed' },
];

/** Placeholder rows drawn while the first history fetch is in flight. */
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

/**
 * The Calls tab: a real call log.
 *
 * This screen replaces the old lobby, which was still the room-join form —
 * "Your user ID", "Callee user ID" and a Call button — stacked together with a
 * missed-call badge, an offline banner, a last-call summary card, five
 * undated history rows, a second contact search and a developer panel. The
 * information architecture here is the opposite of that: one job, done fully.
 *
 * - The whole log, not the five most recent calls.
 * - Rows grouped under date headings, each showing the time of day and the
 *   duration rather than a bare "Call · 02:31".
 * - An All / Missed filter.
 * - Tapping a row opens the person hub. It never dials by surprise: the old
 *   screen dialled *video* from any row tap, so redialling a voice call
 *   started a video call.
 * - The trailing call button dials in the modality the call was placed in.
 * - A "New call" FAB opens the People picker, then asks audio or video.
 */
export default function CallsScreen({
  callHistory,
  missedCallCount = 0,
  onMarkMissedRead,
  onOpenProfile,
  onAudioCall,
  onVideoCall,
  onOpenSearch,
  onSearchUsers,
  conversations,
  isServerUnreachable,
  onRetryConnect,
  isLoading = false,
  status,
}: CallsScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [filter, setFilter] = useState((CALL_FILTERS.ALL as CallFilter));
  const [isPickerVisible, setIsPickerVisible] = useState(false);
  // Peer chosen in the picker, awaiting an audio/video decision.
  const [pendingPeerId, setPendingPeerId] = useState((null as string | null));

  // Opening the tab is the acknowledgement: the badge exists to bring the user
  // here, so keeping it lit once they have arrived is just noise.
  useEffect(() => {
    if (missedCallCount > 0) onMarkMissedRead?.();
    // Deliberately only on mount: re-running on every count change would clear
    // a call missed while the user is looking at the log, before they see it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sections = useMemo(
    () => groupCallsByDay(filterCallLog(callHistory, filter)),
    [callHistory, filter],
  );

  const handleFilterChange = useCallback((next: CallFilter) => {
    setFilter(next);
    announceForAccessibility(
      next === CALL_FILTERS.MISSED ? 'Showing missed calls' : 'Showing all calls',
    );
  }, []);

  const redial = useCallback(
    (entry: CallHistoryEntry) => {
      const peerId = callPeerId(entry);
      if (!peerId) return;
      // The whole point of recording the modality: a voice call redials as a
      // voice call.
      if (callMediaType(entry) === 'audio') onAudioCall?.(peerId);
      else onVideoCall?.(peerId);
    },
    [onAudioCall, onVideoCall],
  );

  const handlePickPerson = useCallback((peerId: string) => {
    setPendingPeerId(peerId);
  }, []);

  const startPendingCall = useCallback(
    (kind: 'audio' | 'video') => {
      const peerId = pendingPeerId;
      setPendingPeerId(null);
      if (!peerId) return;
      if (kind === 'audio') onAudioCall?.(peerId);
      else onVideoCall?.(peerId);
    },
    [onAudioCall, onVideoCall, pendingPeerId],
  );

  const canCall = Boolean(onAudioCall || onVideoCall);
  const hasEntries = sections.length > 0;

  return (
    <View style={styles.root} testID="calls-root">
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Calls
        </Text>
        {onOpenSearch ? (
          <IconAction
            icon="search"
            accessibilityLabel="Search"
            accessibilityHint="Search people, conversations, messages and calls"
            onPress={onOpenSearch}
            testID="calls-open-search"
          />
        ) : null}
      </View>

      <View style={styles.filterRow}>
        <SegmentedControl
          options={FILTER_OPTIONS}
          value={filter}
          onChange={handleFilterChange}
          accessibilityLabel="Filter calls"
          testID="calls-filter"
        />
      </View>

      {/* The same condition, worded the same way and weighted the same way, as
          the one Search and the conversation show. */}
      {isServerUnreachable ? (
        <Banner
          tone="warning"
          message={describeOffline(OFFLINE_CONSEQUENCE.calls)}
          icon={OFFLINE_ICON}
          actionLabel="Retry"
          actionHint="Tries to reconnect to the signaling server"
          onAction={onRetryConnect}
          accessibilityRole="alert"
          style={styles.bannerWrap}
          testID="offline-banner"
        />
      ) : null}

      <StatusBanner status={status} style={styles.bannerWrap} />

      {isLoading && !hasEntries ? (
        <View testID="calls-loading">
          {SKELETON_ROWS.map(row => (
            <SkeletonRow key={row} />
          ))}
        </View>
      ) : hasEntries ? (
        <SectionList
          sections={sections.map(section => ({ ...section, data: section.entries }))}
          keyExtractor={entry => entry.callId}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          testID="call-history-section"
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
          renderItem={({ item }) => {
            const peerId = callPeerId(item);
            const missed = isMissedCall(item);
            const durationLabel =
              item.durationSeconds != null ? formatCallDuration(item.durationSeconds) : '';
            const timeLabel = formatCallTimeOfDay(item.createdAt);
            const modality = callMediaType(item);

            return (
              <ListItem
                title={peerId || 'Unknown contact'}
                subtitle={[describeCallOutcome(item), timeLabel, durationLabel]
                  .filter(Boolean)
                  .join(' · ')}
                destructive={missed}
                leading={<Avatar id={peerId} size="md" />}
                onPress={onOpenProfile && peerId ? () => onOpenProfile(peerId) : undefined}
                accessibilityLabel={describeCallEntryForA11y(item, durationLabel)}
                accessibilityHint={peerId ? `Opens ${peerId}'s details` : undefined}
                trailing={
                  <View style={styles.trailing}>
                    <Icon
                      name={callDirectionIcon(item)}
                      size={16}
                      color={missed ? colors.negative : colors.onSurfaceVariant}
                    />
                    <Icon
                      name={callMediaIcon(item)}
                      size={16}
                      color={colors.onSurfaceVariant}
                    />
                    {canCall && peerId ? (
                      <IconAction
                        icon={modality === 'audio' ? 'callTypeAudio' : 'callTypeVideo'}
                        accessibilityLabel={`Call ${peerId} back`}
                        accessibilityHint={
                          modality === 'audio'
                            ? 'Starts an audio call'
                            : 'Starts a video call'
                        }
                        onPress={() => redial(item)}
                        size={40}
                        testID="call-history-redial"
                      />
                    ) : null}
                  </View>
                }
                testID="call-history-row"
              />
            );
          }}
        />
      ) : (
        <EmptyState
          icon="emptyCalls"
          title={filter === CALL_FILTERS.MISSED ? 'No missed calls' : 'No calls yet'}
          description={
            filter === CALL_FILTERS.MISSED
              ? 'Calls you miss will be listed here.'
              : 'Call someone and it will show up here.'
          }
          actionLabel={filter === CALL_FILTERS.MISSED ? undefined : 'Start a call'}
          actionHint="Opens the list of people you can call"
          onAction={
            filter === CALL_FILTERS.MISSED ? undefined : () => setIsPickerVisible(true)
          }
          testID="calls-empty"
        />
      )}

      {canCall ? (
        <FAB
          icon="newCall"
          accessibilityLabel="New call"
          accessibilityHint="Opens the list of people you can call"
          onPress={() => setIsPickerVisible(true)}
          testID="calls-new-call"
        />
      ) : null}

      <PeoplePickerSheet
        visible={isPickerVisible}
        onClose={() => setIsPickerVisible(false)}
        title="New call"
        onSearchUsers={onSearchUsers}
        conversations={conversations}
        onSelect={handlePickPerson}
        testID="calls-people-picker"
      />

      <Sheet
        visible={Boolean(pendingPeerId)}
        onClose={() => setPendingPeerId(null)}
        title={pendingPeerId ? `Call ${pendingPeerId}` : 'Call'}
        subtitle="Choose how to connect"
        testID="calls-modality-sheet">
        <ListItem
          title="Audio call"
          icon="callTypeAudio"
          onPress={() => startPendingCall('audio')}
          accessibilityLabel={`Audio call ${pendingPeerId ?? ''}`}
          testID="calls-modality-audio"
        />
        <ListItem
          title="Video call"
          icon="callTypeVideo"
          onPress={() => startPendingCall('video')}
          accessibilityLabel={`Video call ${pendingPeerId ?? ''}`}
          testID="calls-modality-video"
        />
      </Sheet>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    title: {
      ...typography.display,
      color: colors.onSurface,
    },
    filterRow: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    bannerWrap: {
      paddingHorizontal: spacing.lg,
    },
    listContent: {
      paddingBottom: spacing['3xl'] + spacing.xl,
    },
    trailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
  });
