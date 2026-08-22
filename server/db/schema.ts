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
 *   - blocks       per-user call blocklist
 */

import { pgTable, uuid, integer, text, timestamp, jsonb, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
  (t) => [
    index('idx_calls_caller_created').on(t.callerId, t.createdAt),
    index('idx_calls_callee_created').on(t.calleeId, t.createdAt),
    index('idx_calls_status').on(t.status),
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
 *    keeps its now-dead token forever otherwise). That is handled instead by
 *    dead-token pruning on delivery failure (`server/src/push.js`) and by
 *    preferring the most-recently-updated device when a user still has
 *    multiple push-registered rows (see `resolveReachableChannels`).
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

export { users, calls, callEvents, devices, auditLog, blocks };
