import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
  Alert,
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
import { MESSAGE_TYPES, describeMessagePreview, messageTypeOf } from '../../../../shared';
import { logWarn } from '../../appLogger';
import { useTheme, useThemedStyles } from '../../ThemeContext';
import { elevation, radius, spacing, touchSlop, typography } from '../../theme';
import { isVideoMimeType } from '../../videoPlayback';
import AttachSheet from '../AttachSheet';
import AudioAttachmentPlayer from '../AudioAttachmentPlayer';
import CallTimelineRow from '../CallTimelineRow';
import IconButton from '../IconButton';
import MediaViewer from '../MediaViewer';
import { Avatar, Banner, Chip, FAB, Icon, Skeleton } from '../primitives';
import { describeOffline, OFFLINE_CONSEQUENCE, OFFLINE_ICON } from '../../connectivityUx';
import { announceForAccessibility, describeMessageDelivery } from '../../accessibilityAnnouncer';
import SwipeableRow from '../SwipeableRow';

import type { CallActivity, ChatMessage } from '../../hooks/useMessaging';
import type { ReactElement, ReactNode } from 'react';
import type { MediaViewerItem } from '../MediaViewer';
import type { ThemeColors } from '../../theme';
import type { PeerPresence } from '../../types/directory';

// The timeline grouping rules — date separators, same-sender runs, collapsed
// call runs, the unread anchor — are pure functions of their arguments, so they
// live in their own module and are unit-testable without rendering this screen.
// Re-exported below so every existing consumer import keeps working.
import {
  buildListItems,
  findUnreadAnchorKey,
  formatMessageTimestamp,
  getMessageStatus,
  isCallEntry,
  messageAccessibilityLabel,
  messageContentKind,
} from './chatTimelineModel';

import type {
  ListItem,
  MessageContentKind,
  MessageStatus,
  TimelineEntry,
} from './chatTimelineModel';

import useDraftPersistence from './useDraftPersistence';

export { findUnreadAnchorKey };
export type { ListItem, MessageStatus, TimelineEntry };

export type { CallActivity, ChatMessage };
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

/** Only items at least this visible count for the pinned date pill. */
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };

const STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

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
 * The unsupported-message placeholder is a compatibility contract: a message
 * written by a newer client must never blank out or crash an older one.
 *
 * @param props
 */
type MessageContentProps = {
 message: ChatMessage;
 isOwn: boolean;
 styles: ChatStyles;
 onDownloadAttachment?: (message: ChatMessage) => void;
 onOpenMedia?: (message: ChatMessage) => void;
};

function BubbleContent({
 media,
 text,
 action,
 styles,
}: {
 media: ReactNode;
 text: ReactNode;
 action: ReactNode;
 styles: ChatStyles;
}) {
 return (
   <View style={styles.bubbleContent}>
     {media}
     {text}
     {action}
   </View>
 );
}

function AttachmentDownload({
 message,
 textStyle,
 styles,
 onDownloadAttachment,
}: Pick<MessageContentProps, 'message' | 'styles' | 'onDownloadAttachment'> & {
 textStyle: object;
}) {
 const attachmentUrl = message.attachment?.url;
 const isUploading =
   message.uploadState === 'uploading' || (Boolean(message.pending) && !attachmentUrl);
 if (isUploading) {
   return (
     <Text style={[textStyle, styles.placeholderText]} testID="chat-attachment-uploading">
       Uploading…
     </Text>
   );
 }
 if (!attachmentUrl || !onDownloadAttachment) return null;
 return (
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
 );
}

type RenderMessageBodyProps = Omit<MessageContentProps, 'onDownloadAttachment'> & {
 downloadButton: ReactNode;
};

function PlaceholderMessageBody({
 kind,
 message,
 isOwn,
 styles,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles'> & {
 kind: 'deleted' | 'unsupported';
}) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 const deleted = kind === 'deleted';
 return (
   <BubbleContent
     media={null}
     text={
       <Text
         style={[textStyle, styles.placeholderText]}
         testID={deleted ? 'chat-message-deleted' : 'chat-message-unsupported'}>
         {deleted ? 'Message deleted' : describeMessagePreview(message)}
       </Text>
     }
     action={null}
     styles={styles}
   />
 );
}

