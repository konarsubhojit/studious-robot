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
 *   searchMessages({ userId, query, limit, before }) → Promise<message[]>
 *   markDelivered(messageId, userId)            → Promise<message|null>
 *   listConversations(userId)                   → Promise<conversationSummary[]>
 *   markRead(conversationId, userId)            → Promise<number>
 *   deleteMessage(conversationId, messageId, userId) → Promise<message|null>
 *   reactToMessage({ conversationId, messageId, userId, emoji, action }) → Promise<message|null>
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
 *     type:          'text'|'image'|'file'|'voice'|'system',
 *     attachment:    object | null,   // { url, mimeType, sizeBytes, … }
 *     replyTo:       string | null,   // messageId this message quotes
 *     reactions:     Record<string, string[]>,  // emoji → reacting userIds
 *     deletedAt:     string (ISO 8601) | null,  // tombstone, see deleteMessage
 *     createdAt:     string (ISO 8601),
 *     deliveredTo:   string[],
 *     readAt:        string (ISO 8601) | null,
 *   }
 *
 * Rows written before rich messaging existed carry none of `type`,
 * `attachment`, `replyTo`, `reactions` or `deletedAt`; every reader therefore
 * defaults the type to `"text"` (see `@wetalk/shared`'s `messageTypeOf`) and
 * treats the rest as absent.
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

import { randomUUID } from 'crypto';
import { MongoClient, MongoParseError } from 'mongodb';
import { describeError } from './lib/errors.ts';

/**
 * Whether `error` came from the driver rejecting the connection string itself.
 *
 * The connection-string parser ships its own `MongoParseError` class (from
 * `mongodb-connection-string-url`), so an `instanceof` check alone misses some
 * URI errors — the error name is checked as well.
 */
function isMongoUriError(error: unknown): boolean {
  if (error instanceof MongoParseError) return true;
  return (
    error instanceof Error &&
    (error.name === 'MongoParseError' || error.name === 'MongoInvalidArgumentError')
  );
}
// Maximum accepted message body length, in characters: part of the wire
// contract, so it is owned by the shared package and enforced identically by
// the client and the `message.send` handler.
import { DEFAULT_MESSAGE_TYPE, MAX_MESSAGE_BODY_LENGTH, isSupportedMessageType } from '../../shared/index.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default page size for {@link listMessages}. */
export type MessageRecord = import('./stores/contracts.ts').MessageRecord;
export type StoredMessage = MessageRecord & {
  type: string;
  attachment: object | null;
  replyTo: string | null;
  reactions: Record<string, string[]>;
  deletedAt: string | null;
  deliveredTo: string[];
  readAt: string | null;
};
export type ConversationSummary = {
  conversationId: string;
  peerId: string;
  lastMessage: StoredMessage;
  unreadCount: number;
};
export type MessageStore = {
  type: 'memory' | 'mongo';
  saveMessage: (
    message: Partial<MessageRecord> & {
      senderId: string;
      recipientId: string;
      body: string;
    }
  ) => Promise<StoredMessage>;
  listMessages: (opts?: {
    conversationId?: string;
    limit?: unknown;
    before?: string;
  }) => Promise<StoredMessage[]>;
  searchMessages: (opts?: {
    userId?: string;
    query?: unknown;
    limit?: unknown;
    before?: string;
  }) => Promise<StoredMessage[]>;
  markDelivered: (
    messageId: string,
    userId: string
  ) => Promise<StoredMessage | null>;
  listConversations: (userId: string) => Promise<ConversationSummary[]>;
  markRead: (conversationId: string, userId: string) => Promise<number>;
  deleteMessage: (
    conversationId: string,
    messageId: string,
    userId: string
  ) => Promise<StoredMessage | null>;
  reactToMessage: (opts?: {
    conversationId?: string;
    messageId?: string;
    userId?: string;
    emoji?: string;
    action?: 'add' | 'remove';
  }) => Promise<StoredMessage | null>;
  close?: () => Promise<void>;
  ready?: () => Promise<unknown>;
};

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
 */
function deriveConversationId(userA: string, userB: string): string {
  return [String(userA), String(userB)].sort().join(':');
}

/**
 * Clamp a requested page size into the supported range.
 */
function clampLimit(limit: unknown): number {
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
 * @returns An ISO timestamp strictly later than the previous one.
 */
function nextTimestamp(): string {
  const now = Date.now();
  _lastGeneratedAtMs = now > _lastGeneratedAtMs ? now : _lastGeneratedAtMs + 1;
  return new Date(_lastGeneratedAtMs).toISOString();
}

/**
 * Normalise a reactions map: emoji → unique reacting userIds, dropping
 * anything that is not a non-empty array of ids.
 */
function normaliseReactions(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const reactions: Record<string, string[]> = {};
  for (const [emoji, userIds] of Object.entries(value)) {
    if (!Array.isArray(userIds)) continue;
    const unique = [...new Set(userIds.filter((userId) => typeof userId === 'string' && userId))];
    if (unique.length) reactions[emoji] = unique;
  }
  return reactions;
}

/**
 * Build a complete message document, filling in server-owned fields.
 *
 * The rich fields are always materialised (rather than omitted when unused) so
 * every newly written row has one shape; readers still default a *legacy* row
 * with no `type` to `"text"`.
 *
 *   message
 */
function createMessageRecord(message: Partial<MessageRecord> & { senderId: string; recipientId: string; body: string; }): StoredMessage {
  return {
    messageId: message.messageId || randomUUID(),
    conversationId:
      message.conversationId || deriveConversationId(message.senderId, message.recipientId),
    senderId: message.senderId,
    recipientId: message.recipientId,
    body: message.body,
    // An unknown type is never persisted: the store owns what it can describe,
    // and a client sending one is rejected long before this point.
    type: isSupportedMessageType(message.type)
      ? (message.type as string)
      : DEFAULT_MESSAGE_TYPE,
    attachment: message.attachment ?? null,
    replyTo: message.replyTo ?? null,
    reactions: normaliseReactions(message.reactions),
    deletedAt: message.deletedAt ?? null,
    createdAt: message.createdAt || nextTimestamp(),
    deliveredTo: Array.isArray(message.deliveredTo) ? [...message.deliveredTo] : [],
    readAt: message.readAt ?? null,
  };
}

/**
 * Redact a message in place, leaving a tombstone: the content is gone for both
 * participants, but the row survives so a reply that quotes it still resolves
 * (and renders "Message deleted" instead of a dangling reference).
 *
 * @returns the same object, mutated.
 */
function applyTombstone(message: StoredMessage, deletedAt: string): StoredMessage {
  message.body = '';
  message.attachment = null;
  message.reactions = {};
  message.deletedAt = deletedAt;
  return message;
}

/**
 * Apply one reaction change to a reactions map, returning a new map.
 *
 * Idempotent in both directions: adding a reaction a user already left, or
 * removing one they never left, leaves the map unchanged — so a retried
 * `message.react` converges rather than toggling.
 */
function applyReaction(reactions: Record<string, string[]>, emoji: string, userId: string, action: 'add' | 'remove'): Record<string, string[]> {
  const next = { ...normaliseReactions(reactions) };
  const current = next[emoji] ?? [];
  if (action === 'add') {
    if (!current.includes(userId)) next[emoji] = [...current, userId];
    return next;
  }
  const remaining = current.filter((candidate) => candidate !== userId);
  if (remaining.length) next[emoji] = remaining;
  else delete next[emoji];
  return next;
}

/**
 * Resolve the "other" participant of a message relative to `userId`.
 *
 * @returns `senderId` when `userId` is the recipient, otherwise `recipientId`.
 */
function peerIdOf(message: StoredMessage, userId: string): string {
  return message.senderId === userId ? message.recipientId : message.senderId;
}

/**
 * Newest-first comparator used by the in-memory store.  `messageId` breaks ties
 * so the ordering stays deterministic even for caller-supplied timestamps.
 */
function byNewestFirst(a: StoredMessage, b: StoredMessage): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.messageId === b.messageId) return 0;
  return a.messageId < b.messageId ? 1 : -1;
}

