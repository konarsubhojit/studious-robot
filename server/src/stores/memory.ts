import { STORE_NAMES } from './contracts.ts';

/**
 * Create the default in-memory {@link Stores} bundle.
 *
 * Each store is a plain `Map`, preserving the exact behaviour the server relied
 * on when the collections were created inline.  This implementation keeps all
 * state in the current process, which is correct for a single-instance
 * deployment and for tests.  Durable/shared implementations (Redis, Postgres)
 * can be added later behind the same interface.
 */
function createMemoryStores(): import('./contracts.ts').Stores {
  const stores: Record<string, Map<unknown, unknown>> = {};
  for (const name of STORE_NAMES) {
    stores[name] = new Map();
  }
  return ((stores as unknown) as import('./contracts.ts').Stores);
}

export { createMemoryStores };
