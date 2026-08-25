import { errorMessage } from './errors';

const LOG_ENTRIES: string[] = [];
let durableLogQueue: Promise<boolean | void> = Promise.resolve();

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

function isSensitiveKey(key: unknown): boolean {
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
 * @param seen already-visited objects, for cycle detection.
 * @returns a plain, serialisable view of the error.
 */
function toSafeError(err: any, seen: WeakSet<object>): unknown {
  if (!err || typeof err !== 'object') {
    return err;
  }

  const safeError: { name: unknown; message: unknown; stack?: unknown; cause?: unknown; } = {
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
 * @param key the property name `value` was read from.
 * @param seen already-visited objects, for cycle detection.
 * @returns `value` with sensitive fields redacted and cycles broken.
 */
function toSafeValue(value: any, key?: string | undefined, seen: WeakSet<object> = new WeakSet()): any {
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

  const output: Record<string, any> = {};
  Object.keys(value).forEach(childKey => {
    try {
      output[childKey] = toSafeValue(value[childKey], childKey, seen);
    } catch (err) {
      const message = errorMessage(err);
      output[childKey] = `[Unserializable: ${message || 'unknown'}]`;
    }
  });

  return output;
}

/**
 * @returns JSON for the redacted metadata, if any.
 */
function safeSerialize(metadata: unknown): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(toSafeValue(metadata));
  } catch (err) {
    return JSON.stringify({
      serializationError: errorMessage(err) || 'Unknown serialization error',
    });
  }
}

/**
 * @returns the formatted line that was buffered.
 */
function addLog(level: string, message: unknown, metadata?: unknown): string {
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
 * @returns the `react-native-fs` module, or `null` when unavailable.
 */
function loadRNFS(): any {
  try {
    const mod = (require('react-native-fs') as any);
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/**
 * @returns path of the durable background log, when storage is
 *   available.
 */
export function getDurableLogFilePath(): string | null {
  const RNFS = loadRNFS();
  const directory = RNFS?.DocumentDirectoryPath;
  return directory ? `${directory}/wetalk-background.log` : null;
}

/**
 * @returns resolves when the append completes.
 */
export function persistLogLine(line: unknown): Promise<boolean | void> {
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
 * @returns resolves once queued writes settle.
 */
export function flushDurableLogs(): Promise<boolean | void> {
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
 * @returns resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundInfo(message: unknown, metadata?: unknown): Promise<boolean | void> {
  return persistLogLine(info(message, metadata));
}

/**
 * @returns resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundWarn(message: unknown, metadata?: unknown): Promise<boolean | void> {
  return persistLogLine(warn(message, metadata));
}

/**
 * @returns resolves once the line is queued for
 *   durable storage.
 */
export function logBackgroundError(message: unknown, metadata?: unknown): Promise<boolean | void> {
  return persistLogLine(error(message, metadata));
}

/**
 * @returns the formatted line that was buffered.
 */
export function debug(message: unknown, metadata?: unknown): string {
  return addLog('debug', message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function info(message: unknown, metadata?: unknown): string {
  return addLog('info', message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function warn(message: unknown, metadata?: unknown): string {
  return addLog('warn', message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function error(message: unknown, metadata?: unknown): string {
  return addLog('error', message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function logDebug(message: unknown, metadata?: unknown): string {
  return debug(message, metadata);
}

/**
 * @returns the buffered line, or `undefined` when verbose
 *   logging is disabled.
 */
export function verbose(message: unknown, metadata?: unknown): string | undefined {
  if (!isVerboseLoggingEnabled()) return undefined;
  return addLog('verbose', message, metadata);
}

/**
 * @returns the buffered line, or `undefined` when verbose
 *   logging is disabled.
 */
export function logVerbose(message: unknown, metadata?: unknown): string | undefined {
  return verbose(message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function logInfo(message: unknown, metadata?: unknown): string {
  return info(message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function logWarn(message: unknown, metadata?: unknown): string {
  return warn(message, metadata);
}

/**
 * @returns the formatted line that was buffered.
 */
export function logError(message: unknown, metadata?: unknown): string {
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
