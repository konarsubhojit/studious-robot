// @ts-check
'use strict';

/**
 * Cross-instance message bus.
 *
 * When the signaling server runs as more than one process/instance behind a
 * load balancer, instances must be able to notify one another about events that
 * originate on a different node — for example a call-state transition handled by
 * the instance that owns the caller's socket, which the instance owning the
 * callee's socket needs to react to.
 *
 * The bus exposes a tiny publish/subscribe contract that is intentionally
 * transport-agnostic:
 *
 *   publish(channel, message)        → Promise<void>
 *   subscribe(channel, handler)      → Promise<() => Promise<void>>  (unsubscribe)
 *   close()                          → Promise<void>
 *
 * `message` is serialised to JSON on publish and parsed back to an object before
 * the handler is invoked (raw non-JSON strings are passed through unchanged).
 *
 * Two implementations are provided:
 *   - {@link createMemoryMessageBus} — in-process EventEmitter; the default for
 *     single-instance deployments and tests. Cross-instance delivery is a no-op
 *     because there is only one instance.
 *   - {@link createRedisMessageBus} — Redis Pub/Sub, for horizontal scaling.
 */

const { EventEmitter } = require('events');
const { toLogMessage } = require('./lib/normalize');

/**
 * The publish/subscribe contract every message bus implementation honours.
 *
 * @typedef {object} MessageBus
 * @property {string} type  Implementation name (`'memory'` / `'redis'`).
 * @property {(channel: string, message: unknown) => Promise<void>} publish
 * @property {(channel: string, handler: (message: unknown, channel: string) => void) => Promise<() => Promise<void>>} subscribe
 * @property {() => Promise<void>} close
 */

/**
 * Serialise a message for transport. Objects become JSON; strings are sent
 * as-is so callers may publish pre-encoded payloads.
 *
 * @param {unknown} message
 * @returns {string}
 */
function encode(message) {
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/**
 * Parse a transported payload back into an object, falling back to the raw
 * string when it is not valid JSON.
 *
 * @param {string} payload
 * @returns {unknown}
 */
function decode(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/**
 * Create an in-process message bus backed by an `EventEmitter`.
 *
 * Suitable for single-instance deployments and tests: publishes are delivered
 * to local subscribers only, asynchronously (mirroring network pub/sub timing
 * so call sites cannot accidentally rely on synchronous delivery).
 *
 * @returns {import('./messageBus').MessageBus}
 */
function createMemoryMessageBus() {
  const emitter = new EventEmitter();
  // Many call/user channels may be subscribed concurrently.
  emitter.setMaxListeners(0);
  let closed = false;

  return {
    type: 'memory',

    async publish(channel, message) {
      if (closed) return;
      const payload = encode(message);
      // Defer so delivery is asynchronous, matching Redis semantics.
      setImmediate(() => {
        if (!closed) emitter.emit(channel, payload);
      });
    },

    async subscribe(channel, handler) {
      const listener = (/** @type {string} */ payload) => {
        try {
          handler(decode(payload), channel);
        } catch (error) {
          console.error(`[messageBus] handler for "${channel}" threw: ${toLogMessage(error)}`);
        }
      };
      emitter.on(channel, listener);
      return async () => {
        emitter.off(channel, listener);
      };
    },

    async close() {
      closed = true;
      emitter.removeAllListeners();
    },
  };
}

/**
 * Create a Redis Pub/Sub-backed message bus.
 *
 * Redis requires a dedicated connection for subscriptions (a subscriber client
 * cannot issue normal commands), so two clients are supplied: `pub` for
 * publishing and `sub` for subscribing. Both must already be connected. The bus
 * multiplexes multiple local handlers per channel over a single Redis
 * subscription and only issues `UNSUBSCRIBE` once the last handler for a channel
 * is removed.
 *
 * The client contract matches `node-redis` v4+:
 *   pub.publish(channel, message)
 *   sub.subscribe(channel, (message, channel) => void)
 *   sub.unsubscribe(channel)
 *   client.quit()
 *
 * @param {{ pub: any, sub: any, ownsClients?: boolean }} opts
 * @returns {import('./messageBus').MessageBus}
 */
function createRedisMessageBus({ pub, sub, ownsClients = false }) {
  if (!pub || !sub) {
    throw new Error('createRedisMessageBus: both "pub" and "sub" clients are required');
  }

  /** @type {Map<string, Set<(message: unknown, channel: string) => void>>} */
  const handlers = new Map();
  let closed = false;

  return {
    type: 'redis',

    async publish(channel, message) {
      if (closed) return;
      await pub.publish(channel, encode(message));
    },

    async subscribe(channel, handler) {
      if (closed) throw new Error('createRedisMessageBus: bus is closed');

      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        // One Redis subscription per channel; fan out to local handlers.
        await sub.subscribe(channel, (/** @type {string} */ payload) => {
          const message = decode(payload);
          for (const fn of handlers.get(channel) ?? []) {
            try {
              fn(message, channel);
            } catch (error) {
              console.error(`[messageBus] handler for "${channel}" threw: ${toLogMessage(error)}`);
            }
          }
        });
      }
      set.add(handler);

      return async () => {
        const current = handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(channel);
          if (!closed) {
            try {
              await sub.unsubscribe(channel);
            } catch (error) {
              console.error(`[messageBus] unsubscribe "${channel}" failed: ${toLogMessage(error)}`);
            }
          }
        }
      };
    },

    async close() {
      if (closed) return;

      // Unsubscribe from all known channels so a reused (non-owned) `sub`
      // client doesn't keep receiving messages with no local handlers.
      const channels = Array.from(handlers.keys());
      if (sub && typeof sub.unsubscribe === 'function') {
        for (const channel of channels) {
          try {
            await sub.unsubscribe(channel);
          } catch (error) {
            console.error(`[messageBus] unsubscribe "${channel}" failed: ${toLogMessage(error)}`);
          }
        }
      }

      closed = true;
      handlers.clear();
      if (ownsClients) {
        await Promise.allSettled([pub.quit?.(), sub.quit?.()]);
      }
    },
  };
}

module.exports = { createMemoryMessageBus, createRedisMessageBus };
