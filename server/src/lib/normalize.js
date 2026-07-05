'use strict';

const { PUSH_PROVIDERS } = require('../config');

/**
 * Small input-normalisation helpers shared across HTTP and socket handlers.
 *
 * Each helper is pure (no side effects) so it can be unit-tested in isolation
 * and reused wherever request/payload fields need sanitising.
 */

/**
 * Trim a string and return `null` when it is empty or not a string.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Alias of {@link normaliseId} used where the value is a free-form optional
 * string (e.g. platform) rather than an identifier.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseOptionalString(value) {
  return normaliseId(value);
}

/**
 * Normalise and validate a push provider, returning it lowercased when it is
 * one of the supported providers (`apns` / `fcm`), otherwise `null`.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalisePushProvider(value) {
  const provider = normaliseId(value)?.toLowerCase();
  return provider && PUSH_PROVIDERS.has(provider) ? provider : null;
}

/**
 * @param {unknown} value
 * @returns {boolean} `true` when `value` is a non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safe `Object.prototype.hasOwnProperty` wrapper.
 *
 * @param {object} value
 * @param {string} key
 * @returns {boolean}
 */
function hasOwnProp(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

module.exports = {
  normaliseId,
  normaliseOptionalString,
  normalisePushProvider,
  isPlainObject,
  hasOwnProp,
};
