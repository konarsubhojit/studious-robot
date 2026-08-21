// @ts-check
'use strict';

const { sanitizeForLog } = require('./normalize');

const SENSITIVE_FIELDS = new Set([
  'authorization',
  'connectionstring',
  'connection_string',
  'password',
  'pushtoken',
  'push_token',
  'secret',
  'token',
  'verificationcode',
  'verification_code',
]);

/**
 * @returns {boolean} `true` when verbose logging is enabled by env vars.
 */
function isVerboseLoggingEnabled() {
  const verbose = process.env.VERBOSE_LOGGING?.trim().toLowerCase();
  const logLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  return (
    verbose === '1' ||
    verbose === 'true' ||
    verbose === 'yes' ||
    logLevel === 'debug' ||
    logLevel === 'trace'
  );
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_FIELDS.has(key.toLowerCase());
}

/**
 * Recursively copy a value, replacing sensitive fields with `[REDACTED]` and
 * guarding against circular references.
 *
 * @param {unknown} value
 * @param {string} [key]  Key the value was found under, used to detect secrets.
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
function redact(value, key, seen = new WeakSet()) {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));

  /** @type {Record<string, any>} */
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey, seen);
  }
  return output;
}

/**
 * Log a redacted verbose message when verbose logging is enabled.
 *
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [metadata]
 * @returns {void}
 */
function verboseLog(scope, message, metadata) {
  if (!isVerboseLoggingEnabled()) return;
  const suffix = metadata === undefined ? '' : ` ${JSON.stringify(redact(metadata))}`;
  console.log(`[verbose][${sanitizeForLog(scope)}] ${sanitizeForLog(message)}${suffix}`);
}

module.exports = {
  isVerboseLoggingEnabled,
  verboseLog,
};
