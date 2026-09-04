/**
 * Multi-instance safety check.
 *
 * Almost every piece of cross-request state in this server — sessions,
 * presence, the socket.io adapter, the call registry and the read cache — is
 * only shared between processes when `REDIS_URL` is configured (see
 * `src/index.ts`).  Without it each process keeps its own private copy, so a
 * write served by one process is invisible to the other five: cache
 * invalidation published on the message bus never leaves the process, and a
 * conversation list can stay stale for a full TTL.
 *
 * That failure mode is silent, which is the dangerous part.  PM2 exposes the
 * instance ordinal in `NODE_APP_INSTANCE` (`pm_id` as a fallback), so a
 * process that knows it is not the first of several can say so loudly.
 */

/** Environment slice this module reads. */
export type InstanceEnv = Record<string, string | undefined>;

/** Outcome of {@link checkMultiInstanceState}. */
export type MultiInstanceCheck = {
  /** `ok` when nothing is wrong, `warn` outside production, `fatal` in it. */
  level: 'ok' | 'warn' | 'fatal';
  /** Zero-based instance ordinal, or `null` when not running under PM2. */
  instanceId: number | null;
  /** Whether cross-instance state (Redis) is configured. */
  sharedState: boolean;
  /** Operator-facing explanation; empty when `level` is `ok`. */
  message: string;
};

/**
 * Read this process's instance ordinal, or `null` when it is not running under
 * a process manager that publishes one.
 */
export function resolveInstanceId(env: InstanceEnv = process.env): number | null {
  for (const key of ['NODE_APP_INSTANCE', 'pm_id', 'PM2_INSTANCE_ID']) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/** Whether cross-instance shared state is configured. */
export function hasSharedState(env: InstanceEnv = process.env): boolean {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim() !== '');
}

/**
 * Decide whether this process is one of several yet has no shared state.
 *
 * Only ordinals above zero are conclusive: instance 0 cannot tell whether it is
 * alone, so it is never faulted.  One loud process per fleet is enough.
 */
export function checkMultiInstanceState(env: InstanceEnv = process.env): MultiInstanceCheck {
  const instanceId = resolveInstanceId(env);
  const sharedState = hasSharedState(env);
  if (sharedState || instanceId === null || instanceId === 0) {
    return { level: 'ok', instanceId, sharedState, message: '' };
  }
  return {
    level: env.NODE_ENV === 'production' ? 'fatal' : 'warn',
    instanceId,
    sharedState,
    message:
      `this is process instance ${instanceId} but REDIS_URL is not set: sessions, presence, ` +
      'call state and the read cache would be private to each process, so cache invalidation ' +
      'cannot reach the other instances and clients would see stale data. Set REDIS_URL, or ' +
      'run a single instance (pm2 `instances: 1`).',
  };
}

/**
 * Apply {@link checkMultiInstanceState}: throw in production, warn elsewhere.
 * Returns the check so callers can log or assert on it.
 */
export function assertSharedStateForMultiInstance(env: InstanceEnv = process.env): MultiInstanceCheck {
  const check = checkMultiInstanceState(env);
  if (check.level === 'fatal') throw new Error(`[signaling] ${check.message}`);
  if (check.level === 'warn') console.warn(`[signaling] WARNING: ${check.message}`);
  return check;
}
