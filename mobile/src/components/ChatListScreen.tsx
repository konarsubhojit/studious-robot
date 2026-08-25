import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { describeMessagePreview } from '../../../shared';
import { useThemedStyles } from '../ThemeContext';
import { spacing, typography } from '../theme';
import PeoplePickerSheet from './PeoplePickerSheet';
import SwipeableRow from './SwipeableRow';
import {
  Avatar,
  Badge,
  EmptyState,
  FAB,
  Icon,
  IconAction,
  ListItem,
  SkeletonRow,
} from './primitives';
import type { CallActivity, ConversationActivity } from '../hooks/useMessaging';
import type { ThemeColors } from '../theme';
import type { ContactRow, ConversationRow } from '../types/directory';

/** Number of placeholder rows shown while the conversation list loads. */
const SKELETON_ROW_COUNT = 6;

export type { ContactRow, ConversationRow };

function formatConversationTimestamp(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString();
}

/**
 * The conversation's newest event: a call, when the server merged one in
 * (`lastActivity`), otherwise the last text message.
 */
function lastActivityOf(conversation: ConversationRow): ConversationActivity | null {
  return conversation?.lastActivity ?? conversation?.lastMessage ?? null;
}

/**
 * Whether a conversation's newest event is a call rather than a message.
 */
function isCallActivity(activity: ConversationActivity): activity is CallActivity {
  return activity.type === 'call';
}

/**
 * One-line preview of a conversation's newest event, so a row whose latest
 * activity was a call reads as such instead of showing a stale older message.
 *
 * Calls no longer prefix themselves with a 📞: the row draws a real direction
 * glyph in the trailing slot, and two different phone pictures on one row read
 * as two different things.
 */
function formatActivityPreview(conversation: ConversationRow): string {
  const activity = lastActivityOf(conversation);
  if (!activity) return 'No messages yet';
  // A rich message describes itself ("📷 Photo", "🎤 Voice message", or a
  // neutral placeholder for a type this build does not know).
  if (!isCallActivity(activity)) return describeMessagePreview(activity) || 'No messages yet';
  if (activity.status === 'missed' && activity.direction === 'incoming') {
    return 'Missed call';
  }
  return activity.direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
}

/** Semantic icon key for a conversation whose newest event is a call. */
function activityIconFor(conversation: ConversationRow): string | null {
  const activity = lastActivityOf(conversation);
  if (!activity || !isCallActivity(activity)) return null;
  if (activity.status === 'missed' && activity.direction === 'incoming') return 'callMissed';
  return activity.direction === 'outgoing' ? 'callOutgoing' : 'callIncoming';
}

export type ChatListScreenProps = {
  conversations?: ConversationRow[];
  onOpenConversation: (peerId: string) => void;
  /** Directory lookup, used by the New-chat People picker. */
  onSearchUsers?: (query: string) => Promise<ContactRow[]>;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** Shows skeleton rows while the first conversation list fetch is still in flight. */
  isLoading?: boolean;
  /** Swipe action: mark a conversation read without opening it. */
  onMarkRead?: (peerId: string) => void;
  /** Opens the full-screen unified search (people, conversations, messages and calls). */
  onOpenSearch?: () => void;
  /** Person hub; reached by long-pressing a row. */
  onOpenProfile?: (peerId: string) => void;
  /** Opens (or creates) a conversation with someone picked from the directory. */
  onStartChat?: (peerId: string) => void;
  /** The signed-in user, shown as the header avatar. */
  currentUserId?: string;
};

/**
 * The Chats tab: the conversation list, and nothing else.
 *
 * The screen used to carry an inline "Search contacts" field that swapped the
 * whole list for directory results, *plus* a 🔍 button opening the full-screen
 * search, *plus* a ⚙️ opening Settings — which is also a tab. Search now
 * happens in exactly one place (`SearchScreen`, via the header action) and
 * starting a new conversation happens in exactly one place (the People picker,
 * via the FAB), so the list itself never turns into something else.
 */
