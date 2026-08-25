/**
 * Extracting a human-readable message from a caught value.
 *
 * Every module used to inline `error instanceof Error ? error.message : …`.
 * That is wrong for the throwables this codebase actually sees: the `pg`,
 * `mongodb`, `redis` and `firebase-admin` clients all reject with objects
 * carrying `message`/`code` that are not `Error` instances, and an `AggregateError`
 * from a DNS failure carries its detail on `errors`. Narrowing on `instanceof`
 * threw those messages away in exactly the cases where the log line mattered.
 *
 * Both helpers are pure and total: they never throw, whatever they are handed.
 */

/**
 * The message carried by `error`, if it carries one.
 *
 * Accepts any object with a string `message` — not just `Error` — so a rejected
 * driver/native error keeps its detail. `undefined` means "this value has no
 * message", which callers render as their own fallback.
 */
function errorMessage(error: unknown): string | undefined {
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
function describeError(error: unknown): string {
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

export { errorMessage, describeError };
