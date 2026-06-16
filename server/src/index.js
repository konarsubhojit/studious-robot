'use strict';

const http = require('http');
const { Server } = require('socket.io');

const { loadConfig } = require('./config');
const { createMetrics } = require('./metrics');
const { createRoomStore } = require('./roomStore');
const { createApp } = require('./app');
const { registerSignaling } = require('./signaling');

/**
 * Build the Express app and HTTP/Socket.IO server.
 *
 * Exported as a factory so tests can spin up an isolated instance on an
 * ephemeral port without starting the production listener. Behaviour is
 * composed from focused modules: `config` (env), `roomStore` (membership),
 * `metrics` (counters), `app` (HTTP), and `signaling` (Socket.IO handlers).
 *
 * @param {object} [options]
 * @param {ReturnType<typeof loadConfig>} [options.config] - Override config (tests).
 * @returns {{ app: import('express').Express, httpServer: import('http').Server, io: import('socket.io').Server, rooms: object, metrics: object, config: object }}
 */
function createServer({ config = loadConfig() } = {}) {
  const metrics = createMetrics();
  const rooms = createRoomStore({ maxRoomSize: config.maxRoomSize });

  const app = createApp({ metrics, rooms });
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin },
  });

  registerSignaling(io, { rooms, metrics });

  return { app, httpServer, io, rooms, metrics, config };
}

module.exports = { createServer };

if (require.main === module) {
  const config = loadConfig();
  const { httpServer, io } = createServer({ config });

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
      httpServer.close(() => {
        clearTimeout(forceExit);
        console.log('[signaling] shutdown complete.');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
