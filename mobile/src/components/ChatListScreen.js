import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';

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
 * @param {() => void} [props.onOpenSettings]
 */
export default function ChatListScreen({
  conversations = [],
  onOpenConversation,
  onSearchUsers,
  onRefresh,
  isRefreshing = false,
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

  return (
    <View style={styles.root} testID="chat-list-root">
      <View style={styles.titleRow}>
        <Text style={styles.title}>Chats</Text>
        <View style={styles.titleSpacer} />
        {onOpenSettings ? (
          <Pressable
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Settings"
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

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={Boolean(isRefreshing)} onRefresh={onRefresh} />
          ) : undefined
        }>
        {isSearchMode ? (
          <>
            {isSearching ? (
              <View style={styles.statusRow} testID="chat-list-searching">
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.statusText}>Searching…</Text>
              </View>
            ) : null}
            {!isSearching && results.length > 0
              ? results.map(contact => (
                  <Pressable
                    key={contact.userId}
                    onPress={() => onOpenConversation?.(contact.userId)}
                    accessibilityRole="button"
                    accessibilityLabel={`Chat with ${contact.userId}`}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    testID="chat-list-contact-row">
                    <Avatar
                      id={contact.userId}
                      online={contact.online}
                      testID="chat-list-contact-avatar"
                    />
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>{contact.userId}</Text>
                      <Text style={styles.rowSubtitle}>
                        {contact.online ? 'Online' : 'Offline'}
                      </Text>
                    </View>
                  </Pressable>
                ))
              : null}
            {!isSearching && hasSearched && results.length === 0 ? (
              <Text style={styles.empty} testID="chat-list-empty">
                No matching contacts
              </Text>
            ) : null}
          </>
        ) : conversations.length > 0 ? (
          conversations.map(conversation => (
            <Pressable
              key={conversation.conversationId}
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
                {conversation.unreadCount > 0 ? (
                  <View style={styles.unreadBadge} testID="chat-list-unread-badge">
                    <Text style={styles.unreadBadgeText}>{conversation.unreadCount}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          ))
        ) : (
          <Text style={styles.empty} testID="chat-list-empty">
            No conversations yet — search for a contact to start chatting
          </Text>
        )}
      </ScrollView>
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
    empty: {
      color: colors.textSecondary,
      fontSize: 13,
      textAlign: 'center',
      marginTop: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
  });
