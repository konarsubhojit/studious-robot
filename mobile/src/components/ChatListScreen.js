import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import SwipeableRow from './SwipeableRow';

/** Number of placeholder rows shown while the conversation list loads. */
const SKELETON_ROW_COUNT = 6;

function ClearableInput({ value, onChangeText, placeholder, accessibilityLabel, testID }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.inputRow}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      />
      {value ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel={`Clear ${accessibilityLabel}`}
          hitSlop={touchSlop(28)}
          testID={`${testID}-clear`}
          style={styles.clearButton}>
          <Text style={styles.clearButtonText}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function formatConversationTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday ? date.toLocaleTimeString() : date.toLocaleDateString();
}

/** Up to two uppercase initials derived from a userId, for the avatar circle. */
function getInitials(id) {
  const trimmed = (id ?? '').trim();
  if (!trimmed) return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Initials avatar with an optional online-status dot, used on both
 * conversation rows and search-result contact rows.
 *
 * @param {{ id: string, online?: boolean, testID?: string }} props
 */
function Avatar({ id, online, testID }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.avatarWrap} testID={testID}>
      <View style={styles.avatarCircle}>
        <Text style={styles.avatarText}>{getInitials(id)}</Text>
      </View>
      {typeof online === 'boolean' ? (
        <View
          style={[
            styles.avatarStatusDot,
            online ? styles.presenceDotOnline : styles.presenceDotOffline,
          ]}
          testID={testID ? `${testID}-status` : undefined}
        />
      ) : null}
    </View>
  );
}

/** Placeholder rows shown while the conversation list is being fetched. */
function ConversationSkeleton() {
  const styles = useThemedStyles(createStyles);

  return (
    <View testID="chat-list-skeleton">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => (
        <View key={`skeleton-${index}`} style={styles.row}>
          <View style={[styles.avatarCircle, styles.skeletonBlock]} />
          <View style={styles.rowText}>
            <View style={[styles.skeletonBlock, styles.skeletonTitle]} />
            <View style={[styles.skeletonBlock, styles.skeletonSubtitle]} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Illustrated placeholder shown when the user has no conversations yet. */
function EmptyConversations() {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.emptyState} testID="chat-list-empty">
      <Text style={styles.emptyIllustration}>💬</Text>
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.empty}>Search for a contact above to start chatting</Text>
    </View>
  );
}

/**
 * Teams/Slack-style chat list: a searchable contact directory that swaps to
 * the conversation list once the search query is cleared.
 *
 * @param {object} props
 * @param {Array<{ conversationId: string, peerId: string, lastMessage?: object, unreadCount?: number, online?: boolean }>} props.conversations
 * @param {(peerId: string) => void} props.onOpenConversation
 * @param {(query: string) => Promise<Array>} [props.onSearchUsers]
 * @param {() => void} [props.onRefresh]
 * @param {boolean} [props.isRefreshing]
 * @param {boolean} [props.isLoading] - Shows skeleton rows while the first conversation
 *   list fetch is still in flight.
 * @param {(peerId: string) => void} [props.onMarkRead] - Swipe action: mark a
 *   conversation read without opening it.
 * @param {() => void} [props.onOpenSettings]
 */
