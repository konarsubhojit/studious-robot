import { randomUUID } from 'crypto';
import { auditLog as auditLogTable } from '../db/schema.ts';
import { describeError } from './lib/errors.ts';
import { runDetached } from './lib/queryTiming.ts';

/**
 * Security utilities for call initiation and signaling hardening.
 *
 * Provides:
 *  - Fixed-window rate limiter (call initiation + RTC signaling flood control)
 *  - Blocklist helpers (per-user opt-in call privacy)
 *  - Append-only audit log (blocked calls, rate limits, block management, session rotations)
 */

const MAX_AUDIT_LOG_SIZE = 1000;

export type AuditEntry = {
  auditId: string;
  timestamp: string;
  event: string;
  actor: string | null;
  target: string | null;
  outcome: string;
  details: object;
};

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
 * Expired buckets are pruned once per window, independently of request volume.
 */
function createRateLimiter({ maxRequests, windowMs }: { maxRequests: number; windowMs: number; }):
{ check: (key: string, now?: number) => import('./stores/contracts.ts').RateLimitResult } &
{ reset: (key?: string) => void; size: () => number; } {
  const buckets: Map<string, { windowStart: number; count: number; }> = new Map();

  /** Drop every bucket whose window has already expired. */
  function sweep(now: number) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.windowStart >= windowMs) {
        buckets.delete(bucketKey);
      }
    }
  }

  const sweepTimer = setInterval(() => sweep(Date.now()), windowMs);
  sweepTimer.unref();

  return {
    /**
     * Check whether the action identified by `key` is allowed, and if so
     * increment its counter.
     *
     * @param key    - Unique identifier for the rate-limited subject (e.g. userId).
     * @param now  - Unix timestamp in ms; defaults to `Date.now()`.
     */
    check(key: string, now: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; } {
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
     */
    reset(key?: string) {
      if (key === undefined) {
        buckets.clear();
      } else {
        buckets.delete(key);
      }
    },

    /**
     * Number of buckets currently tracked.  Intended for testing/observability
     * only.
     */
    size(): number {
      return buckets.size;
    },
  };
}

export function createSharedRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
  namespace: string;
  security?: import('./stores/contracts.ts').SecurityTransport;
}): import('./stores/contracts.ts').RateLimiter {
  const local = createRateLimiter(options);
  if (!options.security) return local;
  const security = options.security;
  return {
    async check(key, now) {
      try {
        return await security.check(options.namespace, key, options.maxRequests, options.windowMs);
      } catch {
        return local.check(key, now);
      }
    },
  };
}

type PrivacyState = Pick<import('./stores/contracts.ts').Stores, 'blocks' | 'blockState' | 'stateAffinity'>;

export async function isBlockedAsync(state: PrivacyState, blockerId: string, targetId: string): Promise<boolean> {
  if (!state.blockState) return state.stateAffinity === 'shared' || isBlocked(state.blocks, blockerId, targetId);
  try {
    return await state.blockState.isBlocked(blockerId, targetId);
  } catch {
    // A stale negative cache entry must never grant access during a store outage.
    return true;
  }
}

export async function isDirectoryVisibleAsync(state: PrivacyState, viewerId: string, candidateId: string): Promise<boolean> {
  return !(await isBlockedAsync(state, viewerId, candidateId)) &&
    !(await isBlockedAsync(state, candidateId, viewerId));
}

export async function filterVisible<T>(items: T[], visible: (item: T) => Promise<boolean>): Promise<T[]> {
  const flags = await Promise.all(items.map(visible));
  return items.filter((_item, index) => flags[index]);
}

export async function listBlocksAsync(state: PrivacyState, userId: string, bothDirections = false): Promise<string[]> {
  if (state.blockState) return state.blockState.list(userId, bothDirections);
  if (state.stateAffinity === 'shared') throw new Error('shared block store unavailable');
  const ids = new Set(listBlocks(state.blocks, userId));
  if (bothDirections) {
    for (const [blocker, blocked] of state.blocks) {
      if (blocked.has(userId)) ids.add(blocker);
    }
  }
  return [...ids];
}

