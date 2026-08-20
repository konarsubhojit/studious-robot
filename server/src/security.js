// @ts-check
'use strict';

const { randomUUID } = require('crypto');
const { toLogMessage } = require('./lib/normalize');

/**
 * Security utilities for call initiation and signaling hardening.
 *
 * Provides:
 *  - Fixed-window rate limiter (call initiation + RTC signaling flood control)
 *  - Blocklist helpers (per-user opt-in call privacy)
 *  - Append-only audit log (blocked calls, rate limits, block management, session rotations)
 */

/**
 * A fixed-window rate limiter, as returned by {@link createRateLimiter}.
 *
 * @typedef {object} RateLimiter
 * @property {(key: string, now?: number) => { allowed: boolean, remaining: number, resetAt: number }} check
 * @property {(key: string) => void} reset
 */

/**
 * A single recorded security event.
 *
 * @typedef {object} AuditEntry
 * @property {string} auditId
 * @property {string} timestamp  ISO timestamp.
 * @property {string} event
 * @property {string|null} actor
 * @property {string|null} target
 * @property {string} outcome
 * @property {object} details
 */

/**
 * Minimal structural view of the Drizzle handle used for audit persistence:
 * only the fire-and-forget insert path is exercised here.
 *
 * @typedef {object} AuditDb
 * @property {(table: unknown) => { values: (row: object) => Promise<unknown> }} insert
 */

/**
 * The append-only audit log returned by {@link createAuditLog}.
 *
 * @typedef {object} AuditLog
 * @property {(entry: { event: string, actor?: string|null, target?: string|null, outcome: string, details?: object }) => void} record
 * @property {(userId: string) => AuditEntry[]} getForUser
 * @property {() => AuditEntry[]} getAll
 */

const MAX_AUDIT_LOG_SIZE = 1000;

// ─── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Create a fixed-window rate limiter.
 *
 * Each unique `key` gets its own counter that resets after `windowMs`
 * milliseconds.  Once `maxRequests` is reached within the current window
 * the limiter returns `{ allowed: false }` until the window rolls over.
 *
 * The `now` parameter accepted by `check()` lets callers inject a synthetic
 * clock for deterministic unit tests.
 *
 * @param {{ maxRequests: number, windowMs: number }} opts
 * @returns {RateLimiter}
 */
function createRateLimiter({ maxRequests, windowMs }) {
  /** @type {Map<string, { windowStart: number, count: number }>} */
  const buckets = new Map();

  return {
    /**
     * Check whether the action identified by `key` is allowed, and if so
     * increment its counter.
     *
     * @param {string} key    - Unique identifier for the rate-limited subject (e.g. userId).
     * @param {number} [now]  - Unix timestamp in ms; defaults to `Date.now()`.
     * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
     */
    check(key, now = Date.now()) {
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        bucket = { windowStart: now, count: 0 };
        buckets.set(key, bucket);
      }
      if (bucket.count >= maxRequests) {
        return { allowed: false, remaining: 0, resetAt: bucket.windowStart + windowMs };
      }
      bucket.count += 1;
      return {
        allowed: true,
        remaining: maxRequests - bucket.count,
        resetAt: bucket.windowStart + windowMs,
      };
    },

    /**
     * Reset the counter for a specific key, or clear all buckets when called
     * with no argument.  Intended for testing only.
     *
     * @param {string} [key]
     */
    reset(key) {
      if (key === undefined) {
        buckets.clear();
      } else {
        buckets.delete(key);
      }
    },
  };
}

// ─── Blocklist helpers ────────────────────────────────────────────────────────

/**
 * Return `true` when `blockerId` has blocked `targetId`.
 *
 * The blocklist is stored as `Map<blockerId, Set<blockedId>>`.
 * A caller checks whether the *callee* has blocked *them*:
 *   `isBlocked(blocks, calleeId, callerId)`.
 *
 * @param {Map<string, Set<string>>} blocks
 * @param {string} blockerId
 * @param {string} targetId
 * @returns {boolean}
 */
function isBlocked(blocks, blockerId, targetId) {
  return blocks.get(blockerId)?.has(targetId) ?? false;
}

