import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import ErrorState from './ErrorState';
import { Avatar, Banner, Icon } from './primitives';
import { usePeerProfile } from '../profile/ProfileContext';
import { describeOffline, OFFLINE_CONSEQUENCE, OFFLINE_ICON } from '../connectivityUx';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import type { CallHistoryEntry } from '../hooks/useCallHistory';
import type { ThemeColors } from '../theme';
import type { ContactRow, ConversationRow } from '../types/directory';
import type { ReactElement } from 'react';

/**
 * How long the input must be idle before a server request is issued. Long
 * enough that typing a word costs one request, short enough to feel live.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/** Maximum rows rendered per section, so one category can't bury the others. */
const MAX_ROWS_PER_SECTION = 8;

/** Contacts, conversations, messages and calls. */
const SECTION_COUNT = 4;

/**
 * Message returned by the server-side message search.
 */
export type MessageResult = { messageId: string; peerId: string; body?: string; createdAt?: string; };

export type { ConversationRow };

export type CallRow = CallHistoryEntry;

type SearchSection = {
  key: 'contacts' | 'conversations' | 'messages' | 'calls';
  title: string;
  data: any[];
};

/**
 * Index of `term` inside `text`, case-insensitively, or -1.
 */
function matchIndex(text: string | null | undefined, term: string): number {
  if (!text || !term) return -1;
  return String(text).toLowerCase().indexOf(term.toLowerCase());
}

/**
 * Rank comparator for local matches: a prefix match outranks a match in the
 * middle of the text, and ties fall back to the order the caller supplied
 * (already recency-ordered for conversations and calls).
 */
function byMatchQuality(a: { index: number; order: number; }, b: { index: number; order: number; }): number {
  if (a.index !== b.index) return a.index - b.index;
  return a.order - b.order;
}

/**
 * Text with the matched substring emphasised, so a result makes it obvious
 * *why* it matched.
 */
export function HighlightedText({ text, term, style, numberOfLines }: { text?: string; term: string; style?: object; numberOfLines?: number; }) {
  const styles = useThemedStyles(createStyles);
  const value = String(text ?? '');
  const index = matchIndex(value, term);

  if (index === -1) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {value}
      </Text>
    );
  }

  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {value.slice(0, index)}
      <Text style={styles.highlight}>{value.slice(index, index + term.length)}</Text>
      {value.slice(index + term.length)}
    </Text>
  );
}

/**
 * Peer of a call-history entry, relative to the signed-in user.
 */
function callPeerOf(entry: { callerId?: string; calleeId?: string; direction?: string; kind?: string }, currentUserId: string | null | undefined): string {
  if (entry.kind === 'group') return '';
  if (entry?.direction === 'outgoing') return entry?.calleeId ?? '';
  if (entry?.direction === 'incoming') return entry?.callerId ?? '';
  return entry?.callerId === currentUserId ? (entry?.calleeId ?? '') : (entry?.callerId ?? '');
}

/**
 * Short, human description of a call-history entry.
 */
function describeCall(entry: { status?: string; direction?: string; }): string {
  if (entry?.status === 'missed' && entry?.direction === 'incoming') return 'Missed call';
  return entry?.direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
}

function formatTimestamp(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString();
}

export type SearchScreenProps = {
  onSearchContacts?: (query: string, options?: { limit?: number; signal?: AbortSignal; }) => Promise<ContactRow[]>;
  onSearchMessages?: (query: string, options?: { limit?: number; signal?: AbortSignal; }) => Promise<MessageResult[]>;
  onSearchLocalMessages?: (query: string, options?: { limit?: number; signal?: AbortSignal; }) => MessageResult[] | Promise<MessageResult[]>;
  conversations?: ConversationRow[];
  callHistory?: CallRow[];
  currentUserId?: string | null;
  onOpenConversation?: (peerId: string) => void;
  onOpenMessage?: (result: { peerId: string; messageId: string; }) => void;
  onOpenProfile?: (peerId: string) => void;
  onBack?: () => void;
  /** Shows the "local results only" note. */
  isServerUnreachable?: boolean;
  recentSearches?: string[];
  /** Called with the term behind a result the user opened, so history reflects real searches. */
  onRecordRecentSearch?: (term: string) => void;
  onClearRecentSearches?: () => void;
};

