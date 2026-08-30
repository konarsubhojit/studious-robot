/**
 * One rendered message row: the bubble, its quoted reply, its reactions, its
 * delivery state and the long-press reaction bar around it.
 *
 * Split out of `ChatConversationPresentation` as a pure relocation: nothing
 * here owns a timer, a subscription or a listener, and `MessageRow`'s only
 * state is whether its reaction bar is open. It renders inside `SwipeableRow`,
 * whose gesture wrapping is deliberately untouched — see the note in
 * `SwipeableRow` about not putting a `Pressable` around swipeable content.
 *
 * Only *types* are imported back from `ChatConversationPresentation`, so the
 * import is erased at build time and no runtime cycle exists between the two
 * modules.
 */

import { memo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { describeMessagePreview } from '../../../../shared';
import { touchSlop } from '../../theme';
import AudioAttachmentPlayer from '../AudioAttachmentPlayer';
import SwipeableRow from '../SwipeableRow';

import {
  getMessageStatus,
  messageAccessibilityLabel,
  messageContentKind,
} from './chatTimelineModel';

import type { ReactNode } from 'react';
import type { ChatMessage } from '../../hooks/useMessaging';
import type { MessageContentKind, MessageStatus } from './chatTimelineModel';
// Types only: erased at build time, so no runtime cycle with the module that
// renders these rows.
import createStyles from './chatStyles';
import { useThemedStyles } from '../../ThemeContext';
import { Chip } from '../primitives';
import { formatMessageTimestamp } from './chatTimelineModel';

import type { ChatStyles } from './chatStyles';
import type { MessageAction, ReactionAction } from './ChatConversationPresentation';

/** Emoji offered by the long-press reaction bar. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
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


export default MessageRow;
