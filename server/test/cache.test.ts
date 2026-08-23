/**
 * Unit tests for the shared read cache (`src/cache.js`).
 *
 * Both backends are covered: the in-process default and the Redis backend,
 * exercised against an in-memory fake that honours the small slice of the
 * `node-redis` contract the cache depends on (`get`, `set` with `PX`,
 * `scanIterator`, `del`) — no live Redis required, mirroring
 * `message-bus.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCache, createMemoryCache, createRedisCache, invalidateCache, subscribeToCacheInvalidations, CACHE_INVALIDATE_CHANNEL, conversationsCacheKey, messagesCacheKey, messagesCachePrefix, callHistoryCacheKey, callHistoryCachePrefix } from '../src/cache.ts';
import { createMemoryMessageBus } from '../src/messageBus.ts';

/** Resolve after pending `setImmediate`/microtasks so async delivery lands. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A `node-redis`-shaped client backed by a plain Map, with PX expiry. */
function createFakeRedisClient() {
  const store: Map<string, { value: string; expiresAtMs: number; }> = new Map();
  return {
    store,
    quitCalled: false,
    on() {
      /* error listener hook */
    },
    async connect() {},
    async quit() {
      this.quitCalled = true;
    },
    /** @param key */
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, options?: { PX?: number; }) {
      store.set(key, { value, expiresAtMs: Date.now() + Number(options?.PX ?? 0) });
    },
    /** @param keys */
    async del(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    },
    /** @param options */
    async *scanIterator({ MATCH }: { MATCH: string; }) {
      // Translate the (escaped) glob into a RegExp the same way Redis would.
      const source = MATCH.replace(/\\(.)/g, '\u0000$1')
        .replace(/[.+^${}()|]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
        .replace(/\u0000(.)/g, (_m: string, ch: string) =>
          ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        );
      const pattern = new RegExp(`^${source}$`);
      for (const key of [...store.keys()]) {
        if (pattern.test(key)) yield key;
      }
    },
  };
}

// ─── Key scheme ───────────────────────────────────────────────────────────────

test('cache keys follow the documented namespaced scheme', () => {
  assert.equal(conversationsCacheKey('alice'), 'conv::alice');
  assert.equal(messagesCacheKey('alice:bob', 50), 'msg::alice:bob::50');
  assert.equal(messagesCachePrefix('alice:bob'), 'msg::alice:bob::');
  assert.equal(callHistoryCacheKey('alice', null, 20), 'callhist::alice::*::20');
  assert.equal(callHistoryCacheKey('alice', 'missed', 20), 'callhist::alice::missed::20');
  assert.equal(callHistoryCachePrefix('alice'), 'callhist::alice::');
});

// ─── Memory backend ───────────────────────────────────────────────────────────

test('createCache returns the memory backend when no redisUrl is configured', async () => {
  const cache = await createCache({});
  assert.equal(cache.type, 'memory');
  await cache.close();
});

test('memory cache round-trips values and reports a miss for unknown keys', async () => {
  const cache = createMemoryCache();
  assert.equal(await cache.get('conv::alice'), undefined);

  await cache.set('conv::alice', [{ peerId: 'bob' }], 1_000);
  assert.deepEqual(await cache.get('conv::alice'), [{ peerId: 'bob' }]);
  await cache.close();
});

test('memory cache expires entries once their TTL has elapsed', async () => {
  const cache = createMemoryCache();
  await cache.set('conv::alice', 'value', 10);
  assert.equal(await cache.get('conv::alice'), 'value');

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await cache.get('conv::alice'), undefined);
  await cache.close();
});

test('memory cache delByPrefix removes only the matching keys', async () => {
  const cache = createMemoryCache();
  await cache.set(messagesCacheKey('a:b', 20), 'x', 1_000);
  await cache.set(messagesCacheKey('a:b', 50), 'y', 1_000);
  await cache.set(messagesCacheKey('a:c', 50), 'z', 1_000);
  await cache.set(conversationsCacheKey('a'), 'conv', 1_000);

  await cache.delByPrefix(messagesCachePrefix('a:b'));

  assert.equal(await cache.get(messagesCacheKey('a:b', 20)), undefined);
  assert.equal(await cache.get(messagesCacheKey('a:b', 50)), undefined);
  assert.equal(await cache.get(messagesCacheKey('a:c', 50)), 'z');
  assert.equal(await cache.get(conversationsCacheKey('a')), 'conv');
  await cache.close();
});

test('memory cache evicts the least recently used entry beyond maxEntries', async () => {
  const cache = createMemoryCache({ maxEntries: 3 });
  await cache.set('k1', 1, 1_000);
  await cache.set('k2', 2, 1_000);
  await cache.set('k3', 3, 1_000);

  // Touching k1 makes k2 the least recently used entry.
  assert.equal(await cache.get('k1'), 1);
  await cache.set('k4', 4, 1_000);

  assert.equal(cache.size(), 3);
  assert.equal(await cache.get('k2'), undefined);
  assert.equal(await cache.get('k1'), 1);
  assert.equal(await cache.get('k3'), 3);
  assert.equal(await cache.get('k4'), 4);
  await cache.close();
});

// ─── Redis backend ────────────────────────────────────────────────────────────

test('redis cache round-trips values through SET/GET with a PX expiry', async () => {
  const client = createFakeRedisClient();
  const cache = createRedisCache({ client });
  assert.equal(cache.type, 'redis');

  await cache.set(conversationsCacheKey('alice'), [{ peerId: 'bob' }], 1_000);
  assert.deepEqual(await cache.get(conversationsCacheKey('alice')), [{ peerId: 'bob' }]);

  const [entry] = [...client.store.values()];
  assert.ok(entry.expiresAtMs > Date.now());
  await cache.close();
});

