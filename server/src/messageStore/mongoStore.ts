/**
 * MongoDB-backed message store.
 *
 * Targets Azure Cosmos DB for MongoDB but works against any MongoDB-compatible
 * endpoint.  Connection, index creation and shutdown live in
 * `mongoConnection.ts`; filter construction in `queries.ts`; `_id` stripping in
 * `documents.ts` — what remains here is the sequence of operations each store
 * method performs, and the Cosmos-specific reasons behind them.
 */

import { summariseConversations } from './conversations.ts';
import { toStoredMessage, toStoredMessages } from './documents.ts';
import { instrumentMongoStore } from './instrumentation.ts';
import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME,
  DEFAULT_DB_NAME,
  createMongoConnector,
} from './mongoConnection.ts';
import {
  LIST_MESSAGES_SORT,
  LIST_CONVERSATION_INDEX_SORT,
  MAX_CONVERSATION_LIMIT,
  CONVERSATION_READ_CONCURRENCY,
  buildListMessagesFilter,
  buildParticipantFilter,
  buildSearchMessagesFilter,
  buildUnreadFilter,
  clampLimit,
  normaliseSearchTerm,
} from './queries.ts';
import {
  applyReaction,
  applyTombstone,
  byNewestFirst,
  createMessageRecord,
  nextTimestamp,
} from './records.ts';
import type {
  ConversationSummary,
  MessageStore,
  MessageDocument,
  MongoClientLike,
} from './types.ts';

/**
 * Read the updated document out of a `findOneAndUpdate` result, which the
 * driver returns either directly or wrapped in `{ value }`.
 */
function unwrapUpdatedDocument(result: unknown): MessageDocument | null {
  if (!result) return null;
  const wrapped = (result as { value?: MessageDocument | null; }).value;
  return (wrapped ?? (result as MessageDocument)) || null;
}

/**
 * Create a MongoDB-backed message store.
 *
 * The connection is established lazily on first use so constructing the store
 * never blocks server start-up, and a failure to create indexes is logged
 * rather than fatal (Cosmos DB throttles index builds under load).
 */
