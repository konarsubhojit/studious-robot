import RNFS from 'react-native-fs';
import { logError, logInfo } from './appLogger';

const SETTINGS_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-settings.json`;

/**
 * Merge persisted settings onto the defaults, keeping only known keys with the
 * expected primitive type.  This guards against corrupt or out-of-date files
 * silently introducing unexpected values.
 *
 * @template T
 * @param {T} defaults
 * @param {unknown} loaded
 * @returns {T}
 */
export function mergeSettings(defaults, loaded) {
  if (!loaded || typeof loaded !== 'object') {
    return { ...defaults };
  }

  const merged = { ...defaults };
  Object.keys(defaults).forEach((key) => {
    const value = loaded[key];
    if (typeof value === typeof defaults[key]) {
      merged[key] = value;
    }
  });
  return merged;
}

/**
 * Load persisted settings, merged onto the provided defaults.  Missing or
 * unreadable files fall back to the defaults rather than throwing.
 *
 * @template T
 * @param {T} defaults
 * @returns {Promise<T>}
 */
export async function loadSettings(defaults) {
  try {
    const exists = await RNFS.exists(SETTINGS_FILE);
    if (!exists) {
      return { ...defaults };
    }
    const content = await RNFS.readFile(SETTINGS_FILE, 'utf8');
    return mergeSettings(defaults, JSON.parse(content));
  } catch (error) {
    logError('Failed to load settings; using defaults', { message: error?.message });
    return { ...defaults };
  }
}

/**
 * Persist settings to disk.  Failures are logged but never thrown so a write
 * error can't break the UI flow that triggered it.
 *
 * @param {object} settings
 * @returns {Promise<boolean>} whether the write succeeded
 */
export async function saveSettings(settings) {
  try {
    await RNFS.writeFile(SETTINGS_FILE, JSON.stringify(settings), 'utf8');
    logInfo('Settings persisted');
    return true;
  } catch (error) {
    logError('Failed to persist settings', { message: error?.message });
    return false;
  }
}

export const SETTINGS_FILE_PATH = SETTINGS_FILE;

// ─── User identity storage ────────────────────────────────────────────────────
// Kept in a separate file so it does not interfere with the app-settings file
// that useWebRTCCall manages independently.

const IDENTITY_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-identity.json`;

/**
 * Load the persisted user identity.  Returns `{ userId: '' }` when no identity
 * has been saved yet or the file cannot be read.
 *
 * @returns {Promise<{ userId: string }>}
 */
export async function loadIdentity() {
  try {
    const exists = await RNFS.exists(IDENTITY_FILE);
    if (!exists) return { userId: '' };
    const content = await RNFS.readFile(IDENTITY_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return { userId: typeof parsed.userId === 'string' ? parsed.userId : '' };
  } catch (error) {
    logError('Failed to load identity; using empty default', { message: error?.message });
    return { userId: '' };
  }
}

/**
 * Persist the user identity to disk.  Failures are logged but never thrown.
 *
 * @param {{ userId: string }} identity
 * @returns {Promise<boolean>} whether the write succeeded
 */
export async function saveIdentity(identity) {
  try {
    await RNFS.writeFile(IDENTITY_FILE, JSON.stringify(identity), 'utf8');
    logInfo('Identity persisted', { userId: identity.userId });
    return true;
  } catch (error) {
    logError('Failed to persist identity', { message: error?.message });
    return false;
  }
}

export const IDENTITY_FILE_PATH = IDENTITY_FILE;
