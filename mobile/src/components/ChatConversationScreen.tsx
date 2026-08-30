import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
  Alert,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  MESSAGE_TYPES,
  describeMessagePreview,
  isSupportedMessageType,
  messageTypeOf,
} from '../../../shared';
import { logWarn } from '../appLogger';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { elevation, radius, spacing, touchSlop, typography } from '../theme';
import { isAudioMimeType, isVideoMimeType } from '../videoPlayback';
import AttachSheet from './AttachSheet';
import AudioAttachmentPlayer from './AudioAttachmentPlayer';
import CallTimelineRow from './CallTimelineRow';
import IconButton from './IconButton';
import MediaViewer from './MediaViewer';
import { Avatar, Banner, Chip, FAB, Icon, Skeleton } from './primitives';
import { describeOffline, OFFLINE_CONSEQUENCE, OFFLINE_ICON } from '../connectivityUx';
import { announceForAccessibility, describeMessageDelivery } from '../accessibilityAnnouncer';
import SwipeableRow from './SwipeableRow';

import type { CallActivity, ChatMessage } from '../hooks/useMessaging';
import type { ReactNode } from 'react';
import type { MediaViewerItem } from './MediaViewer';
import type { ThemeColors } from '../theme';
import type { PeerPresence } from '../types/directory';

export type { CallActivity, ChatMessage };
/** A conversation timeline holds messages and (merged) call records alike. */
export type TimelineEntry = ChatMessage | CallActivity;
export type ChatStyles = ReturnType<typeof createStyles>;

/** Whether a reaction tap adds or removes the emoji. */
export type ReactionChange = 'add' | 'remove';
/** Anything acting on one message: retry, delete, reply, download. */
export type MessageAction = (message: ChatMessage) => void;
/** Adds or removes an emoji reaction on a message. */
export type ReactionAction = (
  message: ChatMessage,
  emoji: string,
  action: ReactionChange,
) => void;
export type { PeerPresence };
/** The kinds of attachment the attach sheet can start picking. */
export type AttachmentKind = 'photo' | 'camera' | 'file';

/**
 * One rendered row: a date separator, a bubble, or a collapsed run of calls.
 */
export type ListItem =
  | { key: string; type: 'date'; label: string }
  | { key: string; type: 'unread'; count: number }
  | {
      key: string;
      type: 'message';
      message: ChatMessage;
      isGroupEnd: boolean;
      dateLabel: string | null;
    }
  | {
      key: string;
      type: 'call';
      entries: CallActivity[];
      dateLabel: string | null;
    };

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
/** Emoji offered by the long-press reaction bar. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
/** How long a bubble stays emphasised after its quote is tapped. */
const QUOTE_HIGHLIGHT_MS = 1600;
/** How long the "attachments aren't available" notice stays visible. */
const ATTACHMENTS_UNAVAILABLE_NOTICE_MS = 4000;
/** Rendered height of an inline image attachment. */
const ATTACHMENT_IMAGE_HEIGHT = 180;

/** Material 3 puts a chat bubble at 16–20dp; the tail corner is squared. */
const BUBBLE_RADIUS = 18;
const BUBBLE_TAIL_RADIUS = radius.xs;

/** Where one of the current user's own messages has got to. */
export type MessageStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

/**
 * Lifecycle state of one of the current user's own messages.
 *
 * - `sending`   optimistic local copy, not yet acked by the server
 * - `failed`    the send was rejected / the socket was down
 * - `sent`      stored by the server, not yet handed to the recipient
 * - `delivered` handed to at least one of the recipient's connected devices
 * - `read`      the recipient opened the conversation
 *
 * @param message
 */
