import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import IconButton from './IconButton';

/** Consecutive own-sender messages within this many minutes are grouped
 * (only the last bubble in the group shows a timestamp/tick). */
const GROUP_GAP_MS = 5 * 60 * 1000;
/** How long after the user stops typing to report "stopped typing". */
const TYPING_IDLE_MS = 3000;
/** Distance (px) from the bottom of the message list still considered
 * "at the bottom" for auto-scroll / scroll-to-bottom-FAB purposes. */
const NEAR_BOTTOM_THRESHOLD = 80;

function formatMessageTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" / "Yesterday" / a locale date string, for the date separator. */
function formatDateSeparator(date) {
  const now = new Date();
  if (isSameCalendarDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Turn a flat, oldest-first message array into a render list that interleaves
 * date separators and flags the last message of each same-sender/time-window
 * group, so consecutive bubbles from one sender only show a single
 * timestamp/tick at the bottom of the group (Teams/Slack-style grouping).
 *
 * @param {Array<object>} orderedMessages oldest-first
 * @returns {Array<{ key: string, type: 'date', label: string } | { key: string, type: 'message', message: object, isGroupEnd: boolean }>}
 */
function buildListItems(orderedMessages) {
  const items = [];
  orderedMessages.forEach((message, index) => {
    const createdAt = new Date(message.createdAt);
    const previous = orderedMessages[index - 1];
    const hasValidDate = !Number.isNaN(createdAt.getTime());
    if (
      hasValidDate &&
      (!previous || !isSameCalendarDay(createdAt, new Date(previous.createdAt)))
    ) {
      items.push({
        key: `date-${message.messageId}`,
        type: 'date',
        label: formatDateSeparator(createdAt),
      });
    }

    const next = orderedMessages[index + 1];
    let isGroupEnd = true;
    if (next && next.senderId === message.senderId) {
      const nextCreatedAt = new Date(next.createdAt);
      const sameDay =
        !hasValidDate ||
        Number.isNaN(nextCreatedAt.getTime()) ||
        isSameCalendarDay(createdAt, nextCreatedAt);
      const withinGap =
        !hasValidDate ||
        Number.isNaN(nextCreatedAt.getTime()) ||
        nextCreatedAt.getTime() - createdAt.getTime() <= GROUP_GAP_MS;
      isGroupEnd = !(sameDay && withinGap);
    }

    items.push({ key: message.messageId, type: 'message', message, isGroupEnd });
  });
  return items;
}

/**
 * One-to-one conversation window: header (back, presence, call actions),
 * a bubble message list (oldest at top, newest at bottom) with date
 * separators and sender/time grouping, and a composer with a typing
 * indicator.
 *
 * @param {object} props
 * @param {string} props.peerId
 * @param {Array<object>} [props.messages] - newest-first, as delivered by the hook.
 * @param {(body: string) => void} props.onSendMessage
 * @param {() => void} [props.onLoadOlder]
 * @param {() => void} props.onBack
 * @param {string} props.currentUserId
 * @param {{ online: boolean, status?: string } | null} [props.peerPresence]
 * @param {() => void} [props.onStartAudioCall]
 * @param {() => void} [props.onStartVideoCall]
 * @param {boolean} [props.isSending]
 * @param {boolean} [props.isStartingCall] - True while a call to this peer is being placed;
 *   shows a loading spinner on the call header buttons instead of the icon.
 * @param {boolean} [props.isPeerTyping] - Shows a "peer is typing…" hint under the header.
 * @param {(isTyping: boolean) => void} [props.onTypingChange] - Reports composer typing state.
 * @param {number} [props.keyboardVerticalOffset] - Distance between the true top of the
 *   screen and this screen's root view (e.g. the safe-area top inset applied by an
 *   ancestor). `KeyboardAvoidingView` measures its own frame relative to its immediate
 *   parent, not the screen, so without this offset it under-compensates for the
 *   keyboard by exactly that amount and the composer stays partly covered.
 */
export default function ChatConversationScreen({
  peerId,
  messages = [],
  onSendMessage,
  onLoadOlder,
  onBack,
  currentUserId,
  peerPresence = null,
  onStartAudioCall,
  onStartVideoCall,
  isSending = false,
  isStartingCall = false,
  isPeerTyping = false,
  onTypingChange,
  keyboardVerticalOffset = 0,
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [draft, setDraft] = useState('');
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const hasReachedTopRef = useRef(false);
  const typingIdleTimerRef = useRef(null);
  const listRef = useRef(null);
  // Tracks the newest message's id so the auto-scroll-to-bottom effect below
  // only fires for a genuinely new/sent message, not when older history is
  // paged in at the top (which must not yank the scroll position).
  const newestMessageIdRef = useRef(null);
  // Whether the list is currently scrolled near its bottom edge; used to
  // decide whether an incoming message should auto-scroll or instead surface
  // the "scroll to bottom" FAB so mid-history reading isn't interrupted.
  const isNearBottomRef = useRef(true);

  // Data arrives newest-first; reverse so a plain (non-inverted) FlatList
  // renders oldest-at-top / newest-at-bottom, matching a natural chat log.
  const listItems = useMemo(() => buildListItems([...messages].reverse()), [messages]);

  // Keep the newest message in view: scroll to the bottom whenever the
  // newest message changes (a message was sent or received) and the user is
  // already near the bottom, or the new message is the current user's own
  // (e.g. just sent). Otherwise (user is reading older history and a peer
  // message arrives) leave the scroll position alone and surface the
  // "scroll to bottom" FAB instead of yanking the view.
  useEffect(() => {
    const newestMessage = messages[0] ?? null;
    const newestId = newestMessage?.messageId ?? null;
    if (newestId !== newestMessageIdRef.current) {
      newestMessageIdRef.current = newestId;
      const isOwnMessage = newestMessage?.senderId === currentUserId;
      if (isNearBottomRef.current || isOwnMessage) {
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
        setShowScrollToBottom(false);
        setNewMessageCount(0);
      } else {
        setShowScrollToBottom(true);
        setNewMessageCount(count => count + 1);
      }
    }
  }, [messages, currentUserId]);

  // Keep the composer and the latest message visible above the keyboard: on
  // Android in particular, the on-screen keyboard can otherwise cover both
  // the text being typed and the send button until the keyboard is dismissed.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const subscription = Keyboard.addListener(showEvent, () => {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(typingIdleTimerRef.current);
    };
  }, []);

  const reportTyping = useCallback(
    isTyping => {
      clearTimeout(typingIdleTimerRef.current);
      onTypingChange?.(isTyping);
      if (isTyping) {
        typingIdleTimerRef.current = setTimeout(() => onTypingChange?.(false), TYPING_IDLE_MS);
      }
    },
    [onTypingChange],
  );

  const handleChangeText = useCallback(
    text => {
      setDraft(text);
      reportTyping(Boolean(text.trim()));
    },
    [reportTyping],
  );

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSendMessage?.(trimmed);
    setDraft('');
    reportTyping(false);
  }, [draft, onSendMessage, reportTyping]);

  const handleRetry = useCallback(
    body => {
      onSendMessage?.(body);
    },
    [onSendMessage],
  );

  const handleScroll = useCallback(
    event => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      if (contentOffset.y <= 0 && !hasReachedTopRef.current) {
        hasReachedTopRef.current = true;
        onLoadOlder?.();
      } else if (contentOffset.y > 0) {
        hasReachedTopRef.current = false;
      }

      if (contentSize && layoutMeasurement) {
        const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
        const isNearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
        isNearBottomRef.current = isNearBottom;
        if (isNearBottom) {
          setShowScrollToBottom(false);
          setNewMessageCount(0);
        }
      }
    },
    [onLoadOlder],
  );

  const handleScrollToBottomPress = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    setShowScrollToBottom(false);
    setNewMessageCount(0);
  }, []);

  const presenceLabel = peerPresence ? (peerPresence.online ? 'Online' : 'Offline') : null;
  // Presence is only a one-shot snapshot fetched when the conversation opens
  // (see useChatSync) rather than a live subscription, so it can go stale the
  // moment the peer's real status changes. Show it as a hint, but don't use
  // it to block placing a call — only an in-flight call attempt should.
  const isCallDisabled = isStartingCall;
  const MCIcon = loadVectorIcons();
  const presenceIconDef = peerPresence
    ? ICONS[peerPresence.online ? 'presenceOnline' : 'presenceOffline']
    : null;
  const presenceColor = peerPresence?.online ? colors.success : colors.textMuted;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={keyboardVerticalOffset}>
      <View style={styles.root} testID="chat-conversation-root">
        <View style={styles.header}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back to chat list"
            testID="chat-back"
            style={styles.backButton}>
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>

          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {peerId}
            </Text>
            {isPeerTyping ? (
              <Text style={styles.headerSubtitle} testID="chat-typing-indicator">
                typing…
              </Text>
            ) : presenceLabel ? (
              <View style={styles.presenceRow} testID="chat-presence-row">
                {presenceIconDef && MCIcon ? (
                  <MCIcon name={presenceIconDef.icon} size={8} color={presenceColor} />
                ) : (
                  <Text style={[styles.presenceDotText, { color: presenceColor }]}>
                    {presenceIconDef?.emoji ?? '●'}
                  </Text>
                )}
                <Text style={styles.headerSubtitle}>{presenceLabel}</Text>
              </View>
            ) : null}
          </View>

          {onStartAudioCall ? (
            <IconButton
              icon="chatAudioCall"
              onPress={onStartAudioCall}
              size={40}
              disabled={isCallDisabled}
              loading={isStartingCall}
              accessibilityLabel={`Call ${peerId}`}
              testID="chat-call-audio"
            />
          ) : null}
          {onStartVideoCall ? (
            <IconButton
              icon="chatVideoCall"
              onPress={onStartVideoCall}
              size={40}
              disabled={isCallDisabled}
              loading={isStartingCall}
              accessibilityLabel={`Video call ${peerId}`}
              testID="chat-call-video"
            />
          ) : null}
        </View>

        <View style={styles.listContainer}>
          <FlatList
            ref={listRef}
            testID="chat-message-list"
            data={listItems}
            keyExtractor={item => item.key}
            contentContainerStyle={styles.messageList}
            onScroll={handleScroll}
            scrollEventThrottle={32}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              if (item.type === 'date') {
                return (
                  <View style={styles.dateSeparator} testID="chat-date-separator">
                    <Text style={styles.dateSeparatorText}>{item.label}</Text>
                  </View>
                );
              }

              const message = item.message;
              const isOwn = message.senderId === currentUserId;
              const showFooter = item.isGroupEnd;
              const isRead = Boolean(message.readAt);
              return (
                <View
                  testID="chat-message-row"
                  style={[
                    styles.messageRow,
                    isOwn ? styles.messageRowOwn : styles.messageRowPeer,
                    !item.isGroupEnd && styles.messageRowGrouped,
                  ]}>
                  <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubblePeer]}>
                    <Text style={isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer}>
                      {message.body}
                    </Text>
                  </View>
                  {showFooter ? (
                    <View style={styles.messageFooter}>
                      <Text style={[styles.timestamp, isOwn && styles.timestampOwn]}>
                        {formatMessageTimestamp(message.createdAt)}
                      </Text>
                      {isOwn && !message.pending && !message.failed ? (
                        <Text
                          style={[styles.tick, isRead && styles.tickRead]}
                          testID="chat-message-tick"
                          accessibilityLabel={isRead ? 'Read' : 'Sent'}>
                          {isRead ? '✓✓' : '✓'}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  {message.pending ? <Text style={styles.pendingText}>Sending…</Text> : null}
                  {message.failed ? (
                    <Pressable
                      onPress={() => handleRetry(message.body)}
                      accessibilityRole="button"
                      accessibilityLabel="Retry sending message">
                      <Text style={styles.failedText}>Failed to send · tap to retry</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            }}
          />
          {showScrollToBottom ? (
            <Pressable
              onPress={handleScrollToBottomPress}
              accessibilityRole="button"
              accessibilityLabel="Scroll to newest message"
              testID="chat-scroll-to-bottom"
              style={styles.scrollToBottomFab}>
              <Text style={styles.scrollToBottomIcon}>↓</Text>
              {newMessageCount > 0 ? (
                <Text style={styles.scrollToBottomText} testID="chat-scroll-to-bottom-count">
                  {newMessageCount > 9 ? '9+' : newMessageCount} new
                </Text>
              ) : null}
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.composer, isComposerFocused && styles.composerFocused]}>
          <TextInput
            value={draft}
            onChangeText={handleChangeText}
            onFocus={() => setIsComposerFocused(true)}
            onBlur={() => setIsComposerFocused(false)}
            placeholder="Message"
            placeholderTextColor={colors.textSecondary}
            style={[styles.composerInput, isComposerFocused && styles.composerInputFocused]}
            multiline
            testID="chat-message-input"
          />
          <IconButton
            icon="➤"
            onPress={handleSend}
            variant="active"
            disabled={!draft.trim() || isSending}
            size={44}
            accessibilityLabel="Send message"
            testID="chat-message-send"
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const createStyles = colors =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    root: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backButtonText: {
      color: colors.textPrimary,
      fontSize: 28,
      lineHeight: 28,
    },
    headerText: {
      flex: 1,
    },
    headerTitle: {
      ...typography.sectionTitle,
      color: colors.textPrimary,
    },
    headerSubtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 1,
    },
    presenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 1,
    },
    presenceDotText: {
      fontSize: 8,
    },
    listContainer: {
      flex: 1,
    },
    messageList: {
      padding: spacing.md,
      gap: spacing.sm,
    },
    dateSeparator: {
      alignItems: 'center',
      marginVertical: spacing.sm,
    },
    dateSeparatorText: {
      ...typography.hint,
      color: colors.textSecondary,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.sm,
      overflow: 'hidden',
    },
    messageRow: {
      marginBottom: spacing.sm,
      maxWidth: '80%',
    },
    messageRowGrouped: {
      marginBottom: 2,
    },
    messageRowOwn: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
    },
    messageRowPeer: {
      alignSelf: 'flex-start',
      alignItems: 'flex-start',
    },
    bubble: {
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleOwn: {
      backgroundColor: colors.accentButton,
      borderWidth: 1,
      borderColor: colors.accent,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.25,
      shadowRadius: 3,
      elevation: 2,
    },
    bubblePeer: {
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.border,
    },
    bubbleTextOwn: {
      color: colors.textOnAccent,
    },
    bubbleTextPeer: {
      color: colors.textPrimary,
    },
    messageFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 2,
    },
    timestamp: {
      ...typography.hint,
      color: colors.textMuted,
    },
    timestampOwn: {
      textAlign: 'right',
    },
    tick: {
      fontSize: 14,
      color: colors.textMuted,
    },
    tickRead: {
      color: colors.success,
    },
    pendingText: {
      ...typography.hint,
      color: colors.textMuted,
      fontStyle: 'italic',
    },
    failedText: {
      ...typography.hint,
      color: colors.danger,
      fontWeight: '600',
    },
    scrollToBottomFab: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.surfaceControl,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 4,
    },
    scrollToBottomIcon: {
      color: colors.textPrimary,
      fontSize: 16,
      lineHeight: 18,
    },
    scrollToBottomText: {
      ...typography.hint,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      padding: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    composerFocused: {
      backgroundColor: colors.backgroundAlt,
    },
    composerInput: {
      flex: 1,
      maxHeight: 120,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    composerInputFocused: {
      borderColor: colors.accent,
      borderWidth: 2,
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 4,
      elevation: 2,
    },
  });
