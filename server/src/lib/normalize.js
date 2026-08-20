// @ts-check
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

/**
 * Escape CR/LF and other control characters out of a value before it is
 * interpolated into a log line, so user-controlled input (e.g. a `userId`)
 * cannot forge additional log entries or corrupt log formatting.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeForLog(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, char =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/**
 * Describe a caught value for a log line.
 *
 * `catch (error)` yields an `unknown`: any value can be thrown, and rejected
 * promises from drivers and SDKs regularly carry plain objects or strings.
 * Reading `error.message` off those blind is how log lines end up saying
 * `undefined`, so callers funnel through here instead.
 *
 * @param {unknown} error
 * @returns {string} the error's message, or the value stringified.
 */
function toLogMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { message } = /** @type {{ message?: unknown }} */ (error);
    if (typeof message === 'string') return message;
  }
  return String(error);
}

module.exports = {
  normaliseId,
  normaliseOptionalString,
  normalisePushProvider,
  isPlainObject,
  hasOwnProp,
  sanitizeForLog,
  toLogMessage,
};
