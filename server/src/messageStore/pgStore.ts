/**
 * Postgres-backed message store.
 *
 * Replaces the MongoDB store. The interface is unchanged — it was already the
 * right seam — so callers, the memory store and the whole test suite are
 * untouched by the swap.
 *
 * What moving to Postgres buys, beyond one fewer database:
 *
 *   - `listConversations` is a single `DISTINCT ON` query with the unread count
 *     joined in, instead of a fan-out read followed by `summariseConversations`
 *     grouping in application code — which had no bound at all on the number of
 *     rows it pulled back.
 *   - `searchMessages` filters and pages *in the database*, instead of fetching
 *     every candidate and slicing.
 *   - There is no `conversation_index` collection to keep consistent by hand,
 *     no compare-and-set ordering, and no `bodyLower` shadow column: the index
 *     is derived (`lower(body)` with `gin_trgm_ops`), so it cannot drift from
 *     the column it indexes.
 *
 * Search semantics are deliberately identical to the memory store's
 * `bodyMatches`: a literal, case-insensitive substring match. The term is
 * escaped for `LIKE` so a user cannot inject a pattern, exactly as it was
 * escaped for a regex before.
 */

import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { messages as messagesTable } from '../../db/schema.ts';
import { clampLimit, normaliseSearchTerm, MAX_CONVERSATION_LIMIT } from './queries.ts';
import { applyReaction, createMessageRecord, nextTimestamp } from './records.ts';
import type { Database } from '../../db/client.ts';
import type {
  ConversationSummary,
  MessageStore,
  NewMessageInput,
  StoredMessage,
} from './types.ts';

/** A row as Drizzle returns it, before it is shaped into a `StoredMessage`. */
type MessageRow = typeof messagesTable.$inferSelect;

/**
 * Escape the `LIKE` metacharacters in a user-supplied search term.
 *
 * Without this, a term containing `%` matches everything and one containing `_`
 * matches more than the user typed. `\` is the escape character declared by the
 * `ESCAPE` clause at the call site.
 */
export function escapeLikePattern(value: string): string {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/**
 * Shape a row into the domain record every caller expects.
 *
 * The timestamp columns are read in `string` mode, so they arrive as ISO text
 * and need no conversion — which matters because `createdAt` doubles as the
 * pagination cursor and a round trip through `Date` would lose precision.
 */
function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    senderId: row.senderId,
    recipientId: row.recipientId,
    body: row.body,
    type: row.type,
    attachment: (row.attachment as object | null) ?? null,
    replyTo: row.replyTo ?? null,
    reactions: (row.reactions as Record<string, string[]>) ?? {},
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    deliveredTo: [...(row.deliveredTo ?? [])],
    readAt: row.readAt ?? null,
  };
}

/** The values written by an insert, derived from the domain record. */
function toInsertValues(record: StoredMessage): typeof messagesTable.$inferInsert {
  return {
    conversationId: record.conversationId,
    messageId: record.messageId,
    senderId: record.senderId,
    recipientId: record.recipientId,
    body: record.body,
    type: record.type,
    attachment: record.attachment,
    replyTo: record.replyTo,
    reactions: record.reactions,
    deliveredTo: record.deliveredTo,
    readAt: record.readAt,
    deletedAt: record.deletedAt,
    createdAt: record.createdAt,
  };
}

/** Predicate matching one row by its composite primary key. */
function byPrimaryKey(conversationId: string, messageId: string) {
  return and(
    eq(messagesTable.conversationId, conversationId),
    eq(messagesTable.messageId, messageId)
  );
}

/** Predicate matching every message a user takes part in, either direction. */
function byParticipant(userId: string) {
  return or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId));
}

/**
 * Build the Postgres-backed message store.
 *
 * @param db - Drizzle handle. Required: the caller decides whether Postgres is
 *   configured, and falls back to the memory store when it is not.
 */