export default function ChatListScreen({
  conversations = [],
  onOpenConversation,
  onSearchUsers,
  onRefresh,
  isRefreshing = false,
  isLoading = false,
  onMarkRead,
  onOpenSettings,
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  const runSearch = useCallback(
    async term => {
      if (typeof onSearchUsers !== 'function') return;
      if (!term) {
        setResults([]);
        setHasSearched(false);
        setIsSearching(false);
        return;
      }
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSearching(true);
      let users = [];
      try {
        users = await onSearchUsers(term);
      } catch (_error) {
        users = [];
      }
      if (requestIdRef.current !== requestId) return;
      setResults(Array.isArray(users) ? users : []);
      setIsSearching(false);
      setHasSearched(true);
    },
    [onSearchUsers],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      runSearch(query.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const isSearchMode = query.trim().length > 0;
  // While a search request is in flight the previous results are hidden, so
  // stale matches for an older query are never shown next to the spinner.
  const listData = isSearchMode ? (isSearching ? [] : results) : conversations;

  const renderContactRow = useCallback(
    contact => (
      <Pressable
        onPress={() => onOpenConversation?.(contact.userId)}
        accessibilityRole="button"
        accessibilityLabel={`Chat with ${contact.userId}`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID="chat-list-contact-row">
        <Avatar id={contact.userId} online={contact.online} testID="chat-list-contact-avatar" />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{contact.userId}</Text>
          <Text style={styles.rowSubtitle}>{contact.online ? 'Online' : 'Offline'}</Text>
        </View>
      </Pressable>
    ),
    [onOpenConversation, styles],
  );

  const renderConversationRow = useCallback(
    conversation => {
      const hasUnread = conversation.unreadCount > 0;
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

      return (
        <SwipeableRow actions={actions}>
          <Pressable
            onPress={() => onOpenConversation?.(conversation.peerId)}
            accessibilityRole="button"
            accessibilityLabel={`Open conversation with ${conversation.peerId}`}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            testID="chat-list-row">
            <Avatar
              id={conversation.peerId}
              online={conversation.online}
              testID="chat-list-avatar"
            />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{conversation.peerId}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {conversation.lastMessage?.body || 'No messages yet'}
              </Text>
            </View>
            <View style={styles.rowMeta}>
              <Text style={styles.rowTimestamp}>
                {formatConversationTimestamp(conversation.lastMessage?.createdAt)}
              </Text>
              {hasUnread ? (
                <View style={styles.unreadBadge} testID="chat-list-unread-badge">
                  <Text style={styles.unreadBadgeText}>{conversation.unreadCount}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        </SwipeableRow>
      );
    },
    [onMarkRead, onOpenConversation, styles],
  );

  const renderItem = useCallback(
    ({ item }) => (isSearchMode ? renderContactRow(item) : renderConversationRow(item)),
    [isSearchMode, renderContactRow, renderConversationRow],
  );

  let emptyComponent = null;
  if (isSearchMode) {
    emptyComponent =
      !isSearching && hasSearched ? (
        <Text style={styles.empty} testID="chat-list-empty">
          No matching contacts
        </Text>
      ) : null;
  } else if (isLoading) {
    emptyComponent = <ConversationSkeleton />;
  } else {
    emptyComponent = <EmptyConversations />;
  }

  return (
    <View style={styles.root} testID="chat-list-root">
      <View style={styles.titleRow}>
        <Text style={styles.title} accessibilityRole="header">
          Chats
        </Text>
        <View style={styles.titleSpacer} />
        {onOpenSettings ? (
          <Pressable
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            accessibilityHint="Opens account and connection settings"
            hitSlop={touchSlop(36)}
            testID="chat-list-open-settings"
            style={styles.gearButton}>
            <Text style={styles.gearIcon}>⚙️</Text>
          </Pressable>
        ) : null}
      </View>

      <ClearableInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search contacts"
        accessibilityLabel="Search contacts"
        testID="chat-list-search-input"
      />

      <FlatList
        testID="chat-list"
        data={listData}
        keyExtractor={item => (isSearchMode ? item.userId : item.conversationId)}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        // Virtualization tuning so a long conversation/contact list mounts a
        // bounded number of rows instead of all of them at once.
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        ListHeaderComponent={
          isSearchMode && isSearching ? (
            <View style={styles.statusRow} testID="chat-list-searching">
              <ActivityIndicator size="small" color={colors.textSecondary} />
              <Text style={styles.statusText}>Searching…</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={emptyComponent}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={Boolean(isRefreshing)} onRefresh={onRefresh} />
          ) : undefined
        }
      />
    </View>
  );
}

const createStyles = colors =>
  StyleSheet.create({
    root: {
      flex: 1,
      padding: spacing.lg,
    },
    content: {
      paddingBottom: spacing.xl,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    title: {
      ...typography.title,
      color: colors.textPrimary,
    },
    titleSpacer: {
      flex: 1,
    },
    gearButton: {
      height: 36,
      width: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    gearIcon: {
      fontSize: 18,
    },
    inputRow: {
      position: 'relative',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    input: {
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      paddingRight: 40,
    },
    clearButton: {
      position: 'absolute',
      right: spacing.sm,
      height: 28,
      width: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    clearButtonText: {
      color: colors.textSecondary,
      fontWeight: '700',
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    statusText: {
      color: colors.textSecondary,
      fontSize: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    rowPressed: {
      opacity: 0.6,
    },
    rowText: {
      flex: 1,
    },
    rowTitle: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    rowSubtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
    },
    rowMeta: {
      alignItems: 'flex-end',
      gap: spacing.xs,
    },
    rowTimestamp: {
      color: colors.textMuted,
      fontSize: 11,
    },
    unreadBadge: {
      backgroundColor: colors.danger,
      borderRadius: 12,
      minWidth: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    unreadBadgeText: {
      color: '#fff',
      fontSize: 11,
      fontWeight: '700',
    },
    avatarWrap: {
      position: 'relative',
    },
    avatarCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    avatarText: {
      color: colors.textPrimary,
      fontSize: 14,
      fontWeight: '700',
    },
    avatarStatusDot: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: 12,
      height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    presenceDotOnline: {
      backgroundColor: colors.success,
    },
    presenceDotOffline: {
      backgroundColor: colors.textSecondary,
    },
    skeletonBlock: {
      backgroundColor: colors.surfaceControl,
      borderRadius: radius.sm,
      opacity: 0.6,
    },
    skeletonTitle: {
      height: 12,
      width: '45%',
    },
    skeletonSubtitle: {
      height: 10,
      width: '70%',
      marginTop: 6,
    },
    emptyState: {
      alignItems: 'center',
      marginTop: spacing.xl,
      gap: spacing.xs,
    },
    emptyIllustration: {
      fontSize: 48,
    },
    emptyTitle: {
      ...typography.sectionTitle,
      color: colors.textPrimary,
    },
    empty: {
      color: colors.textSecondary,
      fontSize: 13,
      textAlign: 'center',
      marginTop: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
  });
