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
 *   - conversations  projection of one row per 1:1 message conversation
 */

import { pgTable, uuid, integer, real, text, timestamp, jsonb, index, primaryKey, uniqueIndex, bigserial, foreignKey } from 'drizzle-orm/pg-core';
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
  displayName: text('display_name'),
  avatarKey: text('avatar_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

const calls = pgTable(
  'calls',
  {
    callId: uuid('call_id').primaryKey(),
    callerId: text('caller_id').notNull(),
    calleeId: text('callee_id').notNull(),
    mediaType: text('media_type').notNull().default('video'),
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

const callQualitySamples = pgTable(
  'call_quality_samples',
  {
    sampleId: uuid('sample_id').primaryKey().defaultRandom(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.callId, { onDelete: 'cascade' }),
    rttMs: real('rtt_ms').notNull(),
    jitterMs: real('jitter_ms').notNull(),
    packetLossPercent: real('packet_loss_percent').notNull(),
    bitrateBps: real('bitrate_bps').notNull(),
    codec: text('codec').notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_call_quality_call_sampled').on(t.callId, desc(t.sampledAt)),
    index('idx_call_quality_sampled').on(t.sampledAt),
  ],
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
 *   - `messageId` is server-generated for explicit-key sends; it remains text
 *     for legacy clients supplying their own id. `clientMessageId` is a nullable
 *     compose-time UUID, unique per sender. NULL leaves legacy rows unchanged.
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
    clientMessageId: uuid('client_message_id'),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageId] }),
    uniqueIndex('idx_messages_sender_client_message').on(t.senderId, t.clientMessageId),
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
    index('idx_messages_body_fts')
      .using('gin', sql`to_tsvector('simple', ${t.body})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

const messageChanges = pgTable(
  'message_changes',
  {
    changeId: bigserial('change_id', { mode: 'bigint' }).primaryKey(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id').notNull(),
    senderId: text('sender_id').notNull(),
    recipientId: text('recipient_id').notNull(),
    changeType: text('change_type').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'string' }).notNull(),
    message: jsonb('message').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.conversationId, t.messageId],
      foreignColumns: [messages.conversationId, messages.messageId],
    }).onDelete('cascade'),
    index('idx_message_changes_sender_cursor').on(t.senderId, t.changedAt, t.changeId),
    index('idx_message_changes_recipient_cursor').on(t.recipientId, t.changedAt, t.changeId),
  ],
);

/**
 * One-row-per-thread projection over `messages`.
 *
 * `messages` remains the source of truth; this table exists so a conversation
 * list page can read the latest-message pointer and unread counters directly.
 * Participant columns preserve `deriveConversationId`'s sorted ordering, which
 * lets app code decide whether to touch `unreadA` or `unreadB` with a string
 * comparison rather than another lookup.
 */
const conversations = pgTable(
  'conversations',
  {
    conversationId: text('conversation_id').primaryKey(),
    participantA: text('participant_a').notNull(),
    participantB: text('participant_b').notNull(),
    lastMessageId: text('last_message_id').notNull(),
    lastCreatedAt: timestamp('last_created_at', { withTimezone: true, mode: 'string' }).notNull(),
    unreadA: integer('unread_a').notNull().default(0),
    unreadB: integer('unread_b').notNull().default(0),
  },
  (t) => [
    index('idx_conversations_a').on(
      t.participantA,
      desc(t.lastCreatedAt),
      desc(t.lastMessageId)
    ),
    index('idx_conversations_b').on(
      t.participantB,
      desc(t.lastCreatedAt),
      desc(t.lastMessageId)
    ),
  ],
);

const groupConversations = pgTable(
  'group_conversations',
  {
    conversationId: uuid('conversation_id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    creatorId: text('creator_id').notNull(),
    membershipVersion: integer('membership_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_group_conversations_updated').on(desc(t.updatedAt)),
  ],
);

const groupConversationMembers = pgTable(
  'group_conversation_members',
  {
    memberId: uuid('member_id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => groupConversations.conversationId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    departureActorId: text('departure_actor_id'),
    departureReason: text('departure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_group_members_active_unique').on(t.conversationId, t.userId).where(sql`${t.leftAt} is null`),
    index('idx_group_members_user').on(t.userId, t.conversationId),
    index('idx_group_members_active').on(t.conversationId, t.leftAt),
  ],
);

const groupInvitations = pgTable('group_invitations', {
  invitationId: uuid('invitation_id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => groupConversations.conversationId, { onDelete: 'cascade' }),
  inviteeId: text('invitee_id').notNull(),
  issuerId: text('issuer_id').notNull(),
  membershipVersion: integer('membership_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, t => [
  index('idx_group_invitations_invitee').on(t.inviteeId, t.expiresAt),
  uniqueIndex('idx_group_invitations_pending').on(t.conversationId, t.inviteeId)
    .where(sql`${t.acceptedAt} is null and ${t.cancelledAt} is null`),
]);

const groupMembershipEvents = pgTable('group_membership_events', {
  eventId: uuid('event_id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => groupConversations.conversationId, { onDelete: 'cascade' }),
  membershipVersion: integer('membership_version').notNull(),
  event: text('event').notNull(),
  actorId: text('actor_id').notNull(),
  userId: text('user_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('idx_group_membership_events_order').on(t.conversationId, t.membershipVersion, t.createdAt, t.eventId)]);

const groupMessages = pgTable(
  'group_messages',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => groupConversations.conversationId, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    senderId: text('sender_id').notNull(),
    body: text('body').notNull(),
    type: text('type').notNull(),
    attachment: jsonb('attachment'),
    replyTo: text('reply_to'),
    reactions: jsonb('reactions').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    clientMessageId: uuid('client_message_id'),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageId] }),
    uniqueIndex('idx_group_messages_sender_client_message').on(t.senderId, t.clientMessageId),
    index('idx_group_messages_created').on(t.conversationId, desc(t.createdAt), desc(t.messageId)),
  ],
);

const groupCalls = pgTable(
  'group_calls',
  {
    callId: uuid('call_id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => groupConversations.conversationId, { onDelete: 'cascade' }),
    initiatorId: text('initiator_id').notNull(),
    mediaType: text('media_type').notNull().default('video'),
    status: text('status').notNull(),
    stateVersion: integer('state_version').notNull().default(1),
    ringTimeoutAt: timestamp('ring_timeout_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_group_calls_conversation').on(t.conversationId, desc(t.createdAt)),
    index('idx_group_calls_retention').on(t.status, t.updatedAt),
    index('idx_group_calls_ringing_timeout')
      .on(t.ringTimeoutAt)
      .where(sql`${t.status} = 'ringing'`),
  ],
);

const groupCallParticipants = pgTable(
  'group_call_participants',
  {
    callId: uuid('call_id')
      .notNull()
      .references(() => groupCalls.callId, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    status: text('status').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.userId] }),
    index('idx_group_call_participant_user').on(t.userId, t.status),
  ],
);

// Independent of groups and accounts: erasure must not cascade pending keys.
const groupAttachmentCleanup = pgTable('group_attachment_cleanup', {
  url: text('url').primaryKey(),
});

/**
 * Queued account erasures (right to erasure).
 *
 * A deletion request is not carried out inside the request that made it: the
 * cascade spans Postgres, Redis and R2, and a partial failure mid-request
 * leaves an account half-erased with nothing to resume from. The row is the
 * queue, and it also holds the grace period during which the owner (or an
 * account they have recovered from a hijack) can still cancel.
 *
 * One row per user, so a repeated request is an upsert rather than a second
 * queue entry. Completed rows are kept — with no personal data beyond the
 * released username — as the record that the erasure ran.
 */
const accountDeletions = pgTable(
  'account_deletions',
  {
    userId: text('user_id').primaryKey(),
    status: text('status').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'string' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  },
  // The sweep's only predicate is `status = 'pending' AND scheduled_for <= now`.
  (t) => [index('idx_account_deletions_due').on(t.status, t.scheduledFor)],
);

export {
  users,
  calls,
  callEvents,
  callQualitySamples,
  devices,
  auditLog,
  blocks,
  messages,
  conversations,
  groupConversations,
  groupConversationMembers,
  groupInvitations,
  groupMembershipEvents,
  groupMessages,
  groupCalls,
  groupCallParticipants,
  accountDeletions,
  groupAttachmentCleanup,
  messageChanges,
};
