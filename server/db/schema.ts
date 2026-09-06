/**
 * Drizzle ORM schema for the studious-robot persistence layer.
 *
 * The schema is defined once here in code; `drizzle-kit generate` derives the
 * versioned SQL migrations under `db/migrations/` from it.  Tables mirror the
 * runtime record shapes used by the signaling server (see `server/src/index.js`
 * and `server/src/security.js`):
 *
 *   - users        public usernames bound to authenticated provider accounts
 *   - calls        durable call history
 *   - call_events  per-call ordered event timeline
 *   - devices      push-notification device registrations
 *   - audit_log    security/audit events
 *
 * `calls`, `call_events` and `audit_log` are append-only and are bounded by the
 * retention sweep in `src/lib/retention.ts`, not by anything in the schema.
 *   - blocks       per-user call blocklist
 *   - messages     durable chat history
 */

import { pgTable, uuid, integer, text, timestamp, jsonb, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';

/**
 * Claimed identities.
 *
 * Each public `userId` is bound to one verified Firebase `authUid`. Both values
 * are unique, preventing either username impersonation or one provider account
 * from claiming multiple public identities.
 */
const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  authUid: text('auth_uid').unique(),
  email: text('email'),
  authProvider: text('auth_provider'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
});

const calls = pgTable(
  'calls',
  {
    callId: uuid('call_id').primaryKey(),
    callerId: text('caller_id').notNull(),
    calleeId: text('callee_id').notNull(),
    status: text('status').notNull(),
    endReason: text('end_reason'),
    // Seconds of connected conversation, computed server-side when the call
    // reaches a terminal state so clients need not infer it.
    durationSeconds: integer('duration_seconds'),
    // When the callee acknowledged a missed call (opened the conversation).
    missedReadAt: timestamp('missed_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    ringTimeoutAt: timestamp('ring_timeout_at', { withTimezone: true }),
  },
  // `GET /calls` is the only query that reads this table by predicate, and it
  // reads it as `(caller_id = $1 OR callee_id = $1)` ordered by
  // `updated_at DESC, created_at DESC, call_id DESC`. The indexes therefore
  // carry the *sort* columns, in the query's own direction, behind each
  // participant column: an index keyed on `created_at` could satisfy the
  // participant half of that query but never its ordering, so every page still
  // sorted the user's whole call history before discarding all but one page.
  (t) => [
    index('idx_calls_caller_updated').on(
      t.callerId,
      desc(t.updatedAt),
      desc(t.createdAt),
      desc(t.callId)
    ),
    index('idx_calls_callee_updated').on(
      t.calleeId,
      desc(t.updatedAt),
      desc(t.createdAt),
      desc(t.callId)
    ),
    // Retained for the status-filtered variant of the same query; deliberately
    // not folded into the two indexes above, because `status` is optional and
    // leading with it would make them useless to the unfiltered page.
    index('idx_calls_status').on(t.status),
    // Serves both the retention sweep (`status IN (terminal) AND updated_at <
    // cutoff`) and bounded boot hydration, which reads the newest page rather
    // than the whole table. Neither can use the participant indexes: they lead
    // with `caller_id`/`callee_id`, and neither query has a participant.
    index('idx_calls_updated_at').on(desc(t.updatedAt), desc(t.callId)),
  ],
);

const callEvents = pgTable(
  'call_events',
  {
    eventId: uuid('event_id').primaryKey(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.callId, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actor: text('actor'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_call_events_call').on(t.callId, t.createdAt)],
);

/**
 * Push-notification device registrations.
 *
 * Uniqueness semantics (see the stale-token incident write-up in
 * `server/src/push.js` and the PR that introduced this index):
 *
 *  - `device_id` is the **per-install** identity and is already the primary
 *    key, so `POST /devices/register` upserting on `deviceId` (see
 *    `persistDevice`) already replaces — never duplicates — the row for a
 *    given (user_id, device_id). Re-registering the same install with a
 *    fresh token overwrites the old one in place.
 *  - A push **token** is additionally unique **globally** (the partial index
 *    below, `WHERE push_token IS NOT NULL`): a live FCM/APNs token can only
 *    ever belong to one row. This matters when the *same physical device*
 *    (same install, e.g. no reinstall) signs in as a different user — the
 *    previous owner's row must not keep holding a token that would let it
 *    keep receiving that device's calls. `persistDevice` clears the token
 *    from any other row before writing the new registration.
 *  - What this index does *not* solve: an app reinstall wipes the
 *    client-persisted `device_id`, so the same physical handset registers as
 *    a brand-new row with a brand-new token, orphaning the old row (which
 *    keeps its now-dead token forever otherwise). Three things handle that:
 *    dead-token pruning on delivery failure (`pruneDeadDevice`), which only
 *    fires when a provider actually reports `UNREGISTERED`/`INVALID_ARGUMENT`
 *    — notably *not* on the Azure Notification Hubs path, where a `201` only
 *    means the hub queued the notification; an age-based sweep of rows whose
 *    registration has not been refreshed within `STALE_DEVICE_MAX_AGE_MS`
 *    (`pruneStaleDevices`), which is the mechanism that actually collects
 *    reinstall orphans; and a bounded, most-recently-registered-first push
 *    fan-out per user (see `resolveReachableChannels`).
 */
const devices = pgTable(
  'devices',
  {
    deviceId: text('device_id').primaryKey(),
    userId: text('user_id').notNull(),
    platform: text('platform'),
    pushProvider: text('push_provider'),
    pushToken: text('push_token'),
    lastRegisteredAt: timestamp('last_registered_at', { withTimezone: true }),
    lastUnregisteredAt: timestamp('last_unregistered_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_devices_user').on(t.userId),
    uniqueIndex('idx_devices_push_token_unique')
      .on(t.pushToken)
      .where(sql`${t.pushToken} is not null`),
  ],
);

const auditLog = pgTable(
  'audit_log',
  {
    auditId: uuid('audit_id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    event: text('event').notNull(),
    actor: text('actor'),
    target: text('target'),
    outcome: text('outcome').notNull(),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    index('idx_audit_actor').on(t.actor, t.ts),
    index('idx_audit_target').on(t.target, t.ts),
    // The retention sweep's only predicate is `ts < cutoff`; the two indexes
    // above lead with a nullable actor/target and cannot serve it.
    index('idx_audit_ts').on(t.ts),
  ],
);

const blocks = pgTable(
  'blocks',
  {
    blockerId: text('blocker_id').notNull(),
    blockeeId: text('blockee_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockeeId] })],
);

/**
 * Durable chat history.
 *
 * Replaces the MongoDB `messages` collection.  The move to Postgres is what
 * lets the chat list and the conversation timeline be *joins* over `messages`
 * and `calls` in one query, rather than two independently-limited reads merged
 * in application code — which is what made missed calls vanish and the merged
 * timeline page incorrectly.
 *
 * Column notes:
 *
 *   - `messageId` is client-supplied (an outbox replay resends the same id), so
 *     it is `text`, not `uuid`: the server must not reject or rewrite an id it
 *     did not mint.  `(conversationId, messageId)` is the primary key, which is
 *     exactly the upsert conflict target `saveMessage` needs to stay idempotent.
 *   - `deliveredTo` is a `text[]` rather than a join table.  It is only ever
 *     read whole, written by appending, and bounded at two entries by the 1:1
 *     conversation model; a second table would add a join to every read to
 *     model a list that never grows.
 *   - `reactions` is `jsonb` (emoji → user ids) for the same reason.
 *   - `deletedAt` marks a tombstone: the row survives a delete so a reply that
 *     quotes it still resolves.  `body` is emptied rather than the row removed.
 */
const messages = pgTable(
  'messages',
  {
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull(),
    senderId: text('sender_id').notNull(),
    recipientId: text('recipient_id').notNull(),
    body: text('body').notNull(),
    type: text('type').notNull(),
    attachment: jsonb('attachment'),
    replyTo: text('reply_to'),
    reactions: jsonb('reactions').notNull().default({}),
    deliveredTo: text('delivered_to').array().notNull().default(sql`'{}'::text[]`),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageId] }),
    // `listMessages` reads one conversation newest-first, tie-broken by
    // `messageId`, and pages with a `created_at <` cursor. The index carries
    // the sort columns in the query's own direction so a page is an index scan
    // rather than a sort of the whole conversation.
    index('idx_messages_conversation_created').on(
      t.conversationId,
      desc(t.createdAt),
      desc(t.messageId)
    ),
    // `listConversations` and `searchMessages` select on participation in
    // either direction, then sort newest-first.
    index('idx_messages_sender_created').on(t.senderId, desc(t.createdAt)),
    index('idx_messages_recipient_created').on(t.recipientId, desc(t.createdAt)),
    // Unread counting reads `(recipient_id, conversation_id)` where `read_at IS
    // NULL`; partial, because a read message is never counted and there are far
    // more of those than unread ones.
    index('idx_messages_unread')
      .on(t.recipientId, t.conversationId)
      .where(sql`${t.readAt} is null`),
    // Search is a literal, case-insensitive *substring* match — the semantics
    // the memory store implements and the API has always had. A btree cannot
    // serve an unanchored `LIKE '%term%'`, so this is a trigram GIN index over
    // the folded body; see migration 0010 for the extension it requires.
    index('idx_messages_body_trgm')
      .using('gin', sql`lower(${t.body}) gin_trgm_ops`),
  ],
);

export { users, calls, callEvents, devices, auditLog, blocks, messages };
