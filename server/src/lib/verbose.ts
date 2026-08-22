import { sanitizeForLog } from './normalize.ts';

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
 * @returns `true` when verbose logging is enabled by env vars.
 */
function isVerboseLoggingEnabled(): boolean {
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

function isSensitiveKey(key: unknown): boolean {
  return typeof key === 'string' && SENSITIVE_FIELDS.has(key.toLowerCase());
}

/**
 * Recursively copy a value, replacing sensitive fields with `[REDACTED]` and
 * guarding against circular references.
 *
 * @param key  Key the value was found under, used to detect secrets.
 */
function redact(value: unknown, key?: string, seen: WeakSet<object> = new WeakSet()): any {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, undefined, seen));

  const output: Record<string, any> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redact(childValue, childKey, seen);
  }
  return output;
}

/**
 * Log a redacted verbose message when verbose logging is enabled.
 */
function verboseLog(scope: string, message: string, metadata?: unknown): void {
  if (!isVerboseLoggingEnabled()) return;
  const suffix = metadata === undefined ? '' : ` ${JSON.stringify(redact(metadata))}`;
  console.log(`[verbose][${sanitizeForLog(scope)}] ${sanitizeForLog(message)}${suffix}`);
}

export {
  isVerboseLoggingEnabled,
  verboseLog,
};