test('redis cache honours the TTL written with PX', async () => {
  const client = createFakeRedisClient();
  const cache = createRedisCache({ client });
  await cache.set('conv::alice', 'value', 10);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await cache.get('conv::alice'), undefined);
  await cache.close();
});

test('redis cache delByPrefix scans and deletes only matching keys', async () => {
  const client = createFakeRedisClient();
  const cache = createRedisCache({ client });
  await cache.set(messagesCacheKey('a:b', 20), 'x', 1_000);
  await cache.set(messagesCacheKey('a:b', 50), 'y', 1_000);
  await cache.set(messagesCacheKey('a:c', 50), 'z', 1_000);
  await cache.set(conversationsCacheKey('a'), 'conv', 1_000);

  await cache.delByPrefix(messagesCachePrefix('a:b'));

  assert.equal(await cache.get(messagesCacheKey('a:b', 20)), undefined);
  assert.equal(await cache.get(messagesCacheKey('a:b', 50)), undefined);
  assert.equal(await cache.get(messagesCacheKey('a:c', 50)), 'z');
  assert.equal(await cache.get(conversationsCacheKey('a')), 'conv');
  await cache.close();
});

test('redis cache never issues KEYS and closes an owned client', async () => {
  const client = createFakeRedisClient();
  assert.equal(typeof ((client as Record<string, unknown>).keys), 'undefined');
  const cache = createRedisCache({ client, ownsClient: true });
  await cache.set('conv::alice', 'value', 1_000);
  await cache.delByPrefix('conv::');
  await cache.close();
  assert.equal(client.quitCalled, true);
});

test('createCache falls back to the memory backend when Redis cannot be opened', async () => {
  const cache = await createCache({
    redisUrl: 'redis://unused',
    createClient: () => {
      throw new Error('connection refused');
    },
  });
  assert.equal(cache.type, 'memory');
  await cache.close();
});

// Regression: the non-injected branch used to call CommonJS `require('redis')`,
// which throws `ReferenceError: require is not defined` under this ESM package.
// The `redis` module itself is mocked so no live server is needed, but the
// module-resolution path inside `createCache` is exercised for real.
test('createCache loads the redis module when no client factory is injected', async (t) => {
  const created: { url?: string; }[] = [];
  t.mock.module('redis', {
    namedExports: {
      createClient(options: { url?: string; }) {
        created.push(options);
        return createFakeRedisClient();
      },
    },
  });

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
  try {
    const cache = await createCache({ redisUrl: 'redis://127.0.0.1:6379' });
    assert.deepEqual(
      errors.filter((line) => line.includes('[cache]')),
      [],
      'the Redis backend opened without falling back'
    );
    assert.equal(cache.type, 'redis');
    assert.deepEqual(created, [{ url: 'redis://127.0.0.1:6379' }]);
    await cache.close();
  } finally {
    console.error = originalError;
  }
});

// ─── Invalidation over the bus ────────────────────────────────────────────────

test('invalidateCache evicts locally and publishes the prefixes on the bus', async () => {
  const bus = createMemoryMessageBus();
  const received: any[] = [];
  await bus.subscribe(CACHE_INVALIDATE_CHANNEL, (message) => {
    received.push(message);
  });

  const state = { cache: createMemoryCache(), messageBus: bus };
  await state.cache.set(conversationsCacheKey('alice'), 'stale', 10_000);

  await invalidateCache(state, conversationsCacheKey('alice'));
  await tick();

  assert.equal(await state.cache.get(conversationsCacheKey('alice')), undefined);
  assert.deepEqual(received, [{ prefixes: ['conv::alice'] }]);
  await bus.close();
});

test('a write on one instance invalidates the cache of another instance', async () => {
  // Two instances sharing one bus, each with its own in-process cache.
  const bus = createMemoryMessageBus();
  const instanceA = { cache: createMemoryCache(), messageBus: bus };
  const instanceB = { cache: createMemoryCache(), messageBus: bus };
  await subscribeToCacheInvalidations(instanceA);
  await subscribeToCacheInvalidations(instanceB);

  await instanceB.cache.set(conversationsCacheKey('alice'), 'stale', 10_000);
  await instanceB.cache.set(messagesCacheKey('alice:bob', 50), 'stale', 10_000);

  await invalidateCache(
    instanceA,
    conversationsCacheKey('alice'),
    messagesCachePrefix('alice:bob')
  );
  await tick();
  await tick();

  assert.equal(await instanceB.cache.get(conversationsCacheKey('alice')), undefined);
  assert.equal(await instanceB.cache.get(messagesCacheKey('alice:bob', 50)), undefined);
  await bus.close();
});

test('invalidateCache is a no-op without a cache and never throws on backend errors', async () => {
  await invalidateCache({}, 'conv::alice');

  // A backend that only implements the failing call under test.
  const failing = (({
      cache: {
        async delByPrefix() {
          throw new Error('redis down');
        },
      },
      messageBus: null,
    } as unknown) as import('../src/cache.ts').CacheableState);
  await invalidateCache(failing, 'conv::alice');
});

test('subscribeToCacheInvalidations is a no-op without a bus', async () => {
  assert.equal(await subscribeToCacheInvalidations({ cache: createMemoryCache() }), null);
});
