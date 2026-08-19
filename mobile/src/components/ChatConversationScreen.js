import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { radius, spacing, touchSlop, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import CallTimelineRow from './CallTimelineRow';
import IconButton from './IconButton';
import StatusBanner from './StatusBanner';
import SwipeableRow from './SwipeableRow';

/** Consecutive own-sender messages within this many minutes are grouped
 * (only the last bubble in the group shows a timestamp/tick). */
const GROUP_GAP_MS = 5 * 60 * 1000;
/** Consecutive calls with the same peer, direction and outcome within this
 * window collapse into a single expandable row, so a redial storm can't bury
 * the conversation around it. */
const CALL_GROUP_GAP_MS = 60 * 60 * 1000;
/** How long after the user stops typing to report "stopped typing". */
const TYPING_IDLE_MS = 3000;
/** Distance (px) from the bottom of the message list still considered
 * "at the bottom" for auto-scroll / scroll-to-bottom-FAB purposes. */
const NEAR_BOTTOM_THRESHOLD = 80;
/** Number of skeleton bubbles rendered while the first page of history loads. */
const SKELETON_BUBBLE_COUNT = 6;

/**
 * Lifecycle state of one of the current user's own messages.
 *
 * - `sending`   optimistic local copy, not yet acked by the server
 * - `failed`    the send was rejected / the socket was down
 * - `sent`      stored by the server, not yet handed to the recipient
 * - `delivered` handed to at least one of the recipient's connected devices
 * - `read`      the recipient opened the conversation
 *
 * @param {{ pending?: boolean, failed?: boolean, readAt?: string | null,
 *   deliveredTo?: string[], recipientId?: string }} message
 * @returns {'sending'|'failed'|'sent'|'delivered'|'read'}
 */
function getMessageStatus(message) {
  if (message?.failed) return 'failed';
  if (message?.pending) return 'sending';
  if (message?.readAt) return 'read';
  const deliveredTo = Array.isArray(message?.deliveredTo) ? message.deliveredTo : [];
  const reachedRecipient = message?.recipientId
    ? deliveredTo.includes(message.recipientId)
    : deliveredTo.length > 0;
  return reachedRecipient ? 'delivered' : 'sent';
}

/**
 * True when a timeline entry is a call record rather than a text message.
 *
 * The server only tags entries with a `type` when the client opts into the
 * merged timeline (`include=calls`), and optimistic local sends carry no type
 * at all, so anything untagged is a message.
 *
 * @param {{ type?: string }} entry
 * @returns {boolean}
 */
function isCallEntry(entry) {
  return entry?.type === 'call';
}

/** Stable list key for either kind of timeline entry. */
function entryKey(entry) {
  return isCallEntry(entry) ? entry.callId : entry.messageId;
}

/** Only items at least this visible count for the pinned date pill. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };

const STATUS_LABELS = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

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
 * True when two consecutive call entries belong in the same collapsed row.
 *
 * @param {object} previous
 * @param {object} entry
 * @returns {boolean}
 */
function isSameCallRun(previous, entry) {
  if (previous.direction !== entry.direction || previous.status !== entry.status) return false;
  const previousAt = new Date(previous.createdAt).getTime();
  const entryAt = new Date(entry.createdAt).getTime();
  if (Number.isNaN(previousAt) || Number.isNaN(entryAt)) return false;
  return entryAt - previousAt <= CALL_GROUP_GAP_MS;
}

/**
 * Turn a flat, oldest-first timeline array into a render list that interleaves
 * date separators and flags the last message of each same-sender/time-window
 * group, so consecutive bubbles from one sender only show a single
 * timestamp/tick at the bottom of the group (Teams/Slack-style grouping).
 *
 * Call entries share the list with messages — one merged conversation, as in
 * every mainstream messenger — and a run of consecutive calls with the same
 * direction and outcome collapses into a single row.
 *
 * Each item also carries the date label of the day it belongs to, so the
 * pinned (sticky) date pill can be derived from whichever item is currently at
 * the top of the viewport without re-scanning the list.
 *
 * @param {Array<object>} orderedEntries oldest-first
 * @returns {Array<{ key: string, type: 'date', label: string }
 *   | { key: string, type: 'message', message: object, isGroupEnd: boolean, dateLabel: string | null }
 *   | { key: string, type: 'call', entries: Array<object>, dateLabel: string | null }>}
 */
function buildListItems(orderedEntries) {
  const items = [];
  let currentDateLabel = null;
  for (let index = 0; index < orderedEntries.length; index++) {
    const entry = orderedEntries[index];
    const createdAt = new Date(entry.createdAt);
    const previous = orderedEntries[index - 1];
    const hasValidDate = !Number.isNaN(createdAt.getTime());
    if (
      hasValidDate &&
      (!previous || !isSameCalendarDay(createdAt, new Date(previous.createdAt)))
    ) {
      currentDateLabel = formatDateSeparator(createdAt);
      items.push({
        key: `date-${entryKey(entry)}`,
        type: 'date',
        label: currentDateLabel,
      });
    }

    if (isCallEntry(entry)) {
      // Collapse the run of same-direction/same-outcome calls starting here.
      const run = [entry];
      while (index + 1 < orderedEntries.length) {
        const candidate = orderedEntries[index + 1];
        if (!isCallEntry(candidate) || !isSameCallRun(run[run.length - 1], candidate)) break;
        if (!isSameCalendarDay(new Date(candidate.createdAt), createdAt)) break;
        run.push(candidate);
        index += 1;
      }
      items.push({
        key: entryKey(entry),
        type: 'call',
        entries: run,
        dateLabel: currentDateLabel,
      });
      continue;
    }

    const next = orderedEntries[index + 1];
    let isGroupEnd = true;
    if (next && !isCallEntry(next) && next.senderId === entry.senderId) {
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

    items.push({
      key: entryKey(entry),
      type: 'message',
      message: entry,
      isGroupEnd,
      dateLabel: currentDateLabel,
    });
  }
  return items;
}

/**
 * A single chat bubble plus its footer (timestamp + delivery status).
 *
 * Memoised so re-rendering the conversation (a new message, a typing event,
 * a scroll-driven state update) only re-renders the bubbles whose own data
 * actually changed — the main reason a long conversation can scroll smoothly.
 */
const MessageRow = memo(function MessageRow({
  message,
  isGroupEnd,
  isOwn,
  isHighlighted,
  onRetry,
  onDelete,
}) {
  const styles = useThemedStyles(createStyles);
  const status = getMessageStatus(message);
  const isTicked = isOwn && (status === 'sent' || status === 'delivered' || status === 'read');

  // Swipe actions only ever apply to the user's own messages: the server
  // refuses to delete somebody else's message, so never offer it here.
  const actions = [];
  if (isOwn && status === 'failed') {
    actions.push({
      key: 'retry',
      label: 'Retry',
      accessibilityLabel: 'Retry sending message',
      testID: 'chat-message-swipe-retry',
      onPress: () => onRetry?.(message),
    });
  }
  if (isOwn && onDelete) {
    actions.push({
      key: 'delete',
      label: 'Delete',
      accessibilityLabel: 'Delete message',
      testID: 'chat-message-swipe-delete',
      destructive: true,
      onPress: () => onDelete(message),
    });
  }

  const row = (
    <View
      testID="chat-message-row"
      style={[
        styles.messageRow,
        isOwn ? styles.messageRowOwn : styles.messageRowPeer,
        !isGroupEnd && styles.messageRowGrouped,
      ]}>
      <View
        style={[
          styles.bubble,
          isOwn ? styles.bubbleOwn : styles.bubblePeer,
          isHighlighted && styles.bubbleHighlighted,
        ]}
        testID={isHighlighted ? 'chat-message-highlighted' : undefined}>
        <Text style={isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer}>{message.body}</Text>
      </View>
      {isGroupEnd ? (
        <View style={styles.messageFooter}>
          <Text style={[styles.timestamp, isOwn && styles.timestampOwn]}>
            {formatMessageTimestamp(message.createdAt)}
          </Text>
          {isTicked ? (
            <Text
              style={[styles.tick, status === 'read' && styles.tickRead]}
              testID="chat-message-tick"
              accessibilityLabel={STATUS_LABELS[status]}>
              {status === 'sent' ? '✓' : '✓✓'}
            </Text>
          ) : null}
        </View>
      ) : null}
      {status === 'sending' ? <Text style={styles.pendingText}>Sending…</Text> : null}
      {status === 'failed' ? (
        <Pressable
          onPress={() => onRetry?.(message)}
          accessibilityRole="button"
          accessibilityLabel="Retry sending message"
          accessibilityHint="Sends this message again"
          hitSlop={touchSlop(20)}>
          <Text style={styles.failedText}>Failed to send · tap to retry, swipe to delete</Text>
        </Pressable>
      ) : null}
    </View>
  );

  return actions.length ? <SwipeableRow actions={actions}>{row}</SwipeableRow> : row;
});

/** Placeholder bubbles shown while the first page of history is still loading. */
function MessageSkeleton() {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.skeletonList} testID="chat-message-skeleton">
      {Array.from({ length: SKELETON_BUBBLE_COUNT }, (_unused, index) => (
        <View
          key={`skeleton-${index}`}
          style={[
            styles.messageRow,
            index % 2 === 0 ? styles.messageRowPeer : styles.messageRowOwn,
            styles.skeletonBubble,
            index % 3 === 0 ? styles.skeletonBubbleShort : null,
          ]}
        />
      ))}
    </View>
  );
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
 *   Entries tagged `type: 'call'` are rendered as call records inline in the
 *   timeline; everything else is a text message.
 * @param {(body: string) => void} props.onSendMessage
 * @param {(message: object) => void} [props.onRetryMessage] - Re-sends a failed message.
 *   Falls back to re-sending its body through `onSendMessage` when absent.
 * @param {(message: object) => void} [props.onDeleteMessage] - Deletes one of the user's own
 *   messages, revealed by swiping the bubble left.
 * @param {() => void} [props.onLoadOlder]
 * @param {() => void} props.onBack
 * @param {string} props.currentUserId
 * @param {{ online: boolean, status?: string } | null} [props.peerPresence]
 * @param {() => void} [props.onStartAudioCall]
 * @param {() => void} [props.onStartVideoCall]
 * @param {(peerId: string) => void} [props.onCallBack] - Audio call back from a call row.
 * @param {(peerId: string) => void} [props.onVideoCallBack] - Video call back from a call row.
 * @param {boolean} [props.isSending]
 * @param {boolean} [props.isStartingCall] - True while a call to this peer is being placed;
 *   shows a loading spinner on the call header buttons instead of the icon.
 * @param {boolean} [props.isPeerTyping] - Shows a "peer is typing…" hint under the header.
 * @param {boolean} [props.isLoadingMessages] - Shows skeleton bubbles while the first page
 *   of history is still being fetched.
 * @param {boolean} [props.isOffline] - Shows a persistent banner explaining that queued
 *   messages will be delivered once connectivity returns.
 * @param {string | null} [props.highlightMessageId] - Message the screen was opened at
 *   (a search result): the list scrolls to it and the bubble is emphasised.
 * @param {() => void} [props.onOpenProfile] - Opens the peer's profile screen.
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
  highlightMessageId = null,
  onOpenProfile,
  onSendMessage,
  onRetryMessage,
  onDeleteMessage,
  onLoadOlder,
  onBack,
  currentUserId,
  peerPresence = null,
  onStartAudioCall,
  onStartVideoCall,
  onCallBack,
  onVideoCallBack,
  isSending = false,
  isStartingCall = false,
  isPeerTyping = false,
  isLoadingMessages = false,
  isOffline = false,
  onTypingChange,
  keyboardVerticalOffset = 0,
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [draft, setDraft] = useState('');
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Date label of the topmost visible message, rendered as a pinned pill over
  // the list so the day being read stays on screen while its inline separator
  // scrolls away (sticky date separator).
  const [stickyDateLabel, setStickyDateLabel] = useState(null);
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
    const newestId = newestMessage ? (newestMessage.messageId ?? newestMessage.callId) : null;
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

  // Deep link from a search result: scroll to the message the conversation was
  // opened at, once it is present in the loaded page. `scrollToIndex` is used
  // rather than `scrollToEnd` because the target is usually mid-history, and a
  // missing index (the message is older than the loaded page) is simply left
  // alone until more history is paged in.
  useEffect(() => {
    if (!highlightMessageId) return undefined;
    const index = listItems.findIndex(
      item => item.type === 'message' && item.message.messageId === highlightMessageId,
    );
    if (index === -1) return undefined;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0.5 });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightMessageId, listItems]);

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
    message => {
      if (onRetryMessage) {
        onRetryMessage(message);
        return;
      }
      onSendMessage?.(message?.body);
    },
    [onRetryMessage, onSendMessage],
  );

  const handleDelete = useCallback(
    message => {
      onDeleteMessage?.(message);
    },
    [onDeleteMessage],
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

  // Pin the day of the topmost visible message: FlatList reports viewable
  // items in render order, so the first message item in that list is the one
  // at the top of the viewport.
  const handleViewableItemsChanged = useCallback(({ viewableItems }) => {
    const topItem = viewableItems.find(
      entry => entry.item?.type === 'message' || entry.item?.type === 'call',
    );
    setStickyDateLabel(topItem?.item?.dateLabel ?? null);
  }, []);

  const renderItem = useCallback(
    ({ item }) => {
      if (item.type === 'date') {
        return (
          <View style={styles.dateSeparator} testID="chat-date-separator">
            <Text style={styles.dateSeparatorText}>{item.label}</Text>
          </View>
        );
      }
      if (item.type === 'call') {
        return (
          <CallTimelineRow
            entries={item.entries}
            peerId={peerId}
            onCallBack={onCallBack}
            onVideoCallBack={onVideoCallBack}
          />
        );
      }
      return (
        <MessageRow
          message={item.message}
          isGroupEnd={item.isGroupEnd}
          isOwn={item.message.senderId === currentUserId}
          isHighlighted={Boolean(highlightMessageId) && item.message.messageId === highlightMessageId}
          onRetry={handleRetry}
          onDelete={onDeleteMessage ? handleDelete : undefined}
        />
      );
    },
    [
      currentUserId,
      handleDelete,
      handleRetry,
      highlightMessageId,
      onCallBack,
      onDeleteMessage,
      onVideoCallBack,
      peerId,
      styles,
    ],
  );

  const handleScrollToIndexFailed = useCallback(info => {
    setTimeout(() => {
      listRef.current?.scrollToIndex?.({
        index: info.index,
        animated: true,
        viewPosition: 0.5,
      });
    }, 100);
  }, []);

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
            hitSlop={touchSlop(36)}
            testID="chat-back"
            style={styles.backButton}>
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>

          <Pressable
            style={styles.headerText}
            onPress={onOpenProfile}
            disabled={!onOpenProfile}
            accessibilityRole={onOpenProfile ? 'button' : undefined}
            accessibilityLabel={onOpenProfile ? `${peerId} profile` : undefined}
            accessibilityHint={
              onOpenProfile ? 'Opens contact details, calls and privacy options' : undefined
            }
            testID="chat-open-profile">
            <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
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
          </Pressable>

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

        {isOffline ? (
          <StatusBanner
            status={{
              message: "Offline — messages will send when you're back",
              severity: 'warning',
            }}
            style={styles.offlineBanner}
          />
        ) : null}

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
            renderItem={renderItem}
            // Virtualization tuning: keep a bounded number of bubbles mounted
            // so a long conversation (thousands of messages) scrolls without
            // the frame drops an unbounded, fully-mounted list would cause.
            removeClippedSubviews
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            windowSize={11}
            // Bubbles have variable heights, so a deep-linked index may not be
            // measured yet; retry once the list has rendered further instead of
            // letting the failure surface as a warning.
            onScrollToIndexFailed={handleScrollToIndexFailed}
            viewabilityConfig={VIEWABILITY_CONFIG}
            onViewableItemsChanged={handleViewableItemsChanged}
            ListEmptyComponent={isLoadingMessages ? <MessageSkeleton /> : null}
          />
          {stickyDateLabel ? (
            <View style={styles.stickyDate} pointerEvents="none" testID="chat-sticky-date">
              <Text style={styles.dateSeparatorText}>{stickyDateLabel}</Text>
            </View>
          ) : null}
          {showScrollToBottom ? (
            <Pressable
              onPress={handleScrollToBottomPress}
              accessibilityRole="button"
              accessibilityLabel="Scroll to newest message"
              hitSlop={touchSlop(36)}
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
            accessibilityLabel={`Message to ${peerId}`}
            testID="chat-message-input"
          />
          <IconButton
            icon="➤"
            onPress={handleSend}
            variant="active"
            disabled={!draft.trim() || isSending}
            size={44}
            accessibilityLabel="Send message"
            accessibilityHint={`Sends the message to ${peerId}`}
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
    offlineBanner: {
      marginHorizontal: spacing.md,
      marginBottom: spacing.xs,
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
    stickyDate: {
      position: 'absolute',
      top: spacing.xs,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    skeletonList: {
      gap: spacing.sm,
    },
    skeletonBubble: {
      height: 36,
      width: '60%',
      borderRadius: radius.lg,
      backgroundColor: colors.surfaceRaised,
      opacity: 0.6,
    },
    skeletonBubbleShort: {
      width: '40%',
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
    bubbleHighlighted: {
      borderColor: colors.accent,
      borderWidth: 2,
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
