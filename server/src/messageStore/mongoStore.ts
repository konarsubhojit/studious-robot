/**
 * MongoDB-backed message store.
 *
 * Targets Azure Cosmos DB for MongoDB but works against any MongoDB-compatible
 * endpoint.  Connection, index creation and shutdown live in
 * `mongoConnection.ts`; filter construction in `queries.ts`; `_id` stripping in
 * `documents.ts` — what remains here is the sequence of operations each store
 * method performs, and the Cosmos-specific reasons behind them.
 */

import { describeError } from '../lib/errors.ts';
import { runDetached } from '../lib/queryTiming.ts';
import { summariseConversations } from './conversations.ts';
import { toStoredMessage, toStoredMessages } from './documents.ts';
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
  bodyLowerOf,
  buildListMessagesFilter,
  buildParticipantFilter,
  buildSearchMessagesFilter,
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
  ConversationIndexCollection,
  DeliveryReceiptInput,
  MessageStore,
  MessageDocument,
  MongoClientLike,
  MongoBulkWriteOperation,
  StoredMessage,
} from './types.ts';

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);
}

function conversationIndexOperationsFor(
  message: StoredMessage
): { upserts: MongoBulkWriteOperation[]; followUps: MongoBulkWriteOperation[] } {
  const upserts: MongoBulkWriteOperation[] = [];
  const followUps: MongoBulkWriteOperation[] = [];
  for (const userId of new Set([message.senderId, message.recipientId])) {
    upserts.push({
      updateOne: {
        filter: { userId, conversationId: message.conversationId },
        update: {
          $setOnInsert: {
            userId,
            conversationId: message.conversationId,
            peerId: message.senderId === userId ? message.recipientId : message.senderId,
            lastMessage: message,
            unreadCount: 0,
            updatedAt: message.createdAt,
          },
        },
        upsert: true,
      },
    });
    if (message.recipientId === userId && !message.readAt) {
      followUps.push({
        updateOne: {
          filter: { userId, conversationId: message.conversationId },
          update: { $inc: { unreadCount: 1 } },
        },
      });
    }
    followUps.push({
      updateOne: {
        filter: {
          userId,
          conversationId: message.conversationId,
          $or: [
            { updatedAt: { $lt: message.createdAt } },
            {
              updatedAt: message.createdAt,
              'lastMessage.messageId': { $lt: message.messageId },
            },
          ],
        },
        update: {
          $set: {
            peerId: message.senderId === userId ? message.recipientId : message.senderId,
            lastMessage: message,
            updatedAt: message.createdAt,
          },
        },
      },
    });
  }
  return { upserts, followUps };
}

async function updateConversationIndex(
  conversationIndex: ConversationIndexCollection,
  message: StoredMessage
): Promise<void> {
  const { upserts, followUps } = conversationIndexOperationsFor(message);
  try {
    await conversationIndex.bulkWrite([...upserts, ...followUps], { ordered: true });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    try {
      await conversationIndex.bulkWrite(upserts, { ordered: false });
    } catch (retryError) {
      if (!isDuplicateKeyError(retryError)) throw retryError;
    }
    await conversationIndex.bulkWrite(followUps, { ordered: false });
  }
}

async function updateIndexedLastMessage(
  conversationIndex: ConversationIndexCollection,
  message: StoredMessage
): Promise<void> {
  await conversationIndex.bulkWrite(
    [...new Set([message.senderId, message.recipientId])].map((userId) => ({
      updateOne: {
        filter: {
          userId,
          conversationId: message.conversationId,
          'lastMessage.messageId': message.messageId,
        },
        update: { $set: { lastMessage: message } },
      },
    })),
    { ordered: false }
  );
}

