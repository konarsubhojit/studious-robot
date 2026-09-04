/**
 * Signaling server entry point.
 *
 * The implementation has been decomposed into single-responsibility modules:
 *   - `config.js`            – shared constants / tunables
 *   - `lib/*`                – pure helpers (normalisation, auth, in-memory
 *                              state, DB persistence, lifecycle)
 *   - `domain/*`             – call state-machine and notification logic
 *   - `routes/*`             – Express routers (one file per resource)
 *   - `signaling/*`          – Socket.IO connection + event handlers
 *   - `createServer.js`      – composition root that wires everything together
 *
 * This file re-exports the public factory surface (unchanged so existing
 * imports/tests keep working) and, when run directly, boots the production
 * listener with graceful shutdown.
 */

import { pathToFileURL } from 'node:url';
import { createServer } from './createServer.ts';
import { createFirebaseTokenVerifier } from './firebaseAuth.ts';
import { getDb } from '../db/client.ts';
import { CALL_END_REASONS, CALL_TRANSITION_CHANNEL } from './config.ts';
import { createStores, createRedisPgStores } from './stores/index.ts';
import { createMemoryMessageBus, createRedisMessageBus } from './messageBus.ts';
import { createCache } from './cache.ts';
import { logNotificationHubStartupStatus } from './push.ts';
import { describeError } from './lib/errors.ts';
import { assertSharedStateForMultiInstance } from './lib/instances.ts';

export {
  createServer,
  CALL_END_REASONS,
  CALL_TRANSITION_CHANNEL,
  createStores,
  createRedisPgStores,
  createMemoryMessageBus,
  createRedisMessageBus,
  createCache,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '0.0.0.0';

  /**
   * Build the server, wiring a Redis-backed store bundle when `REDIS_URL` is
   * configured so sessions/presence survive restarts and scale across
   * instances. Falls back to the in-memory bundle (single instance) otherwise.
   * When `DATABASE_URL` is set, users and devices are persisted to (and
   * hydrated from) the Neon Postgres database at startup.
   */
  async function bootstrap(): Promise<{ httpServer: import('http').Server; shutdown: Function; stores?: object; }> {
    logNotificationHubStartupStatus();
    // Fail (or at least shout) before serving traffic if this process is one of
    // several but has no shared state to invalidate across.
    assertSharedStateForMultiInstance();
    const verifyIdToken = createFirebaseTokenVerifier();

    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required in production for durable identity ownership');
    }
    const db = process.env.DATABASE_URL ? getDb() : null;

    let server;
    if (process.env.REDIS_URL) {
      try {
        const stores = await createRedisPgStores();
        console.log('[signaling] using Redis-backed stores (REDIS_URL set)');
        console.log('[signaling] cross-instance call state enabled (stateAffinity=shared)');
        // Share the read cache across instances so a cached conversation list
        // is not re-read (and re-throttled) once per instance.
        const cache = await createCache({ redisUrl: process.env.REDIS_URL });
        server = createServer({ stores, db, verifyIdToken, cache });
        if (db) {
          await server.loadPersistedState();
        }
        return { ...server, stores };
      } catch (err) {
        // Fail closed on an explicitly configured but unreachable Redis so the
        // operator notices rather than silently losing cross-instance state.
        console.error('[signaling] failed to initialise Redis stores:', describeError(err));
        throw err;
      }
    }

    server = createServer({ db, verifyIdToken });
    if (db) {
      await server.loadPersistedState();
    }
    return server;
  }

  bootstrap()
    .then(({ httpServer, shutdown, stores }) => {
      httpServer.listen(port, host, () => {
        console.log(`[signaling] listening on http://${host}:${port}`);
        console.log(`[signaling] health endpoint: http://${host}:${port}/health`);
      });

      // Graceful shutdown for rolling deploys: drain in-flight connections, then
      // exit cleanly so systemd can restart/replace the instance.
      let exiting = false;
      const handleSignal = (signal: string) => {
        if (exiting) return;
        exiting = true;
        console.log(`[signaling] received ${signal}; draining connections...`);
        shutdown({ reason: signal })
          .then(() =>
            // Close Redis connections after draining; log close failures
            // specifically but don't abort the exit on them.
            Promise.resolve(
              ((stores ?? {}) as { close?: () => Promise<void> }).close?.()
            ).catch((err: unknown) => {
              console.error('[signaling] error closing Redis stores:', describeError(err));
            })
          )
          .then(() => {
            console.log('[signaling] shutdown complete; exiting');
            process.exit(0);
          })
          .catch((err: unknown) => {
            console.error('[signaling] error during shutdown:', err);
            process.exit(1);
          });
      };
      process.on('SIGTERM', () => handleSignal('SIGTERM'));
      process.on('SIGINT', () => handleSignal('SIGINT'));
    })
    .catch((err) => {
      console.error('[signaling] fatal startup error:', err);
      process.exit(1);
    });
}
