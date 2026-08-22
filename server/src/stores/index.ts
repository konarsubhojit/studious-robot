import { STORE_NAMES } from './contracts.ts';
import { createMemoryStores } from './memory.ts';

/**
 * Validate that a caller-supplied object provides every store in the contract.
 *
 * @param {Record<string, unknown>} stores
 * @returns {import('./contracts.ts').Stores}
 */
function assertStores(stores: Record<string, unknown>): import('./contracts.ts').Stores {
  for (const name of STORE_NAMES) {
    if (!(name in stores) || stores[name] == null) {
      throw new Error(`createStores: missing store "${name}"`);
    }
  }
  return (stores as import('./contracts.ts').Stores);
}

/**
 * Factory for the server's persistence stores.
 *
 * By default this returns the in-memory implementation.  Callers (including
 * tests) may inject a pre-built bundle via `opts.stores` to swap in an
 * alternative backend (e.g. Redis/Postgres) while keeping the same interface;
 * the bundle is validated against the {@link STORE_NAMES} contract.
 *
 * @param {object} [opts]
 * @param {import('./contracts.ts').Stores} [opts.stores]
 *   Pre-built store bundle to use instead of the in-memory default.
 * @returns {import('./contracts.ts').Stores}
 */
function createStores(opts: { stores?: import('./contracts.ts').Stores; } = {}): import('./contracts.ts').Stores {
  if (opts.stores) {
    return assertStores(opts.stores);
  }
  return createMemoryStores();
}

/**
 * Redis-backed bundle. The module is imported lazily so the default in-memory
 * path never loads the `redis` / `@socket.io/redis-adapter` dependencies.
 *
 * @param {object} [opts]
 * @returns {Promise<import('./contracts.ts').Stores & Record<string, any>>}
 */
async function createRedisPgStores(opts: object = {}): Promise<import('./contracts.ts').Stores & Record<string, any>> {
  const redis = await import('./redis.ts');
  return redis.createRedisPgStores(opts);
}

export { STORE_NAMES, createMemoryStores, createStores, createRedisPgStores };