/**
 * Escape every regular-expression metacharacter in `value`, so a user-supplied
 * search term is only ever matched literally.  Without this a term such as
 * `.*` would match every message, and a pathological one could make the
 * database evaluate a catastrophically backtracking pattern.
 */
function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a search term: trimmed, and empty when there is nothing to match.
 */
function normaliseSearchTerm(query: unknown): string {
  return String(query ?? '').trim();
}

/**
 * Whether `message.body` contains `term`, case-insensitively.
 */
function bodyMatches(message: { body?: string; }, term: string): boolean {
  return String(message?.body ?? '')
    .toLowerCase()
    .includes(term.toLowerCase());
}

// ─── In-memory store ──────────────────────────────────────────────────────────

/**
 * Create an in-process, array-backed message store.
 *
 * Used when Mongo is not configured and by the test suite.  History does not
 * survive a restart, which matches the pre-existing behaviour of the rest of
 * the in-memory state.
 */
function createMemoryMessageStore(): MessageStore {
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
 * @param messages - The Mongo collection.
 * @param spec - Index key spec, e.g. `{ conversationId: 1 }`.
 * @param options - Index options, e.g. `{ unique: true }`.
 */
async function createIndexOrWarn(messages: any, spec: object, options?: object): Promise<void> {
  try {
    await messages.createIndex(spec, options);
  } catch (error) {
    console.error(
      `[messages] DEGRADED: index creation skipped for ${JSON.stringify(spec)}` +
        `${options ? ` ${JSON.stringify(options)}` : ''} — sorted queries and/or ` +
        `uniqueness guarantees may be affected: ${describeError(error)}`
    );
  }
}

/**
 * Best-effort extraction of the Mongo host(s) for startup logging, without
 * ever logging credentials embedded in the connection string.
 */
function safeMongoHost(mongoClient: any, uri?: string): string {
  try {
    const options = mongoClient?.options ?? mongoClient?.s?.options;
    const hosts = options?.hosts;
    if (Array.isArray(hosts) && hosts.length) {
      return hosts
        .map((h: any) =>
          h?.host ? `${h.host}${h.port ? `:${h.port}` : ''}` : String(h)
        )
        .join(',');
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
 */
function createMongoMessageStore({ uri, dbName, collectionName, client }: { uri?: string; dbName?: string; collectionName?: string; client?: any; } = {}): MessageStore {
  if (!uri && !client) {
    throw new Error('createMongoMessageStore: "uri" is required');
  }

  const database = dbName || DEFAULT_DB_NAME;
  const collection = collectionName || DEFAULT_COLLECTION_NAME;

  let clientPromise: Promise<any> | null = null;
  let closed = false;

  /**
   * Connect (once) and ensure the supporting indexes exist.
   *
   * @returns The messages collection.
   */
  function connect(): Promise<any> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mongoClient =
          client ??
          new MongoClient((uri as string), {
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
        // Supports `searchMessages`' body lookup. Deliberately a plain
        // shard-key-prefixed index rather than a `text` index: Azure Cosmos DB
        // for MongoDB (RU) does not support text indexes / `$text`, so the
        // search is expressed as a case-insensitive literal match on `body`
        // (see `searchMessages`), which is served identically on the in-memory
        // store, MongoDB/vCore and Cosmos RU.
        await createIndexOrWarn(messages, { conversationId: 1, body: 1 });

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
      //
      const result = await messages.updateOne(
        { conversationId: record.conversationId, messageId: record.messageId },
        { $setOnInsert: { ...record } },
        { upsert: true }
      );
      // The write was a replay of an already-stored message: return the stored
      // document rather than this copy of it, so the caller (and the sender)
      // sees what is actually persisted.
      if (!result?.upsertedCount) {
        const existing = await messages.findOne({
          conversationId: record.conversationId,
          messageId: record.messageId,
        });
        if (existing?.messageId) {
          // Strip the driver-managed `_id` so the shape matches the memory store.
          const { _id, ...rest } = existing;
          return rest;
        }
      }
      return record;
    },

    async listMessages({ conversationId, limit, before } = {}) {
      const cap = clampLimit(limit);
      const { messages } = await connect();
      const query: Record<string, unknown> = { conversationId };
      if (before) {
        query.createdAt = { $lt: before };
      }
      const found = await messages
        .find(query)
        .sort({ conversationId: 1, createdAt: -1, messageId: -1 })
        .limit(cap)
        .toArray();
      // Strip the driver-managed `_id` so the wire shape matches the memory store.
      return found.map(({ _id, ...rest }: any) => rest);
    },

    async searchMessages({ userId, query, limit, before } = {}) {
      const term = normaliseSearchTerm(query);
      if (!term || !userId) return [];
      const cap = clampLimit(limit);
      const { messages } = await connect();
      const filter: Record<string, unknown> = {
        $or: [{ senderId: userId }, { recipientId: userId }],
        // Literal, case-insensitive substring match: the term is escaped so a
        // user cannot inject a pattern, and no `$text` is used because Cosmos
        // RU does not implement it.
        body: { $regex: escapeRegExp(term), $options: 'i' },
      };
      if (before) {
        filter.createdAt = { $lt: before };
      }
      // Deliberately no `.sort()`: the query fans out across every
      // conversation the user takes part in (i.e. across shard-key
      // partitions), which Cosmos DB for MongoDB (RU) rejects unless a
      // matching composite index serves it — impossible for a cross-partition
      // sort. Sorting happens in application code, exactly as
      // `listConversations` does, and the page is cut afterwards.
      const found = await messages.find(filter).toArray();
      return found
        .map(({ _id, ...rest }: any) => rest)
        .sort(byNewestFirst)
        .slice(0, cap);
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

      const byConversation: Map<string, ConversationSummary> = new Map();

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

    async deleteMessage(conversationId, messageId, userId) {
      const { messages } = await connect();
      // The `senderId` in the filter is the authorisation check: a delete for
      // someone else's message matches nothing and reports "not found".
      // Shard-key (`conversationId`) prefixed so Cosmos can route the write.
      const existing = await messages.findOne({ conversationId, messageId, senderId: userId });
      if (!existing?.messageId || existing.deletedAt) return null;
      const { _id, ...rest } = existing;
      // A tombstone rather than a deletion: the content goes, the row stays so
      // a reply quoting it still resolves on both clients.
      const tombstone = applyTombstone(rest, nextTimestamp());
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
      const { _id, ...rest } = existing;
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

    async close() {
      if (closed || !clientPromise) return;
      closed = true;
      try {
        const { mongoClient } = await clientPromise;
        await mongoClient.close();
      } catch (error) {
        console.warn(`[messages] error while closing Mongo client: ${describeError(error)}`);
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
 * @param opts.messageStore - Pre-built store (tests / injection).
 */
function createMessageStore(opts: { messageStore?: MessageStore; } = {}): MessageStore {
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

  let client;
  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    });
  } catch (error) {
    // Only the driver's own parse/validation errors say anything about the
    // URI; anything else (a broken driver import, an out-of-memory failure, …)
    // must keep its own context instead of being blamed on configuration.
    if (isMongoUriError(error)) {
      throw new Error(`Invalid MONGODB_URI: ${describeError(error)}`);
    }
    throw new Error(`Failed to create the MongoDB client: ${describeError(error)}`);
  }

  return createMongoMessageStore({
    uri,
    dbName: process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME,
    collectionName: process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME,
    client,
  });
}

export {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_MESSAGE_BODY_LENGTH,
  DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
  deriveConversationId,
  clampLimit as clampMessageLimit,
  createMessageRecord,
  applyReaction,
  createMemoryMessageStore,
  createMongoMessageStore,
  createMessageStore,
};