// ─── Blocklist helpers ────────────────────────────────────────────────────────

/**
 * Return `true` when `blockerId` has blocked `targetId`.
 *
 * The blocklist is stored as `Map<blockerId, Set<blockedId>>`.
 * A caller checks whether the *callee* has blocked *them*:
 *   `isBlocked(blocks, calleeId, callerId)`.
 */
function isBlocked(blocks: Map<string, Set<string>>, blockerId: string, targetId: string): boolean {
  return blocks.get(blockerId)?.has(targetId) ?? false;
}

/**
 * Whether `candidateId` is visible to `viewerId` in the user directory.
 *
 * A block hides its two parties from each other in *both* directions: the
 * blocker should not keep seeing the person they blocked, and the blocked user
 * must not be able to tell they were blocked by watching someone vanish only
 * from their side.
 *
 * This is the predicate `GET /users` filters on, and it is shared rather than
 * restated so that everything keyed to "can this person see that person"
 * — the directory listing, and avatar downloads — can never drift apart.
 * Directory visibility is the widest audience a block has to hold against,
 * which is why anything readable by that audience must ask this question.
 */
function isDirectoryVisible(blocks: Map<string, Set<string>>, viewerId: string, candidateId: string): boolean {
  return !isBlocked(blocks, viewerId, candidateId) && !isBlocked(blocks, candidateId, viewerId);
}

/**
 * Add a block entry.  Idempotent: re-blocking has no effect.
 */
function addBlock(blocks: Map<string, Set<string>>, blockerId: string, blockedId: string) {
  let blocked = blocks.get(blockerId);
  if (!blocked) {
    blocked = new Set();
    blocks.set(blockerId, blocked);
  }
  blocked.add(blockedId);
}

/**
 * Remove a block entry.
 *
 * @returns `true` when the block existed and was removed.
 */
function removeBlock(blocks: Map<string, Set<string>>, blockerId: string, blockedId: string): boolean {
  const set = blocks.get(blockerId);
  if (!set) return false;
  const removed = set.delete(blockedId);
  if (set.size === 0) blocks.delete(blockerId);
  return removed;
}

/**
 * Return the list of user IDs blocked by `blockerId`.
 */
function listBlocks(blocks: Map<string, Set<string>>, blockerId: string): string[] {
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
 */
function createAuditLog({ db = null }: { db?: import('../db/client.ts').Database | null; } = {}): import('./stores/contracts.ts').AuditLog & {
    getAll: () => AuditEntry[];
} {
  const entries: AuditEntry[] = [];

  /**
   * Best-effort durable persistence of a single audit record.  No-op when no
   * `db` is configured (tests / no DATABASE_URL).
   */
  function persist(entry: AuditEntry) {
    if (!db) return;
    try {
      void runDetached(() => db
        .insert(auditLogTable)
        .values({
          auditId: entry.auditId,
          ts: new Date(entry.timestamp),
          event: entry.event,
          actor: entry.actor,
          target: entry.target,
          outcome: entry.outcome,
          details: entry.details ?? {},
        })
        .catch((err: unknown) => {
          console.error('[security] failed to persist audit event to DB:', describeError(err));
        }));
    } catch (err) {
      console.error('[security] failed to persist audit event to DB:', describeError(err));
    }
  }

  return {
    /**
     * Append a security event to the log.
     */
    record({ event, actor = null, target = null, outcome, details = {} }: { event: string; actor?: string | null; target?: string | null; outcome: string; details?: object; }) {
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
     */
    getForUser(userId: string): AuditEntry[] {
      return entries.filter((e) => e.actor === userId || e.target === userId);
    },

    /**
     * Return all entries.  Used internally and for testing.
     */
    getAll(): AuditEntry[] {
      return [...entries];
    },
  };
}

export {
  createRateLimiter,
  isBlocked,
  isDirectoryVisible,
  addBlock,
  removeBlock,
  listBlocks,
  createAuditLog,
};
