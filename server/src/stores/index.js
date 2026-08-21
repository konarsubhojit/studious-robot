// @ts-check
'use strict';

const { STORE_NAMES } = require('./contracts');
const { createMemoryStores } = require('./memory');

/**
 * Validate that a caller-supplied object provides every store in the contract.
 *
 * @param {Record<string, unknown>} stores
 * @returns {import('./contracts').Stores}
 */
function assertStores(stores) {
  for (const name of STORE_NAMES) {
    if (!(name in stores) || stores[name] == null) {
      throw new Error(`createStores: missing store "${name}"`);
    }
  }
  return /** @type {import('./contracts').Stores} */ (stores);
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
 * @param {import('./contracts').Stores} [opts.stores]
 *   Pre-built store bundle to use instead of the in-memory default.
 * @returns {import('./contracts').Stores}
 */
function createStores(opts = {}) {
  if (opts.stores) {
    return assertStores(opts.stores);
  }
  return createMemoryStores();
}

module.exports = {
  STORE_NAMES,
  createMemoryStores,
  createStores,
  // Lazily required so the default in-memory path never loads the `redis` /
  // `@socket.io/redis-adapter` dependencies.
  get createRedisPgStores() {
    return require('./redis').createRedisPgStores;
  },
};
