'use strict';

/**
 * Drizzle ORM schema for the studious-robot persistence layer.
 *
 * The schema is defined once here in code; `drizzle-kit generate` derives the
 * versioned SQL migrations under `db/migrations/` from it.  Tables mirror the
 * runtime record shapes used by the signaling server (see `server/src/index.js`
 * and `server/src/security.js`):
 *
 *   - users        claimed identities (unique userId + verification secret)
 *   - calls        durable call history
 *   - call_events  per-call ordered event timeline
 *   - devices      push-notification device registrations
 *   - audit_log    security/audit events
 *   - blocks       per-user call blocklist
 */

const {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  primaryKey,
} = require('drizzle-orm/pg-core');

/**
 * Claimed identities.
 *
 * A `userId` becomes "claimed" the first time a `POST /session` request supplies
 * a verification code for it.  The code is stored only as a salted scrypt hash
 * (`verification_hash` + `verification_salt`); the plaintext is never persisted.
 * Once an identity is claimed, a later session request for the same `userId`
 * must present the matching code, otherwise it is rejected — preventing trivial
 * impersonation.  The primary key on `user_id` enforces uniqueness.
 */
const users = pgTable('users', {
  userId: text('user_id').primaryKey(),
  verificationHash: text('verification_hash'),
  verificationSalt: text('verification_salt'),
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
  (t) => [index('idx_devices_user').on(t.userId)],
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

module.exports = { users, calls, callEvents, devices, auditLog, blocks };