function ChatListScreen({
  conversations = [],
  onOpenConversation,
  onSearchUsers,
  onRefresh,
  isRefreshing = false,
  isLoading = false,
  onMarkRead,
  onOpenSearch,
  onOpenProfile,
  onStartChat,
  currentUserId,
}: ChatListScreenProps) {
  const styles = useThemedStyles(createStyles);
  const [isPickerVisible, setIsPickerVisible] = useState(false);

  const startChat = onStartChat ?? onOpenConversation;

  const renderConversationRow = useCallback(
    (conversation: ConversationRow) => {
      const unreadCount = conversation.unreadCount ?? 0;
      const hasUnread = unreadCount > 0;
      const actions =
        onMarkRead && hasUnread
          ? [
              {
                key: 'mark-read',
                label: 'Mark read',
                accessibilityLabel: `Mark conversation with ${conversation.peerId} as read`,
                testID: 'chat-list-mark-read',
                onPress: () => onMarkRead(conversation.peerId),
              },
            ]
          : [];
      const activityIcon = activityIconFor(conversation);
      const timestamp = formatConversationTimestamp(lastActivityOf(conversation)?.createdAt);

      return (
        <SwipeableRow actions={actions}>
          <ListItem
            title={conversation.peerId}
            subtitle={formatActivityPreview(conversation)}
            leading={
              <Avatar
                id={conversation.peerId}
                size="md"
                online={conversation.online}
                testID="chat-list-avatar"
              />
            }
            trailing={
              <View style={styles.meta}>
                {timestamp ? <Text style={styles.timestamp}>{timestamp}</Text> : null}
                <View style={styles.metaRow}>
                  {activityIcon ? (
                    <Icon
                      name={activityIcon}
                      size={14}
                      color={
                        activityIcon === 'callMissed'
                          ? styles.missedGlyph.color
                          : styles.timestamp.color
                      }
                    />
                  ) : null}
                  {hasUnread ? (
                    <Badge count={unreadCount} testID="chat-list-unread-badge" />
                  ) : null}
                </View>
              </View>
            }
            onPress={() => onOpenConversation?.(conversation.peerId)}
            onLongPress={onOpenProfile ? () => onOpenProfile(conversation.peerId) : undefined}
            accessibilityLabel={
              hasUnread
                ? `Open conversation with ${conversation.peerId}, ${unreadCount} unread`
                : `Open conversation with ${conversation.peerId}`
            }
            accessibilityHint={onOpenProfile ? 'Long press for contact details' : undefined}
            testID="chat-list-row"
          />
        </SwipeableRow>
      );
    },
    [onMarkRead, onOpenConversation, onOpenProfile, styles],
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationRow; }) => renderConversationRow(item),
    [renderConversationRow],
  );

  const emptyComponent = isLoading ? (
    <View testID="chat-list-skeleton">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => (
        <SkeletonRow key={`skeleton-${index}`} />
      ))}
    </View>
  ) : (
    <EmptyState
      icon="emptyChats"
      title="No conversations yet"
      description="Find someone by their username and say hello."
      actionLabel={onSearchUsers ? 'Find someone' : undefined}
      actionHint="Opens the list of people you can message"
      onAction={onSearchUsers ? () => setIsPickerVisible(true) : undefined}
      testID="chat-list-empty"
    />
  );

  return (
    <View style={styles.root} testID="chat-list-root">
      <View style={styles.titleRow}>
        {/* Identity, not a control: Settings is a tab, and the ⚙️ that used to
            sit here was a second door into the same room. */}
        <Avatar id={currentUserId} size="sm" testID="chat-list-self-avatar" />
        <Text style={styles.title} accessibilityRole="header">
          Chats
        </Text>
        <View style={styles.titleSpacer} />
        {onOpenSearch ? (
          <IconAction
            icon="search"
            accessibilityLabel="Search"
            accessibilityHint="Search people, conversations, messages and calls"
            onPress={onOpenSearch}
            testID="chat-list-open-search"
          />
        ) : null}
      </View>

      <FlatList
        testID="chat-list"
        data={conversations}
        keyExtractor={item => item.conversationId ?? item.peerId}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        // Virtualization tuning so a long conversation list mounts a bounded
        // number of rows instead of all of them at once.
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        ListEmptyComponent={emptyComponent}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={Boolean(isRefreshing)} onRefresh={onRefresh} />
          ) : undefined
        }
      />

      {onSearchUsers ? (
        <FAB
          icon="newChat"
          accessibilityLabel="New chat"
          accessibilityHint="Opens the list of people you can message"
          onPress={() => setIsPickerVisible(true)}
          testID="chat-list-new-chat"
        />
      ) : null}

      <PeoplePickerSheet
        visible={isPickerVisible}
        onClose={() => setIsPickerVisible(false)}
        title="New chat"
        onSearchUsers={onSearchUsers}
        conversations={conversations}
        onSelect={startChat}
        testID="chat-list-people-picker"
      />
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
    content: {
      paddingBottom: spacing['3xl'] + spacing.xl,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    title: {
      ...typography.display,
      color: colors.onSurface,
    },
    titleSpacer: {
      flex: 1,
    },
    meta: {
      alignItems: 'flex-end',
      gap: spacing.xs,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    timestamp: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
    },
    // Read for its colour when tinting the missed-call glyph, so that red still
    // comes from the palette rather than being spelled at the call site.
    missedGlyph: {
      color: colors.negative,
    },
  });

/**
 * Memoized: the conversation list re-renders only when its own props change,
 * not merely because an ancestor re-rendered.
 */
export default memo(ChatListScreen);
