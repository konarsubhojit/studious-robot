/**
 * Conversation grouping: turning a user's messages into one summary per
 * conversation.
 *
 * Both backends group in application code — the Mongo store because Cosmos DB
 * for MongoDB (RU) rejects a cross-partition `$group`/`$sort`, the memory store
 * because it has no query engine at all — so the rule that decides the peer,
 * the last message and the unread count lives here once, and neither backend
 * can drift from the other.
 */

import { byNewestFirst, peerIdOf } from './records.ts';
import type { ConversationSummary, StoredMessage } from './types.ts';

/**
 * Group `messages` (already restricted to a candidate set) into per-conversation
 * summaries for `userId`, newest conversation first.
 *
 * Messages the user is not party to are ignored, so the same function serves a
 * caller that pre-filtered by participant and one that did not.
 *
 * The returned `lastMessage` is the caller's own object, not a copy: the memory
 * store owns live records and copies them on the way out, while the Mongo store
 * hands over documents it has already detached from the driver.
 */
export function summariseConversations(
  messages: Iterable<StoredMessage>,
  userId: string
): ConversationSummary[] {
  const byConversation: Map<string, ConversationSummary> = new Map();

  for (const message of messages) {
    if (message.senderId !== userId && message.recipientId !== userId) continue;

    let summary = byConversation.get(message.conversationId);
    if (!summary) {
      summary = {
        conversationId: message.conversationId,
        peerId: peerIdOf(message, userId),
        lastMessage: message,
        unreadCount: 0,
      };
      byConversation.set(message.conversationId, summary);
    } else if (byNewestFirst(message, summary.lastMessage) < 0) {
      summary.lastMessage = message;
    }

    if (message.recipientId === userId && !message.readAt) {
      summary.unreadCount += 1;
    }
  }

  return [...byConversation.values()].sort((a, b) =>
    byNewestFirst(a.lastMessage, b.lastMessage)
  );
}
