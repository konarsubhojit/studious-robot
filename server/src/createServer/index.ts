import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { SERVER_EVENTS } from '../../../shared/index.ts';
import { createTelemetry } from '../telemetry.ts';
import { createRateLimiter, createAuditLog } from '../security.ts';
import { createStores } from '../stores/index.ts';
import { createMessageStore } from '../messageStore.ts';
import { createMemoryCache, subscribeToCacheInvalidations } from '../cache.ts';
import { DEFAULT_RINGING_TIMEOUT_MS, DEFAULT_MEDIA_CONNECT_TIMEOUT_MS, DEFAULT_MAX_CALL_DURATION_MS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS, DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS, RINGING_POLL_MS, DEFAULT_SHUTDOWN_DRAIN_MS, DEFAULT_CALL_RETENTION_MS, DEFAULT_MAX_RETAINED_CALLS, DEFAULT_SOCKET_PING_INTERVAL_MS, DEFAULT_SOCKET_PING_TIMEOUT_MS, DEFAULT_SOCKET_MAX_BUFFER_BYTES, DEFAULT_JSON_BODY_LIMIT, DEFAULT_STALE_DEVICE_MAX_AGE_MS, DEFAULT_STALE_DEVICE_SWEEP_INTERVAL_MS, DEFAULT_SESSION_TTL_MS, DEFAULT_SESSION_SWEEP_INTERVAL_MS, DEFAULT_DB_CALL_RETENTION_MS, DEFAULT_AUDIT_RETENTION_MS, DEFAULT_MESSAGE_RETENTION_MS, DEFAULT_DB_RETENTION_SWEEP_INTERVAL_MS } from '../config.ts';
import { getPresenceSnapshot, resolveReachableChannels, drainLocalPresence, pruneExpiredSessions } from '../lib/state.ts';
import { runRetentionSweep } from '../lib/retention.ts';
import { waitForSocketsToDrain } from '../lib/lifecycle.ts';
import { tickRingingTimeouts, sanitizeHydratedCalls, pruneTerminalCalls } from '../domain/calls.ts';
import { notifyCallTransition } from '../domain/notifications.ts';
import { loadPersistedStateFromDb, pruneStaleDevices } from '../lib/persistence.ts';
import { mountRoutes } from '../routes/index.ts';
import { registerSocketHandlers } from '../signaling/index.ts';
import { isVerboseLoggingEnabled, verboseLog } from '../lib/verbose.ts';
import { describeError } from '../lib/errors.ts';
import { parseByteSize, parseNonNegativeNumber } from '../lib/env.ts';
import { setQueryTimingSink } from '../lib/queryTiming.ts';
import type { CreateServerOptions } from './types.ts';

/**
 * Build the Express app and HTTP/Socket.IO server.
 *
 * Exported as a factory so tests can spin up an isolated instance on an
 * ephemeral port without starting the production listener.
 *
 * This is the composition root: it constructs shared state, wires the HTTP
 * routers (see `routes/`), the realtime signaling handlers (see `signaling/`),
 * the background ringing-timeout worker, and the graceful-shutdown lifecycle.
 */
