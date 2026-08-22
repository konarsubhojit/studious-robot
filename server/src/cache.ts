/**
 * Read-through cache for hot, repeatedly-issued queries.
 *
 * Mirrors the transport-agnostic style of `messageBus.js` and `messageStore.js`:
 * a tiny interface with an in-process default and an optional durable backend,
 * chosen by environment configuration.  When no `REDIS_URL` is configured the
 * server uses the in-memory implementation and behaves exactly as it did before
 * caching existed, other than latency.
 *
 * Interface
 * ─────────
 *   get(key)                → Promise<any | undefined>
 *   set(key, value, ttlMs)  → Promise<void>
 *   delByPrefix(prefix)     → Promise<void>
 *   close()                 → Promise<void>
 *
 * Key scheme (see {@link conversationsCacheKey} and friends)
 * ─────────────────────────────────────────────────────────
 *   conv::<userId>                      → listConversations(userId)
 *   msg::<conversationId>::<limit>      → first page of listMessages
 *   callhist::<userId>::<status>::<limit> → GET /calls payload
 *
 * Deep pagination (`before` present) is deliberately not cached: it is rare,
 * unbounded in key space and the least latency-sensitive path.
 */

/** Default time-to-live for every cached entry, in milliseconds. */
const DEFAULT_TTL_MS = 30_000;
/** Upper bound on entries held by the memory backend before LRU eviction. */
const DEFAULT_MAX_ENTRIES = 1_000;
/** Namespace applied to every Redis key so `delByPrefix` can never scan beyond the cache. */
const REDIS_KEY_PREFIX = 'wetalk:cache:';

/**
 * Message-bus channel carrying cache invalidations so every instance drops its
 * local entries, not just the one that handled the write.
 */
const CACHE_INVALIDATE_CHANNEL = 'signaling:cache.invalidate';

// ─── Key helpers ──────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @returns {string} Cache key for that user's conversation list.
 */
function conversationsCacheKey(userId: string): string {
  return `conv::${userId}`;
}

/**
 * @param {string} userId
 * @returns {string} Prefix matching every conversation-list key for a user.
 */
function conversationsCachePrefix(userId: string): string {
  return conversationsCacheKey(userId);
}

/**
 * @param {string} conversationId
 * @param {number} limit
 * @returns {string} Cache key for the first page of a conversation's history.
 */
function messagesCacheKey(conversationId: string, limit: number): string {
  return `msg::${conversationId}::${limit}`;
}

/**
 * @param {string} conversationId
 * @returns {string} Prefix matching every page-size variant for a conversation.
 */
function messagesCachePrefix(conversationId: string): string {
  return `msg::${conversationId}::`;
}

/**
 * @param {string} userId
 * @param {string|null} statusFilter
 * @param {number} limit
 * @returns {string} Cache key for a user's call-history page.
 */
function callHistoryCacheKey(userId: string, statusFilter: string | null, limit: number): string {
  return `callhist::${userId}::${statusFilter || '*'}::${limit}`;
}

/**
 * @param {string} userId
 * @returns {string} Prefix matching every call-history key for a user.
 */
function callHistoryCachePrefix(userId: string): string {
  return `callhist::${userId}::`;
}

export type Cache = { type: 'memory' | 'redis'; get: (key: string) => Promise<any|undefined>; set: (key: string, value: unknown, ttlMs?: number) => Promise<void>; delByPrefix: (prefix: string) => Promise<void>; close: () => Promise<void>; };

export type CacheableState = { cache?: Cache; telemetry?: import('./telemetry.ts').Telemetry; messageBus?: import('./messageBus.ts').MessageBus | null; };

/**
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Memory backend ───────────────────────────────────────────────────────────

/**
 * Create an in-process cache backed by a `Map` with expiry timestamps and a
 * bounded entry count (least-recently-used eviction).
 *
 * `Map` preserves insertion order, so re-inserting an entry on every read moves
 * it to the back of the iteration order and the oldest key is always first.
 *
 * @param {{ maxEntries?: number }} [opts]
 * @returns {Cache & { size: () => number }} Cache instance.
 */