function searchRowDetails(category: SearchSection['key'], item: any, name: string) {
  switch (category) {
    case 'contacts':
      return { label: `Open ${name} profile`, subtitle: item.online ? 'Online' : 'Offline', testID: 'search-contact-row' };
    case 'conversations':
      return {
        label: `Open conversation with ${name}`,
        subtitle: item.lastActivity?.body ?? item.lastMessage?.body ?? '',
        testID: 'search-conversation-row',
      };
    case 'messages':
      return { label: `Open message from ${name}`, subtitle: item.body, testID: 'search-message-row' };
    case 'calls':
      return { label: `Open ${name} profile`, subtitle: describeCall(item), testID: 'search-call-row' };
  }
}

function SearchIdentityRow({
  item, section, currentUserId, term, styles, rememberTerm,
  onOpenProfile, onOpenConversation, onOpenMessage,
}: Pick<SearchScreenProps, 'currentUserId' | 'onOpenProfile' | 'onOpenConversation' | 'onOpenMessage'> & {
  item: any;
  section: SearchSection;
  term: string;
  styles: ReturnType<typeof createStyles>;
  rememberTerm: () => void;
}) {
  const category = section.key;
  const peerId = category === 'contacts' ? item.userId
    : category === 'calls' ? callPeerOf(item, currentUserId) : item.peerId;
  const suppliedProfile = category === 'contacts' ? item : undefined;
  const { name } = usePeerProfile(peerId, suppliedProfile);
  // A group conversation has no peer identity to resolve: its own name is the title.
  const title = item.group?.name ?? name;
  const { label, subtitle, testID } = searchRowDetails(category, item, title);
  const onPress = () => {
    rememberTerm();
    if (category === 'conversations') onOpenConversation?.(peerId);
    else if (category === 'messages') onOpenMessage?.({ peerId, messageId: item.messageId });
    else onOpenProfile?.(peerId);
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID={testID}>
      <Avatar id={peerId} profile={suppliedProfile} size="sm" />
      <View style={styles.rowText}>
        <HighlightedText text={title} term={term} style={styles.rowTitle} />
        {category === 'messages' ? (
          <HighlightedText text={subtitle} term={term} style={styles.rowSubtitle} numberOfLines={2} />
        ) : (
          <Text style={styles.rowSubtitle} numberOfLines={1}>{subtitle}</Text>
        )}
      </View>
      {category === 'calls' || category === 'messages' ? (
        <Text style={styles.rowMeta}>{formatTimestamp(item.createdAt)}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Unified search: one ranked list across contacts, conversations, messages and
 * calls, each in its own labelled section.
 *
 * Contacts come from the server, while message matches start with the device
 * cache and merge in full-history server results. Conversations and calls are
 * also matched locally, so cached results remain available offline.
 *
 * Requests are debounced ({@link SEARCH_DEBOUNCE_MS}) and the previous ones are
 * aborted on every new keystroke, so a fast typist issues one request and can
 * never see the results of a stale query.
 */
function SearchScreen({
  onSearchContacts,
  onSearchMessages,
  onSearchLocalMessages,
  conversations = [],
  callHistory = [],
  currentUserId = null,
  onOpenConversation,
  onOpenMessage,
  onOpenProfile,
  onBack,
  isServerUnreachable = false,
  recentSearches = [],
  onRecordRecentSearch,
  onClearRecentSearches,
}: SearchScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState(([] as ContactRow[]));
  const [messages, setMessages] = useState(([] as MessageResult[]));
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [contactsFailed, setContactsFailed] = useState(false);
  // Bumped to re-run the debounced effect without changing the search term.
  const [retryToken, setRetryToken] = useState(0);
  const abortRef = useRef((null as AbortController | null));

  const term = query.trim();

  // Debounced, cancellable server search. The abort controller is torn down by
  // the effect's own cleanup, so a new keystroke both cancels the pending
  // timer and aborts any request the previous one already started.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (!term) {
      setContacts([]);
      setMessages([]);
      setIsSearching(false);
      setHasSearched(false);
      setContactsFailed(false);
      return undefined;
    }

    let cancelled = false;
    setIsSearching(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(async () => {
      const options = { signal: controller.signal };
      const cachedMessages = await Promise.resolve(onSearchLocalMessages?.(term, options)).catch(() => []);
      if (cancelled || controller.signal.aborted) return;
      if (Array.isArray(cachedMessages)) setMessages(cachedMessages);

      // Contacts and the merged message search can genuinely require the
      // network; cached message matches are already visible while they run.
      let contactsRejected = false;
      const [foundContacts, foundMessages] = await Promise.all([
        Promise.resolve(onSearchContacts?.(term, options)).catch(() => {
          contactsRejected = true;
          return [];
        }),
        Promise.resolve(onSearchMessages?.(term, options)).catch(() => []),
      ]);
      if (cancelled || controller.signal.aborted) return;
      setContacts(Array.isArray(foundContacts) ? foundContacts : []);
      setMessages(Array.isArray(foundMessages) ? foundMessages : []);
      setIsSearching(false);
      setHasSearched(true);
      setContactsFailed(contactsRejected);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, onSearchContacts, onSearchLocalMessages, onSearchMessages, retryToken]);

  // A term is only worth remembering once the user acts on one of its results:
  // recording every debounced query instead would fill the (short) history with
  // the prefixes typed on the way to the real search.
  const rememberTerm = useCallback(() => {
    if (term) onRecordRecentSearch?.(term);
  }, [onRecordRecentSearch, term]);

  const matchedConversations = useMemo(() => {
    if (!term) return [];
    return conversations
      .map((conversation, order) => ({
        conversation,
        order,
        index: matchIndex(conversation.group?.name ?? conversation.peerId, term),
      }))
      .filter(entry => entry.index !== -1)
      .sort(byMatchQuality)
      .slice(0, MAX_ROWS_PER_SECTION)
      .map(entry => entry.conversation);
  }, [conversations, term]);

  const matchedCalls = useMemo(() => {
    if (!term) return [];
    return callHistory
      .map((entry, order) => ({
        entry,
        order,
        index: matchIndex(callPeerOf(entry, currentUserId), term),
      }))
      .filter(entry => entry.index !== -1)
      .sort(byMatchQuality)
      .slice(0, MAX_ROWS_PER_SECTION)
      .map(entry => entry.entry);
  }, [callHistory, currentUserId, term]);

  const sections = useMemo<SearchSection[]>(() => {
    const built: SearchSection[] = [
      { key: 'contacts', title: 'Contacts', data: contacts.slice(0, MAX_ROWS_PER_SECTION) },
      { key: 'conversations', title: 'Conversations', data: matchedConversations },
      { key: 'messages', title: 'Messages', data: messages.slice(0, MAX_ROWS_PER_SECTION) },
      { key: 'calls', title: 'Calls', data: matchedCalls },
    ];
    return built.filter(section => section.data.length > 0);
  }, [contacts, matchedCalls, matchedConversations, messages]);

  const renderItem = useCallback(
    ({ item, section }: { item: any; section: SearchSection; }) => {
      return (
        <SearchIdentityRow
          item={item}
          section={section}
          currentUserId={currentUserId}
          term={term}
          styles={styles}
          rememberTerm={rememberTerm}
          onOpenProfile={onOpenProfile}
          onOpenConversation={onOpenConversation}
          onOpenMessage={onOpenMessage}
        />
      );
    },
    [currentUserId, onOpenConversation, onOpenMessage, onOpenProfile, rememberTerm, styles, term],
  );

  const keyExtractor = useCallback(
    (item: any, index: number) =>
      item.messageId ?? item.callId ?? item.conversationId ?? item.userId ?? String(index),
    [],
  );

  let emptyComponent: ReactElement | undefined;
  if (!term) {
    emptyComponent = (
      <View style={styles.emptyState} testID="search-empty-prompt">
        <Text style={styles.emptyTitle}>Search WeTalk</Text>
        <Text style={styles.emptyBody}>
          Find contacts, conversations, messages and calls in one place.
        </Text>
        {recentSearches.length > 0 ? (
          <View style={styles.recentBlock} testID="search-recents">
            <View style={styles.recentHeader}>
              <Text style={styles.sectionTitle}>Recent searches</Text>
              {onClearRecentSearches ? (
                <Pressable
                  onPress={onClearRecentSearches}
                  accessibilityRole="button"
                  accessibilityLabel="Clear recent searches"
                  hitSlop={touchSlop(32)}
                  testID="search-clear-recents">
                  <Text style={styles.clearRecents}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
            {recentSearches.map(recent => (
              <Pressable
                key={recent}
                onPress={() => setQuery(recent)}
                accessibilityRole="button"
                accessibilityLabel={`Search for ${recent}`}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                testID="search-recent-row">
                <Text style={styles.rowTitle}>{recent}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );
  } else if (!isSearching && hasSearched && !contactsFailed) {
    emptyComponent = (
      <Text style={styles.empty} testID="search-no-results">
        No results for “{term}”
      </Text>
    );
  }

  return (
    <View style={styles.root} testID="search-root">
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Close search"
          hitSlop={touchSlop(36)}
          testID="search-back"
          style={styles.backButton}>
          <Icon name="back" size={26} color={colors.onSurface} />
        </Pressable>
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
          placeholder="Search messages, people and calls"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Search"
          testID="search-input"
        />
      </View>

      {isServerUnreachable ? (
        <Banner
          tone="warning"
          icon={OFFLINE_ICON}
          message={describeOffline(OFFLINE_CONSEQUENCE.search)}
          style={styles.degradedNote}
          testID="search-degraded-note"
        />
      ) : null}

      <SectionList<any, SearchSection>
        testID="search-results"
        sections={sections}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        contentContainerStyle={styles.content}
        // Every section is capped, so the whole list is small: render it in one
        // pass rather than letting virtualisation hide the later sections.
        initialNumToRender={MAX_ROWS_PER_SECTION * SECTION_COUNT}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <>
            {isSearching ? (
              <View style={styles.statusRow} testID="search-searching">
                <ActivityIndicator size="small" color={colors.textSecondary} />
                <Text style={styles.statusText}>Searching…</Text>
              </View>
            ) : null}
            {!isSearching && contactsFailed ? (
              <ErrorState
                title="Can't search contacts"
                description={
                  'We couldn\u2019t reach the directory, so people are missing from these ' +
                  'results. Messages and calls below come from this device.'
                }
                actionLabel="Retry"
                actionHint="Runs the search again"
                onAction={() => setRetryToken(token => token + 1)}
                testID="search-contacts-error"
              />
            ) : null}
          </>
        }
        ListEmptyComponent={emptyComponent}
      />
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      padding: spacing.lg,
    },
    content: {
      paddingBottom: spacing.xl,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    backButton: {
      height: 36,
      width: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    input: {
      flex: 1,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
    },
    sectionTitle: {
      ...typography.sectionTitle,
      color: colors.textSecondary,
      marginTop: spacing.md,
      marginBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowPressed: {
      opacity: 0.6,
    },
    rowText: {
      flex: 1,
    },
    rowTitle: {
      ...typography.body,
      color: colors.textPrimary,
    },
    rowSubtitle: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    rowMeta: {
      ...typography.hint,
      color: colors.textMuted,
    },
    highlight: {
      color: colors.accent,
      fontWeight: '700',
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    statusText: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    degradedNote: {
      ...typography.hint,
      color: colors.warning,
      marginBottom: spacing.sm,
    },
    empty: {
      ...typography.body,
      color: colors.textSecondary,
      textAlign: 'center',
      marginTop: spacing.xl,
    },
    emptyState: {
      marginTop: spacing.lg,
    },
    emptyTitle: {
      ...typography.sectionTitle,
      color: colors.textPrimary,
    },
    emptyBody: {
      ...typography.hint,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    recentBlock: {
      marginTop: spacing.lg,
    },
    recentHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    clearRecents: {
      ...typography.hint,
      color: colors.accent,
    },
  });

/**
 * Memoized: the search screen re-renders only when its own props change, not merely
 * because an ancestor re-rendered.
 */
export default memo(SearchScreen);
