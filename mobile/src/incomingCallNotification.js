import { NativeModules, Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';

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
 * @param {{ callId: string, callerId?: string | null, hasVideo?: boolean }} opts
 * @returns {Promise<boolean>} `true` when a notification was posted
 */
export async function showIncomingCallNotification({ callId, callerId, hasVideo = true } = {}) {
  if (!callId) return false;
  const module = getNativeModule();
  if (!module || typeof module.show !== 'function') return false;

  try {
    await module.show(callId, callerId || 'Incoming call', Boolean(hasVideo));
    logInfo('[IncomingCallNotification] Shown', { callId, callerId: callerId ?? null });
    return true;
  } catch (error) {
    logError('[IncomingCallNotification] show failed', error);
    return false;
  }
}

/**
 * Dismiss WeTalk's branded incoming-call notification for a single call
 * (e.g. once CallKeep reports the call answered, ended or declined
 * elsewhere). Safe to call even when nothing was ever shown.
 *
 * @param {string} callId
 * @returns {boolean} `true` when a dismiss request was sent
 */
export function dismissIncomingCallNotification(callId) {
  if (!callId) return false;
  const module = getNativeModule();
  if (!module || typeof module.dismiss !== 'function') return false;

  try {
    module.dismiss(callId);
    return true;
  } catch (error) {
    logWarn('[IncomingCallNotification] dismiss failed', { message: error?.message });
    return false;
  }
}
