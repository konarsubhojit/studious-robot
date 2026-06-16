'use strict';

/**
 * Attach the Socket.IO Redis adapter for horizontal scaling.
 *
 * Without an adapter, each server instance only knows about the sockets it
 * holds locally, so two participants connected to different replicas could not
 * exchange signaling messages. The Redis adapter (an optional dependency)
 * broadcasts room events across every instance subscribed to the same Redis,
 * letting the signaling tier scale out (and autoscale) behind a load balancer.
 *
 * Enabled only when `REDIS_URL` is configured. If the optional packages are not
 * installed, the server logs a warning and continues in single-instance mode
 * rather than failing to boot.
 *
 * @param {import('socket.io').Server} io
 * @param {object} options
 * @param {string|null} options.redisUrl
 * @param {object} [options.logger=console]
 * @param {object} [options.telemetry]
 * @returns {Promise<{ enabled: boolean, close: () => Promise<void> }>}
 */
async function attachRedisAdapter(io, { redisUrl, logger = console, telemetry } = {}) {
  const noop = { enabled: false, close: async () => {} };

  if (!redisUrl) {
    return noop;
  }

  let createAdapter;
  let createClient;
  try {
    // Optional dependencies: only loaded when REDIS_URL is set.
    // eslint-disable-next-line global-require
    ({ createAdapter } = require('@socket.io/redis-adapter'));
    // eslint-disable-next-line global-require
    ({ createClient } = require('redis'));
  } catch (err) {
    logger.warn?.(`[scale] REDIS_URL set but Redis packages unavailable; running single-instance: ${err.message}`);
    telemetry?.captureMessage?.('Redis adapter requested but packages missing', { error: err.message });
    return noop;
  }

  const pubClient = createClient({ url: redisUrl });
  const subClient = pubClient.duplicate();

  // Never let a Redis connection error crash the process.
  pubClient.on('error', (err) => {
    logger.warn?.(`[scale] redis pub client error: ${err.message}`);
    telemetry?.captureException?.(err, { component: 'redis-pub' });
  });
  subClient.on('error', (err) => {
    logger.warn?.(`[scale] redis sub client error: ${err.message}`);
    telemetry?.captureException?.(err, { component: 'redis-sub' });
  });

  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
  logger.info?.('[scale] Socket.IO Redis adapter attached; multi-instance signaling enabled.');

  return {
    enabled: true,
    close: async () => {
      try {
        await Promise.all([pubClient.quit(), subClient.quit()]);
      } catch {
        // Best-effort cleanup on shutdown.
      }
    },
  };
}

module.exports = { attachRedisAdapter };
