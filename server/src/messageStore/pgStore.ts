/**
 * Postgres-backed message store.
 *
 * Replaces the MongoDB store. The interface is unchanged — it was already the
 * right seam — so callers, the memory store and the whole test suite are
 * untouched by the swap.
 *
 * What moving to Postgres buys, beyond one fewer database:
 *
 *   - `listConversations` reads a bounded page from its one-row-per-conversation
 *     projection, then joins those message pointers back to the source table.
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

import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { conversations as conversationsTable, messages as messagesTable } from '../../db/schema.ts';
import {
  clampExportReadLimit,
  clampLimit,
  normaliseSearchTerm,
  MAX_CONVERSATION_LIMIT,
} from './queries.ts';
import { applyReaction, createMessageRecord, nextTimestamp } from './records.ts';
import { normalizeTimestamp } from '../../../shared/time.ts';
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
 * The handle passed into `db.transaction(...)`. Derived rather than imported
 * from `drizzle-orm/pg-core` directly, so it always matches whatever
 * generics `Database` is instantiated with.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
 * The timestamp columns are read in `string` mode, which does *not* mean ISO
 * text: Drizzle's node-postgres session replaces the driver's `timestamptz`
 * parser with the identity function, so what arrives is Postgres' own
 * rendering — `2026-09-09 14:16:47.89+00`, with a space separator, the trailing
 * zeroes of the fraction trimmed and a two-digit offset.  That is neither
 * comparable against the ISO timestamps call records carry (a space sorts
 * before `T`, so every call looked newer than every message from the same day)
 * nor parseable by Hermes, which the mobile app runs.  Normalising here — the
 * one place every read is shaped — restores the invariant the rest of the
 * system is written against: a timestamp is fixed-width UTC ISO, so comparing
 * two of them lexicographically is the same as comparing them chronologically.
 *
 * Lossless for this table: every writer of these three columns goes through
 * `nextTimestamp()`, which has millisecond resolution, so the sub-millisecond
 * digits normalisation drops are always the zeroes Postgres padded them with.
 * That matters because `createdAt` doubles as the `before` pagination cursor,
 * whose tie-break is an equality test against the stored value.
 */
function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    senderId: row.senderId,
    recipientId: row.recipientId,
    body: row.body,
    type: row.type,
    attachment:
      (row.attachment as import('../../../shared/signaling/schemas.ts').AttachmentRecord | null) ??
      null,
    replyTo: row.replyTo ?? null,
    reactions: (row.reactions as Record<string, string[]>) ?? {},
    deletedAt: normalizeTimestamp(row.deletedAt ?? null),
    createdAt: normalizeTimestamp(row.createdAt),
    deliveredTo: [...(row.deliveredTo ?? [])],
    readAt: normalizeTimestamp(row.readAt ?? null),
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
 * Sort two participant ids the same way `deriveConversationId` does.
 *
 * The projection's `participant_a`/`participant_b` columns exist so a
 * participant's unread counter is addressable by a plain string comparison
 * ("am I A or B?") rather than another lookup; that only holds if every writer
 * sorts the pair identically.
 */
function sortedParticipants(userA: string, userB: string): [string, string] {
  return userA < userB ? [userA, userB] : [userB, userA];
}

/**
 * Advance the conversation-list projection for one newly-inserted message, in
 * the same transaction as the insert.
 *
 * Two invariants, enforced by two separate statements rather than folded into
 * one `ON CONFLICT DO UPDATE`, because they have different guards:
 *
 *   - The last-message pointer is order-sensitive: an out-of-order arrival or
 *     a concurrent writer must not let an older message overwrite a newer
 *     preview. The row-value comparison mirrors the `(created_at, message_id)`
 *     tie-break used throughout this module. Gating the whole conflict action
 *     on that guard (`setWhere`) is exactly what a single upsert can express.
 *   - The unread bump is *not* order-sensitive: an older message that loses
 *     the pointer race is still unread, so it must count regardless of
 *     whether the guard above fired. That cannot share the guarded statement —
 *     a `setWhere` that is false skips the whole `DO UPDATE`, unread column
 *     included — so it is a second, unconditional statement.
 *
 * Both run only when this call performed the insert (see `saveMessageWithStatus`):
 * a replay of an already-stored message must not double-count unread.
 */
