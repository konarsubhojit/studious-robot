import RNFS from 'react-native-fs';
import { logError, logInfo } from './appLogger';
import { DEFAULT_THEME_PREFERENCES, normalizeThemePreferences } from './theme';
import type { ThemeMode, ThemePreferences } from './theme';
import { errorMessage } from './errors';

const SETTINGS_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-settings.json`;

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
 * Load the persisted appearance preferences.
 *
 * Every field falls back **independently** (see `normalizeThemePreferences`):
 * a corrupt accent must not also discard a pinned dark mode. An unreadable or
 * missing file yields the defaults, which are the appearance the app shipped
 * with.
 */
export async function loadThemePreferences(): Promise<ThemePreferences> {
  try {
    const exists = await RNFS.exists(THEME_FILE);
    if (!exists) return { ...DEFAULT_THEME_PREFERENCES };
    const content = await RNFS.readFile(THEME_FILE, 'utf8');
    return normalizeThemePreferences(JSON.parse(content));
  } catch (error) {
    logError('Failed to load theme preferences; using defaults', {
      message: errorMessage(error),
    });
    return { ...DEFAULT_THEME_PREFERENCES };
  }
}

/**
 * Persist the appearance preferences.  Failures are logged but never thrown so
 * a write error can't break the control that triggered it.
 *
 * The value is normalized before writing, so a bad value can never reach disk
 * and be read back as a "valid" preference on the next launch.
 *
 * @returns whether the write succeeded
 */
export async function saveThemePreferences(preferences: ThemePreferences): Promise<boolean> {
  const safe = normalizeThemePreferences(preferences);
  try {
    await RNFS.writeFile(THEME_FILE, JSON.stringify(safe), 'utf8');
    logInfo('Theme preferences persisted', { mode: safe.mode });
    return true;
  } catch (error) {
    logError('Failed to persist theme preferences', { message: errorMessage(error) });
    return false;
  }
}

/**
 * Load just the appearance mode ('system' | 'light' | 'dark').
 *
 * A thin wrapper over {@link loadThemePreferences}, kept so callers that only
 * care about the mode do not have to know the wider shape exists.
 */
export async function loadThemeMode(): Promise<ThemeMode> {
  const preferences = await loadThemePreferences();
  return preferences.mode;
}

/**
 * Persist the appearance mode, leaving the other preferences as they are.
 *
 * Read-modify-write rather than a blind overwrite: writing `{ mode }` alone
 * would silently reset the accent and text size the user had chosen.
 *
 * @returns whether the write succeeded
 */
export async function saveThemeMode(mode: ThemeMode): Promise<boolean> {
  const preferences = await loadThemePreferences();
  return saveThemePreferences({ ...preferences, mode });
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

// ─── Call modality log ────────────────────────────────────────────────────────
// The signaling server has no notion of an "audio call": `startAudioCallWith`
// places an ordinary call and turns the local camera off once it connects, so
// the call record the server returns cannot say which of the two the user
// actually placed.  Without that, the call log can't show an audio-vs-video
// type icon and redial always starts a video call — the exact complaint that
// "redialling a voice call starts a video call".  Remembering the modality per
// call id locally is enough, and keeps the change out of the wire protocol.

const CALL_MEDIA_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-call-media.json`;

/** Cap on remembered call ids; the call log itself holds at most 50 entries. */
const MAX_CALL_MEDIA_ENTRIES = 200;

export type CallMediaType = 'audio' | 'video';

/** Ordered `callId -> modality` map; most recently recorded first. */
export type CallMediaTypeMap = Record<string, CallMediaType>;

/**
 * Load the remembered per-call modality map.  Unreadable or corrupt files
 * yield an empty map rather than throwing: a missing entry only means the log
 * falls back to the default modality for that row.
 */
