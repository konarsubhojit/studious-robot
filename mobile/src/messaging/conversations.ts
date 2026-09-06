import type { ChatMessage, ConversationSummary } from './types';

/**
 * The conversation list and its unread accounting.
 *
 * Unread is a *count* on the conversation row, not something derived from the
 * messages held for it: the chat list shows conversations whose history has
 * never been loaded, and the unread divider inside a conversation counts back
 * from this number rather than from read receipts (see `B3` in
 * `OPTIMIZATION_PLAN.md`).
 */

/** Sum of unreadCount across every conversation; drives the tab badge. */
export function totalUnread(conversations: ConversationSummary[]): number {
  return conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}

/** The conversation id known for a peer, or null when the conversation has
 * not been created server-side yet. */
export function conversationIdForPeer(
  conversations: ConversationSummary[],
  peerId: string,
): string | null {
  return conversations.find(c => c.peerId === peerId)?.conversationId ?? null;
}

/**
 * Fold a message into the conversation list: it becomes the row's newest
 * activity, and the row moves to the top.
 *
 * @param peerId - the other participant, which is how the list is keyed
 *   regardless of who sent the message.
 * @param incrementUnread - whether this also bumps the unread badge. Only ever
 *   true for a message *received* while its conversation is not open.
 * @returns the new list with the changed conversation first.
 */
function withMessage(
  conversations: ConversationSummary[],
  message: ChatMessage,
  peerId: string,
  incrementUnread: boolean,
): ConversationSummary[] {
  const index = conversations.findIndex(c => c.peerId === peerId);
  const existing = index === -1 ? null : conversations[index];
  const updated = {
    ...(existing ?? {
      conversationId: message.conversationId ?? undefined,
      peerId,
      unreadCount: 0,
    }),
    lastMessage: message,
    lastActivity: { ...message, type: 'text' },
    unreadCount: (existing?.unreadCount || 0) + (incrementUnread ? 1 : 0),
  };
  return [updated, ...conversations.filter((_, conversationIndex) => conversationIndex !== index)];
}

/**
 * Fold an inbound message into the conversation list: it becomes the row's
 * newest activity and bumps its unread count.
 *
 * @returns the new list with the changed conversation first.
 */
export function withIncomingMessage(
  conversations: ConversationSummary[],
  message: ChatMessage,
  { incrementUnread = true }: { incrementUnread?: boolean; } = {},
): ConversationSummary[] {
  return withMessage(conversations, message, message.senderId, incrementUnread);
}

/**
 * Fold a message this user just sent into the conversation list.
 *
 * Without this the list preview lagged the conversation it summarises: the
 * open conversation showed the message optimistically while the chat list kept
 * quoting whatever came before it, until a `GET /conversations` refetch
 * happened to correct it.  Keyed on the recipient, since the list is keyed by
 * the *other* participant, and never touches the unread count — a message the
 * user typed is by definition read.
 *
 * @returns the new list with the changed conversation first.
 */
export function withOutgoingMessage(
  conversations: ConversationSummary[],
  message: ChatMessage,
): ConversationSummary[] {
  if (!message?.recipientId) return conversations;
  return withMessage(conversations, message, message.recipientId, false);
}

/** Zero a conversation's unread badge locally, without waiting for a refetch. */
export function withConversationRead(
  conversations: ConversationSummary[],
  peerId: string,
): ConversationSummary[] {
  return conversations.map(c => (c.peerId === peerId ? { ...c, unreadCount: 0 } : c));
}
