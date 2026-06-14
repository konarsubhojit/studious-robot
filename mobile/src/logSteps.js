import { logError, logInfo } from './appLogger';

// Lightweight timing/correlation helper.  Wraps an async or sync step so each
// step emits a `start` line and then either a `success` line with `durationMs`
// or an `error` line with `durationMs` plus the error name/message — all via
// `appLogger` (which redacts sensitive fields).  Use it to make the duration of
// each major async step (getUserMedia, createOffer, setRemoteDescription, …)
// visible in the exported logs.

function nowMs() {
  return Date.now();
}

function toErrorMeta(error) {
  return {
    name: error?.name,
    message: error?.message,
  };
}

/**
 * Run and time an async step.
 *
 * @param {string} message - Stage-tagged label, e.g. `[webrtc] createOffer`.
 * @param {() => Promise<any>|any} fn - The work to run.
 * @param {object} [metadata] - Correlation metadata (callId, roomId, …).
 * @returns {Promise<any>} Resolves with the return value of `fn`.
 */
export async function runStep(message, fn, metadata) {
  const startedAt = nowMs();
  logInfo(`${message} start`, metadata);
  try {
    const result = await fn();
    logInfo(`${message} success`, { ...metadata, durationMs: nowMs() - startedAt });
    return result;
  } catch (error) {
    logError(`${message} error`, {
      ...metadata,
      durationMs: nowMs() - startedAt,
      error: toErrorMeta(error),
    });
    throw error;
  }
}

/**
 * Run and time a synchronous step.  Same logging contract as {@link runStep}.
 *
 * @param {string} message - Stage-tagged label.
 * @param {() => any} fn - The work to run.
 * @param {object} [metadata] - Correlation metadata.
 * @returns {any} The return value of `fn`.
 */
export function runStepSync(message, fn, metadata) {
  const startedAt = nowMs();
  logInfo(`${message} start`, metadata);
  try {
    const result = fn();
    logInfo(`${message} success`, { ...metadata, durationMs: nowMs() - startedAt });
    return result;
  } catch (error) {
    logError(`${message} error`, {
      ...metadata,
      durationMs: nowMs() - startedAt,
      error: toErrorMeta(error),
    });
    throw error;
  }
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a short random correlation id for a single call so that all of its
 * signaling/WebRTC/ICE log lines can be traced end-to-end.
 *
 * @param {number} [length=8]
 * @returns {string}
 */
export function createCorrelationId(length = 8) {
  let id = '';
  for (let index = 0; index < length; index += 1) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}
