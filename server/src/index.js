// @ts-check
'use strict';

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

const { createServer } = require('./createServer');
const { CALL_END_REASONS, CALL_TRANSITION_CHANNEL } = require('./config');
const { createStores, createRedisPgStores } = require('./stores');
const { createMemoryMessageBus, createRedisMessageBus } = require('./messageBus');
const { createCache } = require('./cache');
const { logNotificationHubStartupStatus } = require('./push');

/**
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  createServer,
  CALL_END_REASONS,
  CALL_TRANSITION_CHANNEL,
  createStores,
  createRedisPgStores,
  createMemoryMessageBus,
  createRedisMessageBus,
  createCache,
};

if (require.main === module) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '0.0.0.0';

  /**
   * Build the server, wiring a Redis-backed store bundle when `REDIS_URL` is
   * configured so sessions/presence survive restarts and scale across
   * instances. Falls back to the in-memory bundle (single instance) otherwise.
   * When `DATABASE_URL` is set, users and devices are persisted to (and
   * hydrated from) the Neon Postgres database at startup.
   *
   * @returns {Promise<{ httpServer: import('http').Server, shutdown: Function, stores?: object }>}
   */
  async function bootstrap() {
    logNotificationHubStartupStatus();
    const { createFirebaseTokenVerifier } = require('./firebaseAuth');
    const verifyIdToken = createFirebaseTokenVerifier();

    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required in production for durable identity ownership');
    }
    const db = process.env.DATABASE_URL ? require('../db/client').getDb() : null;

    let server;
    if (process.env.REDIS_URL) {
      try {
        const stores = await createRedisPgStores();
        console.log('[signaling] using Redis-backed stores (REDIS_URL set)');
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
        console.error('[signaling] failed to initialise Redis stores:', errorMessage(err));
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
      const handleSignal = (/** @type {string} */ signal) => {
        if (exiting) return;
        exiting = true;
        console.log(`[signaling] received ${signal}; draining connections...`);
        shutdown({ reason: signal })
          .then(() =>
            // Close Redis connections after draining; log close failures
            // specifically but don't abort the exit on them.
            Promise.resolve(
              /** @type {{ close?: () => Promise<void> }} */ (stores ?? {}).close?.()
            ).catch((/** @type {unknown} */ err) => {
              console.error('[signaling] error closing Redis stores:', errorMessage(err));
            })
          )
          .then(() => {
            console.log('[signaling] shutdown complete; exiting');
            process.exit(0);
          })
          .catch((/** @type {unknown} */ err) => {
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