async function ensureConversationIndexRows(
  conversationIndex: ConversationIndexCollection,
  message: StoredMessage
): Promise<void> {
  await conversationIndex.bulkWrite(
    [...new Set([message.senderId, message.recipientId])].map((userId) => ({
      updateOne: {
        filter: { userId, conversationId: message.conversationId },
        update: {
          $setOnInsert: {
            userId,
            conversationId: message.conversationId,
            peerId: message.senderId === userId ? message.recipientId : message.senderId,
            lastMessage: message,
            unreadCount: message.recipientId === userId && !message.readAt ? 1 : 0,
            updatedAt: message.createdAt,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

const DELIVERY_FLUSH_INTERVAL_MS = 100;

function receiptKey({ conversationId, messageId, userId }: DeliveryReceiptInput): string {
  return `${conversationId ?? ''}\0${messageId}\0${userId}`;
}

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
  conversationIndexWrites,
  conversationIndexReady,
  bodyLowerWrites,
  bodyLowerReady,
  client,
}: {
  uri?: string;
  dbName?: string;
  collectionName?: string;
  conversationIndexCollectionName?: string;
  conversationIndexWrites?: boolean;
  conversationIndexReady?: boolean;
  bodyLowerWrites?: boolean;
  bodyLowerReady?: boolean;
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
  const writeConversationIndex = conversationIndexWrites ?? useConversationIndex;
  // Same two-phase rollout as the conversation index: dual-write first, read
  // from the new field only once the backfill has covered the old rows.
  const searchOnBodyLower = bodyLowerReady ?? false;
  const writeBodyLower = bodyLowerWrites ?? searchOnBodyLower;

  const connector = createMongoConnector({
    uri,
    database,
    collection,
    conversationIndexCollection,
    enableConversationIndex: writeConversationIndex,
    client,
  });
  const connect = connector.connect;
  const pendingDeliveryReceipts: Map<string, DeliveryReceiptInput> = new Map();
  let deliveryFlushTimer: NodeJS.Timeout | null = null;
  let deliveryFlushPromise: Promise<void> | null = null;

  function scheduleDeliveryReceiptFlush(): void {
    if (deliveryFlushTimer) return;
    deliveryFlushTimer = setTimeout(() => {
      deliveryFlushTimer = null;
      void flushDeliveryReceipts().catch(() => {});
    }, DELIVERY_FLUSH_INTERVAL_MS);
    deliveryFlushTimer.unref();
  }

  async function flushDeliveryReceipts(): Promise<void> {
    while (deliveryFlushPromise) {
      try {
        await deliveryFlushPromise;
      } catch {
        // The in-flight flush already logged and requeued its receipts.
      }
    }
    if (pendingDeliveryReceipts.size === 0) return;
    const receipts = [...pendingDeliveryReceipts.values()];
    pendingDeliveryReceipts.clear();
    if (receipts.length === 0) return;

    deliveryFlushPromise = (async () => {
      const { messages, conversationIndex } = await connect();
      await messages.bulkWrite(
        receipts.map(({ messageId, userId, conversationId }) => ({
          updateOne: {
            filter: conversationId ? { conversationId, messageId } : { messageId },
            update: { $addToSet: { deliveredTo: userId } },
          },
        })),
        { ordered: false }
      );
      if (conversationIndex) {
        const indexOperations = receipts
          .filter((receipt) => receipt.conversationId)
          .map(({ messageId, userId, conversationId }) => ({
            updateMany: {
              filter: { conversationId, 'lastMessage.messageId': messageId },
              update: { $addToSet: { 'lastMessage.deliveredTo': userId } },
            },
          }));
        if (indexOperations.length > 0) {
          await conversationIndex.bulkWrite(indexOperations, { ordered: false });
        }
      }
    })().catch((error: unknown) => {
      for (const receipt of receipts) {
        pendingDeliveryReceipts.set(receiptKey(receipt), receipt);
      }
      console.error(`[messages] failed to flush delivery receipts: ${describeError(error)}`);
      scheduleDeliveryReceiptFlush();
      throw error;
    }).finally(() => {
      deliveryFlushPromise = null;
    });
    await deliveryFlushPromise;
  }

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
        {
          $setOnInsert: {
            ...record,
            ...(writeBodyLower ? { bodyLower: bodyLowerOf(record.body) } : {}),
          },
        },
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
      if (conversationIndex && result?.upsertedCount) {
        await updateConversationIndex(conversationIndex, saved);
      } else if (conversationIndex) {
        await ensureConversationIndexRows(conversationIndex, saved);
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
      const { messages, conversationIndex } = await connect();
      // Narrow to the user's own partitions when the conversation index can
      // say what they are. `conversationId` is the shard key, so this is the
      // difference between reading the user's conversations and fanning out
      // across every partition in the collection. One extra single-partition
      // index read buys that, and it is skipped entirely when the index is not
      // in service.
      let conversationIds: string[] | null = null;
      if (useConversationIndex && conversationIndex) {
        const rows = await conversationIndex.find({ userId }).toArray();
        conversationIds = rows
          .map((row) => row.conversationId)
          .filter((id): id is string => typeof id === 'string' && id !== '');
      }
      // Deliberately no `.sort()`: the query still spans several shard-key
      // partitions, which Cosmos DB for MongoDB (RU) rejects unless a matching
      // composite index serves it — impossible for a cross-partition sort.
      // Sorting happens in application code, exactly as `listConversations`
      // does, and the page is cut afterwards.
      const found = await messages
        .find(
          buildSearchMessagesFilter(userId, term, before, {
            conversationIds,
            useBodyLower: searchOnBodyLower,
          })
        )
        .toArray();
      return toStoredMessages(found).sort(byNewestFirst).slice(0, cap);
    },

    async markDelivered(messageId, userId, conversationId) {
      const { messages, conversationIndex } = await connect();
      // Shard-key (`conversationId`) prefixed when the caller knows it, so
      // Cosmos routes the write to one partition instead of fanning out; the
      // unique index is `{ conversationId, messageId }`.
      const filter = conversationId ? { conversationId, messageId } : { messageId };
      // `$addToSet` gives idempotency for free.
      const result = await messages.findOneAndUpdate(
        filter,
        { $addToSet: { deliveredTo: userId } },
        { returnDocument: 'after' }
      );
      const updated = unwrapUpdatedDocument(result);
      if (!updated?.messageId) return null;
      const stored = toStoredMessage(updated);
      if (conversationIndex) await updateIndexedLastMessage(conversationIndex, stored);
      return stored;
    },

    enqueueDeliveryReceipt(receipt) {
      pendingDeliveryReceipts.set(receiptKey(receipt), receipt);
      scheduleDeliveryReceiptFlush();
    },

    flushDeliveryReceipts,

    async listConversations(userId) {
      const { messages, conversationIndex } = await connect();
      if (useConversationIndex && conversationIndex) {
        const indexed = await conversationIndex
          .find(
            { userId },
            { projection: { _id: 0, userId: 0, updatedAt: 0 } }
          )
          .sort(LIST_CONVERSATION_INDEX_SORT)
          .limit(MAX_CONVERSATION_LIMIT)
          .toArray();
        const visible = indexed.filter(
          (summary) =>
            summary.lastMessage?.senderId === userId ||
            summary.lastMessage?.recipientId === userId
        );
        if (visible.length !== indexed.length) {
          console.error(
            `[messages] conversation index dropped ${indexed.length - visible.length}` +
              ` non-participant row(s)`
          );
        }
        return visible
          .map(({ conversationId, peerId, lastMessage, unreadCount }) => ({
            conversationId,
            peerId,
            lastMessage,
            unreadCount,
          }));
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

    async markRead(conversationId, userId, peerId) {
      const { messages, conversationIndex } = await connect();
      const readAt = nextTimestamp();
      const result = await messages.updateMany(
        { conversationId, recipientId: userId, readAt: null },
        { $set: { readAt } }
      );
      if (conversationIndex) {
        // Without a `peerId` from the caller the peer's row can only be found
        // the old way — one extra round trip — rather than left unpatched.
        const resolvedPeerId =
          peerId ?? (await conversationIndex.findOne({ userId, conversationId }))?.peerId;
        // The reader's unread reset and the read receipt on their own row are
        // one write. The `lastMessage.*` conditions are in the *filter* rather
        // than checked by a prior read: when the last message is the reader's
        // own (or already read) the update matches nothing, and the plain reset
        // below runs instead — never both.
        const merged = await conversationIndex.updateOne(
          {
            userId,
            conversationId,
            'lastMessage.recipientId': userId,
            'lastMessage.readAt': null,
          },
          { $set: { unreadCount: 0, 'lastMessage.readAt': readAt } }
        );
        // `matchedCount`, not `modifiedCount`: a row the guard matched but left
        // unchanged (its `unreadCount` was already 0) needs no second write.
        if (!(merged?.matchedCount ?? merged?.modifiedCount)) {
          await conversationIndex.updateOne(
            { userId, conversationId },
            { $set: { unreadCount: 0 } }
          );
        }
        if (resolvedPeerId) {
          // The sender's copy of the receipt is not needed before answering the
          // reader, so it is not awaited; it is pushed to them over the socket
          // anyway. Same filter-as-guard trick: a no-op when it does not apply.
          void runDetached(() => conversationIndex
            .updateOne(
              {
                userId: resolvedPeerId,
                conversationId,
                'lastMessage.recipientId': userId,
                'lastMessage.readAt': null,
              },
              { $set: { 'lastMessage.readAt': readAt } }
            ))
            .catch((error: unknown) => {
              console.error(
                `[messages] conversation index read receipt failed` +
                  ` conversationId=${conversationId}: ${describeError(error)}`
              );
            });
        }
      }
      return result?.modifiedCount ?? 0;
    },

    async deleteMessage(conversationId, messageId, userId) {
      const { messages, conversationIndex } = await connect();
      // The `senderId` in the filter is the authorisation check: a delete for
      // someone else's message matches nothing and reports "not found".
      // Shard-key (`conversationId`) prefixed so Cosmos can route the write.
      const existing = await messages.findOne({ conversationId, messageId, senderId: userId });
      if (!existing?.messageId) return null;
      if (existing.deletedAt) {
        if (conversationIndex) {
          await updateIndexedLastMessage(conversationIndex, toStoredMessage(existing));
        }
        return null;
      }
      // A tombstone rather than a deletion: the content goes, the row stays so
      // a reply quoting it still resolves on both clients.
      const tombstone = applyTombstone(toStoredMessage(existing), nextTimestamp());
      await messages.updateOne(
        { conversationId, messageId, senderId: userId },
        {
          $set: {
            body: tombstone.body,
            ...(writeBodyLower ? { bodyLower: bodyLowerOf(tombstone.body) } : {}),
            attachment: tombstone.attachment,
            reactions: tombstone.reactions,
            deletedAt: tombstone.deletedAt,
          },
        }
      );
      if (conversationIndex) await updateIndexedLastMessage(conversationIndex, tombstone);
      return tombstone;
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action } = {}) {
      const { messages, conversationIndex } = await connect();
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
      if (conversationIndex) await updateIndexedLastMessage(conversationIndex, rest);
      return rest;
    },

    async close() {
      if (deliveryFlushTimer) {
        clearTimeout(deliveryFlushTimer);
        deliveryFlushTimer = null;
      }
      try {
        await flushDeliveryReceipts();
      } catch {
        // The flush path already logged and requeued; closing the client must
        // still run during shutdown so a transient write error cannot leak it.
        if (deliveryFlushTimer) {
          clearTimeout(deliveryFlushTimer);
          deliveryFlushTimer = null;
        }
      } finally {
        await connector.close();
      }
    },
  };

  return store;
}
