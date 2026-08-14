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
 *   }
 *
 * Two implementations are provided:
 *   - {@link createMemoryMessageStore} — array-backed; the default for
 *     single-instance deployments and tests.
 *   - {@link createMongoMessageStore} — Azure Cosmos DB for MongoDB (or any
 *     MongoDB-compatible endpoint) via the official `mongodb` driver.
 */

const { randomUUID } = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default page size for {@link listMessages}. */
const DEFAULT_MESSAGE_LIMIT = 50;
/** Maximum page size for {@link listMessages}. */
const MAX_MESSAGE_LIMIT = 100;
/** Maximum accepted message body length, in characters. */
const MAX_MESSAGE_BODY_LENGTH = 4000;

const DEFAULT_DB_NAME = 'wetalk';
const DEFAULT_COLLECTION_NAME = 'messages';

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
    conversationId: message.conversationId
      || deriveConversationId(message.senderId, message.recipientId),
    senderId: message.senderId,
    recipientId: message.recipientId,
    body: message.body,
    createdAt: message.createdAt || nextTimestamp(),
    deliveredTo: Array.isArray(message.deliveredTo) ? [...message.deliveredTo] : [],
  };
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

    async close() {
      messages.length = 0;
    },
  };
}

// ─── MongoDB / Cosmos DB store ────────────────────────────────────────────────

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
        const mongoClient = client
          ?? new (require('mongodb').MongoClient)(uri);
        if (typeof mongoClient.connect === 'function') {
          await mongoClient.connect();
        }
        const messages = mongoClient.db(database).collection(collection);

        // Index creation is idempotent, but Cosmos DB can reject or throttle it;
        // never let that take the server down — reads/writes still work without
        // the indexes, just less efficiently.
        try {
          await messages.createIndex({ conversationId: 1, createdAt: -1 });
          await messages.createIndex({ messageId: 1 }, { unique: true });
        } catch (error) {
          console.warn(`[messages] index creation skipped: ${error?.message}`);
        }

        console.log(`[messages] Mongo message store ready (db=${database} collection=${collection})`);
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

    async saveMessage(message) {
      const record = createMessageRecord(message);
      const { messages } = await connect();
      await messages.insertOne({ ...record });
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
        .sort({ createdAt: -1, messageId: -1 })
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
        { returnDocument: 'after' },
      );
      const updated = result?.value ?? result;
      if (!updated || !updated.messageId) return null;
      const { _id, ...rest } = updated;
      return rest;
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
 * Returns the in-memory store when `MONGODB_URI` is absent, so the server runs
 * unchanged without any Mongo configuration.
 *
 * @param {object} [opts]
 * @param {object} [opts.messageStore] - Pre-built store (tests / injection).
 * @returns {object}
 */
function createMessageStore(opts = {}) {
  if (opts.messageStore) return opts.messageStore;

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    return createMemoryMessageStore();
  }

  try {
    return createMongoMessageStore({
      uri,
      dbName: process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME,
      collectionName: process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME,
    });
  } catch (error) {
    console.warn(`[messages] Mongo store unavailable (${error?.message}); using in-memory store`);
    return createMemoryMessageStore();
  }
}

module.exports = {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_MESSAGE_BODY_LENGTH,
  deriveConversationId,
  createMessageRecord,
  createMemoryMessageStore,
  createMongoMessageStore,
  createMessageStore,
};
