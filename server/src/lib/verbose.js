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

function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_FIELDS.has(key.toLowerCase());
}

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

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey, seen);
  }
  return output;
}

function verboseLog(scope, message, metadata) {
  if (!isVerboseLoggingEnabled()) return;
  const suffix = metadata === undefined ? '' : ` ${JSON.stringify(redact(metadata))}`;
  console.log(`[verbose][${sanitizeForLog(scope)}] ${sanitizeForLog(message)}${suffix}`);
}

module.exports = {
  isVerboseLoggingEnabled,
  verboseLog,
};
