import { PUSH_PROVIDERS } from '../config.ts';

/**
 * Small input-normalisation helpers shared across HTTP and socket handlers.
 *
 * Each helper is pure (no side effects) so it can be unit-tested in isolation
 * and reused wherever request/payload fields need sanitising.
 */

/**
 * Trim a string and return `null` when it is empty or not a string.
 */
function normaliseId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Alias of {@link normaliseId} used where the value is a free-form optional
 * string (e.g. platform) rather than an identifier.
 */
function normaliseOptionalString(value: unknown): string | null {
  return normaliseId(value);
}

/**
 * Normalise and validate a push provider, returning it lowercased when it is
 * one of the supported providers (`apns` / `fcm`), otherwise `null`.
 */
function normalisePushProvider(value: unknown): string | null {
  const provider = normaliseId(value)?.toLowerCase();
  return provider && PUSH_PROVIDERS.has(provider) ? provider : null;
}

/**
 * @returns `true` when `value` is a non-array object.
 */
function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Safe `Object.prototype.hasOwnProperty` wrapper.
 */
function hasOwnProp(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Escape CR/LF and other control characters out of a value before it is
 * interpolated into a log line, so user-controlled input (e.g. a `userId`)
 * cannot forge additional log entries or corrupt log formatting.
 */
function sanitizeForLog(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, char =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

export {
  normaliseId,
  normaliseOptionalString,
  normalisePushProvider,
  isPlainObject,
  hasOwnProp,
  sanitizeForLog,
};