export function createPgMessageStore({ db }: { db: Database; }): MessageStore {
  return {
    type: 'postgres',

    async ready() {},

    async saveMessage(message: NewMessageInput) {
      const record = createMessageRecord(message);

      // Idempotent on `(conversationId, messageId)` — the primary key, and the
      // pair a client replays from its durable outbox. `DO NOTHING` rather than
      // an update: a replay must not overwrite the reactions, receipts or
      // tombstone the original has accumulated since.
      const inserted = await db
        .insert(messagesTable)
        .values(toInsertValues(record))
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) return toStoredMessage(inserted[0]);

      // The insert was a no-op, so the message already exists; return the
      // stored copy rather than the one that was just rejected.
      const [existing] = await db
        .select()
        .from(messagesTable)
        .where(byPrimaryKey(record.conversationId, record.messageId))
        .limit(1);
      return existing ? toStoredMessage(existing) : record;
    },

    async listMessages({ conversationId, limit, before } = {}) {
      if (!conversationId) return [];
      const rows = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.conversationId, conversationId),
            before ? lt(messagesTable.createdAt, before) : undefined
          )
        )
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(clampLimit(limit));
      return rows.map(toStoredMessage);
    },

    async searchMessages({ userId, query, limit, before } = {}) {
      const term = normaliseSearchTerm(query);
      if (!term || !userId) return [];

      // `lower(body) LIKE lower('%term%')` is exactly what the trigram GIN
      // index on `lower(body)` serves, and exactly what `bodyMatches` does in
      // the memory store.
      const pattern = `%${escapeLikePattern(term.toLowerCase())}%`;
      const rows = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            byParticipant(userId),
            sql`lower(${messagesTable.body}) like ${pattern} escape '\\'`,
            before ? lt(messagesTable.createdAt, before) : undefined
          )
        )
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(clampLimit(limit));
      return rows.map(toStoredMessage);
    },

    async markDelivered(messageId: string, userId: string, conversationId?: string) {
      // `array_append` only when the id is absent keeps the receipt idempotent
      // *in the database*, so two instances processing the same receipt cannot
      // race into a duplicate entry.
      const updated = await db
        .update(messagesTable)
        .set({
          deliveredTo: sql`case when ${messagesTable.deliveredTo} @> array[${userId}]::text[]
            then ${messagesTable.deliveredTo}
            else array_append(${messagesTable.deliveredTo}, ${userId}) end`,
        })
        .where(
          conversationId
            ? byPrimaryKey(conversationId, messageId)
            : eq(messagesTable.messageId, messageId)
        )
        .returning();

      return updated.length > 0 ? toStoredMessage(updated[0]) : null;
    },

    async listConversations(userId: string): Promise<ConversationSummary[]> {
      // One query: `DISTINCT ON` picks each conversation's newest message, and
      // the unread count is a correlated aggregate over the partial index.
      // Previously this read every message the user had ever exchanged and
      // grouped them in application code.
      const lastMessages = db
        .selectDistinctOn([messagesTable.conversationId])
        .from(messagesTable)
        .where(byParticipant(userId))
        .orderBy(
          asc(messagesTable.conversationId),
          desc(messagesTable.createdAt),
          desc(messagesTable.messageId)
        )
        .as('last_messages');

      const unreadCounts = db
        .select({
          conversationId: messagesTable.conversationId,
          unreadCount: sql<number>`count(*)::int`.as('unread_count'),
        })
        .from(messagesTable)
        .where(and(eq(messagesTable.recipientId, userId), isNull(messagesTable.readAt)))
        .groupBy(messagesTable.conversationId)
        .as('unread_counts');

      const rows = await db
        .select({
          conversationId: lastMessages.conversationId,
          messageId: lastMessages.messageId,
          senderId: lastMessages.senderId,
          recipientId: lastMessages.recipientId,
          body: lastMessages.body,
          type: lastMessages.type,
          attachment: lastMessages.attachment,
          replyTo: lastMessages.replyTo,
          reactions: lastMessages.reactions,
          deliveredTo: lastMessages.deliveredTo,
          readAt: lastMessages.readAt,
          deletedAt: lastMessages.deletedAt,
          createdAt: lastMessages.createdAt,
          unreadCount: unreadCounts.unreadCount,
        })
        .from(lastMessages)
        .leftJoin(unreadCounts, eq(lastMessages.conversationId, unreadCounts.conversationId))
        .orderBy(desc(lastMessages.createdAt), desc(lastMessages.messageId))
        .limit(MAX_CONVERSATION_LIMIT);

      return rows.map((row) => {
        const lastMessage = toStoredMessage(row as MessageRow);
        return {
          conversationId: lastMessage.conversationId,
          // The peer is the other participant, whichever end of the last
          // message the caller is on.
          peerId:
            lastMessage.senderId === userId ? lastMessage.recipientId : lastMessage.senderId,
          lastMessage,
          unreadCount: row.unreadCount ?? 0,
        };
      });
    },

    async markRead(conversationId: string, userId: string) {
      const updated = await db
        .update(messagesTable)
        .set({ readAt: nextTimestamp() })
        .where(
          and(
            eq(messagesTable.conversationId, conversationId),
            eq(messagesTable.recipientId, userId),
            isNull(messagesTable.readAt)
          )
        )
        .returning({ messageId: messagesTable.messageId });
      return updated.length;
    },

    async deleteMessage(conversationId: string, messageId: string, userId: string) {
      // Only the author may delete, and only once: the `deleted_at IS NULL`
      // predicate makes a repeated delete report "not found" rather than
      // re-notifying both participants. Both rules are in the `WHERE` clause,
      // so they are enforced by the database rather than by a read-then-write
      // that two instances could interleave.
      const updated = await db
        .update(messagesTable)
        .set({
          body: '',
          attachment: null,
          reactions: {},
          deletedAt: nextTimestamp(),
        })
        .where(
          and(
            byPrimaryKey(conversationId, messageId),
            eq(messagesTable.senderId, userId),
            isNull(messagesTable.deletedAt)
          )
        )
        .returning();

      return updated.length > 0 ? toStoredMessage(updated[0]) : null;
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action } = {}) {
      if (!conversationId || !messageId || !userId || !emoji) return null;

      const [existing] = await db
        .select()
        .from(messagesTable)
        .where(and(byPrimaryKey(conversationId, messageId), isNull(messagesTable.deletedAt)))
        .limit(1);
      if (!existing) return null;

      // The merge rule (idempotent in both directions) is shared with the
      // memory store rather than reimplemented as a jsonb expression, so the
      // two backends cannot disagree about what a retried reaction does.
      const reactions = applyReaction(
        (existing.reactions as Record<string, string[]>) ?? {},
        emoji,
        userId,
        action ?? 'add'
      );

      const updated = await db
        .update(messagesTable)
        .set({ reactions })
        .where(and(byPrimaryKey(conversationId, messageId), isNull(messagesTable.deletedAt)))
        .returning();

      return updated.length > 0 ? toStoredMessage(updated[0]) : null;
    },

    async close() {
      // The pool is owned by `db/client.ts`, which closes it during shutdown;
      // the store must not close a handle it borrowed.
    },
  };
}
