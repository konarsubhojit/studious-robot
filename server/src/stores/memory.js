// @ts-check
'use strict';

const { STORE_NAMES } = require('./contracts');

/**
 * Create the default in-memory {@link Stores} bundle.
 *
 * Each store is a plain `Map`, preserving the exact behaviour the server relied
 * on when the collections were created inline.  This implementation keeps all
 * state in the current process, which is correct for a single-instance
 * deployment and for tests.  Durable/shared implementations (Redis, Postgres)
 * can be added later behind the same interface.
 *
 * @returns {import('./contracts').Stores}
 */
function createMemoryStores() {
  /** @type {Record<string, Map<unknown, unknown>>} */
  const stores = {};
  for (const name of STORE_NAMES) {
    stores[name] = new Map();
  }
  return /** @type {import('./contracts').Stores} */ (stores);
}

module.exports = { createMemoryStores };
