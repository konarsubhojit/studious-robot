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
 * Fold an inbound message into the conversation list: it becomes the row's
 * newest activity and bumps its unread count.
 *
 * @returns the new list, or `null` when the sender has no row yet — the caller
 *   has to refetch the authoritative list rather than invent one.
 */
export function withIncomingMessage(
  conversations: ConversationSummary[],
  message: ChatMessage,
): ConversationSummary[] | null {
  const index = conversations.findIndex(c => c.peerId === message.senderId);
  if (index === -1) return null;
  const next = [...conversations];
  next[index] = {
    ...next[index],
    lastMessage: message,
    lastActivity: { ...message, type: 'text' },
    unreadCount: (next[index].unreadCount || 0) + 1,
  };
  return next;
}

/** Zero a conversation's unread badge locally, without waiting for a refetch. */
export function withConversationRead(
  conversations: ConversationSummary[],
  peerId: string,
): ConversationSummary[] {
  return conversations.map(c => (c.peerId === peerId ? { ...c, unreadCount: 0 } : c));
}
