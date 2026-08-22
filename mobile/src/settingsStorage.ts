import RNFS from 'react-native-fs';
import { logError, logInfo } from './appLogger';
import { THEME_MODE_VALUES, THEME_MODES } from './theme';

const SETTINGS_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-settings.json`;

/**
 * @returns the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Merge persisted settings onto the defaults, keeping only known keys with the
 * expected primitive type.  This guards against corrupt or out-of-date files
 * silently introducing unexpected values.
 *
 * @template {Record<string, unknown>} T
 */
export function mergeSettings<T extends Record<string, unknown>>(defaults: T, loaded: unknown): T {
  if (!loaded || typeof loaded !== 'object') {
    return { ...defaults };
  }

  const source = (loaded as Record<string, unknown>);
  const merged = ({ ...defaults } as Record<string, unknown>);
  Object.keys(defaults).forEach(key => {
    const value = source[key];
    if (typeof value === typeof defaults[key]) {
      merged[key] = value;
    }
  });
  return (merged as T);
}

/**
 * Load persisted settings, merged onto the provided defaults.  Missing or
 * unreadable files fall back to the defaults rather than throwing.
 *
 * @template {Record<string, unknown>} T
 */
export async function loadSettings<T extends Record<string, unknown>>(defaults: T): Promise<T> {
  try {
    const exists = await RNFS.exists(SETTINGS_FILE);
    if (!exists) {
      return { ...defaults };
    }
    const content = await RNFS.readFile(SETTINGS_FILE, 'utf8');
    return mergeSettings(defaults, JSON.parse(content));
  } catch (error) {
    logError('Failed to load settings; using defaults', {
      message: errorMessage(error),
    });
    return { ...defaults };
  }
}

/**
 * Persist settings to disk.  Failures are logged but never thrown so a write
 * error can't break the UI flow that triggered it.
 *
 * @returns whether the write succeeded
 */
export async function saveSettings(settings: object): Promise<boolean> {
  try {
    await RNFS.writeFile(SETTINGS_FILE, JSON.stringify(settings), 'utf8');
    logInfo('Settings persisted');
    return true;
  } catch (error) {
    logError('Failed to persist settings', { message: errorMessage(error) });
    return false;
  }
}

export const SETTINGS_FILE_PATH = SETTINGS_FILE;

// ─── User identity storage ────────────────────────────────────────────────────
// Kept in a separate file so it does not interfere with the app-settings file
// that useAppSettings manages independently.

const IDENTITY_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-identity.json`;

/**
 * Load the persisted public username. Authentication credentials remain in
 * the platform Firebase SDK and are never written to this file.
 * when no identity has been saved yet or the file cannot be read.
 */
export async function loadIdentity(): Promise<{ userId: string; }> {
  try {
    const exists = await RNFS.exists(IDENTITY_FILE);
    if (!exists) return { userId: '' };
    const content = await RNFS.readFile(IDENTITY_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    };
  } catch (error) {
    logError('Failed to load identity; using empty default', {
      message: errorMessage(error),
    });
    return { userId: '' };
  }
}

/**
 * Persist the user identity to disk.  Failures are logged but never thrown.
 *
 * @returns whether the write succeeded
 */
export async function saveIdentity(identity: { userId: string; }): Promise<boolean> {
  try {
    await RNFS.writeFile(
      IDENTITY_FILE,
      JSON.stringify({
        userId: typeof identity?.userId === 'string' ? identity.userId : '',
      }),
      'utf8',
    );
    logInfo('Identity persisted', {
      userId: identity?.userId,
    });
    return true;
  } catch (error) {
    logError('Failed to persist identity', { message: errorMessage(error) });
    return false;
  }
}

export const IDENTITY_FILE_PATH = IDENTITY_FILE;

// ─── Appearance (theme) preference ────────────────────────────────────────────
// Stored in its own file for the same reason as the identity: `saveSettings`
// rewrites the whole app-settings document, so sharing it would let a theme
// change clobber settings written by another part of the app.

const THEME_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-theme.json`;

/**
 * Load the persisted appearance mode ('system' | 'light' | 'dark').  Unknown
 * or unreadable values fall back to 'system'.
 */
export async function loadThemeMode(): Promise<string> {
  try {
    const exists = await RNFS.exists(THEME_FILE);
    if (!exists) return THEME_MODES.SYSTEM;
    const content = await RNFS.readFile(THEME_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return THEME_MODE_VALUES.includes(parsed?.mode) ? parsed.mode : THEME_MODES.SYSTEM;
  } catch (error) {
    logError('Failed to load theme mode; using system default', {
      message: errorMessage(error),
    });
    return THEME_MODES.SYSTEM;
  }
}

/**
 * Persist the appearance mode.  Failures are logged but never thrown so a
 * write error can't break the toggle that triggered it.
 *
 * @returns whether the write succeeded
 */
export async function saveThemeMode(mode: string): Promise<boolean> {
  const safeMode = THEME_MODE_VALUES.includes(mode) ? mode : THEME_MODES.SYSTEM;
  try {
    await RNFS.writeFile(THEME_FILE, JSON.stringify({ mode: safeMode }), 'utf8');
    logInfo('Theme mode persisted', { mode: safeMode });
    return true;
  } catch (error) {
    logError('Failed to persist theme mode', { message: errorMessage(error) });
    return false;
  }
}

export const THEME_FILE_PATH = THEME_FILE;

// ─── Stable device identifier ─────────────────────────────────────────────────
// The signaling server keys device records (and therefore push registrations)
// by `deviceId`.  When `POST /session` omits one the server mints a fresh
// random id, so every app launch would create a brand-new device row and orphan
// the push token registered by the previous launch.  Persisting the id once per
// install keeps exactly one device row per device.

const DEVICE_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-device.json`;

let fallbackDeviceIdCounter = 0;

/**
 * Generate an opaque per-install device identifier. This is not a credential
 * (the session token is), it only has to be unique and stable.
 */
function generateDeviceId(): string {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `device-${hex}`;
  }

  // No secure random source available (e.g. an older runtime). This id isn't
  // a credential, so a timestamp + monotonic counter is an adequate
  // fallback and avoids relying on an insecure PRNG.
  fallbackDeviceIdCounter += 1;
  return `device-${Date.now().toString(16)}-${fallbackDeviceIdCounter.toString(16)}`;
}

/**
 * Return this install's stable device id, generating and persisting one on
 * first use.  Never throws: an unwritable file only means the id is not reused
 * after a restart.
 */
export async function loadDeviceId(): Promise<string> {
  try {
    const exists = await RNFS.exists(DEVICE_FILE);
    if (exists) {
      const content = await RNFS.readFile(DEVICE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      const stored = typeof parsed?.deviceId === 'string' ? parsed.deviceId.trim() : '';
      if (stored) return stored;
    }
  } catch (error) {
    logError('Failed to load device id; generating a new one', {
      message: errorMessage(error),
    });
  }

  const deviceId = generateDeviceId();
  try {
    await RNFS.writeFile(DEVICE_FILE, JSON.stringify({ deviceId }), 'utf8');
    logInfo('Device id generated and persisted');
  } catch (error) {
    logError('Failed to persist device id', { message: errorMessage(error) });
  }
  return deviceId;
}

export const DEVICE_FILE_PATH = DEVICE_FILE;
