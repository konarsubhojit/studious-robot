/**
 * In-process, array-backed message store.
 *
 * Used when Mongo is not configured and by the test suite.  History does not
 * survive a restart, which matches the pre-existing behaviour of the rest of
 * the in-memory state.
 */

import { summariseConversations } from './conversations.ts';
import {
  applyReaction,
  applyTombstone,
  byNewestFirst,
  createMessageRecord,
  nextTimestamp,
} from './records.ts';
import { bodyMatches, clampLimit, normaliseSearchTerm } from './queries.ts';
import type { MessageStore, StoredMessage } from './types.ts';

export function createMemoryMessageStore(): MessageStore {
  const messages: StoredMessage[] = [];

  return {
    type: 'memory',

    async ready() {},

    async saveMessage(message) {
      const record = createMessageRecord(message);
      // Idempotent on the client-supplied `{ conversationId, messageId }` pair,
      // mirroring the Mongo store's upsert: a client replaying a send from its
      // durable outbox must not create a second copy of the same message.
      const existing = messages.find(
        (candidate) =>
          candidate.conversationId === record.conversationId &&
          candidate.messageId === record.messageId
      );
      if (existing) return { ...existing };
      messages.push(record);
      return { ...record };
    },

    async listMessages({ conversationId, limit, before } = {}) {
      const cap = clampLimit(limit);
      return messages
        .filter((message) => message.conversationId === conversationId)
        .filter((message) => (before ? message.createdAt < before : true))
        .sort(byNewestFirst)
        .slice(0, cap)
        .map((message) => ({ ...message }));
    },

    async searchMessages({ userId, query, limit, before } = {}) {
      const term = normaliseSearchTerm(query);
      if (!term || !userId) return [];
      const cap = clampLimit(limit);
      return messages
        .filter((message) => message.senderId === userId || message.recipientId === userId)
        .filter((message) => (before ? message.createdAt < before : true))
        .filter((message) => bodyMatches(message, term))
        .sort(byNewestFirst)
        .slice(0, cap)
        .map((message) => ({ ...message }));
    },

    async markDelivered(messageId, userId) {
      const message = messages.find((candidate) => candidate.messageId === messageId);
      if (!message) return null;
      // Idempotent: re-delivering to the same user must not duplicate the entry.
      if (!message.deliveredTo.includes(userId)) {
        message.deliveredTo.push(userId);
      }
      return { ...message };
    },

    async listConversations(userId) {
      // The summaries reference the live records, so each is copied on the way
      // out — a caller must not be able to mutate the store through them.
      return summariseConversations(messages, userId).map((summary) => ({
        ...summary,
        lastMessage: { ...summary.lastMessage },
      }));
    },

    async markRead(conversationId, userId) {
      const now = nextTimestamp();
      let updated = 0;
      for (const message of messages) {
        if (
          message.conversationId === conversationId &&
          message.recipientId === userId &&
          !message.readAt
        ) {
          message.readAt = now;
          updated += 1;
        }
      }
      return updated;
    },

    async deleteMessage(conversationId, messageId, userId) {
      const message = messages.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.messageId === messageId &&
          // Only the author may delete: a participant cannot remove what the
          // other person said.
          candidate.senderId === userId &&
          // Idempotent: a repeated delete finds an already-tombstoned row and
          // reports "not found" rather than re-notifying both participants.
          !candidate.deletedAt
      );
      if (!message) return null;
      return { ...applyTombstone(message, nextTimestamp()) };
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action } = {}) {
      const message = messages.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.messageId === messageId &&
          !candidate.deletedAt
      );
      if (!message) return null;
      message.reactions = applyReaction(
        message.reactions,
        (emoji as string),
        (userId as string),
        (action as 'add'|'remove')
      );
      return { ...message };
    },

    async close() {
      messages.length = 0;
    },
  };
}
