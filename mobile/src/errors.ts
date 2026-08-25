/**
 * Extracting a human-readable message from a caught value.
 *
 * Every module used to inline `error instanceof Error ? error.message : …`.
 * That is wrong for the throwables this app actually sees: React Native's
 * native bridge rejects with plain objects carrying `message`/`code`, and so do
 * several of the linked modules (`react-native-fs`, `react-native-webrtc`,
 * `@react-native-firebase/*`). Narrowing on `instanceof Error` replaced those
 * messages with a fallback in exactly the cases — native failures — where the
 * log line was most useful.
 *
 * Both helpers are pure and total: they never throw, whatever they are handed.
 */

/**
 * The message carried by `error`, if it carries one.
 *
 * Accepts any object with a string `message` — not just `Error` — so a rejected
 * native-module error keeps its detail. `undefined` means "this value has no
 * message", which callers render as their own fallback.
 */
export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error.length > 0 ? error : undefined;
  }
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  return undefined;
}

/**
 * {@link errorMessage}, with `String(error)` as the last resort, for the log
 * lines that would rather say `"[object Object]"` than say nothing at all.
 */
export function describeError(error: unknown): string {
  const message = errorMessage(error);
  if (message !== undefined) {
    return message;
  }
  try {
    return String(error);
  } catch {
    // A thrown value with a hostile `toString`/`Symbol.toPrimitive` must not
    // take down the logging path that is trying to report it.
    return 'unknown error';
  }
}
