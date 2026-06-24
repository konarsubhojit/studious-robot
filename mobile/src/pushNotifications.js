import { Linking } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';

/**
 * Push notification helpers for the TCalling mobile app.
 *
 * Provides three capabilities:
 *  1. Deep-link parsing  – convert `tcalling://call/{callId}` URLs into call
 *     descriptors.
 *  2. App-launch detection – retrieve the URL the app was opened from
 *     (notification tap while the app was killed or backgrounded).
 *  3. Push-token registration – persist the device push token with the
 *     signaling server so offline delivery can be attempted.
 *
 * Note: obtaining the raw OS-level push token requires a native push library
 * (e.g. @react-native-firebase/messaging on Android, or
 * @react-native-community/push-notification-ios on iOS).  The
 * `registerPushToken` helper below accepts a token that the host application
 * has already retrieved via such a library, and it registers it with the
 * signaling server's POST /devices/register endpoint.
 */

// ─── Deep-link helpers ────────────────────────────────────────────────────────

const DEEP_LINK_SCHEME = 'tcalling';

/**
 * Parse a TCalling deep-link URL into a call descriptor.
 *
 * Expected format: `tcalling://call/{callId}`
 *
 * @param {string | null | undefined} url
 * @returns {{ callId: string } | null}
 */
export function parseCallDeepLink(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // `tcalling://call/{callId}` → protocol=tcalling:, host=call, pathname=/{callId}
  const callId = parsed.pathname?.replace(/^\//, '').trim();
  if (parsed.host === 'call' && callId) {
    return { callId };
  }

  return null;
}

/**
 * Return the call descriptor for the URL the app was launched from, if any.
 * Returns `null` when the app was opened normally (not from a notification tap).
 *
 * @returns {Promise<{ callId: string } | null>}
 */
export async function getInitialCallLink() {
  try {
    const url = await Linking.getInitialURL();
    return parseCallDeepLink(url);
  } catch (error) {
    logWarn('[Push] getInitialURL failed', { message: error?.message });
    return null;
  }
}

/**
 * Subscribe to deep-link URLs received while the app is already running
 * (e.g. a notification tap that brings a backgrounded app to the foreground).
 *
 * @param {(descriptor: { callId: string }) => void} callback
 * @returns {() => void} Unsubscribe function – call it in the effect cleanup.
 */
export function addCallLinkListener(callback) {
  const subscription = Linking.addEventListener('url', ({ url }) => {
    const descriptor = parseCallDeepLink(url);
    if (descriptor) {
      logInfo('[Push] Deep-link received', descriptor);
      callback(descriptor);
    }
  });
  return () => subscription?.remove();
}

// ─── Push-token registration ──────────────────────────────────────────────────

/**
 * Register a device push token with the signaling server.
 *
 * The token must be obtained before calling this function using a native push
 * library appropriate for the platform.
 *
 * @param {{
 *   sessionId: string,
 *   signalingUrl: string,
 *   provider: 'apns' | 'fcm',
 *   pushToken: string,
 * }} opts
 * @returns {Promise<boolean>} `true` on success
 */
export async function registerPushToken({ sessionId, signalingUrl, provider, pushToken }) {
  try {
    const response = await fetch(`${signalingUrl.trim()}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, provider, pushToken }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      logWarn('[Push] registerPushToken failed', {
        status: response.status,
        error: body?.error,
      });
      return false;
    }

    logInfo('[Push] Push token registered', {
      provider,
      deviceId: body?.deviceId,
    });
    return true;
  } catch (error) {
    logError('[Push] registerPushToken threw', error);
    return false;
  }
}

/**
 * Unregister the push token for the current device session.
 *
 * @param {{ sessionId: string, signalingUrl: string }} opts
 * @returns {Promise<boolean>} `true` on success
 */
export async function unregisterPushToken({ sessionId, signalingUrl }) {
  try {
    const response = await fetch(`${signalingUrl.trim()}/devices/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      logWarn('[Push] unregisterPushToken failed', {
        status: response.status,
        error: body?.error,
      });
      return false;
    }

    logInfo('[Push] Push token unregistered');
    return true;
  } catch (error) {
    logError('[Push] unregisterPushToken threw', error);
    return false;
  }
}