async function advanceConversationProjection(tx: Tx, record: StoredMessage): Promise<void> {
  const [participantA, participantB] = sortedParticipants(record.senderId, record.recipientId);
  const recipientIsA = record.recipientId === participantA;

  // Ensure the row exists, and move the last-message pointer forward only if
  // this message is newer than whatever it currently points at. The unread
  // counters are seeded at zero here — even for a brand-new row — because the
  // increment below always accounts for this message; seeding one at 1 would
  // double-count it for a fresh conversation.
  await tx
    .insert(conversationsTable)
    .values({
      conversationId: record.conversationId,
      participantA,
      participantB,
      lastMessageId: record.messageId,
      lastCreatedAt: record.createdAt,
      unreadA: 0,
      unreadB: 0,
    })
    .onConflictDoUpdate({
      target: conversationsTable.conversationId,
      set: {
        lastMessageId: sql`excluded.last_message_id`,
        lastCreatedAt: sql`excluded.last_created_at`,
      },
      setWhere: sql`(${conversationsTable.lastCreatedAt}, ${conversationsTable.lastMessageId})
        < (excluded.last_created_at, excluded.last_message_id)`,
    });

  await tx
    .update(conversationsTable)
    .set(
      recipientIsA
        ? { unreadA: sql`${conversationsTable.unreadA} + 1` }
        : { unreadB: sql`${conversationsTable.unreadB} + 1` }
    )
    .where(eq(conversationsTable.conversationId, record.conversationId));
}

/**
 * Build the Postgres-backed message store.
 *
 * @param db - Drizzle handle. Required: the caller decides whether Postgres is
 *   configured, and falls back to the memory store when it is not.
 */
