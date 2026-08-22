import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { SERVER_EVENTS } from '../../shared/index.ts';
import { createTelemetry } from './telemetry.ts';
import { createRateLimiter, createAuditLog } from './security.ts';
import { createStores } from './stores/index.ts';
import { createMessageStore } from './messageStore.ts';
import { createMemoryCache, subscribeToCacheInvalidations } from './cache.ts';
import { DEFAULT_RINGING_TIMEOUT_MS, DEFAULT_MEDIA_CONNECT_TIMEOUT_MS, DEFAULT_MAX_CALL_DURATION_MS, DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS, DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS, RINGING_POLL_MS, DEFAULT_SHUTDOWN_DRAIN_MS, DEFAULT_SOCKET_PING_INTERVAL_MS, DEFAULT_SOCKET_PING_TIMEOUT_MS } from './config.ts';
import { getPresenceSnapshot, resolveReachableChannels, drainLocalPresence } from './lib/state.ts';
import { waitForSocketsToDrain } from './lib/lifecycle.ts';
import { tickRingingTimeouts, sanitizeHydratedCalls } from './domain/calls.ts';
import { notifyCallTransition } from './domain/notifications.ts';
import { loadPersistedStateFromDb } from './lib/persistence.ts';
import { mountRoutes } from './routes/index.ts';
import { registerSocketHandlers } from './signaling/index.ts';
import { verboseLog } from './lib/verbose.ts';