function ImageMessageBody({
 message,
 isOwn,
 styles,
 onOpenMedia,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles' | 'onOpenMedia'>) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 return (
   <BubbleContent
     media={
       <Pressable
         onPress={onOpenMedia ? () => onOpenMedia(message) : undefined}
         accessibilityRole={onOpenMedia ? 'button' : undefined}
         accessibilityLabel={onOpenMedia ? 'Open photo' : undefined}
         accessibilityHint={onOpenMedia ? 'Opens the photo fullscreen' : undefined}
         testID="chat-message-image-open">
         <Image
           source={{ uri: message.attachment?.thumbnailUrl || message.attachment?.url }}
           style={styles.attachmentImage}
           resizeMode="cover"
           accessibilityLabel={message.body || 'Photo'}
           testID="chat-message-image"
         />
       </Pressable>
     }
     text={message.body ? <Text style={textStyle}>{message.body}</Text> : null}
     action={null}
     styles={styles}
   />
 );
}

function VideoMessageBody({
 message,
 isOwn,
 styles,
 onOpenMedia,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles' | 'onOpenMedia'>) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 return (
   <BubbleContent
     media={
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
         ) : <View style={[styles.attachmentImage, styles.attachmentVideoPlaceholder]} />}
         <View style={styles.attachmentVideoBadge} pointerEvents="none">
           <Text style={styles.attachmentVideoBadgeText}>▶</Text>
         </View>
       </Pressable>
     }
     text={message.body ? <Text style={textStyle}>{message.body}</Text> : null}
     action={null}
     styles={styles}
   />
 );
}

function AudioMessageBody({
 message,
 isOwn,
 styles,
 downloadButton,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles' | 'downloadButton'>) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 return (
   <BubbleContent
     media={
       <AudioAttachmentPlayer
         uri={message.attachment?.url}
         durationMs={message.attachment?.durationMs ?? 0}
         isOwn={isOwn}
       />
     }
     text={message.body ? <Text style={textStyle}>{message.body}</Text> : null}
     action={downloadButton}
     styles={styles}
   />
 );
}

function AttachmentMessageBody({
 message,
 isOwn,
 styles,
 downloadButton,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles' | 'downloadButton'>) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 return (
   <BubbleContent
     media={
       <Text style={textStyle} testID="chat-message-attachment">
         {describeMessagePreview(message)}
       </Text>
     }
     text={message.body ? <Text style={textStyle}>{message.body}</Text> : null}
     action={downloadButton}
     styles={styles}
   />
 );
}

function TextMessageBody({
 message,
 isOwn,
 styles,
}: Pick<RenderMessageBodyProps, 'message' | 'isOwn' | 'styles'>) {
 const textStyle = isOwn ? styles.bubbleTextOwn : styles.bubbleTextPeer;
 return (
   <BubbleContent
     media={null}
     text={<Text style={textStyle}>{message.body}</Text>}
     action={null}
     styles={styles}
   />
 );
}

function MessageBody({ kind, ...props }: RenderMessageBodyProps & { kind: MessageContentKind }) {
 switch (kind) {
   case 'deleted':
   case 'unsupported':
     return <PlaceholderMessageBody {...props} kind={kind} />;
   case 'image':
     return <ImageMessageBody {...props} />;
   case 'video':
     return <VideoMessageBody {...props} />;
   case 'audio':
     return <AudioMessageBody {...props} />;
   case 'attachment':
     return <AttachmentMessageBody {...props} />;
   default:
     return <TextMessageBody {...props} />;
 }
}