export async function loadCallMediaTypes(): Promise<CallMediaTypeMap> {
  try {
    const exists = await RNFS.exists(CALL_MEDIA_FILE);
    if (!exists) return {};
    const content = await RNFS.readFile(CALL_MEDIA_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return {};
    const entries = Object.entries((parsed as Record<string, unknown>)).filter(
      ([callId, value]) => callId && (value === 'audio' || value === 'video'),
    );
    return (Object.fromEntries(entries.slice(0, MAX_CALL_MEDIA_ENTRIES)) as CallMediaTypeMap);
  } catch (error) {
    logError('Failed to load call modality log; ignoring it', {
      message: errorMessage(error),
    });
    return {};
  }
}

/**
 * Persist the per-call modality map, trimmed to the most recent entries.
 * Failures are logged but never thrown so a write error can't break the call
 * teardown that triggered it.
 *
 * @returns whether the write succeeded
 */
export async function saveCallMediaTypes(map: CallMediaTypeMap): Promise<boolean> {
  try {
    const trimmed = Object.fromEntries(Object.entries(map).slice(0, MAX_CALL_MEDIA_ENTRIES));
    await RNFS.writeFile(CALL_MEDIA_FILE, JSON.stringify(trimmed), 'utf8');
    return true;
  } catch (error) {
    logError('Failed to persist call modality log', { message: errorMessage(error) });
    return false;
  }
}

export const CALL_MEDIA_FILE_PATH = CALL_MEDIA_FILE;

// ─── Notification preferences ─────────────────────────────────────────────────
// Kept in their own file rather than in `wetalk-settings.json`: the message-push
// handler runs headless, before React (and therefore `useAppSettings`) exists,
// so it needs to read these without booting the app's settings machinery.

const NOTIFICATION_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-notifications.json`;

/** Cap on remembered muted people, so the file cannot grow without limit. */
const MAX_MUTED_PEERS = 500;

export type NotificationPrefs = {
  /** Master switch for chat-message notifications. */
  messageNotificationsEnabled: boolean;
  /** People whose message notifications are silenced, newest first. */
  mutedPeers: string[];
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  messageNotificationsEnabled: true,
  mutedPeers: [],
};

/**
 * Load the notification preferences.  An unreadable or corrupt file yields the
 * defaults rather than throwing: failing open (notifications on) is the safe
 * direction — silently swallowing every message would look like the app is
 * broken.
 */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const exists = await RNFS.exists(NOTIFICATION_FILE);
    if (!exists) return { ...DEFAULT_NOTIFICATION_PREFS };
    const content = await RNFS.readFile(NOTIFICATION_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_NOTIFICATION_PREFS };
    const raw = (parsed as Partial<NotificationPrefs>);
    const mutedPeers = Array.isArray(raw.mutedPeers)
      ? raw.mutedPeers
          .filter((peerId): peerId is string => typeof peerId === 'string' && peerId.length > 0)
          .slice(0, MAX_MUTED_PEERS)
      : [];
    return {
      messageNotificationsEnabled:
        typeof raw.messageNotificationsEnabled === 'boolean'
          ? raw.messageNotificationsEnabled
          : DEFAULT_NOTIFICATION_PREFS.messageNotificationsEnabled,
      mutedPeers,
    };
  } catch (error) {
    logError('Failed to load notification preferences; using defaults', {
      message: errorMessage(error),
    });
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

/**
 * Persist the notification preferences.
 *
 * @returns whether the write succeeded
 */
export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<boolean> {
  try {
    await RNFS.writeFile(
      NOTIFICATION_FILE,
      JSON.stringify({
        messageNotificationsEnabled: Boolean(prefs.messageNotificationsEnabled),
        mutedPeers: (prefs.mutedPeers ?? []).slice(0, MAX_MUTED_PEERS),
      }),
      'utf8',
    );
    return true;
  } catch (error) {
    logError('Failed to persist notification preferences', { message: errorMessage(error) });
    return false;
  }
}

export const NOTIFICATION_FILE_PATH = NOTIFICATION_FILE;

// ─── Onboarding state ─────────────────────────────────────────────────────────
// Its own file for the same reason as the identity and theme: `saveSettings`
// rewrites the whole app-settings document, and this flag is written from a
// different part of the app (the first-run flow) than the settings toggles.

const ONBOARDING_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-onboarding.json`;

export type OnboardingState = {
  /**
   * Whether the explanation shown before the system permission dialogs has
   * been answered. Recorded whichever way it was answered: a user who chose
   * "Not now" has seen it, and re-asking on every launch is nagging.
   */
  permissionsPrimerSeen: boolean;
};

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  permissionsPrimerSeen: false,
};

/**
 * Load the first-run flags. An unreadable or corrupt file yields the defaults,
 * which means the primer is shown again — the safe direction, since showing an
 * explanation twice is a smaller failure than never explaining at all.
 */
export async function loadOnboardingState(): Promise<OnboardingState> {
  try {
    const exists = await RNFS.exists(ONBOARDING_FILE);
    if (!exists) return { ...DEFAULT_ONBOARDING_STATE };
    const content = await RNFS.readFile(ONBOARDING_FILE, 'utf8');
    return mergeSettings(DEFAULT_ONBOARDING_STATE, JSON.parse(content));
  } catch (error) {
    logError('Failed to load onboarding state; using defaults', {
      message: errorMessage(error),
    });
    return { ...DEFAULT_ONBOARDING_STATE };
  }
}

/**
 * Persist the first-run flags. Failures are logged but never thrown so a write
 * error can't break the flow that triggered it.
 *
 * @returns whether the write succeeded
 */
export async function saveOnboardingState(state: OnboardingState): Promise<boolean> {
  try {
    await RNFS.writeFile(
      ONBOARDING_FILE,
      JSON.stringify({ permissionsPrimerSeen: Boolean(state?.permissionsPrimerSeen) }),
      'utf8',
    );
    return true;
  } catch (error) {
    logError('Failed to persist onboarding state', { message: errorMessage(error) });
    return false;
  }
}

export const ONBOARDING_FILE_PATH = ONBOARDING_FILE;
