/**
 * The pure model behind the conversation timeline.
 *
 * Everything here is a plain function of its arguments: no React state, no
 * effects, no refs, no styles. That is the whole point of the split — the
 * grouping rules (date separators, same-sender runs, collapsed call runs, the
 * unread anchor) are the part most likely to be wrong and the part that was
 * previously only reachable by rendering a 2,500-line screen.
 *
 * Rendering lives in `ChatConversationPresentation.tsx`, which re-exports the
 * types below so existing consumer imports keep working.
 */

import {
  MESSAGE_TYPES,
  describeMessagePreview,
  isSupportedMessageType,
  messageTypeOf,
} from '../../../../shared';
import { isAudioMimeType, isVideoMimeType } from '../../videoPlayback';

import type { CallActivity, ChatMessage } from '../../hooks/useMessaging';

/** A conversation timeline holds messages and (merged) call records alike. */
export type TimelineEntry = ChatMessage | CallActivity;

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

/** Where one of the current user's own messages has got to. */
export type MessageStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

export type MessageContentKind =
  | 'deleted'
  | 'unsupported'
  | 'image'
  | 'video'
  | 'audio'
  | 'attachment'
  | 'text';

/** Consecutive own-sender messages within this many minutes are grouped
 * (only the last bubble in the group shows a timestamp/tick). */
const GROUP_GAP_MS = 5 * 60 * 1000;
/** Consecutive calls with the same peer, direction and outcome within this
 * window collapse into a single expandable row, so a redial storm can't bury
 * the conversation around it. */
const CALL_GROUP_GAP_MS = 60 * 60 * 1000;

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
export function getMessageStatus(message: {
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

export function messageAccessibilityLabel(message: ChatMessage, status: MessageStatus, progress = 0): string {
  const preview = describeMessagePreview(message) || 'Message';
  if (message.uploadState === 'uploading') {
    return `${preview}. Uploading attachment ${Math.round(progress * 100)} percent`;
  }
  if (status === 'failed') return `${preview}. Failed to send. Tap to retry`;
  if (status === 'sending') return `${preview}. Sending`;
  return preview;
}

/**
 * True when a timeline entry is a call record rather than a text message.
 *
 * The server only tags entries with a `type` when the client opts into the
 * merged timeline (`include=calls`), and optimistic local sends carry no type
 * at all, so anything untagged is a message.
 */
export function isCallEntry(entry: TimelineEntry): entry is CallActivity {
  return entry?.type === 'call';
}

/**
 * Stable list key for either kind of timeline entry.
 */
export function entryKey(entry: TimelineEntry): string {
  return isCallEntry(entry) ? entry.callId : entry.messageId;
}

export function formatMessageTimestamp(isoString: string | null | undefined): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today" / "Yesterday" / a locale date string, for the date separator.
 */
export function formatDateSeparator(date: Date): string {
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
export function isSameCallRun(previous: CallActivity, entry: CallActivity): boolean {
  if (previous.direction !== entry.direction || previous.status !== entry.status) return false;
  const previousAt = new Date(previous.createdAt).getTime();
  const entryAt = new Date(entry.createdAt).getTime();
  if (Number.isNaN(previousAt) || Number.isNaN(entryAt)) return false;
  return entryAt - previousAt <= CALL_GROUP_GAP_MS;
}

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
function appendDateSeparator(
  items: ListItem[],
  entry: TimelineEntry,
  previous: TimelineEntry | undefined,
): string | null {
  const createdAt = new Date(entry.createdAt ?? '');
  if (
    Number.isNaN(createdAt.getTime()) ||
    (previous && isSameCalendarDay(createdAt, new Date(previous.createdAt ?? '')))
  ) {
    return null;
  }
  const label = formatDateSeparator(createdAt);
  items.push({ key: `date-${entryKey(entry)}`, type: 'date', label });
  return label;
}

function callListItemAt(
  orderedEntries: TimelineEntry[],
  index: number,
  dateLabel: string | null,
): { item: Extract<ListItem, { type: 'call' }>; finalIndex: number } {
  const entry = orderedEntries[index] as CallActivity;
  const createdAt = new Date(entry.createdAt);
  const entries = [entry];
  let finalIndex = index;
  while (finalIndex + 1 < orderedEntries.length) {
    const candidate = orderedEntries[finalIndex + 1];
    if (!isCallEntry(candidate) || !isSameCallRun(entries[entries.length - 1], candidate)) break;
    if (!isSameCalendarDay(new Date(candidate.createdAt), createdAt)) break;
    entries.push(candidate);
    finalIndex += 1;
  }
  return {
    item: { key: entryKey(entry), type: 'call', entries, dateLabel },
    finalIndex,
  };
}

function isMessageGroupEnd(entry: ChatMessage, next: TimelineEntry | undefined): boolean {
  if (!next || isCallEntry(next) || next.senderId !== entry.senderId) return true;
  const createdAt = new Date(entry.createdAt ?? '');
  const nextCreatedAt = new Date(next.createdAt ?? '');
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(nextCreatedAt.getTime())) return false;
  return !(
    isSameCalendarDay(createdAt, nextCreatedAt) &&
    nextCreatedAt.getTime() - createdAt.getTime() <= GROUP_GAP_MS
  );
}

/**
 * Turn a flat, oldest-first timeline array into a render list that interleaves
 * date separators and flags the last message of each same-sender/time-window
 * group. Call entries collapse by direction and outcome, and each item carries
 * the date label for the pinned date pill.
 *
 * @param orderedEntries oldest-first
 * @param unread where to place the "N new messages" divider, if anywhere
 */
export function buildListItems(
  orderedEntries: TimelineEntry[],
  unread: { anchorId: string | null; count: number } = { anchorId: null, count: 0 },
): ListItem[] {
  const items = ([] as ListItem[]);
  let currentDateLabel = (null as string | null);
  for (let index = 0; index < orderedEntries.length; index++) {
    const entry = orderedEntries[index];
    const previous = orderedEntries[index - 1];
    currentDateLabel = appendDateSeparator(items, entry, previous) ?? currentDateLabel;

    // The divider sits *below* the day separator when the first unread
    // message opens a new day, so the reader still sees which day they are
    // resuming into.
    if (unread.anchorId && unread.count > 0 && entryKey(entry) === unread.anchorId) {
      items.push({ key: 'unread-divider', type: 'unread', count: unread.count });
    }

    if (isCallEntry(entry)) {
      // Collapse the run of same-direction/same-outcome calls starting here.
      const callItem = callListItemAt(orderedEntries, index, currentDateLabel);
      items.push(callItem.item);
      index = callItem.finalIndex;
      continue;
    }

    const next = orderedEntries[index + 1];
    items.push({
      key: entryKey(entry),
      type: 'message',
      message: entry,
      isGroupEnd: isMessageGroupEnd(entry, next),
      dateLabel: currentDateLabel,
    });
  }
  return items;
}

export function messageContentKind(message: ChatMessage): MessageContentKind {
  const type = messageTypeOf(message);
  const attachmentUrl = message.attachment?.url;
  if (message.deletedAt) return 'deleted';
  if (!isSupportedMessageType(type)) return 'unsupported';
  if (type === MESSAGE_TYPES.IMAGE && attachmentUrl) return 'image';
  if (type === MESSAGE_TYPES.FILE && isVideoMimeType(message.attachment?.mimeType) && attachmentUrl) {
    return 'video';
  }
  if (type === MESSAGE_TYPES.VOICE || isAudioMimeType(message.attachment?.mimeType)) return 'audio';
  if (type === MESSAGE_TYPES.FILE) return 'attachment';
  return 'text';
}
