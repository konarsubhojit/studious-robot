import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import {
  CALL_FILTERS,
  callDirectionIcon,
  callMediaIcon,
  callMediaType,
  callPeerId,
  CallLogSection,
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
import SwipeableRow from './SwipeableRow';
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
  onFetchCallHistory?: () => void | Promise<void>;
  onMarkMissedRead?: () => void;
  /** Person-hub navigation; every person-shaped tap routes here. */
  onOpenProfile?: (peerId: string) => void;
  /** Open the conversation with this person; surfaced as a row swipe action. */
  onMessage?: (peerId: string) => void;
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

function CallHistoryTrailing({
  item,
  peerId,
  missed,
  canCall,
  colors,
  styles,
  onRedial,
}: {
  item: CallHistoryEntry;
  peerId: string;
  missed: boolean;
  canCall: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onRedial: (entry: CallHistoryEntry) => void;
}) {
  const modality = callMediaType(item);
  return (
    <View style={styles.trailing}>
      <Icon
        name={callDirectionIcon(item)}
        size={16}
        color={missed ? colors.negative : colors.onSurfaceVariant}
      />
      <Icon name={callMediaIcon(item)} size={16} color={colors.onSurfaceVariant} />
      {canCall && peerId ? (
        <IconAction
          icon={modality === 'audio' ? 'callTypeAudio' : 'callTypeVideo'}
          accessibilityLabel={`Call ${peerId} back`}
          accessibilityHint={modality === 'audio' ? 'Starts an audio call' : 'Starts a video call'}
          onPress={() => onRedial(item)}
          size={40}
          testID="call-history-redial"
        />
      ) : null}
    </View>
  );
}

function CallHistoryRow({
  item,
  canCall,
  colors,
  styles,
  onMessage,
  onOpenProfile,
  onRedial,
}: {
  item: CallHistoryEntry;
  canCall: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onMessage?: (peerId: string) => void;
  onOpenProfile?: (peerId: string) => void;
  onRedial: (entry: CallHistoryEntry) => void;
}) {
  const peerId = callPeerId(item);
  const missed = isMissedCall(item);
  const durationLabel =
    item.durationSeconds != null ? formatCallDuration(item.durationSeconds) : '';
  const timeLabel = formatCallTimeOfDay(item.createdAt);
  // The reciprocal of the call button in the conversation header: from
  // a call in the log, reach the conversation with the same person.
  const actions = onMessage && peerId
    ? [{
        key: 'message',
        label: 'Message',
        accessibilityLabel: `Message ${peerId}`,
        testID: 'call-history-message',
        onPress: () => onMessage(peerId),
      }]
    : [];

  return (
    <SwipeableRow actions={actions}>
      <ListItem
        title={peerId || 'Unknown contact'}
        subtitle={[describeCallOutcome(item), timeLabel, durationLabel].filter(Boolean).join(' · ')}
        destructive={missed}
        leading={<Avatar id={peerId} size="md" />}
        onPress={onOpenProfile && peerId ? () => onOpenProfile(peerId) : undefined}
        accessibilityLabel={describeCallEntryForA11y(item, durationLabel)}
        accessibilityHint={peerId ? `Opens ${peerId}'s details` : undefined}
        trailing={
          <CallHistoryTrailing
            item={item}
            peerId={peerId}
            missed={missed}
            canCall={canCall}
            colors={colors}
            styles={styles}
            onRedial={onRedial}
          />
        }
        testID="call-history-row"
      />
    </SwipeableRow>
  );
}

function CallsScreenResults({
  isServerUnreachable,
  onRetryConnect,
  status,
  isLoading,
  hasEntries,
  sections,
  renderSectionHeader,
  renderItem,
  filter,
  onOpenSearch,
  styles,
}: {
  isServerUnreachable?: boolean;
  onRetryConnect?: () => void;
  status?: CallStatus;
  isLoading: boolean;
  hasEntries: boolean;
  sections: Array<CallLogSection & { data: CallHistoryEntry[]; }>;
  renderSectionHeader: ({ section }: { section: CallLogSection }) => React.ReactElement;
  renderItem: ({ item }: { item: CallHistoryEntry }) => React.ReactElement;
  filter: CallFilter;
  onOpenSearch?: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <>
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
          {SKELETON_ROWS.map(row => <SkeletonRow key={row} />)}
        </View>
      ) : hasEntries ? (
        <SectionList
          sections={sections}
          keyExtractor={entry => entry.callId}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.listContent}
          testID="call-history-section"
          renderSectionHeader={renderSectionHeader}
          renderItem={renderItem}
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
          // No `actionLabel` here: the FAB below is the screen's one primary
          // action, and an empty state that repeats it in the same accent
          // colour 200px away makes whichever the user reaches for the wrong
          // one. The search link is low-emphasis on purpose: it is the way out
          // for someone who has no one to call yet, which the FAB's picker
          // cannot offer them.
          linkLabel={onOpenSearch ? 'Search for people' : undefined}
          onLinkPress={onOpenSearch}
          linkHint="Search people, conversations, messages and calls"
          testID="calls-empty"
        />
      )}
    </>
  );
}

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
  onFetchCallHistory,
  onMarkMissedRead,
  onOpenProfile,
  onMessage,
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

  useEffect(() => {
    void onFetchCallHistory?.();
  }, [onFetchCallHistory]);

  // Opening the tab is the acknowledgement: the badge exists to bring the user
  // here, so keeping it lit once they have arrived is just noise.
  useEffect(() => {
    if (missedCallCount > 0) onMarkMissedRead?.();
    // Deliberately only on mount: re-running on every count change would clear
    // a call missed while the user is looking at the log, before they see it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grouped once per (history, filter) change and already shaped for
  // SectionList: mapping `entries` -> `data` in the render body would allocate
  // a fresh array of fresh section objects on every render, which defeats the
  // list's own bail-outs and re-renders every visible row.
  const sections = useMemo(
    () =>
      groupCallsByDay(filterCallLog(callHistory, filter)).map(section => ({
        ...section,
        data: section.entries,
      })),
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

  const canCall = Boolean(onAudioCall || onVideoCall);

  const renderSectionHeader = useCallback(
    ({ section }: { section: CallLogSection }) => <SectionHeader title={section.title} />,
    [],
  );

  // Hoisted out of the JSX: an inline renderer is a new function identity on
  // every render, which forces SectionList to re-render every mounted row.
  const renderItem = useCallback(
    ({ item }: { item: CallHistoryEntry }) => (
      <CallHistoryRow
        item={item}
        canCall={canCall}
        colors={colors}
        styles={styles}
        onMessage={onMessage}
        onOpenProfile={onOpenProfile}
        onRedial={redial}
      />
    ),
    [
      canCall,
      colors,
      onMessage,
      onOpenProfile,
      redial,
      styles,
    ],
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

      <CallsScreenResults
        isServerUnreachable={isServerUnreachable}
        onRetryConnect={onRetryConnect}
        status={status}
        isLoading={isLoading}
        hasEntries={hasEntries}
        sections={sections}
        renderSectionHeader={renderSectionHeader}
        renderItem={renderItem}
        filter={filter}
        onOpenSearch={onOpenSearch}
        styles={styles}
      />

      {canCall ? (
        <FAB
          icon="newCall"
          accessibilityLabel="New call"
          accessibilityHint="Opens the list of people you can call"
          onPress={() => setIsPickerVisible(true)}
          style={styles.fab}
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
    // Material 3 pins a FAB 16dp from the right edge and 16dp above whatever
    // is beneath it; in flow it used to sit flush against the screen edge and
    // push the list up by its own height.
    fab: {
      position: 'absolute',
      right: spacing.lg,
      bottom: spacing.lg,
    },
    trailing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
  });