export function createMongoMessageStore({
  uri,
  dbName,
  collectionName,
  conversationIndexCollectionName,
  conversationIndexReady,
  client,
}: {
  uri?: string;
  dbName?: string;
  collectionName?: string;
  conversationIndexCollectionName?: string;
  conversationIndexReady?: boolean;
  client?: MongoClientLike;
} = {}): MessageStore {
  if (!uri && !client) {
    throw new Error('createMongoMessageStore: "uri" is required');
  }

  const database = dbName || DEFAULT_DB_NAME;
  const collection = collectionName || DEFAULT_COLLECTION_NAME;
  const conversationIndexCollection =
    conversationIndexCollectionName || DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME;
  const useConversationIndex = conversationIndexReady ?? false;

  const connector = createMongoConnector({
    uri,
    database,
    collection,
    conversationIndexCollection,
    enableConversationIndex: useConversationIndex,
    client,
  });
  const connect = connector.connect;

  const store: MessageStore = {
    type: 'mongo',

    ready: connect,

    async saveMessage(message) {
      const record = createMessageRecord(message);
      const { messages, conversationIndex } = await connect();
      // `messageId` is client-supplied (mobile-generated UUIDs), so a client
      // retry/replay of the same send must not create a duplicate message —
      // upsert on the shard-key-prefixed `{ conversationId, messageId }` pair
      // (see the indexes) so this stays correct even on a backend where the
      // unique index itself could not be created (e.g. Cosmos RU under a
      // shard-key mismatch it otherwise rejects).
      const result = await messages.updateOne(
        { conversationId: record.conversationId, messageId: record.messageId },
        { $setOnInsert: { ...record } },
        { upsert: true }
      );
      // The write was a replay of an already-stored message: return the stored
      // document rather than this copy of it, so the caller (and the sender)
      // sees what is actually persisted.
      let saved = record;
      if (!result?.upsertedCount) {
        const existing = await messages.findOne({
          conversationId: record.conversationId,
          messageId: record.messageId,
        });
        if (existing?.messageId) {
          saved = toStoredMessage(existing);
        }
      }
      if (conversationIndex) {
        await Promise.all(
          [saved.senderId, saved.recipientId].map((userId) =>
            conversationIndex.updateOne(
              { userId, conversationId: saved.conversationId },
              {
                $setOnInsert: { userId, conversationId: saved.conversationId },
                $max: { updatedAt: saved.createdAt },
              },
              { upsert: true }
            )
          )
        );
      }
      return saved;
    },

    async listMessages({ conversationId, limit, before } = {}) {
      const cap = clampLimit(limit);
      const { messages } = await connect();
      const found = await messages
        .find(buildListMessagesFilter(conversationId, before))
        .sort(LIST_MESSAGES_SORT)
        .limit(cap)
        .toArray();
      return toStoredMessages(found);
    },

    async searchMessages({ userId, query, limit, before } = {}) {
      const term = normaliseSearchTerm(query);
      if (!term || !userId) return [];
      const cap = clampLimit(limit);
      const { messages } = await connect();
      // Deliberately no `.sort()`: the query fans out across every
      // conversation the user takes part in (i.e. across shard-key
      // partitions), which Cosmos DB for MongoDB (RU) rejects unless a
      // matching composite index serves it — impossible for a cross-partition
      // sort. Sorting happens in application code, exactly as
      // `listConversations` does, and the page is cut afterwards.
      const found = await messages.find(buildSearchMessagesFilter(userId, term, before)).toArray();
      return toStoredMessages(found).sort(byNewestFirst).slice(0, cap);
    },

    async markDelivered(messageId, userId) {
      const { messages } = await connect();
      // `$addToSet` gives idempotency for free.
      const result = await messages.findOneAndUpdate(
        { messageId },
        { $addToSet: { deliveredTo: userId } },
        { returnDocument: 'after' }
      );
      const updated = unwrapUpdatedDocument(result);
      if (!updated?.messageId) return null;
      return toStoredMessage(updated);
    },

    async listConversations(userId) {
      const { messages, conversationIndex } = await connect();
      if (conversationIndex) {
        const indexed = await conversationIndex
          .find(
            { userId },
            { projection: { _id: 0, conversationId: 1 } }
          )
          .sort(LIST_CONVERSATION_INDEX_SORT)
          .limit(MAX_CONVERSATION_LIMIT)
          .toArray();
        const candidates: Array<ConversationSummary | null> = [];
        for (let offset = 0; offset < indexed.length; offset += CONVERSATION_READ_CONCURRENCY) {
          const batch = indexed.slice(offset, offset + CONVERSATION_READ_CONCURRENCY);
          candidates.push(
            ...(await Promise.all(
              batch.map(async ({ conversationId }) => {
                const [latest, unread] = await Promise.all([
                  messages
                    .find({ conversationId })
                    .sort(LIST_MESSAGES_SORT)
                    .limit(1)
                    .toArray(),
                  messages
                    .find(buildUnreadFilter(conversationId, userId), {
                      projection: { _id: 0, messageId: 1 },
                    })
                    .toArray(),
                ]);
                const message = toStoredMessages(latest)[0];
                return message
                  ? {
                      conversationId,
                      peerId:
                        message.senderId === userId ? message.recipientId : message.senderId,
                      lastMessage: message,
                      unreadCount: unread.length,
                    }
                  : null;
              })
            ))
          );
        }
        return candidates
          .filter((summary): summary is ConversationSummary => summary !== null)
          .sort((a, b) => byNewestFirst(a.lastMessage, b.lastMessage));
      }
      // Deliberately no `.sort()`/`$sort`/`$group` at the database level: this
      // query fans out across every conversation the user is part of (i.e.
      // across shard-key partitions), and Cosmos DB for MongoDB (RU) rejects
      // cross-partition `ORDER BY`/`$group`+`$sort` unless served by a matching
      // composite index — which isn't feasible here since the sort key
      // (`lastMessage.createdAt`) isn't known until after grouping. Instead,
      // fetch the (bounded, per-user) candidate set and group/sort in
      // application code, mirroring the in-memory store's implementation.
      const found = await messages.find(buildParticipantFilter(userId)).toArray();
      return summariseConversations(toStoredMessages(found), userId);
    },

    async markRead(conversationId, userId) {
      const { messages } = await connect();
      const result = await messages.updateMany(
        { conversationId, recipientId: userId, readAt: null },
        { $set: { readAt: nextTimestamp() } }
      );
      return result?.modifiedCount ?? 0;
    },

    async deleteMessage(conversationId, messageId, userId) {
      const { messages } = await connect();
      // The `senderId` in the filter is the authorisation check: a delete for
      // someone else's message matches nothing and reports "not found".
      // Shard-key (`conversationId`) prefixed so Cosmos can route the write.
      const existing = await messages.findOne({ conversationId, messageId, senderId: userId });
      if (!existing?.messageId || existing.deletedAt) return null;
      // A tombstone rather than a deletion: the content goes, the row stays so
      // a reply quoting it still resolves on both clients.
      const tombstone = applyTombstone(toStoredMessage(existing), nextTimestamp());
      await messages.updateOne(
        { conversationId, messageId, senderId: userId },
        {
          $set: {
            body: tombstone.body,
            attachment: tombstone.attachment,
            reactions: tombstone.reactions,
            deletedAt: tombstone.deletedAt,
          },
        }
      );
      return tombstone;
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action } = {}) {
      const { messages } = await connect();
      const existing = await messages.findOne({ conversationId, messageId });
      if (!existing?.messageId || existing.deletedAt) return null;
      const rest = toStoredMessage(existing);
      rest.reactions = applyReaction(
        rest.reactions,
        (emoji as string),
        (userId as string),
        (action as 'add'|'remove')
      );
      await messages.updateOne(
        { conversationId, messageId },
        { $set: { reactions: rest.reactions } }
      );
      return rest;
    },

    close: connector.close,
  };

  return instrumentMongoStore(store, { collection, ensureReady: connect });
}