/**
 * @returns the error message, or a stringified fallback.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CreateServerOptions = { verifyIdToken?: (idToken: string) => Promise<{ authUid: string, email?: string|null, authProvider?: string|null, }>; stores?: any; db?: any; messageStore?: any; cache?: import('./cache.ts').Cache; messageBus?: import('./messageBus.ts').MessageBus | null; sessionTtlMs?: number; participantDisconnectGraceMs?: number; callRateLimit?: number; callRateWindowMs?: number; rtcRateLimit?: number; rtcRateWindowMs?: number; turnRateLimit?: number; turnRateWindowMs?: number; messageRateLimit?: number; messageRateWindowMs?: number; messageSearchRateLimit?: number; messageSearchRateWindowMs?: number; shutdownDrainMs?: number; turnFetch?: typeof fetch; turnEnv?: NodeJS.ProcessEnv; };

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
  app.use(express.json());
  app.use((req, res, next) => {
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

  const ringingTimeoutMs = Number(process.env.RINGING_TIMEOUT_MS) || DEFAULT_RINGING_TIMEOUT_MS;
  // Windows after which a call stuck in a non-terminal state is force-ended, so
  // no state can keep both participants busy forever (see domain/calls.js).
  const callTimeouts = {
    ringingTimeoutMs,
    mediaConnectTimeoutMs:
      Number(process.env.MEDIA_CONNECT_TIMEOUT_MS) || DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
    maxCallDurationMs: Number(process.env.MAX_CALL_DURATION_MS) || DEFAULT_MAX_CALL_DURATION_MS,
    heartbeatTimeoutMs:
      Number(process.env.CALL_HEARTBEAT_TIMEOUT_MS) || DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  };
  const participantDisconnectGraceMs =
    opts.participantDisconnectGraceMs ??
    (Number(process.env.PARTICIPANT_DISCONNECT_GRACE_MS) ||
      DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS);

  // ── Session TTL ──────────────────────────────────────────────────────────
  // When non-zero, sessions expire after this many milliseconds.  Pass via
  // opts (tests) or SESSION_TTL_MS env var (production).
  const sessionTtlMs = opts.sessionTtlMs ?? (Number(process.env.SESSION_TTL_MS) || 0);

  // ── Rate limiters ────────────────────────────────────────────────────────
  const callInitRateLimiter = createRateLimiter({
    maxRequests: opts.callRateLimit ?? (Number(process.env.CALL_RATE_LIMIT) || 10),
    windowMs: opts.callRateWindowMs ?? (Number(process.env.CALL_RATE_WINDOW_MS) || 60_000),
  });
  const rtcRateLimiter = createRateLimiter({
    maxRequests: opts.rtcRateLimit ?? (Number(process.env.RTC_RATE_LIMIT) || 100),
    windowMs: opts.rtcRateWindowMs ?? (Number(process.env.RTC_RATE_WINDOW_MS) || 10_000),
  });
  const turnCredentialsRateLimiter = createRateLimiter({
    maxRequests: opts.turnRateLimit ?? (Number(process.env.TURN_CREDENTIALS_RATE_LIMIT) || 10),
    windowMs:
      opts.turnRateWindowMs ?? (Number(process.env.TURN_CREDENTIALS_RATE_WINDOW_MS) || 60_000),
  });
  const messageSendRateLimiter = createRateLimiter({
    maxRequests: opts.messageRateLimit ?? (Number(process.env.MESSAGE_RATE_LIMIT) || 30),
    windowMs: opts.messageRateWindowMs ?? (Number(process.env.MESSAGE_RATE_WINDOW_MS) || 60_000),
  });
  // Search fans out across every conversation a user takes part in, so it is
  // the most expensive read the API serves; it gets its own budget rather than
  // sharing the (much cheaper) send allowance.
  const messageSearchRateLimiter = createRateLimiter({
    maxRequests:
      opts.messageSearchRateLimit ?? (Number(process.env.MESSAGE_SEARCH_RATE_LIMIT) || 30),
    windowMs:
      opts.messageSearchRateWindowMs ??
      (Number(process.env.MESSAGE_SEARCH_RATE_WINDOW_MS) || 60_000),
  });

  const telemetry = createTelemetry();

  // ── Persistence stores ───────────────────────────────────────────────────
  // Keyed runtime collections (rooms, sessions, calls, …) are obtained from a
  // pluggable store bundle.  Defaults to in-memory Maps; tests/production may
  // inject an alternative backend via opts.stores.
  const stores = createStores({ stores: opts.stores });

  // Optional Drizzle db instance for durable persistence of users and devices.
  // When null/undefined (tests, no DATABASE_URL) the server operates fully
  // in-memory and skips all DB writes.
  const db = opts.db ?? null;

  // Durable store for text-chat messages.  Defaults to an in-process store, so
  // the server runs unchanged when MONGODB_URI is not configured.
  const messageStore = (createMessageStore({ messageStore: opts.messageStore }) as any);

  // Shared read cache for hot queries (conversation lists, first-page message
  // history, call history).  Defaults to the in-process backend; `index.js`
  // injects a Redis-backed cache when REDIS_URL is configured.
  const cache = opts.cache ?? createMemoryCache();

  const state: import('./stores/contracts.ts').ServerState = {
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
    /** Persistent store for text-chat messages (in-memory unless Mongo is configured). */
    messageStore,
    /** Shared read cache for conversation lists, message pages and call history. */
    cache,
    /** Current asynchronous readiness state for the message store. */
    messageStoreStatus: messageStore.type === 'mongo' ? 'starting' : 'ready',
    /**
     * Optional cross-instance message bus (Redis Pub/Sub).  Supplied via
     * `opts.messageBus` or by a Redis-backed store bundle (`stores.messageBus`).
     * Used to broadcast call-state transitions to other instances / observers.
     * `null` for single-instance (in-memory) deployments.
     */
    messageBus: opts.messageBus ?? stores.messageBus ?? null,
    /**
     * Lifecycle flag.  Flipped to `true` by `shutdown()` so that `/health`
     * reports the instance as draining and new socket connections are rejected
     * during a rolling deploy.
     */
    draining: false,
  };
  // Drop locally cached entries when another instance reports a write.
  subscribeToCacheInvalidations(state).catch((error: unknown) => {
    console.error(`[cache] failed to subscribe to invalidations: ${errorMessage(error)}`);
  });

  if (messageStore.type === 'mongo' && typeof messageStore.ready === 'function') {
    Promise.resolve(messageStore.ready())
      .then(() => {
        state.messageStoreStatus = 'ready';
      })
      .catch((error: unknown) => {
        state.messageStoreStatus = 'unavailable';
        console.error(
          `[messages] Mongo message store health check failed: ${errorMessage(error)}`
        );
      });
  }
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
    pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS) || DEFAULT_SOCKET_PING_INTERVAL_MS,
    pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS) || DEFAULT_SOCKET_PING_TIMEOUT_MS,
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
  const pollTimer = setInterval(
    () =>
      tickRingingTimeouts(
        state,
        Date.now(),
        (call, previousStatus, reason) => {
          notifyCallTransition(io, state, call, {
            previousStatus,
            actor: null,
            reason,
          });
        },
        callTimeouts
      ),
    RINGING_POLL_MS
  );
  // Don't prevent the process from exiting if only the timer is left.
  pollTimer.unref();

  const shutdownDrainMs =
    opts.shutdownDrainMs ?? (Number(process.env.SHUTDOWN_DRAIN_MS) || DEFAULT_SHUTDOWN_DRAIN_MS);

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
      await new Promise((resolve: (value?: undefined) => void) =>
        io.close(() => resolve())
      );
      await new Promise((resolve: (value?: undefined) => void) =>
        httpServer.close(() => resolve())
      );

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
