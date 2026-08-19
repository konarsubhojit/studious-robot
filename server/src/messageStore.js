'use strict';

/**
 * Persistent store for text-chat messages.
 *
 * Mirrors the transport-agnostic style of `messageBus.js` and `stores/`: a tiny
 * interface with an in-process default and an optional durable backend, chosen
 * by environment configuration.  When no `MONGODB_URI` is configured the server
 * uses the in-memory implementation and behaves exactly as it did before chat
 * persistence existed.
 *
 * Interface
 * ─────────
 *   saveMessage(message)                        → Promise<savedMessage>
 *   listMessages({ conversationId, limit, before }) → Promise<message[]>
 *   markDelivered(messageId, userId)            → Promise<message|null>
 *   listConversations(userId)                   → Promise<conversationSummary[]>
 *   markRead(conversationId, userId)            → Promise<number>
 *   close()                                     → Promise<void>
 *
 * Message document shape
 * ──────────────────────
 *   {
 *     messageId:     string (uuid),
 *     conversationId:string,
 *     senderId:      string,
 *     recipientId:   string,
 *     body:          string,
 *     createdAt:     string (ISO 8601),
 *     deliveredTo:   string[],
 *     readAt:        string (ISO 8601) | null,
 *   }
 *
 * Conversation summary shape (returned by `listConversations`)
 * ──────────────────────────────────────────────────────────
 *   {
 *     conversationId: string,
 *     peerId:         string,  // the *other* participant, relative to userId
 *     lastMessage:    message,
 *     unreadCount:    number,  // messages addressed to userId with readAt === null
 *   }
 *
 * Two implementations are provided:
 *   - {@link createMemoryMessageStore} — array-backed; the default for
 *     single-instance deployments and tests.
 *   - {@link createMongoMessageStore} — Azure Cosmos DB for MongoDB (or any
 *     MongoDB-compatible endpoint) via the official `mongodb` driver.
 */

const { randomUUID } = require('crypto');
// Maximum accepted message body length, in characters: part of the wire
// contract, so it is owned by the shared package and enforced identically by
// the client and the `message.send` handler.
const { MAX_MESSAGE_BODY_LENGTH } = require('../../shared');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default page size for {@link listMessages}. */
const DEFAULT_MESSAGE_LIMIT = 50;
/** Maximum page size for {@link listMessages}. */
const MAX_MESSAGE_LIMIT = 100;

const DEFAULT_DB_NAME = 'wetalk';
const DEFAULT_COLLECTION_NAME = 'messages';
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a deterministic conversation id from the two participant ids.
 *
 * The ids are sorted before joining so both participants — and both directions
 * of a send — always resolve to the same conversation.
 *
 * @param {string} userA
 * @param {string} userB
 * @returns {string}
 */
function deriveConversationId(userA, userB) {
  return [String(userA), String(userB)].sort().join(':');
}

/**
 * Clamp a requested page size into the supported range.
 *
 * @param {unknown} limit
 * @returns {number}
 */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isFinite(requested)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_MESSAGE_LIMIT);
}

/**
 * Monotonic ISO timestamp generator.
 *
 * `createdAt` doubles as the sort key *and* the pagination cursor, so two
 * messages sent within the same millisecond would otherwise tie: the newest-first
 * ordering becomes arbitrary and a `before` cursor can silently skip or repeat
 * the tied messages.  Forcing each generated timestamp to be strictly greater
 * than the previous one keeps ordering and pagination exact.
 */
let _lastGeneratedAtMs = 0;

/**
 * @returns {string} An ISO timestamp strictly later than the previous one.
 */
function nextTimestamp() {
  const now = Date.now();
  _lastGeneratedAtMs = now > _lastGeneratedAtMs ? now : _lastGeneratedAtMs + 1;
  return new Date(_lastGeneratedAtMs).toISOString();
}

/**
 * Build a complete message document, filling in server-owned fields.
 *
 * @param {{ conversationId?: string, senderId: string, recipientId: string, body: string }} message
 * @returns {object}
 */