function createMemoryCache({ maxEntries = DEFAULT_MAX_ENTRIES }: { maxEntries?: number; } = {}): Cache & { size: () => number; } {
  /** @type {Map<string, { value: unknown, expiresAtMs: number }>} */
  const entries: Map<string, { value: unknown; expiresAtMs: number; }> = new Map();

  return {
    type: 'memory',

    async get(/** @type {string} */ key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAtMs <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency for the LRU bound.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    async set(
      /** @type {string} */ key: string,
      /** @type {unknown} */ value: unknown,
      ttlMs = DEFAULT_TTL_MS
    ) {
      entries.delete(key);
      entries.set(key, { value, expiresAtMs: Date.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },

    async delByPrefix(/** @type {string} */ prefix: string) {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },

    async close() {
      entries.clear();
    },

    /** Test/introspection helper: current entry count (including expired). */
    size() {
      return entries.size;
    },
  };
}

// ─── Redis backend ────────────────────────────────────────────────────────────

/**
 * Iterate the keys produced by `SCAN MATCH pattern`.
 *
 * `scanIterator` yields a single key per iteration on node-redis v4 and an
 * array of keys per iteration on v5; both shapes are handled here.
 *
 * @param {any} client
 * @param {string} pattern
 * @returns {AsyncGenerator<string>}
 */
async function* scanKeys(client: any, pattern: string): AsyncGenerator<string> {
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (Array.isArray(batch)) {
      for (const key of batch) yield key;
    } else {
      yield batch;
    }
  }
}

/**
 * Create a Redis-backed cache.
 *
 * Values are stored JSON-encoded with `SET … PX <ttl>` so Redis owns expiry.
 * `delByPrefix` uses `SCAN` (never `KEYS`, which blocks the Redis event loop).
 *
 * @param {{ client: any, ownsClient?: boolean, keyPrefix?: string }} opts
 * @returns {Cache} Cache instance.
 */
function createRedisCache({ client, ownsClient = false, keyPrefix = REDIS_KEY_PREFIX }: { client: any; ownsClient?: boolean; keyPrefix?: string; }): Cache {
  if (!client) {
    throw new Error('createRedisCache: a connected Redis "client" is required');
  }
  let closed = false;

  return {
    type: 'redis',

    async get(/** @type {string} */ key: string) {
      if (closed) return undefined;
      const raw = await client.get(keyPrefix + key);
      if (raw === null || raw === undefined) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },

    async set(
      /** @type {string} */ key: string,
      /** @type {unknown} */ value: unknown,
      ttlMs = DEFAULT_TTL_MS
    ) {
      if (closed) return;
      await client.set(keyPrefix + key, JSON.stringify(value), { PX: Math.max(1, ttlMs) });
    },

    async delByPrefix(/** @type {string} */ prefix: string) {
      if (closed) return;
      // Escape glob metacharacters so ids can never widen the match pattern.
      const pattern = `${keyPrefix}${prefix}`.replace(/([[\]?*\\])/g, '\\$1') + '*';
      /** @type {string[]} */
      let batch: string[] = [];
      for await (const key of scanKeys(client, pattern)) {
        batch.push(key);
        if (batch.length >= 100) {
          await client.del(batch);
          batch = [];
        }
      }
      if (batch.length > 0) await client.del(batch);
    },

    async close() {
      if (closed) return;
      closed = true;
      if (ownsClient) {
        await client.quit?.();
      }
    },
  };
}

/**
 * Create the cache backend appropriate for the current deployment.
 *
 * Falls back to the memory backend when `redisUrl` is falsy (and when opening
 * the Redis client fails, so a cache outage degrades to per-instance caching
 * rather than taking the server down).
 *
 * @param {{ redisUrl?: string, createClient?: () => any, maxEntries?: number }} [opts]
 * @returns {Promise<Cache>} Cache instance.
 */
async function createCache(opts: { redisUrl?: string; createClient?: () => any; maxEntries?: number; } = {}): Promise<Cache> {
  const { redisUrl, createClient, maxEntries } = opts;
  if (!redisUrl && !createClient) {
    return createMemoryCache({ maxEntries });
  }

  const factory = createClient || (() => require('redis').createClient({ url: redisUrl }));
  try {
    const client = factory();
    client.on?.('error', (/** @type {unknown} */ error: unknown) => {
      console.error(`[cache] redis client error: ${errorMessage(error)}`);
    });
    await client.connect?.();
    return createRedisCache({ client, ownsClient: true });
  } catch (error) {
    console.error(
      '[cache] failed to initialise Redis cache, falling back to in-process cache: ' +
        errorMessage(error)
    );
    return createMemoryCache({ maxEntries });
  }
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Read a cached value, recording the hit/miss on the shared telemetry counters.
 *
 * Never throws: a cache outage degrades to a miss so the caller falls through
 * to the underlying store.
 *
 * @param {CacheableState} state
 * @param {string} key
 * @returns {Promise<any|undefined>}
 */
async function readCached(state: CacheableState, key: string): Promise<any | undefined> {
  if (!state?.cache) return undefined;
  try {
    const value = await state.cache.get(key);
    if (value !== undefined) {
      state.telemetry?.recordCacheHit?.();
      return value;
    }
  } catch (error) {
    console.error(`[cache] read failed for "${key}": ${errorMessage(error)}`);
  }
  state.telemetry?.recordCacheMiss?.();
  return undefined;
}

/**
 * Store a value in the shared cache.  Never throws.
 *
 * @param {CacheableState} state
 * @param {string} key
 * @param {unknown} value
 * @param {number} [ttlMs]
 * @returns {Promise<void>}
 */
async function writeCached(state: CacheableState, key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
  if (!state?.cache) return;
  try {
    await state.cache.set(key, value, ttlMs);
  } catch (error) {
    console.error(`[cache] write failed for "${key}": ${errorMessage(error)}`);
  }
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

/**
 * Evict every cache entry under `prefixes`, locally and on every other
 * instance.
 *
 * The local eviction is applied first (so a read issued immediately after a
 * write on this instance can never observe the stale entry), then the prefixes
 * are published on the shared bus so peers drop their copies too.
 *
 * Best-effort: cache/bus failures are logged, never thrown, because a caching
 * fault must not fail the write that triggered it.
 *
 * @param {CacheableState} state
 * @param {...string} prefixes
 * @returns {Promise<void>}
 */
async function invalidateCache(state: CacheableState, ...prefixes: string[]): Promise<void> {
  const wanted = prefixes.filter(Boolean);
  if (!state?.cache || wanted.length === 0) return;

  const cache = state.cache;
  await Promise.all(
    wanted.map((prefix) =>
      Promise.resolve(cache.delByPrefix(prefix)).catch((/** @type {unknown} */ error: unknown) => {
        console.error(`[cache] eviction failed for "${prefix}": ${errorMessage(error)}`);
      })
    )
  );

  if (state.messageBus) {
    try {
      await state.messageBus.publish(CACHE_INVALIDATE_CHANNEL, { prefixes: wanted });
    } catch (error) {
      console.error(`[cache] invalidation publish failed: ${errorMessage(error)}`);
    }
  }
}

/**
 * Subscribe an instance to cache invalidations broadcast by its peers.
 *
 * A no-op (resolving to `null`) when no cross-instance bus is configured.
 *
 * @param {CacheableState} state
 * @returns {Promise<(() => Promise<void>)|null>} Unsubscribe handle.
 */
async function subscribeToCacheInvalidations(state: CacheableState): Promise<(() => Promise<void>) | null> {
  if (!state?.cache || !state?.messageBus) return null;
  const cache = state.cache;
  return state.messageBus.subscribe(CACHE_INVALIDATE_CHANNEL, (message) => {
    const prefixes = (Array.isArray((message as any)?.prefixes)
        ? (message as any).prefixes
        : [] as unknown[]);
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || prefix.length === 0) continue;
      Promise.resolve(cache.delByPrefix(prefix)).catch((/** @type {unknown} */ error: unknown) => {
        console.error(`[cache] remote eviction failed for "${prefix}": ${errorMessage(error)}`);
      });
    }
  });
}

export {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  CACHE_INVALIDATE_CHANNEL,
  createCache,
  createMemoryCache,
  createRedisCache,
  readCached,
  writeCached,
  invalidateCache,
  subscribeToCacheInvalidations,
  conversationsCacheKey,
  conversationsCachePrefix,
  messagesCacheKey,
  messagesCachePrefix,
  callHistoryCacheKey,
  callHistoryCachePrefix,
};
