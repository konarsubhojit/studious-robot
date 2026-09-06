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
 * That failure mode is silent, which is the dangerous part, so a process that
 * knows it is not the first of several says so loudly.
 *
 * Deployment is a single systemd unit (`deploy/robot-signal.service`), and a
 * lone process needs no shared state at all: the in-memory bus and cache are
 * exactly equivalent to Redis for one process.  The systemd-native way to run
 * more than one is a *template* unit — `robot-signal@.service`, instantiated
 * as `robot-signal@0`, `robot-signal@1`, … behind an nginx upstream — which
 * makes the ordinal available as `%i`.  The unit is expected to surface it as
 * `INSTANCE_ID=%i` (`SIGNAL_INSTANCE_ID` is honoured as an alias), and the
 * moment such a unit exists `REDIS_URL` becomes mandatory.
 */

/** Environment slice this module reads. */
export type InstanceEnv = Record<string, string | undefined>;

/** Outcome of {@link checkMultiInstanceState}. */
export type MultiInstanceCheck = {
  /** `ok` when nothing is wrong, `warn` outside production, `fatal` in it. */
  level: 'ok' | 'warn' | 'fatal';
  /** Zero-based instance ordinal, or `null` for a single un-templated unit. */
  instanceId: number | null;
  /** Whether cross-instance state (Redis) is configured. */
  sharedState: boolean;
  /** Operator-facing explanation; empty when `level` is `ok`. */
  message: string;
};

/**
 * Read this process's instance ordinal, or `null` when it is not running as an
 * instance of a systemd template unit.
 *
 * A plain `robot-signal.service` sets neither variable, so a single-instance
 * host reports `null` and is never faulted.
 */
export function resolveInstanceId(env: InstanceEnv = process.env): number | null {
  for (const key of ['INSTANCE_ID', 'SIGNAL_INSTANCE_ID']) {
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
      'run a single instance (the plain robot-signal.service unit, not the robot-signal@ template).',
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
