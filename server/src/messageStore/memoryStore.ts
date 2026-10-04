/**
 * In-process, array-backed message store.
 *
 * Used when no database handle is configured and by the test suite.  History does not
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
import {
  bodyMatches,
  clampExportReadLimit,
  clampLimit,
  MAX_CONVERSATION_LIMIT,
  normaliseSearchTerm,
} from './queries.ts';
import type { MessageChange, MessageStore, StoredMessage } from './types.ts';
import { nextMessageChangeId } from './changeCursor.ts';

export function createMemoryMessageStore(): MessageStore {
  const messages: StoredMessage[] = [];
  const changes: MessageChange[] = [];
  const cloneMessage = (message: StoredMessage) => ({
    ...message,
    attachment: message.attachment ? { ...message.attachment } : null,
    reactions: Object.fromEntries(
      Object.entries(message.reactions).map(([emoji, userIds]) => [emoji, [...userIds]])
    ),
    deliveredTo: [...message.deliveredTo],
  });
  const recordChange = (message: StoredMessage, type: MessageChange['type'], changedAt: string) => {
    changes.push({
      changeId: nextMessageChangeId(),
      type,
      changedAt,
      message: cloneMessage(message),
    });
  };
  const saveMessageWithStatus: MessageStore['saveMessageWithStatus'] = async (message) => {
    const record = createMessageRecord(message);
    // Mirror sender/key uniqueness and the legacy primary-key retry path.
    const existing = messages.find(
      (candidate) =>
        (record.clientMessageId && candidate.senderId === record.senderId &&
          candidate.clientMessageId === record.clientMessageId) ||
        (candidate.conversationId === record.conversationId &&
          candidate.messageId === record.messageId)
    );
    if (existing) return { message: { ...existing }, inserted: false };
    messages.push(record);
    recordChange(record, 'new', record.createdAt);
    return { message: { ...record }, inserted: true };
  };

  return {
    type: 'memory',

    async ready() {},

    async saveMessage(message) {
      return (await saveMessageWithStatus(message)).message;
    },

    saveMessageWithStatus,

    async listMessages({ conversationId, limit, before, beforeMessageId, withLookahead } = {}) {
      const cap = withLookahead ? clampExportReadLimit(limit) : clampLimit(limit);
      return messages
        .filter((message) => message.conversationId === conversationId)
        .filter((message) =>
          before
            ? message.createdAt < before ||
              (message.createdAt === before &&
                beforeMessageId !== undefined &&
                message.messageId < beforeMessageId)
            : true
        )
        .sort(byNewestFirst)
        .slice(0, cap)
        .map((message) => ({ ...message }));
    },

    async getMessage(conversationId, messageId) {
      const message = messages.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.messageId === messageId
      );
      return message ? { ...message } : null;
    },

    async searchMessages({
      userId,
      query,
      conversationId,
      excludedUserIds = [],
      createdAtAfter,
      limit,
      before,
      beforeMessageId,
      withLookahead,
    } = {}) {
      const term = normaliseSearchTerm(query);
      if (!term || !userId) return [];
      const cap = withLookahead ? clampExportReadLimit(limit) : clampLimit(limit);
      return messages
        .filter((message) => message.senderId === userId || message.recipientId === userId)
        .filter((message) => !conversationId || message.conversationId === conversationId)
        .filter((message) => !message.deletedAt)
        .filter((message) => !createdAtAfter || message.createdAt >= createdAtAfter)
        .filter((message) => !excludedUserIds.includes(message.senderId === userId ? message.recipientId : message.senderId))
        .filter((message) =>
          before
            ? message.createdAt < before ||
              (message.createdAt === before &&
                beforeMessageId !== undefined &&
                message.messageId < beforeMessageId)
            : true
        )
        .filter((message) => bodyMatches(message, term))
        .sort(byNewestFirst)
        .slice(0, cap)
        .map((message) => ({ ...message }));
    },

    async listMessageChanges({
      userId,
      since,
      afterChangedAt,
      afterChangeId,
      excludedUserIds = [],
      createdAtAfter,
      limit,
    }) {
      return changes
        .filter((change) => change.message.senderId === userId || change.message.recipientId === userId)
        .filter((change) => !excludedUserIds.includes(
          change.message.senderId === userId ? change.message.recipientId : change.message.senderId
        ))
        .filter((change) => !createdAtAfter || change.message.createdAt >= createdAtAfter)
        .filter((change) => change.changedAt > since)
        .filter((change) =>
          !afterChangedAt || !afterChangeId ||
          change.changedAt > afterChangedAt ||
          (change.changedAt === afterChangedAt && BigInt(change.changeId) > BigInt(afterChangeId))
        )
        .sort((a, b) =>
          a.changedAt === b.changedAt
            ? a.changeId.localeCompare(b.changeId, undefined, { numeric: true })
            : a.changedAt.localeCompare(b.changedAt)
        )
        .slice(0, clampExportReadLimit(limit))
        .map((change) => ({ ...change, message: cloneMessage(change.message) }));
    },

    async listConversationChanges({
      conversationId,
      afterChangedAt,
      afterChangeId,
      createdAtAfter,
      limit,
    }) {
      const live = new Map(
        messages
          .filter((message) => message.conversationId === conversationId)
          .map((message) => [message.messageId, message])
      );
      return changes
        .filter((change) => change.message.conversationId === conversationId)
        .filter((change) =>
          !afterChangedAt || !afterChangeId ||
          change.changedAt > afterChangedAt ||
          (change.changedAt === afterChangedAt && BigInt(change.changeId) > BigInt(afterChangeId))
        )
        .sort((a, b) =>
          a.changedAt === b.changedAt
            ? a.changeId.localeCompare(b.changeId, undefined, { numeric: true })
            : a.changedAt.localeCompare(b.changedAt)
        )
        .flatMap((change) => {
          const current = live.get(change.message.messageId);
          if (!current || (createdAtAfter && current.createdAt < createdAtAfter)) return [];
          return [{ ...change, message: cloneMessage(current) }];
        })
        .slice(0, clampExportReadLimit(limit));
    },

    async listUserMessages({ userId, limit, before, beforeMessageId } = {}) {
      if (!userId) return [];
      return messages
        .filter((message) => message.senderId === userId || message.recipientId === userId)
        .filter((message) =>
          before
            ? message.createdAt < before ||
              (message.createdAt === before &&
                beforeMessageId !== undefined &&
                message.messageId < beforeMessageId)
            : true
        )
        .sort(byNewestFirst)
        .slice(0, clampExportReadLimit(limit))
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

    enqueueDeliveryReceipt({ messageId, userId }) {
      const message = messages.find((candidate) => candidate.messageId === messageId);
      if (message && !message.deliveredTo.includes(userId)) {
        message.deliveredTo.push(userId);
      }
    },

    async flushDeliveryReceipts() {},

    async listConversations(userId) {
      // `MAX_CONVERSATION_LIMIT` is applied here *and* in the Postgres store's
      // query deliberately: the two backends must return the same conversations
      // for the same history, so a caller cannot tell them apart by result
      // count. Keep the two caps in sync if either ever changes.
      //
      // `summariseConversations` already orders newest-first on the same
      // `(createdAt DESC, messageId DESC)` key the Postgres store sorts by, so
      // truncating here retains exactly the conversations Postgres would keep.
      //
      // The summaries reference the live records, so each is copied on the way
      // out — a caller must not be able to mutate the store through them.
      return summariseConversations(messages, userId)
        .slice(0, MAX_CONVERSATION_LIMIT)
        .map((summary) => ({
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
          // A read implies delivery even when no delivery receipt preceded
          // it, so backfill `deliveredTo` here to match the Postgres store.
          if (!message.deliveredTo.includes(userId)) {
            message.deliveredTo.push(userId);
          }
          updated += 1;
          recordChange(message, 'read', now);
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
      const deletedAt = nextTimestamp();
      const deleted = applyTombstone(message, deletedAt);
      recordChange(deleted, 'deleted', deletedAt);
      return cloneMessage(deleted);
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action } = {}) {
      const message = messages.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.messageId === messageId &&
          !candidate.deletedAt
      );
      if (!message) return null;
      const reactions = applyReaction(
        message.reactions,
        (emoji as string),
        (userId as string),
        (action as 'add'|'remove')
      );
      if (JSON.stringify(reactions) !== JSON.stringify(message.reactions)) {
        message.reactions = reactions;
        recordChange(message, 'reactions', nextTimestamp());
      }
      return cloneMessage(message);
    },

    async close() {
      messages.length = 0;
    },
  };
}
