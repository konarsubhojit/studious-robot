const LOG_ENTRIES = [];

// Numeric priority for each log level. Lines whose level is below the active
// threshold are dropped so high-frequency `debug` output (per-ICE-candidate and
// per-stats-tick lines) can be enabled on demand without overwhelming the log by
// default. High-signal lifecycle/signaling/ICE-summary lines stay at `info`.
const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function readLogLevel() {
  const fromEnv = globalThis?.process?.env?.LOG_LEVEL;
  const normalized = typeof fromEnv === 'string' ? fromEnv.toLowerCase() : '';
  return LEVEL_PRIORITY[normalized] ? normalized : 'info';
}

// Active log-level threshold (env-inlined `LOG_LEVEL`, defaults to `info`).
export const LOG_LEVEL = readLogLevel();

function isLevelEnabled(level) {
  return (LEVEL_PRIORITY[level] || 0) >= (LEVEL_PRIORITY[LOG_LEVEL] || 0);
}

const REDACTED_TEXT = '[REDACTED]';
const CIRCULAR_TEXT = '[Circular]';
const SENSITIVE_FIELDS = new Set([
  'turn_username',
  'turn_credential',
  'credential',
  'password',
  'token',
  'secret',
  'authorization',
]);

function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_FIELDS.has(key.toLowerCase());
}

function toSafeError(error, seen) {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const safeError = {
    name: error.name,
    message: error.message,
  };

  if (error.stack) {
    safeError.stack = error.stack;
  }

  if ('cause' in error) {
    safeError.cause = toSafeValue(error.cause, undefined, seen);
  }

  return safeError;
}

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
    return value.map((item) => toSafeValue(item, undefined, seen));
  }

  const output = {};
  Object.keys(value).forEach((childKey) => {
    try {
      output[childKey] = toSafeValue(value[childKey], childKey, seen);
    } catch (error) {
      output[childKey] = `[Unserializable: ${error?.message || 'unknown'}]`;
    }
  });

  return output;
}

function safeSerialize(metadata) {
  if (metadata === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(toSafeValue(metadata));
  } catch (error) {
    return JSON.stringify({
      serializationError: error?.message || 'Unknown serialization error',
    });
  }
}

function addLog(level, message, metadata) {
  if (!isLevelEnabled(level)) {
    return undefined;
  }

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

export function debug(message, metadata) {
  return addLog('debug', message, metadata);
}

export function info(message, metadata) {
  return addLog('info', message, metadata);
}

export function warn(message, metadata) {
  return addLog('warn', message, metadata);
}

export function error(message, metadata) {
  return addLog('error', message, metadata);
}

export function logDebug(message, metadata) {
  return debug(message, metadata);
}

export function logInfo(message, metadata) {
  return info(message, metadata);
}

export function logWarn(message, metadata) {
  return warn(message, metadata);
}

export function logError(message, metadata) {
  return error(message, metadata);
}

export function getLogsAsText() {
  return LOG_ENTRIES.join('\n');
}

export function clearLogs() {
  LOG_ENTRIES.length = 0;
}