function createMessageRecord(message) {
  return {
    messageId: message.messageId || randomUUID(),
    conversationId:
      message.conversationId || deriveConversationId(message.senderId, message.recipientId),
    senderId: message.senderId,
    recipientId: message.recipientId,
    body: message.body,
    createdAt: message.createdAt || nextTimestamp(),
    deliveredTo: Array.isArray(message.deliveredTo) ? [...message.deliveredTo] : [],
    readAt: message.readAt ?? null,
  };
}

/**
 * Resolve the "other" participant of a message relative to `userId`.
 *
 * @param {object} message
 * @param {string} userId
 * @returns {string} `senderId` when `userId` is the recipient, otherwise `recipientId`.
 */
function peerIdOf(message, userId) {
  return message.senderId === userId ? message.recipientId : message.senderId;
}

/**
 * Newest-first comparator used by the in-memory store.  `messageId` breaks ties
 * so the ordering stays deterministic even for caller-supplied timestamps.
 */
function byNewestFirst(a, b) {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.messageId === b.messageId) return 0;
  return a.messageId < b.messageId ? 1 : -1;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

/**
 * Create an in-process, array-backed message store.
 *
 * Used when Mongo is not configured and by the test suite.  History does not
 * survive a restart, which matches the pre-existing behaviour of the rest of
 * the in-memory state.
 *
 * @returns {object}
 */