function getMessageStatus(message: {
        pending?: boolean; failed?: boolean; readAt?: string | null;
        deliveredTo?: string[]; recipientId?: string;
    }): MessageStatus {
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
 */
function isCallEntry(entry: TimelineEntry): entry is CallActivity {
  return entry?.type === 'call';
}

/**
 * Stable list key for either kind of timeline entry.
 */
function entryKey(entry: TimelineEntry): string {
  return isCallEntry(entry) ? entry.callId : entry.messageId;
}

/** Only items at least this visible count for the pinned date pill. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

function formatMessageTimestamp(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today" / "Yesterday" / a locale date string, for the date separator.
 */
function formatDateSeparator(date: Date): string {
  const now = new Date();
  if (isSameCalendarDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * True when two consecutive call entries belong in the same collapsed row.
 */
function isSameCallRun(previous: CallActivity, entry: CallActivity): boolean {
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
/**
 * Key of the message the "N new messages" divider belongs above.
 *
 * The anchor is derived from the conversation's unread *count* rather than
 * from per-message `readAt`, because opening the conversation marks it read
 * within a round trip — by the time the list renders, the receipts that would
 * identify the unread run are already gone. Counting back `unreadCount`
 * incoming messages from the end reproduces the same anchor and survives that
 * race.
 *
 * Calls are skipped: an unread count counts messages, so including call rows
 * would place the divider too early.
 *
 * @param orderedEntries oldest-first
 * @param unreadCount conversation unread count, captured when the screen opened
 * @param currentUserId so the reader's own messages are never counted
 * @returns the anchor entry's key, or null when there is nothing to divide
 */
export function findUnreadAnchorKey(
  orderedEntries: TimelineEntry[],
  unreadCount: number,
  currentUserId: string | null | undefined,
): string | null {
  if (!Array.isArray(orderedEntries) || !(unreadCount > 0)) return null;
  const incoming = orderedEntries.filter(
    entry => !isCallEntry(entry) && entry.senderId !== currentUserId,
  );
  if (!incoming.length) return null;
  // A count larger than what is loaded anchors at the oldest loaded message
  // rather than dropping the divider: "some of this is new" still beats
  // showing nothing.
  const anchor = incoming[Math.max(0, incoming.length - unreadCount)];
  return anchor ? entryKey(anchor) : null;
}

/**
 * @param orderedEntries oldest-first
 * @param unread where to place the "N new messages" divider, if anywhere
 */
function buildListItems(
  orderedEntries: TimelineEntry[],
  unread: { anchorId: string | null; count: number } = { anchorId: null, count: 0 },
): ListItem[] {
  const items = ([] as ListItem[]);
  let currentDateLabel = (null as string | null);
  for (let index = 0; index < orderedEntries.length; index++) {
    const entry = orderedEntries[index];
    const createdAt = new Date(entry.createdAt ?? '');
    const previous = orderedEntries[index - 1];
    const hasValidDate = !Number.isNaN(createdAt.getTime());
    if (
      hasValidDate &&
      (!previous || !isSameCalendarDay(createdAt, new Date(previous.createdAt ?? '')))
    ) {
      currentDateLabel = formatDateSeparator(createdAt);
      items.push({
        key: `date-${entryKey(entry)}`,
        type: 'date',
        label: currentDateLabel,
      });
    }

    // The divider sits *below* the day separator when the first unread
    // message opens a new day, so the reader still sees which day they are
    // resuming into.
    if (unread.anchorId && unread.count > 0 && entryKey(entry) === unread.anchorId) {
      items.push({ key: 'unread-divider', type: 'unread', count: unread.count });
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
      const nextCreatedAt = new Date(next.createdAt ?? '');
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
 * The content of one bubble: text, an inline attachment, a tombstone, or —
 * for a `type` this build does not know — a neutral placeholder.
 *
 * The placeholder is the compatibility contract: a message written by a newer
 * client must never blank out or crash an older one.
 *
 * @param props
 */
/**
 * The inside of a bubble, for every message type there is.
 *
 * One geometry: an optional media block, then the body text, then an optional
 * attachment action — in that order, at that spacing, whatever the type. The
 * seven types used to disagree: three returned a bare `Text` (so they sat at a
 * different offset from the ones wrapped in a `View`), the image branch put its
 * caption below the picture while the file branch put its label above, and only
 * some of them left room for a download link. A bubble should look like a
 * bubble before you have read what is in it.
 *
 * @param props
 */
function MessageContent({ message, isOwn, styles, onDownloadAttachment, onOpenMedia }: {
        message: ChatMessage; isOwn: boolean; styles: ChatStyles;
        onDownloadAttachment?: (message: ChatMessage) => void;
        onOpenMedia?: (message: ChatMessage) => void;
    }) {
  const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
  const type = messageTypeOf(message);
  const attachmentUrl = message.attachment?.url;
  const isUploading = Boolean(message.pending) && !attachmentUrl;
  const downloadButton =
    attachmentUrl && onDownloadAttachment ? (
      <Pressable
        onPress={() => onDownloadAttachment(message)}
        accessibilityRole="button"
        accessibilityLabel="Download attachment"
        accessibilityHint="Saves this attachment to your device"
        hitSlop={touchSlop(12)}
        style={styles.attachmentDownloadButton}
        testID="chat-attachment-download">
        <Text style={[textStyle, styles.attachmentDownloadText]}>Download</Text>
      </Pressable>
    ) : isUploading ? (
      <Text style={[textStyle, styles.placeholderText]} testID="chat-attachment-uploading">
        Uploading…
      </Text>
    ) : null;

  /** Every branch ends here, so every bubble is laid out the same way. */
  const body = (media: ReactNode, text: ReactNode, action: ReactNode = downloadButton) => (
    <View style={styles.bubbleContent}>
      {media}
      {text}
      {action}
    </View>
  );

  if (message.deletedAt) {
    return body(
      null,
      <Text style={[textStyle, styles.placeholderText]} testID="chat-message-deleted">
        Message deleted
      </Text>,
      null,
    );
  }

  if (!isSupportedMessageType(type)) {
    return body(
      null,
      <Text style={[textStyle, styles.placeholderText]} testID="chat-message-unsupported">
        {describeMessagePreview(message)}
      </Text>,
      null,
    );
  }

  if (type === MESSAGE_TYPES.IMAGE && message.attachment?.url) {
    return body(
      <Pressable
        onPress={onOpenMedia ? () => onOpenMedia(message) : undefined}
        accessibilityRole={onOpenMedia ? 'button' : undefined}
        accessibilityLabel={onOpenMedia ? 'Open photo' : undefined}
        accessibilityHint={onOpenMedia ? 'Opens the photo fullscreen' : undefined}
        testID="chat-message-image-open">
        <Image
          source={{ uri: message.attachment.thumbnailUrl || message.attachment.url }}
          style={styles.attachmentImage}
          resizeMode="cover"
          accessibilityLabel={message.body || 'Photo'}
          testID="chat-message-image"
        />
      </Pressable>,
      message.body ? <Text style={textStyle}>{message.body}</Text> : null,
      // Inline media carries no `Download` link: the picture *is* the control
      // (it opens fullscreen, where downloading lives), and the extra line
      // pushed the footer past the bubble it belongs to.
      null,
    );
  }

  // A video arrives as a `file` message (`video/mp4` is on the file MIME
  // allowlist), so it is recognised by its MIME type rather than its type.
  if (type === MESSAGE_TYPES.FILE && isVideoMimeType(message.attachment?.mimeType) && attachmentUrl) {
    return body(
      <Pressable
        onPress={onOpenMedia ? () => onOpenMedia(message) : undefined}
        accessibilityRole={onOpenMedia ? 'button' : undefined}
        accessibilityLabel={onOpenMedia ? 'Play video' : undefined}
        accessibilityHint={onOpenMedia ? 'Opens the video fullscreen' : undefined}
        style={styles.attachmentVideo}
        testID="chat-message-video">
        {message.attachment?.thumbnailUrl ? (
          <Image
            source={{ uri: message.attachment.thumbnailUrl }}
            style={styles.attachmentImage}
            resizeMode="cover"
            accessibilityLabel={message.attachment?.name || 'Video'}
            testID="chat-message-video-thumbnail"
          />
        ) : (
          <View style={[styles.attachmentImage, styles.attachmentVideoPlaceholder]} />
        )}
        <View style={styles.attachmentVideoBadge} pointerEvents="none">
          <Text style={styles.attachmentVideoBadgeText}>▶</Text>
        </View>
      </Pressable>,
      message.body ? <Text style={textStyle}>{message.body}</Text> : null,
      null,
    );
  }

  if (type === MESSAGE_TYPES.VOICE || isAudioMimeType(message.attachment?.mimeType)) {
    return body(
      <AudioAttachmentPlayer
        uri={attachmentUrl}
        durationMs={message.attachment?.durationMs ?? 0}
        isOwn={isOwn}
      />,
      message.body ? <Text style={textStyle}>{message.body}</Text> : null,
    );
  }

  if (type === MESSAGE_TYPES.VOICE || type === MESSAGE_TYPES.FILE) {
    return body(
      <Text style={textStyle} testID="chat-message-attachment">
        {describeMessagePreview(message)}
      </Text>,
      message.body ? <Text style={textStyle}>{message.body}</Text> : null,
    );
  }

  return body(null, <Text style={textStyle}>{message.body}</Text>, null);
}

/**
 * The compact quoted preview of the message a reply answers.
 *
 * A quote whose original was deleted (or is older than the loaded page) still
 * renders — as "Message deleted" — so a reply never leaves a dangling
 * reference behind.
 *
 * @param props
 */
function QuotedMessage({ quotedMessage, isOwn, onPress, styles }: {
        quotedMessage: ChatMessage | null; isOwn: boolean; onPress?: () => void;
        styles: ChatStyles;
    }) {
  const label = quotedMessage ? describeMessagePreview(quotedMessage) : 'Message deleted';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Replying to: ${label || 'message'}`}
      style={styles.quote}
      testID="chat-message-quote">
      <Text
        numberOfLines={2}
        style={[isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer, styles.quoteText]}>
        {label || 'Message'}
      </Text>
    </Pressable>
  );
}

/**
 * The reaction chips under a bubble, one per emoji with its count.
 *
 * @param props
 */
function ReactionChips({ reactions, currentUserId, onToggle, styles }: {
        reactions?: Record<string, string[]>; currentUserId: string;
        onToggle?: (emoji: string, action: 'add' | 'remove') => void; styles: ChatStyles;
    }) {
  const entries = Object.entries(reactions ?? {}).filter(([, userIds]) => userIds?.length);
  if (!entries.length) return null;

  return (
    <View style={styles.reactionRow} testID="chat-message-reactions">
      {entries.map(([emoji, userIds]) => {
        const mine = userIds.includes(currentUserId);
        return (
          <Chip
            key={emoji}
            label={`${emoji} ${userIds.length}`}
            variant="reaction"
            selected={mine}
            onPress={() => onToggle?.(emoji, mine ? 'remove' : 'add')}
            accessibilityLabel={`${emoji} ${userIds.length}${mine ? ', reacted by you' : ''}`}
          />
        );
      })}
    </View>
  );
}

/**
 * Where a message got to, in one place.
 *
 * Three separate affordances used to live at three different offsets under a
 * bubble — a tick row that appeared only at the end of a group, an italic
 * "Sending…" line, and a red "Failed to send" line — so a message changed shape
 * as it progressed. They are now one slot in the footer that renders exactly
 * one of the five states.
 *
 * `queued` is what `sending` looks like while the device is offline: the
 * message is not in flight, it is waiting, and saying "Sending…" would be a
 * lie.
 *
 * @param props
 */
function DeliveryState({ status, isQueued, styles, onRetry }: {
        status: MessageStatus; isQueued: boolean; styles: ChatStyles; onRetry?: () => void;
    }) {
  if (status === 'failed') {
    return (
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry sending message"
        accessibilityHint="Sends this message again"
        hitSlop={touchSlop(20)}
        testID="chat-message-failed">
        <Text style={styles.failedText}>Failed · tap to retry</Text>
      </Pressable>
    );
  }

  if (status === 'sending') {
    return (
      <Text style={styles.pendingText} testID="chat-message-pending">
        {isQueued ? 'Queued' : 'Sending…'}
      </Text>
    );
  }

  return (
    <Text
      style={[styles.tick, status === 'read' && styles.tickRead]}
      testID="chat-message-tick"
      accessibilityLabel={STATUS_LABELS[status]}>
      {status === 'sent' ? '✓' : '✓✓'}
    </Text>
  );
}

/**
 * A single chat bubble plus its footer (timestamp + delivery status).
 *
 * Memoised so re-rendering the conversation (a new message, a typing event,
 * a scroll-driven state update) only re-renders the bubbles whose own data
 * actually changed — the main reason a long conversation can scroll smoothly.
 */
export type MessageRowProps = {
  message: ChatMessage;
  quotedMessage?: ChatMessage | null;
  isGroupEnd: boolean;
  isOwn: boolean;
  isHighlighted: boolean;
  /** Nothing can leave the device right now, so a pending send is queued. */
  isQueued?: boolean;
  currentUserId: string;
  onRetry?: MessageAction;
  onDelete?: MessageAction;
  onReply?: MessageAction;
  onReact?: ReactionAction;
  onQuotePress?: (messageId: string) => void;
  onDownloadAttachment?: MessageAction;
  onOpenMedia?: MessageAction;
};

const MessageRow = memo(
  function MessageRowComponent({
  message,
  quotedMessage = null,
  isGroupEnd,
  isOwn,
  isHighlighted,
  isQueued = false,
  currentUserId,
  onRetry,
  onDelete,
  onReply,
  onReact,
  onQuotePress,
  onDownloadAttachment,
  onOpenMedia,
}: MessageRowProps) {
  const styles = useThemedStyles(createStyles);
  const status = getMessageStatus(message);
  const isPendingOrFailed = isOwn && (status === 'sending' || status === 'failed');
  // Long-press opens the reaction bar for this bubble only; it closes as soon
  // as an emoji is chosen or the bubble is pressed again.
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const isTombstone = Boolean(message.deletedAt);

  // Swipe actions only ever apply to the user's own messages: the server
  // refuses to delete somebody else's message, so never offer it here.
  const actions = [];
  if (onReply && !isTombstone) {
    actions.push({
      key: 'reply',
      label: 'Reply',
      accessibilityLabel: 'Reply to message',
      testID: 'chat-message-swipe-reply',
      onPress: () => onReply(message),
    });
  }
  if (isOwn && status === 'failed') {
    actions.push({
      key: 'retry',
      label: 'Retry',
      accessibilityLabel: 'Retry sending message',
      testID: 'chat-message-swipe-retry',
      onPress: () => onRetry?.(message),
    });
  }
  if (isOwn && onDelete && !isTombstone) {
    actions.push({
      key: 'delete',
      label: 'Delete',
      accessibilityLabel: 'Delete message',
      testID: 'chat-message-swipe-delete',
      destructive: true,
      onPress: () => onDelete(message),
    });
  }

  const canReact = Boolean(onReact) && !isTombstone;
  const toggleReactionBar = canReact ? () => setIsReactionBarOpen(open => !open) : undefined;

  // The bubble is a plain view, not a `Pressable`: a touch responder covering
  // the whole drag surface competes with the swipe gesture for the same touch
  // (and wins it while its long-press timer runs), which is why a bubble used
  // to refuse to swipe at all. The long press is handed to `SwipeableRow`
  // instead, where it is raced against the pan by the native gesture system.
  const row = (
    <View
      testID="chat-message-row"
      style={[
        styles.messageRow,
        isOwn ? styles.messageRowOwn : styles.messageRowPeer,
        !isGroupEnd && styles.messageRowGrouped,
      ]}>
      <View
        accessible
        accessibilityRole={canReact ? 'button' : undefined}
        accessibilityHint={canReact ? 'Long press to react' : undefined}
        style={[
          styles.bubble,
          isOwn ? styles.bubbleOwn : styles.bubblePeer,
          isGroupEnd && (isOwn ? styles.bubbleTailOwn : styles.bubbleTailPeer),
          isHighlighted && styles.bubbleHighlighted,
        ]}
        testID={isHighlighted ? 'chat-message-highlighted' : 'chat-message-bubble'}>
        {message.replyTo ? (
          <QuotedMessage
            quotedMessage={quotedMessage}
            isOwn={isOwn}
            onPress={() => (message.replyTo ? onQuotePress?.(message.replyTo) : undefined)}
            styles={styles}
          />
        ) : null}
        <MessageContent
          message={message}
          isOwn={isOwn}
          styles={styles}
          onDownloadAttachment={onDownloadAttachment}
          onOpenMedia={onOpenMedia}
        />
      </View>
      {isReactionBarOpen ? (
        <View style={styles.reactionBar} testID="chat-message-reaction-bar">
          {QUICK_REACTIONS.map(emoji => (
            <Pressable
              key={emoji}
              onPress={() => {
                setIsReactionBarOpen(false);
                const mine = message.reactions?.[emoji]?.includes(currentUserId);
                onReact?.(message, emoji, mine ? 'remove' : 'add');
              }}
              accessibilityRole="button"
              accessibilityLabel={`React with ${emoji}`}
              hitSlop={touchSlop(16)}
              style={styles.reactionBarButton}>
              <Text style={styles.reactionBarEmoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <ReactionChips
        reactions={message.reactions ?? undefined}
        currentUserId={currentUserId}
        onToggle={onReact ? (emoji, action) => onReact(message, emoji, action) : undefined}
        styles={styles}
      />
      {isGroupEnd || isPendingOrFailed ? (
        <View style={styles.messageFooter}>
          <Text style={[styles.timestamp, isOwn && styles.timestampOwn]}>
            {formatMessageTimestamp(message.createdAt)}
          </Text>
          {isOwn ? (
            <DeliveryState
              status={status}
              isQueued={isQueued}
              styles={styles}
              onRetry={onRetry ? () => onRetry(message) : undefined}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return actions.length || toggleReactionBar ? (
    <SwipeableRow
      actions={actions}
      onLongPress={toggleReactionBar}
      longPressLabel="React to message">
      {row}
    </SwipeableRow>
  ) : (
    row
  );
  },
);

/** Placeholder bubbles shown while the first page of history is still loading. */
function MessageSkeleton() {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.skeletonList} testID="chat-message-skeleton">
      {Array.from({ length: SKELETON_BUBBLE_COUNT }, (_unused, index) => (
        <Skeleton
          key={`skeleton-${index}`}
          width={index % 3 === 0 ? '40%' : '60%'}
          height={36}
          style={[
            styles.skeletonBubble,
            index % 2 === 0 ? styles.messageRowPeer : styles.messageRowOwn,
          ]}
        />
      ))}
    </View>
  );
}

export type ChatConversationScreenProps = {
  peerId: string;
  /** newest-first, as delivered by the hook. Entries tagged `type: 'call'` are rendered as call records inline in the timeline; everything else is a text message. */
  messages?: TimelineEntry[];
  onSendMessage: (body: string, options?: { replyTo?: string | null }) => void;
  /** Re-sends a failed message. Falls back to re-sending its body through `onSendMessage` when absent. */
  onRetryMessage?: MessageAction;
  /** Deletes one of the user's own messages, revealed by swiping the bubble left. */
  onDeleteMessage?: MessageAction;
  /** Adds or removes one of the user's emoji reactions, from the long-press reaction bar or by tapping an existing chip. */
  onReactToMessage?: ReactionAction;
  onDownloadAttachment?: MessageAction;
  onLoadOlder?: () => void;
  onBack: () => void;
  currentUserId: string;
  peerPresence?: PeerPresence | null;
  onStartAudioCall?: () => void;
  onStartVideoCall?: () => void;
  /** Audio call back from a call row. */
  onCallBack?: (peerId: string) => void;
  /** Video call back from a call row. */
  onVideoCallBack?: (peerId: string) => void;
  isSending?: boolean;
  /** True while a call to this peer is being placed; shows a loading spinner on the call header buttons instead of the icon. */
  isStartingCall?: boolean;
  /** Shows a "peer is typing…" hint under the header. */
  isPeerTyping?: boolean;
  /** Shows skeleton bubbles while the first page of history is still being fetched. */
  isLoadingMessages?: boolean;
  /** Shows a persistent banner explaining that queued messages will be delivered once connectivity returns. */
  isOffline?: boolean;
  /** Message the screen was opened at (a search result): the list scrolls to it and the bubble is emphasised. */
  highlightMessageId?: string | null;
  /** Opens the peer's profile screen. */
  onOpenProfile?: () => void;
  /** Reports composer typing state. */
  onTypingChange?: (isTyping: boolean) => void;
  /**
   * Unread count for this conversation as it stood before the screen opened;
   * drives the "N new messages" divider. Read once, on mount.
   */
  unreadCount?: number;
  /** Composer text (and reply target) restored from the local chat store. */
  initialDraft?: { text: string; replyToId?: string | null } | null;
  /** Persist the composer entry; called when the screen is left, not per key. */
  onSaveDraft?: (text: string, replyToId: string | null) => void;
  /** Drop the stored composer entry (the message was sent). */
  onClearDraft?: () => void;
  /** Distance between the true top of the screen and this screen's root view (e.g. the safe-area top inset applied by an ancestor). `KeyboardAvoidingView` measures its own frame relative to its immediate parent, not the screen, so without this offset it under-compensates for the keyboard by exactly that amount and the composer stays partly covered. */
  keyboardVerticalOffset?: number;
  /** Runs the named picker, uploads the result, and sends it as an attachment message. */
  onPickAttachment?: (kind: AttachmentKind) => void;
  /** Starts recording a voice note. */
  onStartVoiceNote?: () => void;
  /** Stops recording and sends the voice note. */
  onStopVoiceNote?: () => void;
  /** Stops recording without sending. */
  onCancelVoiceNote?: () => void;
  /** An attachment pick is uploading. */
  isUploadingAttachment?: boolean;
  /** Upload progress, 0–1. */
  attachmentUploadProgress?: number;
  onCancelAttachmentUpload?: () => void;
  /** A voice note is currently being recorded. */
  isRecordingVoiceNote?: boolean;
  /** Whether this server has attachment uploads configured; the attach control stays visible either way (never silently absent) but is disabled with an explanatory message when this is `false`. */
  attachmentsAvailable?: boolean;
  /** Whether the voice-recorder native module is linked on this build. */
  isVoiceNoteSupported?: boolean;
};

/**
 * One-to-one conversation window: header (back, presence, call actions),
 * a bubble message list (oldest at top, newest at bottom) with date
 * separators and sender/time grouping, and a composer with a typing
 * indicator.
 */
function ChatConversationScreen({
  peerId,
  messages = [],
  highlightMessageId = null,
  onOpenProfile,
  onSendMessage,
  onRetryMessage,
  onDeleteMessage,
  onReactToMessage,
  onDownloadAttachment,
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
  unreadCount = 0,
  initialDraft = null,
  onSaveDraft,
  onClearDraft,
  keyboardVerticalOffset = 0,
  onPickAttachment,
  onStartVoiceNote,
  onStopVoiceNote,
  onCancelVoiceNote,
  isUploadingAttachment = false,
  attachmentUploadProgress = 0,
  onCancelAttachmentUpload,
  isRecordingVoiceNote = false,
  attachmentsAvailable = true,
  isVoiceNoteSupported = false,
}: ChatConversationScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  // Seeded from the persisted draft so re-opening a conversation restores the
  // half-typed message instead of silently discarding it.
  const [draft, setDraft] = useState(() => initialDraft?.text ?? '');
  // The message the composer is currently replying to, if any.
  const [replyTarget, setReplyTarget] = useState((null as ChatMessage | null));
  // A bubble briefly emphasised because its quote was tapped; takes precedence
  // over the deep-link highlight the screen may have been opened with.
  const [quotedHighlightId, setQuotedHighlightId] = useState(
    (null as string | null),
  );
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isAttachSheetOpen, setIsAttachSheetOpen] = useState(false);
  const [showAttachmentsUnavailable, setShowAttachmentsUnavailable] = useState(false);
  // Index into `mediaItems` of the attachment shown fullscreen; `null` when the
  // viewer is closed.
  const [viewerIndex, setViewerIndex] = useState((null as number | null));
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Date label of the topmost visible message, rendered as a pinned pill over
  // the list so the day being read stays on screen while its inline separator
  // scrolls away (sticky date separator).
  const [stickyDateLabel, setStickyDateLabel] = useState((null as string | null));
  const hasReachedTopRef = useRef(false);
  const typingIdleTimerRef = useRef((undefined as ReturnType<typeof setTimeout> | undefined));
  const listRef = useRef((null as FlatList | null));
  // Tracks the newest message's id so the auto-scroll-to-bottom effect below
  // only fires for a genuinely new/sent message, not when older history is
  // paged in at the top (which must not yank the scroll position).
  const newestMessageIdRef = useRef((null as string | null));
  // Whether the list is currently scrolled near its bottom edge; used to
  // decide whether an incoming message should auto-scroll or instead surface
  // the "scroll to bottom" FAB so mid-history reading isn't interrupted.
  const isNearBottomRef = useRef(true);

  // Data arrives newest-first; reverse so a plain (non-inverted) FlatList
  // renders oldest-at-top / newest-at-bottom, matching a natural chat log.
  // Frozen on mount: opening the conversation marks it read, so reading the
  // live count would make the divider vanish the moment it appeared.
  const initialUnreadCountRef = useRef(unreadCount);
  const orderedEntries = useMemo(() => [...messages].reverse(), [messages]);
  const unreadAnchorKey = useMemo(
    () =>
      findUnreadAnchorKey(orderedEntries, initialUnreadCountRef.current, currentUserId),
    [currentUserId, orderedEntries],
  );
  const listItems = useMemo(
    () =>
      buildListItems(orderedEntries, {
        anchorId: unreadAnchorKey,
        count: initialUnreadCountRef.current,
      }),
    [orderedEntries, unreadAnchorKey],
  );

  // Resolves a reply's `replyTo` to the quoted message, when it is part of the
  // loaded page. A miss renders as "Message deleted" rather than as nothing.
  const messagesById = useMemo(() => {
    const byId = (new Map() as Map<string, ChatMessage>);
    messages.forEach(message => {
      if (!isCallEntry(message) && message?.messageId) byId.set(message.messageId, message);
    });
    return byId;
  }, [messages]);

  // Every viewable image/video in the loaded page, oldest first, so the
  // fullscreen viewer can be swiped between them exactly as they appear in the
  // conversation.
  const mediaItems = useMemo(() => {
    const ordered = [...messages].reverse();
    return ordered.reduce((collected: MediaViewerItem[], entry) => {
      if (isCallEntry(entry) || entry.deletedAt) return collected;
      const url = entry.attachment?.url;
      if (!url) return collected;
      const type = messageTypeOf(entry);
      const isVideo = type === MESSAGE_TYPES.FILE && isVideoMimeType(entry.attachment?.mimeType);
      if (type !== MESSAGE_TYPES.IMAGE && !isVideo) return collected;
      collected.push({
        key: entry.messageId,
        url,
        mimeType: entry.attachment?.mimeType ?? null,
        name: entry.attachment?.name ?? null,
        kind: isVideo ? 'video' : 'image',
      });
      return collected;
    }, []);
  }, [messages]);

  const activeHighlightId = quotedHighlightId ?? highlightMessageId;

  // Speak the outcome of the user's own sends. Delivery is otherwise conveyed
  // only by a tick glyph in the bubble footer, which a screen-reader user has
  // no reason to go back and re-read — so "did that send?" had no spoken
  // answer. Only terminal states are announced, and only for messages that
  // have changed state since the last render, so opening a conversation full
  // of already-sent messages says nothing.
  const announcedStatusRef = useRef((new Map() as Map<string, MessageStatus>));
  useEffect(() => {
    const seen = (new Set() as Set<string>);
    messages.forEach(entry => {
      if (isCallEntry(entry) || entry.senderId !== currentUserId || !entry.messageId) return;
      seen.add(entry.messageId);
      const status = getMessageStatus(entry);
      const previous = announcedStatusRef.current.get(entry.messageId);
      announcedStatusRef.current.set(entry.messageId, status);
      // No previous status means this message arrived already in its final
      // state (a page of history), not a send that just completed.
      if (previous === undefined || previous === status) return;
      const message = describeMessageDelivery(status);
      if (message) announceForAccessibility(message);
    });
    announcedStatusRef.current.forEach((_status, messageId) => {
      if (!seen.has(messageId)) announcedStatusRef.current.delete(messageId);
    });
  }, [messages, currentUserId]);

  // Keep the newest message in view: scroll to the bottom whenever the
  // newest message changes (a message was sent or received) and the user is
  // already near the bottom, or the new message is the current user's own
  // (e.g. just sent). Otherwise (user is reading older history and a peer
  // message arrives) leave the scroll position alone and surface the
  // "scroll to bottom" FAB instead of yanking the view.
  useEffect(() => {
    const newestMessage = messages[0] ?? null;
    const newestId = newestMessage
      ? isCallEntry(newestMessage)
        ? newestMessage.callId
        : newestMessage.messageId
      : null;
    if (newestId !== newestMessageIdRef.current) {
      newestMessageIdRef.current = newestId;
      const isOwnMessage =
        Boolean(newestMessage) &&
        !isCallEntry((newestMessage as TimelineEntry)) &&
        (newestMessage as ChatMessage).senderId === currentUserId;
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
    if (!activeHighlightId) return undefined;
    const index = listItems.findIndex(
      item => item.type === 'message' && item.message.messageId === activeHighlightId,
    );
    if (index === -1) return undefined;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0.5 });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeHighlightId, listItems]);

  // The quote highlight is a momentary "here it is" flash, not a mode.
  useEffect(() => {
    if (!quotedHighlightId) return undefined;
    const timer = setTimeout(() => setQuotedHighlightId(null), QUOTE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [quotedHighlightId]);

  // The unconfigured-server notice is momentary too: the attach control stays
  // visible and tappable (never silently absent), it just explains itself
  // again each time rather than blocking the composer.
  useEffect(() => {
    if (!showAttachmentsUnavailable) return undefined;
    const timer = setTimeout(
      () => setShowAttachmentsUnavailable(false),
      ATTACHMENTS_UNAVAILABLE_NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [showAttachmentsUnavailable]);

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
      (isTyping: boolean) => {
      clearTimeout(typingIdleTimerRef.current);
      onTypingChange?.(isTyping);
      if (isTyping) {
        typingIdleTimerRef.current = setTimeout(() => onTypingChange?.(false), TYPING_IDLE_MS);
      }
    },
    [onTypingChange],
  );

  const handleChangeText = useCallback(
      (text: string) => {
      setDraft(text);
      reportTyping(Boolean(text.trim()));
    },
    [reportTyping],
  );

  const draftStateRef = useRef({ text: draft, replyToId: replyTarget?.messageId ?? null });

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSendMessage?.(trimmed, { replyTo: replyTarget?.messageId ?? null });
    setDraft('');
    setReplyTarget(null);
    // Cleared synchronously as well as through the effect below: unmounting in
    // the same commit as the send would otherwise persist the sent text back.
    draftStateRef.current = { text: '', replyToId: null };
    onClearDraft?.();
    reportTyping(false);
  }, [draft, onClearDraft, onSendMessage, replyTarget, reportTyping]);

  // The reply target is restored separately: it is stored by id, and the
  // message it points at may not have been loaded yet when the screen mounts.
  const restoredReplyRef = useRef(false);
  const initialReplyToId = initialDraft?.replyToId ?? null;
  useEffect(() => {
    if (restoredReplyRef.current || !initialReplyToId) return;
    const target = messages.find(
      entry => (entry as ChatMessage)?.messageId === initialReplyToId,
    ) as ChatMessage | undefined;
    if (!target) return;
    restoredReplyRef.current = true;
    setReplyTarget(target);
  }, [initialReplyToId, messages]);

  // The draft is persisted when the user *leaves* (screen closed, app
  // backgrounded), never per keystroke: writing on every character would push
  // a state update through the chat provider on each key, re-rendering the
  // whole conversation.
  useEffect(() => {
    draftStateRef.current = { text: draft, replyToId: replyTarget?.messageId ?? null };
  }, [draft, replyTarget]);

  const onSaveDraftRef = useRef(onSaveDraft);
  useEffect(() => {
    onSaveDraftRef.current = onSaveDraft;
  }, [onSaveDraft]);

  useEffect(() => {
    const persist = () => {
      const { text, replyToId } = draftStateRef.current;
      onSaveDraftRef.current?.(text, replyToId);
    };
    const subscription = AppState.addEventListener?.('change', nextState => {
      if (nextState !== 'active') persist();
    });
    return () => {
      subscription?.remove?.();
      persist();
    };
  }, []);

  const handleAttachPress = useCallback(() => {
    if (!attachmentsAvailable) {
      setShowAttachmentsUnavailable(true);
      return;
    }
    setIsAttachSheetOpen(true);
  }, [attachmentsAvailable]);

  const handlePickAttachment = useCallback(
      (kind: 'photo'|'camera'|'file') => {
      onPickAttachment?.(kind);
    },
    [onPickAttachment],
  );

  const handleMicPress = useCallback(() => {
    if (isRecordingVoiceNote) {
      onStopVoiceNote?.();
    } else {
      onStartVoiceNote?.();
    }
  }, [isRecordingVoiceNote, onStartVoiceNote, onStopVoiceNote]);

  const handleCancelVoiceNote = useCallback(() => {
    onCancelVoiceNote?.();
  }, [onCancelVoiceNote]);

  const handleReply = useCallback(/** @param message */ (message: ChatMessage) => {
    setReplyTarget(message);
  }, []);

  const handleReact = useCallback(
    (message: ChatMessage, emoji: string, action: 'add' | 'remove') => {
      onReactToMessage?.(message, emoji, action);
    },
    [onReactToMessage],
  );

  const handleQuotePress = useCallback(/** @param messageId */ (messageId: string) => {
    if (messageId) setQuotedHighlightId(messageId);
  }, []);

  const handleDownloadAttachment = useCallback(
      (message: ChatMessage) => {
      onDownloadAttachment?.(message);
    },
    [onDownloadAttachment],
  );

  const handleOpenMedia = useCallback(
    (message: ChatMessage) => {
      const index = mediaItems.findIndex(candidate => candidate.key === message?.messageId);
      if (index < 0) {
        logWarn('[Media] cannot open this attachment', {
          type: messageTypeOf(message),
          mimeType: message?.attachment?.mimeType,
          hasUrl: Boolean(message?.attachment?.url),
        });
        return;
      }
      setViewerIndex(index);
    },
    [mediaItems],
  );

  const handleRetry = useCallback(
      (message: ChatMessage) => {
      if (onRetryMessage) {
        onRetryMessage(message);
        return;
      }
      onSendMessage?.(message?.body);
    },
    [onRetryMessage, onSendMessage],
  );

  const handleDelete = useCallback(
      (message: ChatMessage) => {
      if (!onDeleteMessage) return;
      Alert.alert(
        'Delete message?',
        'This removes the message for everyone. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => onDeleteMessage(message),
          },
        ],
        { cancelable: true },
      );
    },
    [onDeleteMessage],
  );

  const handleScroll = useCallback(
      (event: NativeSyntheticEvent<NativeScrollEvent>) => {
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
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ item?: ListItem; }>; }) => {
      const topItem = viewableItems.find(
        entry => entry.item?.type === 'message' || entry.item?.type === 'call',
      );
      const item = topItem?.item;
      setStickyDateLabel(
        item && (item.type === 'message' || item.type === 'call')
          ? (item.dateLabel ?? null)
          : null,
      );
    },
    [],
  );

  const renderItem = useCallback(
    /** @param info */
    ({ item }: { item: ListItem; }) => {
      if (item.type === 'date') {
        return (
          // A rule either side of the label, like the unread divider: as a
          // bare chip it sat beside the day's first bubble instead of above it.
          <View style={styles.dateSeparator} testID="chat-date-separator">
            <View style={styles.dateSeparatorRule} />
            <Text style={styles.dateSeparatorText}>{item.label}</Text>
            <View style={styles.dateSeparatorRule} />
          </View>
        );
      }
      if (item.type === 'unread') {
        return (
          <View style={styles.unreadDivider} testID="chat-unread-divider">
            <View style={styles.unreadDividerRule} />
            <Text style={styles.unreadDividerText}>
              {item.count === 1 ? '1 new message' : `${item.count} new messages`}
            </Text>
            <View style={styles.unreadDividerRule} />
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
          quotedMessage={
            item.message.replyTo ? (messagesById.get(item.message.replyTo) ?? null) : null
          }
          isGroupEnd={item.isGroupEnd}
          isOwn={item.message.senderId === currentUserId}
          isQueued={isOffline}
          isHighlighted={
            Boolean(activeHighlightId) && item.message.messageId === activeHighlightId
          }
          currentUserId={currentUserId}
          onRetry={handleRetry}
          onDelete={onDeleteMessage ? handleDelete : undefined}
          onReply={handleReply}
          onReact={onReactToMessage ? handleReact : undefined}
          onQuotePress={handleQuotePress}
          onDownloadAttachment={onDownloadAttachment ? handleDownloadAttachment : undefined}
          onOpenMedia={handleOpenMedia}
        />
      );
    },
    [
      activeHighlightId,
      currentUserId,
      handleDelete,
      handleQuotePress,
      handleReact,
      handleDownloadAttachment,
      handleOpenMedia,
      handleReply,
      handleRetry,
      isOffline,
      messagesById,
      onCallBack,
      onDeleteMessage,
      onDownloadAttachment,
      onReactToMessage,
      onVideoCallBack,
      peerId,
      styles,
    ],
  );

  const handleScrollToIndexFailed = useCallback(/** @param info */ (info: { index: number; }) => {
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
            <Icon name="back" size={26} color={colors.onSurface} />
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
            <Avatar id={peerId} size="sm" online={peerPresence?.online} />
            <View style={styles.headerTextColumn}>
              <Text style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
                {peerId}
              </Text>
            {isPeerTyping ? (
              <Text style={styles.headerSubtitle} testID="chat-typing-indicator">
                typing…
              </Text>
            ) : presenceLabel ? (
              <View style={styles.presenceRow} testID="chat-presence-row">
                <Icon
                  name={peerPresence?.online ? 'presenceOnline' : 'presenceOffline'}
                  size={8}
                  color={presenceColor}
                />
                <Text style={styles.headerSubtitle}>{presenceLabel}</Text>
              </View>
            ) : null}
            </View>
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
            // NOTE: removeClippedSubviews is deliberately omitted — on Android
            // it clips by layout bounds and ignores `transform`, which hides
            // the SwipeableRow action tray and breaks touch dispatch on swiped rows.
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
              <Text style={styles.stickyDateText}>{stickyDateLabel}</Text>
            </View>
          ) : null}
          {showScrollToBottom ? (
            <FAB
              icon="scrollToBottom"
              onPress={handleScrollToBottomPress}
              accessibilityLabel="Scroll to newest message"
              accessibilityHint={
                newMessageCount > 0 ? 'Jumps to the messages you have not seen' : undefined
              }
              badgeCount={newMessageCount}
              tone="surface"
              size="sm"
              style={styles.scrollToBottomFab}
              testID="chat-scroll-to-bottom"
            />
          ) : null}
        </View>

        {/* One stack, one geometry. These four used to be four bespoke rows in
            three different places: the offline banner above the list, the reply
            preview and two notices below it, each with its own padding, colour
            and icon convention. */}
        <View style={styles.noticeStack}>
          {isOffline ? (
            <Banner
              icon={OFFLINE_ICON}
              tone="warning"
              message={describeOffline(OFFLINE_CONSEQUENCE.conversation)}
              testID="chat-offline-notice"
            />
          ) : null}
          {showAttachmentsUnavailable ? (
            <Banner
              icon="messageFailed"
              tone="warning"
              message="Attachments aren't available on this server"
              accessibilityRole="alert"
              testID="chat-attachments-unavailable-notice"
            />
          ) : null}
          {isUploadingAttachment ? (
            <Banner
              icon="attachmentAttach"
              message={`Uploading… ${Math.round(attachmentUploadProgress * 100)}%`}
              accessibilityRole="progressbar"
              accessibilityValue={{
                now: Math.round(attachmentUploadProgress * 100),
                min: 0,
                max: 100,
              }}
              onDismiss={onCancelAttachmentUpload}
              dismissLabel="Cancel upload"
              dismissTestID="chat-attachment-upload-cancel"
              testID="chat-attachment-upload-progress"
            />
          ) : null}
          {replyTarget ? (
            <Banner
              icon="messageReply"
              tone="accent"
              message={`Replying to: ${describeMessagePreview(replyTarget) || 'message'}`}
              onDismiss={() => setReplyTarget(null)}
              dismissLabel="Cancel reply"
              dismissTestID="chat-reply-cancel"
              testID="chat-reply-preview"
            />
          ) : null}
        </View>

        <View style={[styles.composer, isComposerFocused && styles.composerFocused]}>
          <IconButton
            icon="attachmentAttach"
            onPress={handleAttachPress}
            variant="default"
            disabled={isUploadingAttachment || isRecordingVoiceNote}
            size={40}
            accessibilityLabel="Add attachment"
            accessibilityHint={
              attachmentsAvailable
                ? 'Opens options to send a photo, take a photo, or send a file'
                : "Attachments aren't available on this server"
            }
            testID="chat-attach-button"
          />
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
          {!draft.trim() ? (
            <IconButton
              icon={isRecordingVoiceNote ? 'attachmentMicStop' : 'attachmentMic'}
              onPress={handleMicPress}
              variant={isRecordingVoiceNote ? 'active' : 'default'}
              disabled={!isVoiceNoteSupported || isUploadingAttachment}
              size={44}
              accessibilityLabel={isRecordingVoiceNote ? 'Stop and send voice note' : 'Record voice note'}
              accessibilityHint={
                isVoiceNoteSupported
                  ? undefined
                  : 'Voice notes are not supported on this build'
              }
              testID="chat-mic-button"
            />
          ) : null}
          {isRecordingVoiceNote ? (
            <IconButton
              icon="dismiss"
              onPress={handleCancelVoiceNote}
              variant="danger"
              size={40}
              accessibilityLabel="Cancel voice note"
              accessibilityHint="Stops recording without sending"
              testID="chat-mic-cancel-button"
            />
          ) : null}
          <IconButton
            icon="➤"
            onPress={handleSend}
            // A faded accent circle beside an enabled mic button is what made
            // send look broken; when there is nothing to send it is simply a
            // quiet control, and it lights up in the accent once there is.
            variant={draft.trim() ? 'active' : 'default'}
            disabled={!draft.trim() || isSending}
            size={44}
            accessibilityLabel="Send message"
            accessibilityHint={`Sends the message to ${peerId}`}
            testID="chat-message-send"
          />
        </View>
      </View>

      <MediaViewer
        items={mediaItems}
        initialIndex={viewerIndex ?? 0}
        visible={viewerIndex !== null}
        onClose={() => setViewerIndex(null)}
        onDownload={
          onDownloadAttachment
            ? item => {
                const message = messagesById.get(item.key);
                if (message) handleDownloadAttachment(message);
              }
            : undefined
        }
      />
      <AttachSheet
        visible={isAttachSheetOpen}
        onClose={() => setIsAttachSheetOpen(false)}
        onSelect={handlePickAttachment}
      />
    </KeyboardAvoidingView>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
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
    headerText: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    headerTextColumn: {
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
    listContainer: {
      flex: 1,
    },
    messageList: {
      padding: spacing.md,
      gap: spacing.sm,
    },
    dateSeparator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },
    dateSeparatorRule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.outlineVariant,
    },
    dateSeparatorText: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    // The floating copy of the same label, which needs its own fill because it
    // is drawn over the messages rather than between them.
    stickyDateText: {
      ...typography.caption,
      color: colors.textSecondary,
      backgroundColor: colors.surfaceContainerHigh,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    unreadDivider: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    unreadDividerRule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.accent,
    },
    unreadDividerText: {
      ...typography.hint,
      color: colors.accent,
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
      borderRadius: radius.lg,
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
    // 18dp, not the near-pill it used to read as at 16dp on short bubbles:
    // Material 3 puts a bubble at 16–20dp and squares the tail-side corner of
    // the last bubble in a run, which is what gives grouping for free.
    bubble: {
      borderRadius: BUBBLE_RADIUS,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleOwn: {
      backgroundColor: colors.accentButton,
      ...elevation(colors.shadow).low,
    },
    // Filled, not outlined: an outlined incoming bubble beside a filled
    // outgoing one inverts the platform norm and reads as draft or disabled.
    bubblePeer: {
      backgroundColor: colors.surfaceVariant,
    },
    bubbleTailOwn: {
      borderBottomRightRadius: BUBBLE_TAIL_RADIUS,
    },
    bubbleTailPeer: {
      borderBottomLeftRadius: BUBBLE_TAIL_RADIUS,
    },
    bubbleHighlighted: {
      borderColor: colors.accent,
      borderWidth: 2,
    },
    bubbleContent: {
      gap: spacing.xs,
    },
    bubbleTextOwn: {
      ...typography.bodyLarge,
      color: colors.textOnAccent,
    },
    bubbleTextPeer: {
      ...typography.bodyLarge,
      color: colors.onSurface,
    },
    placeholderText: {
      fontStyle: 'italic',
      opacity: 0.8,
    },
    attachmentImage: {
      width: 220,
      height: ATTACHMENT_IMAGE_HEIGHT,
      borderRadius: radius.md,
    },
    attachmentVideo: {
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachmentVideoPlaceholder: {
      backgroundColor: colors.stageDark,
    },
    attachmentVideoBadge: {
      position: 'absolute',
      alignSelf: 'center',
      top: ATTACHMENT_IMAGE_HEIGHT / 2 - 20,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    attachmentVideoBadgeText: {
      color: colors.textPrimary,
      fontSize: 18,
    },
    attachmentDownloadButton: {
      marginTop: spacing.xs,
      alignSelf: 'flex-start',
      paddingVertical: 2,
    },
    attachmentDownloadText: {
      fontWeight: '700',
      textDecorationLine: 'underline',
    },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
      paddingLeft: spacing.sm,
      marginBottom: spacing.xs,
      opacity: 0.9,
    },
    quoteText: {
      ...typography.hint,
    },
    reactionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginTop: 2,
    },
    reactionBar: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginTop: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
    },
    reactionBarButton: {
      paddingHorizontal: 2,
    },
    reactionBarEmoji: {
      fontSize: 20,
    },
    noticeStack: {
      paddingHorizontal: spacing.md,
      gap: spacing.xs,
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
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceContainerHigh,
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

/**
 * Memoized: an open conversation re-renders only when its own props change, not merely
 * because an ancestor re-rendered.
 */
export default memo(ChatConversationScreen);