export function createPgMessageStore({ db }: { db: Database; }): MessageStore {
  const saveMessageWithStatus: MessageStore['saveMessageWithStatus'] = async (message) => {
    const record = createMessageRecord(message);

    // The insert and the projection update must land together: a crash or a
    // concurrent instance between them would let the two disagree about
    // whether a message counts as unread. `db.transaction` is Postgres
    // `BEGIN`/`COMMIT` around both statements, not two independent ones.
    return db.transaction(async (tx) => {
      // Idempotent on `(conversationId, messageId)` — the primary key, and the
      // pair a client replays from its durable outbox. `DO NOTHING` rather than
      // an update: a replay must not overwrite the reactions, receipts or
      // tombstone the original has accumulated since.
      const inserted = await tx
        .insert(messagesTable)
        .values(toInsertValues(record))
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0) {
        // Gated on an actual insert: a replay from the client's durable
        // outbox resends the same `(conversationId, messageId)` and must not
        // bump the unread counter a second time.
        await advanceConversationProjection(tx, record);
        return { message: toStoredMessage(inserted[0]), inserted: true };
      }

      // The insert was a no-op, so the message already exists; return the
      // stored copy rather than the one that was just rejected.
      const [existing] = await tx
        .select()
        .from(messagesTable)
        .where(byPrimaryKey(record.conversationId, record.messageId))
        .limit(1);
      return { message: existing ? toStoredMessage(existing) : record, inserted: false };
    });
  };

  return {
    type: 'postgres',

    async ready() {},

    async saveMessage(message: NewMessageInput) {
      return (await saveMessageWithStatus(message)).message;
    },

    saveMessageWithStatus,

    async listMessages({ conversationId, limit, before, beforeMessageId, withLookahead } = {}) {
      if (!conversationId) return [];
      const rows = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.conversationId, conversationId),
            before
              ? or(
                  lt(messagesTable.createdAt, before),
                  beforeMessageId
                    ? and(
                        eq(messagesTable.createdAt, before),
                        lt(messagesTable.messageId, beforeMessageId)
                      )
                    : undefined
                )
              : undefined
          )
        )
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(withLookahead ? clampExportReadLimit(limit) : clampLimit(limit));
      return rows.map(toStoredMessage);
    },

    async getMessage(conversationId: string, messageId: string) {
      const [row] = await db
        .select()
        .from(messagesTable)
        .where(byPrimaryKey(conversationId, messageId))
        .limit(1);
      return row ? toStoredMessage(row) : null;
    },

    async searchMessages({ userId, query, limit, before, beforeMessageId, withLookahead } = {}) {
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
            before
              ? or(
                  lt(messagesTable.createdAt, before),
                  beforeMessageId
                    ? and(
                        eq(messagesTable.createdAt, before),
                        lt(messagesTable.messageId, beforeMessageId)
                      )
                    : undefined
                )
              : undefined
          )
        )
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(withLookahead ? clampExportReadLimit(limit) : clampLimit(limit));
      return rows.map(toStoredMessage);
    },

    async listUserMessages({ userId, limit, before, beforeMessageId } = {}) {
      if (!userId) return [];
      const rows = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            byParticipant(userId),
            before
              ? or(
                  lt(messagesTable.createdAt, before),
                  beforeMessageId
                    ? and(
                        eq(messagesTable.createdAt, before),
                        lt(messagesTable.messageId, beforeMessageId)
                      )
                    : undefined
                )
              : undefined
          )
        )
        .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(clampExportReadLimit(limit));
      return rows.map(toStoredMessage);
    },

    async markDelivered(messageId: string, userId: string, conversationId?: string) {
      // The primary key is `(conversation_id, message_id)` and a btree cannot
      // serve a probe on its second column alone, so `where message_id = $1`
      // is a sequential scan of the whole table — on a write path, once per
      // delivery receipt, growing with total chat volume across all users.
      // Every caller today holds the conversation id (and one that only has
      // both participants can derive it with `deriveConversationId`), so this
      // branch is dead; it warns rather than silently degrading, so a future
      // caller cannot reintroduce the scan unnoticed.
      if (!conversationId) {
        console.warn(
          `[messages] markDelivered without a conversationId falls back to a` +
            ` sequential scan of "messages" messageId=${messageId}`
        );
      }
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
      // Bound the projection scan before touching `messages`: its participant
      // indexes supply this ordering directly, and the join below is therefore
      // at most MAX_CONVERSATION_LIMIT primary-key lookups.
      const selectedConversations = db
        .select({
          conversationId: conversationsTable.conversationId,
          lastMessageId: conversationsTable.lastMessageId,
          lastCreatedAt: conversationsTable.lastCreatedAt,
          unreadCount: sql<number>`case when ${conversationsTable.participantA} = ${userId}
            then ${conversationsTable.unreadA} else ${conversationsTable.unreadB} end`.as(
            'unread_count'
          ),
        })
        .from(conversationsTable)
        .where(
          or(
            eq(conversationsTable.participantA, userId),
            eq(conversationsTable.participantB, userId)
          )
        )
        .orderBy(
          desc(conversationsTable.lastCreatedAt),
          desc(conversationsTable.lastMessageId)
        )
        .limit(MAX_CONVERSATION_LIMIT)
        .as('selected_conversations');

      const rows = await db
        .select({
          conversationId: messagesTable.conversationId,
          messageId: messagesTable.messageId,
          senderId: messagesTable.senderId,
          recipientId: messagesTable.recipientId,
          body: messagesTable.body,
          type: messagesTable.type,
          attachment: messagesTable.attachment,
          replyTo: messagesTable.replyTo,
          reactions: messagesTable.reactions,
          deliveredTo: messagesTable.deliveredTo,
          readAt: messagesTable.readAt,
          deletedAt: messagesTable.deletedAt,
          createdAt: messagesTable.createdAt,
          unreadCount: selectedConversations.unreadCount,
        })
        .from(selectedConversations)
        .innerJoin(
          messagesTable,
          and(
            eq(messagesTable.conversationId, selectedConversations.conversationId),
            eq(messagesTable.messageId, selectedConversations.lastMessageId)
          )
        )
        .orderBy(
          desc(selectedConversations.lastCreatedAt),
          desc(selectedConversations.lastMessageId)
        );

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
      // Flipping the messages and zeroing the reader's counter must land
      // together, or a crash between them leaves the counter stale until the
      // next message re-derives it.
      return db.transaction(async (tx) => {
        const updated = await tx
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

        // Set to zero rather than decrementing by `updated.length`: the
        // predicate above is already "every unread message addressed to this
        // user in this conversation", so zero is exactly right and, unlike a
        // decrement, is self-healing against any drift concurrency caused.
        // Which column depends on whether this reader sorts before or after
        // their peer, so it is a string comparison against the stored
        // participant columns rather than another lookup.
        await tx
          .update(conversationsTable)
          .set({
            unreadA: sql`case when ${conversationsTable.participantA} = ${userId}
              then 0 else ${conversationsTable.unreadA} end`,
            unreadB: sql`case when ${conversationsTable.participantB} = ${userId}
              then 0 else ${conversationsTable.unreadB} end`,
          })
          .where(eq(conversationsTable.conversationId, conversationId));

        return updated.length;
      });
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
