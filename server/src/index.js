'use strict';

const http = require('http');
const { Server } = require('socket.io');

const { loadConfig } = require('./config');
const { createMetrics } = require('./metrics');
const { createRoomStore } = require('./roomStore');
const { createApp } = require('./app');
const { registerSignaling } = require('./signaling');
const { createTelemetry } = require('./telemetry');
const { attachRedisAdapter } = require('./redisAdapter');

/**
 * Build the Express app and HTTP/Socket.IO server.
 *
 * Exported as a factory so tests can spin up an isolated instance on an
 * ephemeral port without starting the production listener. Behaviour is
 * composed from focused modules: `config` (env), `roomStore` (membership),
 * `metrics` (counters), `app` (HTTP), `signaling` (Socket.IO handlers),
 * `telemetry` (error reporting), and `redisAdapter` (horizontal scaling).
 *
 * @param {object} [options]
 * @param {ReturnType<typeof loadConfig>} [options.config] - Override config (tests).
 * @param {ReturnType<typeof createTelemetry>} [options.telemetry] - Override telemetry (tests).
 * @returns {{ app: import('express').Express, httpServer: import('http').Server, io: import('socket.io').Server, rooms: object, metrics: object, config: object, telemetry: object }}
 */
function createServer({ config = loadConfig(), telemetry } = {}) {
  const resolvedTelemetry = telemetry || createTelemetry({
    dsn: config.sentryDsn,
    environment: config.environment,
    instanceId: config.instanceId,
  });
  const metrics = createMetrics();
  const rooms = createRoomStore({ maxRoomSize: config.maxRoomSize });

  const app = createApp({ metrics, rooms, config, telemetry: resolvedTelemetry });
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin },
  });

  registerSignaling(io, { rooms, metrics });

  return { app, httpServer, io, rooms, metrics, config, telemetry: resolvedTelemetry };
}

module.exports = { createServer };

if (require.main === module) {
  const config = loadConfig();
  const { httpServer, io, telemetry } = createServer({ config });

  // Report otherwise-fatal errors to telemetry before they take the process down.
  process.on('uncaughtException', (err) => {
    telemetry.captureException(err, { kind: 'uncaughtException' });
    console.error('[signaling] uncaught exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    telemetry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
      kind: 'unhandledRejection',
    });
    console.error('[signaling] unhandled rejection:', reason);
  });

  // Horizontal scaling: attach the Redis adapter when REDIS_URL is configured.
  let redisAdapter = { enabled: false, close: async () => {} };
  attachRedisAdapter(io, { redisUrl: config.redisUrl, telemetry })
    .then((adapter) => {
      redisAdapter = adapter;
    })
    .catch((err) => {
      telemetry.captureException(err, { component: 'redis-adapter' });
      console.warn('[signaling] failed to attach Redis adapter; continuing single-instance:', err.message);
    });

  httpServer.listen(config.port, config.host, () => {
    console.log(`[signaling] listening on http://${config.host}:${config.port}`);
    console.log(`[signaling] health endpoint: http://${config.host}:${config.port}/health`);
    console.log(`[signaling] metrics endpoint: http://${config.host}:${config.port}/metrics`);
  });

  // Graceful shutdown: stop accepting connections, drain Socket.IO, then exit.
  // This lets platforms like Render perform zero-downtime redeploys instead of
  // hard-killing in-flight connections.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[signaling] received ${signal}, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      console.warn('[signaling] graceful shutdown timed out; forcing exit.');
      process.exit(1);
    }, 10000);
    forceExit.unref?.();

    io.close(() => {
      httpServer.close(async () => {
        await redisAdapter.close();
        await telemetry.flush();
        clearTimeout(forceExit);
        console.log('[signaling] shutdown complete.');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
