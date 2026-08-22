/**
 * Redis + Postgres ("hot + durable") store bundle for horizontal scaling.
 *
 * The signaling server keeps its keyed runtime collections behind a pluggable
 * {@link import('./contracts.ts').Stores} bundle. The default in-memory bundle
 * (see `./memory`) is correct for a single instance. To run multiple instances
 * behind a load balancer two things are required beyond shared durable storage:
 *
 *   1. A **cross-instance message bus** so an event handled on one instance can
 *      be observed by the others (see `../messageBus`).
 *   2. A **Socket.IO Redis adapter** so room/`io.to(...)` emits fan out to
 *      sockets connected to other instances.
 *
 * `createRedisPgStores()` wires both using Redis Pub/Sub, and returns the store
 * bundle augmented with `messageBus`, `attachAdapter(io)`, and `close()`.
 *
 * Hot keyed state (rooms, sessions, presence, …) is kept as in-process `Map`s on
 * each instance — the store contract is synchronous, and per-socket emits are
 * routed across instances by the Redis adapter via per-user rooms rather than by
 * sharing the maps. Durable records (call history, devices, audit, blocks) are
 * persisted through the Drizzle Postgres client (`server/db/client.js`) where
 * appropriate; this module focuses on the Redis wiring that the durable layer
 * and the adapter depend on.
 */

import { STORE_NAMES } from './contracts.ts';
import { createRedisMessageBus } from '../messageBus.ts';

/**
 * Build the hot in-process keyed collections required by the store contract.
 *
 * @returns {Record<string, Map<unknown, unknown>>}
 */
function createHotMaps(): Record<string, Map<unknown, unknown>> {
  /** @type {Record<string, Map<unknown, unknown>>} */
  const maps: Record<string, Map<unknown, unknown>> = {};
  for (const name of STORE_NAMES) {
    maps[name] = new Map();
  }
  return maps;
}

/**
 * Create a Redis-backed store bundle with a cross-instance message bus and a
 * Socket.IO Redis adapter.
 *
 * Four Redis connections are opened: a publish/subscribe pair for the message
 * bus and a separate pair for the Socket.IO adapter (Socket.IO's adapter and a
 * Pub/Sub subscriber must not share a subscriber connection).
 *
 * For testability without a live Redis, callers may inject a `createClient`
 * factory (each call must return a fresh, connectable client) and a
 * `createAdapter` function.
 *
 * @param {object} [opts]
 * @param {string} [opts.redisUrl]   Redis connection URL (defaults to `REDIS_URL`).
 * @param {() => any} [opts.createClient]   Client factory; defaults to `redis.createClient`.
 * @param {(pub: any, sub: any) => any} [opts.createAdapter]
 *   Socket.IO adapter factory; defaults to `@socket.io/redis-adapter.createAdapter`.
 * @returns {Promise<import('./contracts.ts').Stores & {
 *   messageBus: import('../messageBus.ts').MessageBus,
 *   attachAdapter: (io: any) => void,
 *   close: () => Promise<void>,
 * }>}
 */
async function createRedisPgStores(opts: { redisUrl?: string; createClient?: () => any; createAdapter?: (pub: any, sub: any) => any; } = {}): Promise<import('./contracts.ts').Stores & {
    messageBus: import('../messageBus.ts').MessageBus;
    attachAdapter: (io: any) => void;
    close: () => Promise<void>;
}> {
  const url = opts.redisUrl || process.env.REDIS_URL;
  if (!url && !opts.createClient) {
    throw new Error('createRedisPgStores: set REDIS_URL or pass opts.createClient');
  }

  // The optional Redis dependencies are imported here (rather than at module
  // scope) so the default in-memory path never loads them.
  const createClient =
    opts.createClient || ((await import('redis')).createClient.bind(null, { url }));
  const createAdapter =
    opts.createAdapter || (await import('@socket.io/redis-adapter')).createAdapter;

  /** @type {any[]} Every Redis client opened here, for orderly shutdown. */
  const clients: any[] = [];

  /**
   * Open and connect a fresh Redis client, tracking it for `close()`.
   *
   * @returns {Promise<any>}
   */
  async function openClient(): Promise<any> {
    const client = createClient();
    // node-redis surfaces connection errors as 'error' events; log instead of
    // letting them crash the process.
    client.on?.('error', (/** @type {any} */ error: any) => {
      console.error(`[stores:redis] client error: ${error?.message}`);
    });
    await client.connect?.();
    clients.push(client);
    return client;
  }

  const busPub = await openClient();
  const busSub = await openClient();
  const adapterPub = await openClient();
  const adapterSub = await openClient();

  const messageBus = createRedisMessageBus({ pub: busPub, sub: busSub });

  /** @type {Record<string, any>} */
  const bundle: Record<string, any> = createHotMaps();
  bundle.messageBus = messageBus;

  /**
   * Attach the Socket.IO Redis adapter to a server instance so room/user emits
   * fan out across all instances.
   *
   * @param {any} io  Socket.IO server.
   */
  bundle.attachAdapter = (io: any) => {
    io.adapter(createAdapter(adapterPub, adapterSub));
  };

  /**
   * Tear down the message bus and close every Redis connection.
   *
   * @returns {Promise<void>}
   */
  bundle.close = async (): Promise<void> => {
    await messageBus.close();
    await Promise.allSettled(clients.map((client) => client.quit?.()));
  };

  return (bundle as any);
}

export { createRedisPgStores };
