// @ts-check

/**
 * Describe a caught value for a log line.
 *
 * `catch (error)` gives an `unknown`: JavaScript lets any value be thrown, and
 * rejected promises from native modules routinely carry plain objects or
 * strings rather than `Error` instances. Reading `error.message` off those
 * blind is how log lines end up saying `undefined`, so every call site funnels
 * through here instead.
 *
 * @param {unknown} error
 * @returns {string} the error's message, or the value stringified.
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { message } = /** @type {{ message?: unknown }} */ (error);
    if (typeof message === 'string') return message;
  }
  return String(error);
}
