import { NativeModules, Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';
import { startIncomingRingtone } from './ringtone';

/** Android's `NotificationManager.IMPORTANCE_HIGH`; below this nothing rings. */
const IMPORTANCE_HIGH = 4;

/**
 * WeTalk's own branded incoming-call notification.
 *
 * `callKeep.js` runs Android CallKeep in *self-managed* mode: Telecom hands
 * the entire ringing UI to the app instead of drawing its own, and fires a
 * `showIncomingCallUi` event to say so (see `registerShowIncomingCallUiListener`
 * in `callKeep.js`). This module is what answers that event — it renders a
 * high-priority, full-screen-intent notification (native module
 * `IncomingCallNotification`, `android/app/src/main/java/com/wetalk/
 * IncomingCallNotificationModule.kt`) with the caller's identity and Accept /
 * Decline actions, over a high-importance channel with sound + vibration so
 * the device actually rings, including over the lock screen.
 *
 * `IncomingCallNotification` is a *first-party optional* native module: it
 * only exists on Android, and every helper below degrades gracefully to a
 * no-op on other platforms or when the native module has not been linked
 * (e.g. a JS-only test run), mirroring every other optional-native-module
 * wrapper in this app (`callKeep.js`, `ringtone.js`, `pushNotifications.js`,
 * `callService.js`).
 */

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function getNativeModule() {
  if (Platform.OS !== 'android') return null;
  return NativeModules?.IncomingCallNotification || null;
}

/** Whether the native incoming-call notification module is available. */
export function isIncomingCallNotificationAvailable() {
  return Boolean(getNativeModule());
}

/**
 * Show WeTalk's branded incoming-call notification.
 *
 * Returns `false` (never throws) when the native module is unavailable or
 * showing the notification fails outright — callers must treat that as a
 * signal to fall back to something audible (see
 * `registerShowIncomingCallUiListener` in `callKeep.js`), since a silently
 * failed branded UI is strictly worse than an ugly one.
 *
 * The native side itself falls back from a full-screen intent to a plain
 * heads-up notification when Android 14+'s `canUseFullScreenIntent()` denies
 * the app that capability; either way the high-importance channel's sound and
 * vibration still ring the device, so a resolved `true` here always means the
 * user was audibly alerted even if the full-screen UI could not be drawn.
 *
 * @param {{ callId?: string, callerId?: string | null, hasVideo?: boolean }} [opts]
 * @returns {Promise<boolean>} `true` when a notification was posted
 */
export async function showIncomingCallNotification({ callId, callerId, hasVideo = true }: { callId?: string; callerId?: string | null; hasVideo?: boolean; } = {}): Promise<boolean> {
  if (!callId) return false;
  const module = getNativeModule();
  if (!module || typeof module.show !== 'function') return false;

  try {
    const result =
      (await module.show(callId, callerId || 'Incoming call', Boolean(hasVideo))) ?? {};
    logInfo('[IncomingCallNotification] Shown', {
      callId,
      callerId: callerId ?? null,
      channelImportance: result.channelImportance ?? null,
      channelHasSound: result.channelHasSound ?? null,
      connectionLive: result.connectionLive ?? null,
    });

    // Notification channel settings are immutable once created, so an install
    // carrying an older, quieter channel can post this notification silently.
    // The native side reports the channel's *effective* importance and sound;
    // when either says it will not ring, ring from JS instead of assuming.
    const importance = result.channelImportance;
    const hasSound = result.channelHasSound;
    if ((typeof importance === 'number' && importance < IMPORTANCE_HIGH) || hasSound === false) {
      logWarn('[IncomingCallNotification] Channel will not ring; starting ringtone fallback', {
        callId,
        channelImportance: importance ?? null,
        channelHasSound: hasSound ?? null,
      });
      startIncomingRingtone();
    }
    return true;
  } catch (error) {
    logError('[IncomingCallNotification] show failed', error);
    return false;
  }
}

/**
 * Remove and return the Accept / Decline the user tapped on the branded
 * notification while the JS context was not running (cold start), so the call
 * flow can replay it. Resolves `null` when nothing is pending.
 *
 * @returns {Promise<{
 *   callId: string,
 *   action: 'accept' | 'decline',
 *   ageMs: number,
 *   connectionLive: boolean,
 * } | null>}
 */
export async function consumePendingCallAction(): Promise<{
    callId: string;
    action: 'accept' | 'decline';
    ageMs: number;
    connectionLive: boolean;
} | null> {
  const module = getNativeModule();
  if (!module || typeof module.consumePendingCallAction !== 'function') return null;
  try {
    const pending = await module.consumePendingCallAction();
    if (!pending?.callId || !pending?.action) return null;
    logInfo('[IncomingCallNotification] Draining persisted call action', pending);
    return pending;
  } catch (error) {
    logWarn('[IncomingCallNotification] consumePendingCallAction failed', {
      message: errorMessage(error),
    });
    return null;
  }
}

/**
 * Whether Telecom still holds a live CallKeep connection for `callId`.
 *
 * The branded notification is posted independently of whether Telecom ever
 * created a connection, so this is reported alongside the ring so the server
 * records whether the call was answerable through the OS call UI.
 *
 * @param {string} callId
 * @returns {Promise<boolean | null>} `null` when the native module is absent
 */
export async function isCallConnectionLive(callId: string): Promise<boolean | null> {
  const module = getNativeModule();
  if (!callId || !module || typeof module.isCallConnectionLive !== 'function') return null;
  try {
    return Boolean(await module.isCallConnectionLive(callId));
  } catch (error) {
    logWarn('[IncomingCallNotification] isCallConnectionLive failed', {
      message: errorMessage(error),
    });
    return null;
  }
}

/**
 * Dismiss WeTalk's branded incoming-call notification for a single call
 * (e.g. once CallKeep reports the call answered, ended or declined
 * elsewhere). Safe to call even when nothing was ever shown.
 *
 * @param {string} [callId]
 * @returns {boolean} `true` when a dismiss request was sent
 */
export function dismissIncomingCallNotification(callId?: string): boolean {
  if (!callId) return false;
  const module = getNativeModule();
  if (!module || typeof module.dismiss !== 'function') return false;

  try {
    module.dismiss(callId);
    return true;
  } catch (error) {
    logWarn('[IncomingCallNotification] dismiss failed', { message: errorMessage(error) });
    return false;
  }
}
