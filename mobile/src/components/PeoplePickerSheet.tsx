import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import {
  Avatar,
  EmptyState,
  Icon,
  IconAction,
  ListItem,
  SectionHeader,
  Sheet,
} from './primitives';
import type { ThemeColors } from '../theme';
import type { ContactRow, ConversationRow } from '../types/directory';

/** Debounce before a keystroke turns into a directory request. */
const SEARCH_DEBOUNCE_MS = 300;

/** How many recent conversations to offer before the user types anything. */
const MAX_RECENT = 8;

export type PeoplePickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Sheet title, e.g. "New chat" or "New call". */
  title: string;
  /** Directory lookup; the sheet renders nothing searchable without it. */
  onSearchUsers?: (query: string) => Promise<ContactRow[]>;
  /** Conversations, used to offer recent people before any query is typed. */
  conversations?: ConversationRow[];
  /** Called with the chosen person. The sheet closes itself first. */
  onSelect: (peerId: string) => void;
  testID?: string;
};

/**
 * The bottom sheet that replaced the dial form.
 *
 * The Calls tab used to ask the user to type another person's id into a
 * "Callee user ID" field — a mental model of "type an id and dial" that stopped
 * being true once identity moved into Firebase auth. Every call now starts from
 * a person the user picked: recent conversations first, "online now" next, and
 * the full directory behind a search field.
 *
 * Shared by the New-chat and New-call FABs (and, later, message forwarding), so
 * "pick a person" looks and behaves the same everywhere it is needed.
 */
export default function PeoplePickerSheet({
  visible,
  onClose,
  title,
  onSearchUsers,
  conversations,
  onSelect,
  testID = 'people-picker',
}: PeoplePickerSheetProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(([] as ContactRow[]));
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // Guards against an earlier request resolving after a later one.
  const requestIdRef = useRef(0);

  // Reopening the sheet should not show the previous session's query.
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setHasSearched(false);
      setSearchFailed(false);
      setIsSearching(false);
    }
  }, [visible]);

  const runSearch = useCallback(
    async (term: string) => {
      if (typeof onSearchUsers !== 'function') return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSearching(true);
      let users: ContactRow[] = [];
      let failed = false;
      try {
        users = await onSearchUsers(term);
      } catch {
        // A directory we could not reach is not a directory without matches;
        // "No matching people" here would be a confident lie.
        failed = true;
      }
      if (requestIdRef.current !== requestId) return;
      setResults(failed || !Array.isArray(users) ? [] : users);
      setIsSearching(false);
      setHasSearched(true);
      setSearchFailed(failed);
    },
    [onSearchUsers],
  );

  useEffect(() => {
    if (!visible || typeof onSearchUsers !== 'function') return undefined;
    const timer = setTimeout(() => {
      runSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, onSearchUsers, runSearch, visible]);

  const recents = useMemo(() => {
    const rows = Array.isArray(conversations) ? conversations : [];
    return rows
      .map(conversation => ({
        userId: conversation.peerId,
        online: conversation.online,
      }))
      .filter(row => Boolean(row.userId))
      .slice(0, MAX_RECENT);
  }, [conversations]);

  const trimmedQuery = query.trim();
  const isBrowsing = trimmedQuery.length === 0;

  // Before a query is typed the sheet offers people the user already talks to,
  // split so anyone reachable right now is visible without scrolling. Empty
  // groups are dropped rather than left as a heading over nothing.
  const sections = useMemo(() => {
    if (!isBrowsing) {
      return [{ key: 'results', title: 'People', rows: results }].filter(
        section => section.rows.length > 0,
      );
    }
    const online = recents.filter(row => row.online);
    const offline = recents.filter(row => !row.online);
    return [
      { key: 'online', title: 'Online now', rows: online },
      { key: 'recent', title: 'Recent', rows: offline },
    ].filter(section => section.rows.length > 0);
  }, [isBrowsing, recents, results]);

  const flatRows = useMemo(
    () =>
      sections.flatMap(section => [
        { type: 'header' as const, key: `header-${section.key}`, title: section.title },
        ...section.rows.map(row => ({
          type: 'person' as const,
          key: `${section.key}-${row.userId}`,
          row,
        })),
      ]),
    [sections],
  );

  const handleSelect = useCallback(
    (peerId: string) => {
      // Close first so the caller's navigation isn't racing the sheet's exit.
      onClose();
      onSelect(peerId);
    },
    [onClose, onSelect],
  );

  const showEmpty =
    !isSearching &&
    flatRows.length === 0 &&
    (isBrowsing || (hasSearched && !searchFailed));

  return (
    <Sheet visible={visible} onClose={onClose} title={title} testID={testID}>
      <View style={styles.searchRow}>
        <Icon name="search" size={18} color={colors.onSurfaceVariant} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          placeholder="Search people"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search people"
          testID={`${testID}-search`}
        />
        {query ? (
          <IconAction
            icon="dismiss"
            variant="plain"
            size={32}
            accessibilityLabel="Clear search"
            onPress={() => setQuery('')}
            testID={`${testID}-search-clear`}
          />
        ) : null}
      </View>

      {isSearching ? (
        <View style={styles.statusRow} testID={`${testID}-searching`}>
          <ActivityIndicator size="small" color={colors.onSurfaceVariant} />
          <Text style={styles.statusText}>Searching…</Text>
        </View>
      ) : null}

      {!isSearching && searchFailed ? (
        <Text style={styles.statusText} accessibilityLiveRegion="polite" testID={`${testID}-error`}>
          Couldn't reach the directory. Check your connection and try again.
        </Text>
      ) : null}

      {showEmpty ? (
        <EmptyState
          icon="people"
          title={isBrowsing ? 'No one here yet' : 'No matching people'}
          description={
            isBrowsing
              ? 'Search for someone by their username to start talking to them.'
              : `No one matches "${trimmedQuery}".`
          }
          testID={`${testID}-empty`}
        />
      ) : (
        <FlatList
          data={flatRows}
          keyExtractor={item => item.key}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) =>
            item.type === 'header' ? (
              <SectionHeader title={item.title} variant="group" />
            ) : (
              <ListItem
                title={item.row.userId}
                subtitle={item.row.online ? 'Online' : 'Offline'}
                leading={
                  <Avatar id={item.row.userId} size="md" online={Boolean(item.row.online)} />
                }
                onPress={() => handleSelect(item.row.userId)}
                accessibilityLabel={`${item.row.userId}, ${
                  item.row.online ? 'online' : 'offline'
                }`}
                testID={`${testID}-row`}
              />
            )
          }
        />
      )}
    </Sheet>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceControl,
    },
    searchInput: {
      flex: 1,
      ...typography.body,
      color: colors.onSurface,
      padding: 0,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    statusText: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
    },
    list: {
      // Bounded so the sheet cannot grow past the screen on a long directory.
      maxHeight: 380,
    },
  });