function createMemoryMessageStore() {
  /** @type {object[]} */
  const messages = [];

  return {
    type: 'memory',

    async ready() {},

    async saveMessage(message) {
      const record = createMessageRecord(message);
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
      /** @type {Map<string, { conversationId: string, peerId: string, lastMessage: object, unreadCount: number }>} */
      const byConversation = new Map();

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

      return [...byConversation.values()]
        .sort((a, b) => byNewestFirst(a.lastMessage, b.lastMessage))
        .map((summary) => ({ ...summary, lastMessage: { ...summary.lastMessage } }));
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

    async close() {
      messages.length = 0;
    },
  };
}

// ─── MongoDB / Cosmos DB store ────────────────────────────────────────────────

/**
 * Create one index, logging (rather than throwing) on failure.
 *
 * Cosmos DB can reject or throttle index builds (e.g. a unique index that
 * does not include the shard key); never let that take the server down —
 * reads/writes still work without the index, just less efficiently, or with
 * the corresponding guarantee (sort support, uniqueness) degraded. Each index
 * is attempted independently so one rejection doesn't skip the rest.
 *
 * @param {object} messages - The Mongo collection.
 * @param {object} spec - Index key spec, e.g. `{ conversationId: 1 }`.
 * @param {object} [options] - Index options, e.g. `{ unique: true }`.
 * @returns {Promise<void>}
 */
async function createIndexOrWarn(messages, spec, options) {
  try {
    await messages.createIndex(spec, options);
  } catch (error) {
    console.error(
      `[messages] DEGRADED: index creation skipped for ${JSON.stringify(spec)}` +
        `${options ? ` ${JSON.stringify(options)}` : ''} — sorted queries and/or ` +
        `uniqueness guarantees may be affected: ${error?.message}`
    );
  }
}

/**
 * Best-effort extraction of the Mongo host(s) for startup logging, without
 * ever logging credentials embedded in the connection string.
 *
 * @param {object} mongoClient
 * @param {string} [uri]
 * @returns {string}
 */
function safeMongoHost(mongoClient, uri) {
  try {
    const options = mongoClient?.options ?? mongoClient?.s?.options;
    const hosts = options?.hosts;
    if (Array.isArray(hosts) && hosts.length) {
      return hosts.map((h) => (h?.host ? `${h.host}${h.port ? `:${h.port}` : ''}` : String(h))).join(',');
    }
  } catch {
    // Fall through to URI parsing below.
  }
  if (!uri) return 'unknown';
  try {
    // Strip credentials before ever touching the URI for logging purposes.
    const withoutCreds = uri.replace(/\/\/[^@/]+@/, '//');
    const match = withoutCreds.match(/^[a-zA-Z+]+:\/\/([^/?]+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Create a MongoDB-backed message store.
 *
 * Targets Azure Cosmos DB for MongoDB but works against any MongoDB-compatible
 * endpoint.  The connection is established lazily on first use so constructing
 * the store never blocks server start-up, and a failure to create indexes is
 * logged rather than fatal (Cosmos DB throttles index builds under load).
 *
 * @param {{ uri: string, dbName?: string, collectionName?: string, client?: object }} opts
 * @returns {object}
 */
function createMongoMessageStore({ uri, dbName, collectionName, client } = {}) {
  if (!uri && !client) {
    throw new Error('createMongoMessageStore: "uri" is required');
  }

  const database = dbName || DEFAULT_DB_NAME;
  const collection = collectionName || DEFAULT_COLLECTION_NAME;

  let clientPromise = null;
  let closed = false;

  /**
   * Connect (once) and ensure the supporting indexes exist.
   *
   * @returns {Promise<object>} The messages collection.
   */
  function connect() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mongoClient =
          client ??
          new (require('mongodb').MongoClient)(uri, {
            serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
          });
        if (typeof mongoClient.connect === 'function') {
          await mongoClient.connect();
        }
        const messages = mongoClient.db(database).collection(collection);

        // Index creation is idempotent, but Cosmos DB can reject or throttle it;
        // never let that take the server down — reads/writes still work without
        // the indexes, just less efficiently (and, on Cosmos RU, sorted queries
        // may fail outright without the matching composite index — see below).
        //
        // All indexes are prefixed with `conversationId` (the shard/partition
        // key). Azure Cosmos DB for MongoDB (RU) requires:
        //   - unique indexes to include the shard key, and
        //   - `sort()` queries to be served by a matching *direction-specific*
        //     composite index (no collection-scan fallback like vCore/MongoDB).
        // `{ messageId: 1 }` alone can no longer be unique (see `saveMessage`'s
        // upsert for the enforcement fallback), so it is replaced by
        // `{ conversationId: 1, messageId: 1 }`, which preserves the intended
        // guarantee because a `messageId` only ever appears within one
        // conversation.
        //
        // Each index is created independently (own try/catch) so a single
        // rejection/throttle never skips the rest.
        await createIndexOrWarn(messages, { conversationId: 1, createdAt: -1 });
        // Ascending counterpart — Cosmos composite indexes are direction
        // specific, so the descending index above does not also serve an
        // ascending sort.
        await createIndexOrWarn(messages, { conversationId: 1, createdAt: 1 });
        // Shard-key-prefixed uniqueness on messageId.
        await createIndexOrWarn(
          messages,
          { conversationId: 1, messageId: 1 },
          { unique: true }
        );
        // Serves `listMessages`'s actual `{ createdAt: -1, messageId: -1 }`
        // tiebreak sort (Cosmos composite indexes must match sorted fields
        // exactly, including the tiebreak field).
        await createIndexOrWarn(messages, { conversationId: 1, createdAt: -1, messageId: -1 });

        const host = safeMongoHost(mongoClient, uri);
        const retryWritesDisabled = /retrywrites=false/i.test(uri || '');
        console.log(
          `[messages] Mongo message store ready (host=${host} db=${database} ` +
            `collection=${collection} retryWrites=${retryWritesDisabled ? 'disabled' : 'default'})`
        );
        return { mongoClient, messages };
      })().catch((error) => {
        // Reset so a later call can retry rather than caching a failed connect.
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  return {
    type: 'mongo',

    ready: connect,

    async saveMessage(message) {
      const record = createMessageRecord(message);
      const { messages } = await connect();
      // `messageId` is client-supplied (mobile-generated UUIDs), so a client
      // retry/replay of the same send must not create a duplicate message —
      // upsert on the shard-key-prefixed `{ conversationId, messageId }` pair
      // (see the indexes above) so this stays correct even on a backend where
      // the unique index itself could not be created (e.g. Cosmos RU under a
      // shard-key mismatch it otherwise rejects).
      await messages.updateOne(
        { conversationId: record.conversationId, messageId: record.messageId },
        { $setOnInsert: { ...record } },
        { upsert: true }
      );
      return record;
    },

    async listMessages({ conversationId, limit, before } = {}) {
      const cap = clampLimit(limit);
      const { messages } = await connect();
      const query = { conversationId };
      if (before) {
        query.createdAt = { $lt: before };
      }
      const found = await messages
        .find(query)
        .sort({ conversationId: 1, createdAt: -1, messageId: -1 })
        .limit(cap)
        .toArray();
      // Strip the driver-managed `_id` so the wire shape matches the memory store.
      return found.map(({ _id, ...rest }) => rest);
    },

    async markDelivered(messageId, userId) {
      const { messages } = await connect();
      // `$addToSet` gives idempotency for free.
      const result = await messages.findOneAndUpdate(
        { messageId },
        { $addToSet: { deliveredTo: userId } },
        { returnDocument: 'after' }
      );
      const updated = result?.value ?? result;
      if (!updated || !updated.messageId) return null;
      const { _id, ...rest } = updated;
      return rest;
    },

    async listConversations(userId) {
      const { messages } = await connect();
      // Deliberately no `.sort()`/`$sort`/`$group` at the database level: this
      // query fans out across every conversation the user is part of (i.e.
      // across shard-key partitions), and Cosmos DB for MongoDB (RU) rejects
      // cross-partition `ORDER BY`/`$group`+`$sort` unless served by a matching
      // composite index — which isn't feasible here since the sort key
      // (`lastMessage.createdAt`) isn't known until after grouping. Instead,
      // fetch the (bounded, per-user) candidate set and group/sort in
      // application code, mirroring the in-memory store's implementation.
      const found = await messages
        .find({ $or: [{ senderId: userId }, { recipientId: userId }] })
        .toArray();

      /** @type {Map<string, { conversationId: string, peerId: string, lastMessage: object, unreadCount: number }>} */
      const byConversation = new Map();

      for (const doc of found) {
        // Strip the driver-managed `_id` so the wire shape matches the memory store.
        const { _id, ...message } = doc;

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
    },

    async markRead(conversationId, userId) {
      const { messages } = await connect();
      const result = await messages.updateMany(
        { conversationId, recipientId: userId, readAt: null },
        { $set: { readAt: nextTimestamp() } }
      );
      return result?.modifiedCount ?? 0;
    },

    async close() {
      if (closed || !clientPromise) return;
      closed = true;
      try {
        const { mongoClient } = await clientPromise;
        await mongoClient.close();
      } catch (error) {
        console.warn(`[messages] error while closing Mongo client: ${error?.message}`);
      }
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the message store for this process from the environment.
 *
 * Development and tests may use memory explicitly. Production fails closed
 * unless Mongo is configured or ALLOW_IN_MEMORY_MESSAGE_STORE=true is set.
 *
 * @param {object} [opts]
 * @param {object} [opts.messageStore] - Pre-built store (tests / injection).
 * @returns {object}
 */
function createMessageStore(opts = {}) {
  if (opts.messageStore) return opts.messageStore;

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_IN_MEMORY_MESSAGE_STORE !== 'true'
    ) {
      throw new Error(
        'MONGODB_URI is required in production (set ALLOW_IN_MEMORY_MESSAGE_STORE=true to opt in)',
      );
    }
    console.log('[messages] using in-memory message store (MONGODB_URI is not set)');
    return createMemoryMessageStore();
  }

  try {
    const client = new (require('mongodb').MongoClient)(uri, {
      serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    });
    return createMongoMessageStore({
      uri,
      dbName: process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME,
      collectionName: process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME,
      client,
    });
  } catch (error) {
    throw new Error(`Invalid MONGODB_URI: ${error?.message}`);
  }
}

module.exports = {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_MESSAGE_BODY_LENGTH,
  DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  deriveConversationId,
  createMessageRecord,
  createMemoryMessageStore,
  createMongoMessageStore,
  createMessageStore,
};
