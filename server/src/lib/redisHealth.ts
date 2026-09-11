/**
 * Process-wide record of Redis/Valkey failures that are *not* connection
 * failures.
 *
 * An unreachable Redis is handled by failing closed at startup
 * (`src/index.ts`): the operator gets a dead instance, which is loud. A
 * *misconfigured* Redis is the opposite — the connection succeeds, so every
 * readiness signal says the fleet is fine while one subsystem is permanently
 * dead:
 *
 *   - a user granted keys but not channels (`resetchannels` is the default)
 *     fails the Socket.IO adapter's and the cache bus's `SUBSCRIBE` with
 *     `NOPERM …channel`, so cross-instance fan-out never works;
 *   - a user granted channels but not keys boots cleanly and then fails every
 *     stale-call sweep with `NOPERM …key`, so nothing ever retires a stranded
 *     `ringing` record — the exact condition that makes the next call to that
 *     user be rejected as busy.
 *
 * Neither is survivable by retrying, and neither should be a crash loop. They
 * are recorded here instead: logged once with the remedy, then rate-limited,
 * and reported on `GET /health` so the degradation is visible rather than
 * buried in a log that repeats every five seconds.
 */

import { describeError } from './errors.ts';

/** One degraded subsystem, as reported by `/health`. */
type RedisDegradation = {
  /** Subsystem that failed, e.g. `fanout-adapter` or `call-sweep`. */
  scope: string;
  /** Why it is degraded. Only permission failures are tracked today. */
  kind: 'permission';
  /** The error Redis returned, verbatim. */
  message: string;
  /** Operator-facing fix. */
  remedy: string;
  /** When the failure was first seen. */
  since: string;
  /** How many times it has recurred since. */
  occurrences: number;
};

type RedisHealth = {
  degraded: boolean;
  issues: RedisDegradation[];
};

/** Repeat the (escalated) log line at most this often per scope. */
const RELOG_INTERVAL_MS = 60_000;

const degradations = new Map<string, RedisDegradation & { lastLoggedAt: number }>();

/**
 * `true` when the error is Redis/Valkey rejecting a command the connected user
 * is not allowed to run — as opposed to a transport failure, which must keep
 * its existing fail-closed handling.
 */
function isRedisPermissionError(error: unknown): boolean {
  const message = describeError(error);
  return /\bNOPERM\b/i.test(message) || /\bNOAUTH\b/i.test(message);
}

/**
 * Record (and, the first time plus at most once a minute thereafter, log) a
 * permission failure that has disabled `scope`.
 *
 * @param scope - Subsystem the failure disabled.
 * @param error - The rejected command's error.
 * @param remedy - What the operator must grant, named explicitly.
 */
function reportRedisPermissionFailure({
  scope,
  error,
  remedy,
}: {
  scope: string;
  error: unknown;
  remedy: string;
}): void {
  const message = describeError(error);
  const now = Date.now();
  const existing = degradations.get(scope);
  const entry = existing ?? {
    scope,
    kind: 'permission' as const,
    message,
    remedy,
    since: new Date(now).toISOString(),
    occurrences: 0,
    lastLoggedAt: 0,
  };
  entry.message = message;
  entry.remedy = remedy;
  entry.occurrences += 1;
  degradations.set(scope, entry);

  if (existing && now - entry.lastLoggedAt < RELOG_INTERVAL_MS) return;
  entry.lastLoggedAt = now;
  console.error(
    `[redis] ${scope} is DEGRADED: ${message}` +
      ` — the connected Redis/Valkey user lacks the required permissions` +
      ` (channels and keys are granted independently; the default is resetchannels).` +
      ` Remedy: ${remedy}.` +
      ` occurrences=${entry.occurrences}; reported on GET /health as redis.issues[].`
  );
}

/** Forget `scope`'s degradation, once it has been observed working again. */
function clearRedisDegradation(scope: string): void {
  if (!degradations.delete(scope)) return;
  console.log(`[redis] ${scope} recovered; degradation cleared`);
}

/** Snapshot for `/health`. */
function getRedisHealth(): RedisHealth {
  const issues = Array.from(degradations.values())
    .map(({ lastLoggedAt: _lastLoggedAt, ...issue }) => issue)
    .sort((a, b) => a.scope.localeCompare(b.scope));
  return { degraded: issues.length > 0, issues };
}

/** Drop all recorded degradations. Exposed for tests. */
function resetRedisHealth(): void {
  degradations.clear();
}

export {
  clearRedisDegradation,
  getRedisHealth,
  isRedisPermissionError,
  reportRedisPermissionFailure,
  resetRedisHealth,
};
export type { RedisDegradation, RedisHealth };
