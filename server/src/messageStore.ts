/**
 * Persistent store for text-chat messages.
 *
 * Mirrors the transport-agnostic style of `messageBus.ts` and `stores/`: a tiny
 * interface with an in-process default and an optional durable backend, chosen
 * by environment configuration.  When no `MONGODB_URI` is configured the server
 * uses the in-memory implementation and behaves exactly as it did before chat
 * persistence existed.
 *
 * This module is the package's public face; the implementation lives in
 * `messageStore/`, one module per concern:
 *
 *  | Module                            | Responsibility                        |
 *  | --------------------------------- | ------------------------------------- |
 *  | `messageStore/types.ts`           | Domain shapes, the store interface and the typed Mongo surface. |
 *  | `messageStore/queries.ts`         | Pagination bounds, search terms and Mongo filters (pure). |
 *  | `messageStore/records.ts`         | Record creation, tombstones and reactions (pure). |
 *  | `messageStore/conversations.ts`   | Conversation grouping shared by both backends (pure). |
 *  | `messageStore/documents.ts`       | Document ↔ domain mapping.            |
 *  | `messageStore/memoryStore.ts`     | The array-backed store.               |
 *  | `messageStore/mongoConnection.ts` | Connecting, indexes and shutdown.     |
 *  | `messageStore/mongoStore.ts`      | The Mongo store's operations.         |
 *  | `messageStore/instrumentation.ts` | Query timing for `/metrics`.          |
 *  | `messageStore/factory.ts`         | Which store this process gets.        |
 *
 * Interface
 * ─────────
 *   saveMessage(message)                        → Promise<savedMessage>
 *   listMessages({ conversationId, limit, before }) → Promise<message[]>
 *   searchMessages({ userId, query, limit, before }) → Promise<message[]>
 *   markDelivered(messageId, userId, conversationId?)  → Promise<message|null>
 *   listConversations(userId)                   → Promise<conversationSummary[]>
 *   markRead(conversationId, userId, peerId?)   → Promise<number>
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

// Maximum accepted message body length, in characters: part of the wire
// contract, so it is owned by the shared package and enforced identically by
// the client and the `message.send` handler.
export { MAX_MESSAGE_BODY_LENGTH } from '../../shared/index.ts';

export type {
  ConversationSummary,
  MessageRecord,
  MessageStore,
  StoredMessage,
} from './messageStore/types.ts';

export {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  deriveConversationId,
  clampLimit as clampMessageLimit,
} from './messageStore/queries.ts';

export { applyReaction, createMessageRecord } from './messageStore/records.ts';

export { DEFAULT_SERVER_SELECTION_TIMEOUT_MS } from './messageStore/mongoConnection.ts';

export { createMemoryMessageStore } from './messageStore/memoryStore.ts';
export { createMongoMessageStore } from './messageStore/mongoStore.ts';
export { createMessageStore } from './messageStore/factory.ts';
