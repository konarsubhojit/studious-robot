// @ts-check
/** @type {string[]} */
const LOG_ENTRIES = [];
/** @type {Promise<boolean|void>} */
let durableLogQueue = Promise.resolve();

const REDACTED_TEXT = '[REDACTED]';
const CIRCULAR_TEXT = '[Circular]';
const SENSITIVE_FIELDS = new Set([
  'turn_username',
  'username',
  'turn_credential',
  'credential',
  'password',
  'pushtoken',
  'push_token',
  'token',
  'secret',
  'authorization',
  'verificationcode',
  'verification_code',
  'recoverycode',
  'recovery_code',
]);

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_FIELDS.has(key.toLowerCase());
}

function isVerboseLoggingEnabled() {
  const verboseFlag = process.env.VERBOSE_LOGGING?.trim?.().toLowerCase?.();
  const logLevel = process.env.LOG_LEVEL?.trim?.().toLowerCase?.();
  return (
    verboseFlag === '1' ||
    verboseFlag === 'true' ||
    verboseFlag === 'yes' ||
    logLevel === 'debug' ||
    logLevel === 'trace'
  );
}

/**
 * @param {any} err
 * @param {WeakSet<object>} seen already-visited objects, for cycle detection.
 * @returns {unknown} a plain, serialisable view of the error.
 */
function toSafeError(err, seen) {
  if (!err || typeof err !== 'object') {
    return err;
  }

  /** @type {{ name: unknown, message: unknown, stack?: unknown, cause?: unknown }} */
  const safeError = {
    name: err.name,
    message: err.message,
  };

  if (err.stack) {
    safeError.stack = err.stack;
  }

  if ('cause' in err) {
    safeError.cause = toSafeValue(err.cause, undefined, seen);
  }

  return safeError;
}

/**
 * @param {any} value
 * @param {string|undefined} [key] the property name `value` was read from.
 * @param {WeakSet<object>} [seen] already-visited objects, for cycle detection.
 * @returns {any} `value` with sensitive fields redacted and cycles broken.
 */
function toSafeValue(value, key, seen = new WeakSet()) {
  if (isSensitiveKey(key)) {
    return REDACTED_TEXT;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return toSafeError(value, seen);
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR_TEXT;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => toSafeValue(item, undefined, seen));
  }

  /** @type {Record<string, any>} */
  const output = {};
  Object.keys(value).forEach(childKey => {
    try {
      output[childKey] = toSafeValue(value[childKey], childKey, seen);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      output[childKey] = `[Unserializable: ${message || 'unknown'}]`;
    }
  });

  return output;
}

/**
 * @param {unknown} metadata
 * @returns {string|undefined} JSON for the redacted metadata, if any.
 */
function safeSerialize(metadata) {
  if (metadata === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(toSafeValue(metadata));
  } catch (err) {
    return JSON.stringify({
      serializationError:
        (err instanceof Error ? err.message : '') || 'Unknown serialization error',
    });
  }
}

/**
 * @param {string} level
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
function addLog(level, message, metadata) {
  const timestamp = new Date().toISOString();
  const safeMessage = typeof message === 'string' ? message : String(message);
  const serializedMetadata = safeSerialize(metadata);
  const line = serializedMetadata
    ? `${timestamp} [${level.toUpperCase()}] ${safeMessage} ${serializedMetadata}`
    : `${timestamp} [${level.toUpperCase()}] ${safeMessage}`;

  LOG_ENTRIES.push(line);

  if (level === 'warn') {
    console.warn(line);
  } else if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  return line;
}

/**
 * @returns {any} the `react-native-fs` module, or `null` when unavailable.
 */
function loadRNFS() {
  try {
    const mod = /** @type {any} */ (require('react-native-fs'));
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/**
 * @returns {string|null} path of the durable background log, when storage is
 *   available.
 */
export function getDurableLogFilePath() {
  const RNFS = loadRNFS();
  const directory = RNFS?.DocumentDirectoryPath;
  return directory ? `${directory}/wetalk-background.log` : null;
}

/**
 * @param {unknown} line
 * @returns {Promise<boolean|void>} resolves when the append completes.
 */
export function persistLogLine(line) {
  const safeLine = typeof line === 'string' ? line : String(line ?? '');
  durableLogQueue = durableLogQueue
    .catch(() => {})
    .then(async () => {
      const RNFS = loadRNFS();
      const path = getDurableLogFilePath();
      if (!RNFS || !path || !safeLine) return false;
      try {
        if (typeof RNFS.appendFile === 'function') {
          await RNFS.appendFile(path, `${safeLine}\n`, 'utf8');
        } else {
          const exists = typeof RNFS.exists === 'function' ? await RNFS.exists(path) : false;
          const previous =
            exists && typeof RNFS.readFile === 'function' ? await RNFS.readFile(path, 'utf8') : '';
          await RNFS.writeFile(path, `${previous}${safeLine}\n`, 'utf8');
        }
        return true;
      } catch {
        return false;
      }
    });
  return durableLogQueue;
}

/**
 * @returns {Promise<boolean|void>} resolves once queued writes settle.
 */
export function flushDurableLogs() {
  return durableLogQueue.catch(() => false);
}

export async function getPersistedLogsAsText() {
  await flushDurableLogs();
  const RNFS = loadRNFS();
  const path = getDurableLogFilePath();
  if (!RNFS || !path || typeof RNFS.exists !== 'function' || typeof RNFS.readFile !== 'function') {
    return '';
  }
  try {
    if (!(await RNFS.exists(path))) return '';
    return await RNFS.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {Promise<boolean|void>} resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundInfo(message, metadata) {
  return persistLogLine(info(message, metadata));
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {Promise<boolean|void>} resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundWarn(message, metadata) {
  return persistLogLine(warn(message, metadata));
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {Promise<boolean|void>} resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundError(message, metadata) {
  return persistLogLine(error(message, metadata));
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function debug(message, metadata) {
  return addLog('debug', message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function info(message, metadata) {
  return addLog('info', message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function warn(message, metadata) {
  return addLog('warn', message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function error(message, metadata) {
  return addLog('error', message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function logDebug(message, metadata) {
  return debug(message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string|undefined} the buffered line, or `undefined` when verbose
 *   logging is disabled.
 */
export function verbose(message, metadata) {
  if (!isVerboseLoggingEnabled()) return undefined;
  return addLog('verbose', message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string|undefined} the buffered line, or `undefined` when verbose
 *   logging is disabled.
 */
export function logVerbose(message, metadata) {
  return verbose(message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function logInfo(message, metadata) {
  return info(message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function logWarn(message, metadata) {
  return warn(message, metadata);
}

/**
 * @param {unknown} message
 * @param {unknown} [metadata]
 * @returns {string} the formatted line that was buffered.
 */
export function logError(message, metadata) {
  return error(message, metadata);
}

export function getLogsAsText() {
  return LOG_ENTRIES.join('\n');
}

export async function getLogsForExport() {
  const memory = getLogsAsText();
  const persisted = (await getPersistedLogsAsText()).trimEnd();
  return [memory, persisted ? '--- persisted background logs ---' : '', persisted]
    .filter(Boolean)
    .join('\n');
}

export function clearLogs() {
  LOG_ENTRIES.length = 0;
}