function createServer(opts: CreateServerOptions = {}) {
  if (!opts.verifyIdToken && !process.env.NODE_TEST_CONTEXT) {
    throw new Error('createServer requires verifyIdToken outside the Node test runner');
  }
  const app = express();
  app.use(
    express.json({
      limit: parseByteSize('JSON_BODY_LIMIT', process.env.JSON_BODY_LIMIT, DEFAULT_JSON_BODY_LIMIT),
    })
  );
  app.use((req, res, next) => {
    // Bail before touching the request when verbose logging is off, which is
    // the production default. Building the metadata object (and enumerating
    // the query keys) on every request paid an allocation for a string that
    // was then thrown away inside `verboseLog`.
    if (!isVerboseLoggingEnabled()) {
      next();
      return;
    }
    const startedAt = Date.now();
    verboseLog('http', 'request.start', {
      method: req.method,
      path: req.path,
      queryKeys: Object.keys(req.query ?? {}),
    });
    res.on('finish', () => {
      verboseLog('http', 'request.finish', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  const parseEnv = (name: string, fallback: number) =>
    parseNonNegativeNumber(name, process.env[name], fallback);
  const ringingTimeoutMs = parseEnv('RINGING_TIMEOUT_MS', DEFAULT_RINGING_TIMEOUT_MS);
  // Windows after which a call stuck in a non-terminal state is force-ended, so
  // no state can keep both participants busy forever (see domain/calls.js).
  const callTimeouts = {
    ringingTimeoutMs,
    mediaConnectTimeoutMs:
      parseEnv('MEDIA_CONNECT_TIMEOUT_MS', DEFAULT_MEDIA_CONNECT_TIMEOUT_MS),
    maxCallDurationMs: parseEnv('MAX_CALL_DURATION_MS', DEFAULT_MAX_CALL_DURATION_MS),
    heartbeatTimeoutMs:
      parseEnv('CALL_HEARTBEAT_TIMEOUT_MS', DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS),
  };
  // Parsed rather than `Number(env) || DEFAULT` so `0` reaches the scheduler
  // as "end the call as soon as the sockets are gone" instead of being read as
  // "unset" — see `lib/env.ts`.
  const participantDisconnectGraceMs =
    opts.participantDisconnectGraceMs ??
    parseNonNegativeNumber(
      'PARTICIPANT_DISCONNECT_GRACE_MS',
      process.env.PARTICIPANT_DISCONNECT_GRACE_MS,
      DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS
    );

  // ── Session TTL ──────────────────────────────────────────────────────────
  // Sessions expire after this many milliseconds.  Pass via opts (tests) or
  // SESSION_TTL_MS env var (production).  `0` restores the old non-expiring
  // behaviour and is deliberately not the default: see DEFAULT_SESSION_TTL_MS.
  //
  // `parseNonNegativeNumber` rather than `parseEnv` so an explicit
  // `SESSION_TTL_MS=0` survives instead of being treated as unset.
  const sessionTtlMs =
    opts.sessionTtlMs ??
    parseNonNegativeNumber('SESSION_TTL_MS', process.env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS);

  // ── Rate limiters ────────────────────────────────────────────────────────
  const callInitRateLimiter = createRateLimiter({
    maxRequests: opts.callRateLimit ?? parseEnv('CALL_RATE_LIMIT', 10),
    windowMs: opts.callRateWindowMs ?? parseEnv('CALL_RATE_WINDOW_MS', 60_000),
  });
  const rtcRateLimiter = createRateLimiter({
    maxRequests: opts.rtcRateLimit ?? parseEnv('RTC_RATE_LIMIT', 100),
    windowMs: opts.rtcRateWindowMs ?? parseEnv('RTC_RATE_WINDOW_MS', 10_000),
  });
  const turnCredentialsRateLimiter = createRateLimiter({
    maxRequests: opts.turnRateLimit ?? parseEnv('TURN_CREDENTIALS_RATE_LIMIT', 10),
    windowMs:
      opts.turnRateWindowMs ?? parseEnv('TURN_CREDENTIALS_RATE_WINDOW_MS', 60_000),
  });
  const messageSendRateLimiter = createRateLimiter({
    maxRequests: opts.messageRateLimit ?? parseEnv('MESSAGE_RATE_LIMIT', 30),
    windowMs: opts.messageRateWindowMs ?? parseEnv('MESSAGE_RATE_WINDOW_MS', 60_000),
  });
  // Search fans out across every conversation a user takes part in, so it is
  // the most expensive read the API serves; it gets its own budget rather than
  // sharing the (much cheaper) send allowance.
  const messageSearchRateLimiter = createRateLimiter({
    maxRequests:
      opts.messageSearchRateLimit ?? parseEnv('MESSAGE_SEARCH_RATE_LIMIT', 30),
    windowMs:
      opts.messageSearchRateWindowMs ??
      parseEnv('MESSAGE_SEARCH_RATE_WINDOW_MS', 60_000),
  });

  const telemetry = createTelemetry();

  // Route every timed datastore round trip (`lib/queryTiming.ts`) into this
  // instance's telemetry, so `GET /metrics` reports query cost per operation.
  // The sink is process-global because the instrumented modules
  // (`db/client.ts`, `messageStore.ts`, `cache.ts`) are constructed without a
  // `state` handle; the last server built owns it, and `shutdown()` releases
  // only its own so tearing one instance down cannot blind the others.
  const releaseQueryTimingSink = setQueryTimingSink((record) => telemetry.recordDbQuery(record));

  // ── Persistence stores ───────────────────────────────────────────────────
  // Keyed runtime collections (rooms, sessions, calls, …) are obtained from a
  // pluggable store bundle.  Defaults to in-memory Maps; tests/production may
  // inject an alternative backend via opts.stores.
  const stores = createStores({ stores: opts.stores });

  // Optional Drizzle db instance for durable persistence of users and devices.
  // When null/undefined (tests, no DATABASE_URL) the server operates fully
  // in-memory and skips all DB writes.
  const db = opts.db ?? null;

  // Durable store for text-chat messages.  Backed by the same Postgres
  // database as the rest of the durable state; falls back to an in-process
  // store so the server runs unchanged when no `db` handle is provided.
  const messageStore = createMessageStore({ messageStore: opts.messageStore, db });

  // Shared read cache for hot queries (conversation lists, first-page message
  // history, call history).  Defaults to the in-process backend; `index.js`
  // injects a Redis-backed cache when REDIS_URL is configured.
  const cache = opts.cache ?? createMemoryCache();

  const state: import('../stores/contracts.ts').ServerState = {
    rooms: stores.rooms,
    /** userId → claimed-identity record */
    users: stores.users,
    sessions: stores.sessions,
    userSessions: stores.userSessions,
    devices: stores.devices,
    userDevices: stores.userDevices,
    userConnections: stores.userConnections,
    userPresence: stores.userPresence,
    /** callId → call record */
    calls: stores.calls,
    /** callId → ordered event list */
    callEvents: stores.callEvents,
    /** @type blockerId → Set<blockedId> */
    blocks: stores.blocks,
    /** Optional Drizzle DB handle for durable persistence. */
    db,
    /**
     * Audit log for security-relevant events.  When a `db` handle is present
     * each recorded event is also persisted to the `audit_log` table so the
     * security trail survives restarts.
     */
    auditLog: createAuditLog({ db }),
    /** Rate limiter for call initiation (HTTP + socket). */
    callInitRateLimiter,
    /** Rate limiter for RTC signaling events. */
    rtcRateLimiter,
    /** Rate limiter for TURN credential minting. */
    turnCredentialsRateLimiter,
    messageSendRateLimiter,
    /** Rate limiter for message search (`GET /messages/search`). */
    messageSearchRateLimiter,
    /** Shared telemetry recorder for this server instance. */
    telemetry,
    /** Persistent store for text-chat messages (in-memory unless Postgres is configured). */
    messageStore,
    /** Shared read cache for conversation lists, message pages and call history. */
    cache,
    /**
     * Optional cross-instance message bus (Redis Pub/Sub).  Supplied via
     * `opts.messageBus` or by a Redis-backed store bundle (`stores.messageBus`).
     * Used to broadcast call-state transitions to other instances / observers.
     * `null` for single-instance (in-memory) deployments.
     */
    messageBus: opts.messageBus ?? stores.messageBus ?? null,
    stateAffinity: stores.stateAffinity ?? 'sticky',
    instanceId: stores.instanceId ?? process.env.INSTANCE_ID ?? `${process.pid}`,
    callState: stores.callState,
    sessionState: stores.sessionState,
    /**
     * Lifecycle flag.  Flipped to `true` by `shutdown()` so that `/health`
     * reports the instance as draining and new socket connections are rejected
     * during a rolling deploy.
     */
    draining: false,
  };
  // Drop locally cached entries when another instance reports a write.
  // The resolved unsubscribe handle is retained so `shutdown()` can release
  // it before tearing down the Redis / message-bus resources it depends on.
  let unsubscribeFromCacheInvalidations: (() => Promise<void>) | null = null;
  const cacheInvalidationSubscription = subscribeToCacheInvalidations(state)
    .then((unsubscribe) => {
      unsubscribeFromCacheInvalidations = unsubscribe;
    })
    .catch((error: unknown) => {
      console.error(`[cache] failed to subscribe to invalidations: ${describeError(error)}`);
    });

  verboseLog('server', 'state.initialized', {
    storeNames: Object.entries(stores)
      .filter(([, value]) => value instanceof Map)
      .map(([key]) => key),
    hasDb: Boolean(db),
    hasMessageBus: Boolean(opts.messageBus ?? stores.messageBus ?? null),
  });

  const httpServer = http.createServer(app);
  const rawCorsOrigin = process.env.CORS_ORIGIN?.trim();
  let corsOrigin: string | string[] = '*';
  if (rawCorsOrigin) {
    corsOrigin =
      rawCorsOrigin === '*'
        ? rawCorsOrigin
        : rawCorsOrigin
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
  } else if (process.env.NODE_ENV === 'production') {
    corsOrigin = [];
    console.warn('[signaling] CORS_ORIGIN is not set; rejecting browser origins in production.');
  }
  // Heartbeat tuning: detect phones that the OS suspended or killed well
  // inside the ringing window, so the per-device push fallback can take over
  // instead of the call being emitted into a dead socket (see config.js).
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    pingInterval: parseEnv('SOCKET_PING_INTERVAL_MS', DEFAULT_SOCKET_PING_INTERVAL_MS),
    pingTimeout: parseEnv('SOCKET_PING_TIMEOUT_MS', DEFAULT_SOCKET_PING_TIMEOUT_MS),
    maxHttpBufferSize:
      parseEnv('SOCKET_MAX_BUFFER_BYTES', DEFAULT_SOCKET_MAX_BUFFER_BYTES),
  });

  // When a Redis-backed store bundle is supplied, attach the Socket.IO Redis
  // adapter so room / per-user emits fan out to sockets on every instance.
  if (typeof stores.attachAdapter === 'function') {
    stores.attachAdapter(io);
    console.log('[signaling] Socket.IO Redis adapter attached (multi-instance mode)');
  }

  // ── HTTP routes ────────────────────────────────────────────────────────────
  // Mounted after `io` is created so the calls router can emit realtime events.
  mountRoutes(app, {
    state,
    db,
    io,
    sessionTtlMs,
    ringingTimeoutMs,
    turnFetch: opts.turnFetch ?? fetch,
    turnEnv: opts.turnEnv ?? process.env,
    verifyIdToken: opts.verifyIdToken,
  });

  // ── Realtime signaling ─────────────────────────────────────────────────────
  registerSocketHandlers(io, { state, ringingTimeoutMs, participantDisconnectGraceMs });

  // Background worker: advance stale ringing calls to `missed` and force-end
  // calls stranded in `accepted` / `connecting_media` / `in_call`.
  // `0` disables the corresponding bound in `pruneTerminalCalls`, so it must
  // survive parsing rather than being swallowed as falsy.
  const callRetentionMs =
    opts.callRetentionMs ??
    parseNonNegativeNumber(
      'CALL_RETENTION_MS',
      process.env.CALL_RETENTION_MS,
      DEFAULT_CALL_RETENTION_MS
    );
  const maxRetainedCalls =
    opts.maxRetainedCalls ??
    parseNonNegativeNumber(
      'MAX_RETAINED_CALLS',
      process.env.MAX_RETAINED_CALLS,
      DEFAULT_MAX_RETAINED_CALLS
    );
  const pollTimer = setInterval(() => {
    void (async () => {
      if (state.callState) {
        const lockTtlMs = Math.max(RINGING_POLL_MS * 3, 15_000);
        const acquired = await state.callState.acquireSweepLease(state.instanceId ?? 'unknown', lockTtlMs);
        if (!acquired) {
          return;
        }
      }

      const now = Date.now();
      tickRingingTimeouts(
        state,
        now,
        (call, previousStatus, reason) => {
          notifyCallTransition(io, state, call, {
            previousStatus,
            actor: null,
            reason,
          });
        },
        callTimeouts
      );
      // Bound the in-memory history the sweep above just added to, so neither it
      // nor `GET /calls` iterates a map that only ever grows.
      pruneTerminalCalls(state, { maxAgeMs: callRetentionMs, maxRetainedCalls, now });
    })().catch((error: unknown) => {
      console.error(`[calls] stale-call sweep failed: ${describeError(error)}`);
    });
  }, RINGING_POLL_MS);
  // Don't prevent the process from exiting if only the timer is left.
  pollTimer.unref();

  // Background worker: sweep device rows abandoned by an app reinstall. The
  // Notification Hubs delivery path never reports a dead token synchronously,
  // so age is the only signal available (see pruneStaleDevices).
  const staleDeviceMaxAgeMs =
    opts.staleDeviceMaxAgeMs ??
    parseEnv('STALE_DEVICE_MAX_AGE_MS', DEFAULT_STALE_DEVICE_MAX_AGE_MS);
  const deviceSweepTimer = setInterval(() => {
    pruneStaleDevices(db, state, { maxAgeMs: staleDeviceMaxAgeMs }).catch((err) => {
      console.error('[devices] stale device sweep failed:', (err as any)?.message);
    });
  }, DEFAULT_STALE_DEVICE_SWEEP_INTERVAL_MS);
  deviceSweepTimer.unref();

  // Background worker: drop expired sessions. Expiry is already enforced on
  // every read, so this only bounds `state.sessions`, which otherwise grows
  // for the lifetime of the process.
  const sessionSweepTimer = setInterval(() => {
    try {
      pruneExpiredSessions(state);
    } catch (error) {
      console.error(`[sessions] expired-session sweep failed: ${describeError(error)}`);
    }
  }, DEFAULT_SESSION_SWEEP_INTERVAL_MS);
  sessionSweepTimer.unref();

  // Background worker: bound the append-only tables. `calls`, `call_events`,
  // `audit_log` and `messages` are written on every call, every audited action
  // and every chat message and were never deleted from, so storage — and,
  // because boot hydration reads `calls`, startup — grew with history. A
  // retention of 0 disables that table's sweep, which is the default for
  // `messages`: it holds the user's own content, not a record the server made
  // about them.
  const dbCallRetentionMs =
    opts.dbCallRetentionMs ??
    parseNonNegativeNumber('DB_CALL_RETENTION_MS', process.env.DB_CALL_RETENTION_MS, DEFAULT_DB_CALL_RETENTION_MS);
  const auditRetentionMs =
    opts.auditRetentionMs ??
    parseNonNegativeNumber('AUDIT_RETENTION_MS', process.env.AUDIT_RETENTION_MS, DEFAULT_AUDIT_RETENTION_MS);
  const messageRetentionMs =
    opts.messageRetentionMs ??
    parseNonNegativeNumber('MESSAGE_RETENTION_MS', process.env.MESSAGE_RETENTION_MS, DEFAULT_MESSAGE_RETENTION_MS);
  const retentionSweepTimer = setInterval(() => {
    runRetentionSweep(db, {
      callRetentionMs: dbCallRetentionMs,
      auditRetentionMs,
      messageRetentionMs,
    }).catch((error) => {
      console.error(`[retention] sweep failed: ${describeError(error)}`);
    });
  }, DEFAULT_DB_RETENTION_SWEEP_INTERVAL_MS);
  retentionSweepTimer.unref();

  const shutdownDrainMs =
    opts.shutdownDrainMs ?? parseEnv('SHUTDOWN_DRAIN_MS', DEFAULT_SHUTDOWN_DRAIN_MS);

  /**
   * Resolves once shutdown has fully completed; shared for idempotency.
   */
  let shutdownPromise: Promise<void> | null = null;

  /**
   * Gracefully shut down this instance for a rolling deploy / SIGTERM.
   *
   * Idempotent: repeated calls return the same in-flight promise.
   *
   * @param shutdownOpts.drainTimeoutMs - Max ms to wait for drain.
   * @param shutdownOpts.reason - Reason advertised to clients.
   */
  function shutdown({ drainTimeoutMs = shutdownDrainMs, reason = 'shutdown' }: { drainTimeoutMs?: number; reason?: string; } = {}): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    state.draining = true;

    shutdownPromise = (async () => {
      // Stop the background worker.
      clearInterval(pollTimer);
      clearInterval(deviceSweepTimer);
      clearInterval(sessionSweepTimer);
      clearInterval(retentionSweepTimer);

      // Tell connected clients to reconnect elsewhere.
      io.emit(SERVER_EVENTS.SERVER_DRAINING, { reason, ts: new Date().toISOString() });

      // Drop this instance's connections from presence so peers see users go
      // offline promptly rather than waiting for socket teardown.
      drainLocalPresence(state);

      // Keep the HTTP server listening during the drain window so health checks
      // observe the 503 `draining` status and load balancers stop routing new
      // traffic here; brand-new socket connections are rejected by the
      // connection handler (see the `state.draining` guard).  Wait for existing
      // clients to disconnect on their own, up to the drain timeout.
      await waitForSocketsToDrain(io, drainTimeoutMs);

      // Force-disconnect any remaining sockets, then close the servers.
      io.disconnectSockets(true);
      httpServer.closeAllConnections?.();
      // `io.close()` also returns a promise, but shutdown waits on the
      // callback so both servers are closed the same way; the returned promise
      // settles with it and is deliberately dropped.
      await new Promise((resolve: (value?: undefined) => void) => {
        void io.close(() => resolve());
      });
      await new Promise((resolve: (value?: undefined) => void) =>
        httpServer.close(() => resolve())
      );

      // Release the cache-invalidation subscription before closing Redis /
      // the message bus it depends on, so no callback fires against
      // resources that are being torn down.
      await cacheInvalidationSubscription;
      if (typeof unsubscribeFromCacheInvalidations === 'function') {
        await unsubscribeFromCacheInvalidations();
      }

      // Close durable stores (Redis/Postgres) if they support it.
      if (typeof stores.close === 'function') {
        await stores.close();
      }

      // Release the message store's connection pool (no-op for the memory store).
      if (typeof messageStore.close === 'function') {
        await messageStore.close();
      }

      // Release the cache's connection (no-op for the memory backend).
      if (typeof cache.close === 'function') {
        await cache.close();
      }

      // Stop feeding query timings into a torn-down instance's telemetry
      // (a no-op when another server has since taken the sink over).
      releaseQueryTimingSink();
    })();

    return shutdownPromise;
  }

  return {
    app,
    httpServer,
    io,
    shutdown,
    messageBus: state.messageBus,
    getPresence: (userId: string) => getPresenceSnapshot(state, userId),
    resolveReachableChannels: (userId: string) =>
      resolveReachableChannels(state, userId),
    /**
     * Resolves once the cache-invalidation subscription attempt has settled.
     * Exposed for deterministic testing; production code never awaits this
     * directly (see `shutdown()`, which awaits it before closing stores).
     */
    cacheInvalidationSubscriptionReady: cacheInvalidationSubscription,
    getCall: (callId: string) => state.calls.get(callId) || null,
    getCallEvents: (callId: string) => state.callEvents.get(callId) || [],
    getMetrics: () => state.telemetry.getSnapshot(),
    /**
     * Advance all stale `ringing` calls to `missed`.  Exposed for
     * deterministic testing; the production server also calls this on a timer.
     *
     * @param now - Unix timestamp in ms (defaults to Date.now()).
     * @returns Number of calls transitioned.
     */
    tickRingingTimeouts: (now: number = Date.now()): number =>
      tickRingingTimeouts(state, now, undefined, callTimeouts),
    pruneTerminalCalls: (now: number = Date.now()): number =>
      pruneTerminalCalls(state, { maxAgeMs: callRetentionMs, maxRetainedCalls, now }),
    /**
     * Populate the in-memory state from the Neon database.
     *
     * Loads persisted `users`, `devices`, `calls`, `call_events`, and `blocks`
     * into in-memory caches so identity, push delivery, call history/timelines,
     * and block rules survive restarts.
     * A no-op when no `db` was passed to `createServer`.
     */
    loadPersistedState: async (): Promise<void> => {
      await loadPersistedStateFromDb(db, state);
      // A restart must never resurrect a dead call: close out anything that was
      // reloaded in a non-terminal state past its timeout window.
      const closed = sanitizeHydratedCalls(state, callTimeouts);
      if (closed > 0) {
        console.log(`[signaling] closed ${closed} stale call record(s) after hydration`);
      }
    },
  };
}

export { createServer };
export type { CreateServerOptions } from './types.ts';