function MessageContent(props: MessageContentProps) {
 const textStyle = props.isOwn ? props.styles.bubbleTextOwn : props.styles.bubbleTextPeer;
 const downloadButton = (
   <AttachmentDownload
     message={props.message}
     textStyle={textStyle}
     styles={props.styles}
     onDownloadAttachment={props.onDownloadAttachment}
   />
 );
 return (
   <MessageBody
     {...props}
     kind={messageContentKind(props.message)}
     downloadButton={downloadButton}
   />
 );
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
function DeliveryState({ status, isQueued, uploadState, uploadProgress, styles, onRetry, onCancelUpload }: {
        status: MessageStatus; isQueued: boolean; uploadState?: ChatMessage['uploadState'];
        uploadProgress?: number; styles: ChatStyles; onRetry?: () => void; onCancelUpload?: () => void;
    }) {
  if (uploadState === 'uploading') {
    const percent = Math.round((uploadProgress ?? 0) * 100);
    return (
      <View style={styles.uploadFooter}>
        <Text
          style={styles.pendingText}
          accessibilityRole="progressbar"
          accessibilityValue={{ now: percent, min: 0, max: 100 }}
          testID="chat-attachment-upload-progress">
          {`Uploading… ${percent}%`}
        </Text>
        {onCancelUpload ? (
          <Pressable
            onPress={onCancelUpload}
            accessibilityRole="button"
            accessibilityLabel="Cancel upload"
            hitSlop={touchSlop(20)}
            testID="chat-attachment-upload-cancel">
            <Text style={styles.failedText}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

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
  onCancelAttachmentUpload?: () => void;
};

function MessageBubble({
  message,
  quotedMessage,
  isOwn,
  isGroupEnd,
  isHighlighted,
  canReact,
  accessibilityLabel,
  onQuotePress,
  onDownloadAttachment,
  onOpenMedia,
  styles,
}: Pick<MessageRowProps, 'message' | 'quotedMessage' | 'isOwn' | 'isGroupEnd' | 'isHighlighted' |
  'onQuotePress' | 'onDownloadAttachment' | 'onOpenMedia'> & {
  canReact: boolean;
  accessibilityLabel: string;
  styles: ChatStyles;
}) {
  return (
    <View
      accessible
      accessibilityRole={canReact ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
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
          quotedMessage={quotedMessage ?? null}
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
  );
}

function ReactionPicker({
  isOpen,
  message,
  currentUserId,
  onReact,
  setIsOpen,
  styles,
}: Pick<MessageRowProps, 'message' | 'currentUserId' | 'onReact'> & {
  isOpen: boolean;
  setIsOpen: (value: boolean) => void;
  styles: ChatStyles;
}) {
  if (!isOpen) return null;
  return (
    <View style={styles.reactionBar} testID="chat-message-reaction-bar">
      {QUICK_REACTIONS.map(emoji => (
        <Pressable
          key={emoji}
          onPress={() => {
            setIsOpen(false);
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
  );
}

function MessageFooter({
  message,
  isOwn,
  isGroupEnd,
  isPendingOrFailed,
  isQueued,
  status,
  uploadProgress,
  retryFailedMessage,
  onCancelAttachmentUpload,
  styles,
}: Pick<MessageRowProps, 'message' | 'isOwn' | 'isGroupEnd' | 'isQueued' |
  'onCancelAttachmentUpload'> & {
  isPendingOrFailed: boolean;
  status: MessageStatus;
  uploadProgress: number;
  retryFailedMessage?: () => void;
  styles: ChatStyles;
}) {
  if (!isGroupEnd && !isPendingOrFailed) return null;
  return (
    <View style={styles.messageFooter}>
      <Text style={[styles.timestamp, isOwn && styles.timestampOwn]}>
        {formatMessageTimestamp(message.createdAt)}
      </Text>
      {isOwn ? (
        <DeliveryState
          status={status}
          isQueued={isQueued ?? false}
          uploadState={message.uploadState}
          uploadProgress={uploadProgress}
          styles={styles}
          onRetry={retryFailedMessage}
          onCancelUpload={message.uploadState === 'uploading' ? onCancelAttachmentUpload : undefined}
        />
      ) : null}
    </View>
  );
}

function MessageRowLayout({
  message,
  quotedMessage,
  isGroupEnd,
  isOwn,
  isHighlighted,
  isQueued,
  currentUserId,
  onReact,
  onQuotePress,
  onDownloadAttachment,
  onOpenMedia,
  onCancelAttachmentUpload,
  actions,
  toggleReactionBar,
  isReactionBarOpen,
  setIsReactionBarOpen,
  canReact,
  accessibilityLabel,
  isPendingOrFailed,
  status,
  uploadProgress,
  retryFailedMessage,
  styles,
}: MessageRowProps & {
  actions: Parameters<typeof SwipeableRow>[0]['actions'];
  toggleReactionBar?: () => void;
  isReactionBarOpen: boolean;
  setIsReactionBarOpen: (value: boolean) => void;
  canReact: boolean;
  accessibilityLabel: string;
  isPendingOrFailed: boolean;
  status: MessageStatus;
  uploadProgress: number;
  retryFailedMessage?: () => void;
  styles: ChatStyles;
}) {
  // The bubble remains a plain view: a Pressable would compete with the native
  // swipe recognizer while its long-press timer runs.
  const row = (
    <View
      testID="chat-message-row"
      style={[
        styles.messageRow,
        isOwn ? styles.messageRowOwn : styles.messageRowPeer,
        !isGroupEnd && styles.messageRowGrouped,
      ]}>
      <MessageBubble
        message={message}
        quotedMessage={quotedMessage}
        isOwn={isOwn}
        isGroupEnd={isGroupEnd}
        isHighlighted={isHighlighted}
        canReact={canReact}
        accessibilityLabel={accessibilityLabel}
        onQuotePress={onQuotePress}
        onDownloadAttachment={onDownloadAttachment}
        onOpenMedia={onOpenMedia}
        styles={styles}
      />
      <ReactionPicker
        isOpen={isReactionBarOpen}
        message={message}
        currentUserId={currentUserId}
        onReact={onReact}
        setIsOpen={setIsReactionBarOpen}
        styles={styles}
      />
      <ReactionChips
        reactions={message.reactions ?? undefined}
        currentUserId={currentUserId}
        onToggle={onReact ? (emoji, action) => onReact(message, emoji, action) : undefined}
        styles={styles}
      />
      <MessageFooter
        message={message}
        isOwn={isOwn}
        isGroupEnd={isGroupEnd}
        isPendingOrFailed={isPendingOrFailed}
        isQueued={isQueued}
        status={status}
        uploadProgress={uploadProgress}
        retryFailedMessage={retryFailedMessage}
        onCancelAttachmentUpload={onCancelAttachmentUpload}
        styles={styles}
      />
    </View>
  );
  if (!actions?.length && !toggleReactionBar) return row;
  return (
    <SwipeableRow
      actions={actions ?? []}
      onLongPress={toggleReactionBar}
      longPressLabel="React to message">
      {row}
    </SwipeableRow>
  );
}

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
  onCancelAttachmentUpload,
}: MessageRowProps) {
  const styles = useThemedStyles(createStyles);
  const status = getMessageStatus(message);
  const isPendingOrFailed = isOwn && (status === 'sending' || status === 'failed');
  // Long-press opens the reaction bar for this bubble only; it closes as soon
  // as an emoji is chosen or the bubble is pressed again.
  const [isReactionBarOpen, setIsReactionBarOpen] = useState(false);
  const isTombstone = Boolean(message.deletedAt);
  const uploadProgress = Math.max(0, Math.min(1, message.uploadProgress ?? 0));
  const accessibilityLabel = messageAccessibilityLabel(message, status, uploadProgress);
  const retryFailedMessage = status === 'failed' && onRetry ? () => onRetry(message) : undefined;

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

  return (
    <MessageRowLayout
      message={message}
      quotedMessage={quotedMessage}
      isGroupEnd={isGroupEnd}
      isOwn={isOwn}
      isHighlighted={isHighlighted}
      isQueued={isQueued}
      currentUserId={currentUserId}
      onReact={onReact}
      onQuotePress={onQuotePress}
      onDownloadAttachment={onDownloadAttachment}
      onOpenMedia={onOpenMedia}
      onCancelAttachmentUpload={onCancelAttachmentUpload}
      actions={actions}
      toggleReactionBar={toggleReactionBar}
      isReactionBarOpen={isReactionBarOpen}
      setIsReactionBarOpen={setIsReactionBarOpen}
      canReact={canReact}
      accessibilityLabel={accessibilityLabel}
      isPendingOrFailed={isPendingOrFailed}
      status={status}
      uploadProgress={uploadProgress}
      retryFailedMessage={retryFailedMessage}
      styles={styles}
    />
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

function ConversationHeader({
  peerId,
  peerPresence,
  isPeerTyping,
  onBack,
  onOpenProfile,
  onStartAudioCall,
  onStartVideoCall,
  isStartingCall,
  colors,
  styles,
}: Pick<ChatConversationScreenProps, 'peerId' | 'peerPresence' | 'isPeerTyping' | 'onBack' |
  'onOpenProfile' | 'onStartAudioCall' | 'onStartVideoCall' | 'isStartingCall'> & {
  colors: ThemeColors;
  styles: ChatStyles;
}) {
  const presenceLabel = peerPresence ? (peerPresence.online ? 'Online' : 'Offline') : null;
  const presenceColor = peerPresence?.online ? colors.success : colors.textMuted;
  return (
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
          disabled={isStartingCall}
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
          disabled={isStartingCall}
          loading={isStartingCall}
          accessibilityLabel={`Video call ${peerId}`}
          testID="chat-call-video"
        />
      ) : null}
    </View>
  );
}

function ConversationTimeline({
  listRef,
  listItems,
  handleScroll,
  renderItem,
  handleScrollToIndexFailed,
  handleViewableItemsChanged,
  isLoadingMessages,
  stickyDateLabel,
  showScrollToBottom,
  newMessageCount,
  handleScrollToBottomPress,
  styles,
}: {
  listRef: { current: FlatList | null };
  listItems: ListItem[];
  handleScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  renderItem: ({ item }: { item: ListItem }) => ReactElement | null;
  handleScrollToIndexFailed: (info: { index: number }) => void;
  handleViewableItemsChanged: (info: { viewableItems: Array<{ item?: ListItem }> }) => void;
  isLoadingMessages: boolean;
  stickyDateLabel: string | null;
  showScrollToBottom: boolean;
  newMessageCount: number;
  handleScrollToBottomPress: () => void;
  styles: ChatStyles;
}) {
  return (
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
        // NOTE: removeClippedSubviews is deliberately omitted: Android clips
        // transformed swipe trays and breaks their touch dispatch.
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        updateCellsBatchingPeriod={50}
        windowSize={11}
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
  );
}

function ConversationNotices({
  isOffline,
  showAttachmentsUnavailable,
  replyTarget,
  setReplyTarget,
  styles,
}: Pick<ChatConversationScreenProps, 'isOffline'> & {
  showAttachmentsUnavailable: boolean;
  replyTarget: ChatMessage | null;
  setReplyTarget: (message: ChatMessage | null) => void;
  styles: ChatStyles;
}) {
  return (
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
  );
}

function ConversationComposer({
  peerId,
  draft,
  isComposerFocused,
  setIsComposerFocused,
  handleChangeText,
  handleAttachPress,
  attachmentsAvailable,
  isUploadingAttachment,
  isRecordingVoiceNote,
  isVoiceNoteSupported,
  handleMicPress,
  handleCancelVoiceNote,
  handleSend,
  isSending,
  colors,
  styles,
}: Pick<ChatConversationScreenProps, 'peerId' | 'attachmentsAvailable' | 'isUploadingAttachment' |
  'isRecordingVoiceNote' | 'isVoiceNoteSupported' | 'isSending'> & {
  draft: string;
  isComposerFocused: boolean;
  setIsComposerFocused: (focused: boolean) => void;
  handleChangeText: (text: string) => void;
  handleAttachPress: () => void;
  handleMicPress: () => void;
  handleCancelVoiceNote: () => void;
  handleSend: () => void;
  colors: ThemeColors;
  styles: ChatStyles;
}) {
  const hasDraft = Boolean(draft.trim());
  return (
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
      {!hasDraft ? (
        <IconButton
          icon={isRecordingVoiceNote ? 'attachmentMicStop' : 'attachmentMic'}
          onPress={handleMicPress}
          variant={isRecordingVoiceNote ? 'active' : 'default'}
          disabled={!isVoiceNoteSupported || isUploadingAttachment}
          size={44}
          accessibilityLabel={isRecordingVoiceNote ? 'Stop and send voice note' : 'Record voice note'}
          accessibilityHint={
            isVoiceNoteSupported ? undefined : 'Voice notes are not supported on this build'
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
        variant={hasDraft ? 'active' : 'default'}
        disabled={!hasDraft || isSending}
        size={44}
        accessibilityLabel="Send message"
        accessibilityHint={`Sends the message to ${peerId}`}
        testID="chat-message-send"
      />
    </View>
  );
}

function ConversationOverlays({
  mediaItems,
  viewerIndex,
  setViewerIndex,
  onDownloadAttachment,
  messagesById,
  handleDownloadAttachment,
  isAttachSheetOpen,
  setIsAttachSheetOpen,
  handlePickAttachment,
}: Pick<ChatConversationScreenProps, 'onDownloadAttachment'> & {
  mediaItems: MediaViewerItem[];
  viewerIndex: number | null;
  setViewerIndex: (index: number | null) => void;
  messagesById: Map<string, ChatMessage>;
  handleDownloadAttachment: MessageAction;
  isAttachSheetOpen: boolean;
  setIsAttachSheetOpen: (open: boolean) => void;
  handlePickAttachment: (kind: AttachmentKind) => void;
}) {
  return (
    <>
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
    </>
  );
}

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
  onCancelAttachmentUpload,
  isRecordingVoiceNote = false,
  attachmentsAvailable = true,
  isVoiceNoteSupported = false,
}: ChatConversationScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  // The message the composer is currently replying to, if any.
  const [replyTarget, setReplyTarget] = useState((null as ChatMessage | null));

  // Seeded from the persisted draft so re-opening a conversation restores the
  // half-typed message instead of silently discarding it. The debounce timer
  // and the AppState subscription behind it are wholly owned by that hook.
  const { draft, setDraft, markDraftCleared } = useDraftPersistence({
    initialText: initialDraft?.text ?? '',
    replyToId: replyTarget?.messageId ?? null,
    onSaveDraft,
  });
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
  const autoScrollFrameRef = useRef((null as number | null));
  const isMountedRef = useRef(true);
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

  const scheduleScrollToEnd = useCallback(() => {
    if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      if (!isMountedRef.current) return;
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, []);

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
    return () => {
      if (autoScrollFrameRef.current !== null) {
        cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    };
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
        scheduleScrollToEnd();
        setShowScrollToBottom(false);
        setNewMessageCount(0);
      } else {
        setShowScrollToBottom(true);
        setNewMessageCount(count => count + 1);
      }
    }
  }, [messages, currentUserId, scheduleScrollToEnd]);

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
      scheduleScrollToEnd();
    });
    return () => subscription.remove();
  }, [scheduleScrollToEnd]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      clearTimeout(typingIdleTimerRef.current);
      if (autoScrollFrameRef.current !== null) cancelAnimationFrame(autoScrollFrameRef.current);
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
    [reportTyping, setDraft],
  );

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSendMessage?.(trimmed, { replyTo: replyTarget?.messageId ?? null });
    setDraft('');
    setReplyTarget(null);
    markDraftCleared();
    onClearDraft?.();
    reportTyping(false);
  }, [draft, markDraftCleared, onClearDraft, onSendMessage, replyTarget, reportTyping, setDraft]);

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
          onCancelAttachmentUpload={onCancelAttachmentUpload}
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
      onCancelAttachmentUpload,
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
    scheduleScrollToEnd();
    setShowScrollToBottom(false);
    setNewMessageCount(0);
  }, [scheduleScrollToEnd]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={keyboardVerticalOffset}>
      <View style={styles.root} testID="chat-conversation-root">
        <ConversationHeader
          peerId={peerId}
          peerPresence={peerPresence}
          isPeerTyping={isPeerTyping}
          onBack={onBack}
          onOpenProfile={onOpenProfile}
          onStartAudioCall={onStartAudioCall}
          onStartVideoCall={onStartVideoCall}
          isStartingCall={isStartingCall}
          colors={colors}
          styles={styles}
        />
        <ConversationTimeline
          listRef={listRef}
          listItems={listItems}
          handleScroll={handleScroll}
          renderItem={renderItem}
          handleScrollToIndexFailed={handleScrollToIndexFailed}
          handleViewableItemsChanged={handleViewableItemsChanged}
          isLoadingMessages={isLoadingMessages}
          stickyDateLabel={stickyDateLabel}
          showScrollToBottom={showScrollToBottom}
          newMessageCount={newMessageCount}
          handleScrollToBottomPress={handleScrollToBottomPress}
          styles={styles}
        />
        <ConversationNotices
          isOffline={isOffline}
          showAttachmentsUnavailable={showAttachmentsUnavailable}
          replyTarget={replyTarget}
          setReplyTarget={setReplyTarget}
          styles={styles}
        />
        <ConversationComposer
          peerId={peerId}
          draft={draft}
          isComposerFocused={isComposerFocused}
          setIsComposerFocused={setIsComposerFocused}
          handleChangeText={handleChangeText}
          handleAttachPress={handleAttachPress}
          attachmentsAvailable={attachmentsAvailable}
          isUploadingAttachment={isUploadingAttachment}
          isRecordingVoiceNote={isRecordingVoiceNote}
          isVoiceNoteSupported={isVoiceNoteSupported}
          handleMicPress={handleMicPress}
          handleCancelVoiceNote={handleCancelVoiceNote}
          handleSend={handleSend}
          isSending={isSending}
          colors={colors}
          styles={styles}
        />
      </View>
      <ConversationOverlays
        mediaItems={mediaItems}
        viewerIndex={viewerIndex}
        setViewerIndex={setViewerIndex}
        onDownloadAttachment={onDownloadAttachment}
        messagesById={messagesById}
        handleDownloadAttachment={handleDownloadAttachment}
        isAttachSheetOpen={isAttachSheetOpen}
        setIsAttachSheetOpen={setIsAttachSheetOpen}
        handlePickAttachment={handlePickAttachment}
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
    uploadFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
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