/**
 * Add a block entry.  Idempotent: re-blocking has no effect.
 *
 * @param {Map<string, Set<string>>} blocks
 * @param {string} blockerId
 * @param {string} blockedId
 */
function addBlock(blocks, blockerId, blockedId) {
  if (!blocks.has(blockerId)) {
    blocks.set(blockerId, new Set());
  }
  blocks.get(blockerId)?.add(blockedId);
}

/**
 * Remove a block entry.
 *
 * @param {Map<string, Set<string>>} blocks
 * @param {string} blockerId
 * @param {string} blockedId
 * @returns {boolean} `true` when the block existed and was removed.
 */
function removeBlock(blocks, blockerId, blockedId) {
  const set = blocks.get(blockerId);
  if (!set) return false;
  const removed = set.delete(blockedId);
  if (set.size === 0) blocks.delete(blockerId);
  return removed;
}

/**
 * Return the list of user IDs blocked by `blockerId`.
 *
 * @param {Map<string, Set<string>>} blocks
 * @param {string} blockerId
 * @returns {string[]}
 */
function listBlocks(blocks, blockerId) {
  return Array.from(blocks.get(blockerId) ?? []);
}

// ─── Audit log ────────────────────────────────────────────────────────────────

/**
 * Create an in-process append-only audit log with a fixed capacity.
 *
 * When the log reaches `MAX_AUDIT_LOG_SIZE` the oldest entry is dropped
 * (FIFO eviction) to prevent unbounded memory growth.
 *
 * Recorded event types:
 *   `call.blocked`      – a blocked caller attempted to initiate a call
 *   `call.rate_limited` – call-initiation rate limit was exceeded
 *   `rtc.rate_limited`  – RTC-signaling rate limit was exceeded
 *   `block.added`       – a user blocked another user
 *   `block.removed`     – a user unblocked another user
 *   `session.refreshed` – a session token was rotated
 *
 * When a Drizzle `db` handle is supplied, every recorded event is *also*
 * persisted (fire-and-forget) to the `audit_log` table so the security trail
 * survives restarts and is queryable outside this process.  DB failures are
 * logged but never block the in-memory record or the request that triggered it.
 *
 * @param {{ db?: AuditDb|null }} [options]
 * @returns {AuditLog}
 */
function createAuditLog({ db = null } = {}) {
  /** @type {AuditEntry[]} */
  const entries = [];

  /**
   * Best-effort durable persistence of a single audit record.  No-op when no
   * `db` is configured (tests / no DATABASE_URL).
   *
   * @param {AuditEntry} entry
   */
  function persist(entry) {
    if (!db) return;
    try {
      const { auditLog: auditLogTable } = require('../db/schema');
      db.insert(auditLogTable)
        .values({
          auditId: entry.auditId,
          ts: new Date(entry.timestamp),
          event: entry.event,
          actor: entry.actor,
          target: entry.target,
          outcome: entry.outcome,
          details: entry.details ?? {},
        })
        .catch((err) => {
          console.error('[security] failed to persist audit event to DB:', toLogMessage(err));
        });
    } catch (err) {
      console.error('[security] failed to persist audit event to DB:', toLogMessage(err));
    }
  }

  return {
    /**
     * Append a security event to the log.
     *
     * @param {{ event: string, actor?: string|null, target?: string|null, outcome: string, details?: object }} entry
     */
    record({ event, actor = null, target = null, outcome, details = {} }) {
      if (entries.length >= MAX_AUDIT_LOG_SIZE) {
        entries.shift();
      }
      const entry = {
        auditId: randomUUID(),
        timestamp: new Date().toISOString(),
        event,
        actor,
        target,
        outcome,
        details,
      };
      entries.push(entry);
      persist(entry);
    },

    /**
     * Return all entries where the session user is the actor or the target.
     *
     * @param {string} userId
     * @returns {AuditEntry[]}
     */
    getForUser(userId) {
      return entries.filter((e) => e.actor === userId || e.target === userId);
    },

    /**
     * Return all entries.  Used internally and for testing.
     *
     * @returns {AuditEntry[]}
     */
    getAll() {
      return [...entries];
    },
  };
}

module.exports = {
  createRateLimiter,
  isBlocked,
  addBlock,
  removeBlock,
  listBlocks,
  createAuditLog,
};
