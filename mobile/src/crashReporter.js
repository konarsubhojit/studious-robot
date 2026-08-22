// @ts-check
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';

/**
 * @param {Date} [date]
 * @returns {string} `YYYYMMDD-HHMMSS`, safe for use in a file name.
 */
function formatDateForFile(date = new Date()) {
  const pad = (/** @type {number} */ v) => String(v).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Persist a crash report — error details plus the current in-memory app logs —
 * to the most accessible storage location available on the device.
 *
 * Tries locations in priority order (Downloads → app external → app documents
 * on Android; app documents on iOS) and returns on first success.
 *
 * @param {Error|unknown} error            The caught error object.
 * @param {boolean}       isFatal          Whether the runtime considers it fatal.
 * @param {() => string} [getLogsCallback]  Returns buffered in-memory app logs.
 * @returns {Promise<{success: boolean, path?: string, label?: string}>}
 */
export async function saveCrashLog(error, isFatal, getLogsCallback) {
  const details = error instanceof Error ? error : null;
  const fileName = `wetalk-crash-${formatDateForFile()}.txt`;

  const content = [
    'WeTalk crash report',
    `crashedAt: ${new Date().toISOString()}`,
    `isFatal: ${Boolean(isFatal)}`,
    `error.name: ${details?.name ?? 'unknown'}`,
    `error.message: ${details?.message ?? String(error ?? 'unknown')}`,
    `error.stack:\n${details?.stack ?? 'unavailable'}`,
    '',
    '--- app logs at time of crash ---',
    typeof getLogsCallback === 'function' ? getLogsCallback() : '(no log callback)',
  ].join('\n');

  const targets =
    Platform.OS === 'android'
      ? [
          { directory: RNFS.DownloadDirectoryPath, label: 'Downloads' },
          { directory: RNFS.ExternalDirectoryPath, label: 'app external storage' },
          { directory: RNFS.DocumentDirectoryPath, label: 'app documents' },
        ]
      : [{ directory: RNFS.DocumentDirectoryPath, label: 'app documents' }];

  for (const target of targets) {
    if (!target.directory) {
      continue;
    }
    try {
      const path = `${target.directory}/${fileName}`;
      await RNFS.writeFile(path, content, 'utf8');
      return { success: true, path, label: target.label };
    } catch {
      // Try the next storage target.
    }
  }

  return { success: false };
}

/**
 * Install a global JavaScript error handler that auto-saves a crash log
 * whenever an unhandled exception is detected by the React Native runtime.
 *
 * This covers:
 *  - Synchronous JS exceptions that escape all try/catch blocks.
 *  - Unhandled Promise rejections (fatal on Hermes / RN 0.73+).
 *
 * Call once, as early as possible in the app lifecycle (e.g. at the top of
 * index.js before AppRegistry.registerComponent).
 *
 * @param {() => string} getLogsCallback  Returns buffered in-memory app logs.
 */
export function installCrashHandler(getLogsCallback) {
  if (!(/** @type {any} */ (global).ErrorUtils)) {
    return;
  }

  const previousHandler = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    // Always log to logcat/console immediately — this is synchronous and
    // survives even if the process is killed before the file write finishes.
    console.error(
      `[CrashReporter] ${isFatal ? 'FATAL' : 'non-fatal'} error: ${error?.message ?? error}`,
      error?.stack ?? '',
    );

    // Best-effort async file dump for easier retrieval from the device.
    // The write may not complete if the process is killed immediately after
    // a fatal crash, but for non-fatal errors it will always finish.
    saveCrashLog(error, Boolean(isFatal), getLogsCallback).catch(() => {
      // Swallow write errors to prevent recursive crash handling.
    });

    if (typeof previousHandler === 'function') {
      previousHandler(error, isFatal);
    }
  });
}
