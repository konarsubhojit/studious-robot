import { Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';

/**
 * System-level incoming-call UI for the WeTalk mobile app.
 *
 * Wraps the optional `react-native-callkeep` native module, which surfaces the
 * OS call UI (Android ConnectionService / iOS CallKit) so an incoming call can
 * ring full-screen even during a cold start triggered by a background push.
 *
 * `react-native-callkeep` is an *optional* native dependency: when it (and the
 * matching Android ConnectionService / iOS entitlement) is not installed, every
 * helper below degrades gracefully to a no-op so the JS bundle still builds and
 * runs. This mirrors the optional handling of `@react-native-firebase/messaging`
 * in `pushNotifications.js` and the server's env-gated push delivery.
 */

/** Options passed to `RNCallKeep.setup`; tuned for a VoIP calling app. */
const CALLKEEP_SETUP_OPTIONS = {
  ios: {
    appName: 'WeTalk',
    supportsVideo: true,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
  android: {
    alertTitle: 'Permissions required',
    alertDescription: 'WeTalk needs access to your phone-call accounts to show incoming calls',
    cancelButton: 'Cancel',
    okButton: 'OK',
    // Show the OS incoming-call UI even when the app is in the background.
    foregroundService: {
      channelId: 'com.wetalk.callkeep',
      channelName: 'Incoming calls',
      notificationTitle: 'WeTalk is running',
    },
    // NOT self-managed: Android Telecom owns the ringing UI. A self-managed
    // phone account makes Telecom create the connection *without* showing any
    // UI — the app is then required to render (and ring) its own full-screen
    // incoming-call notification in response to CallKeep's `showIncomingCallUi`
    // event. This app has no such handler, so a self-managed account meant a
    // push could be delivered and `displayIncomingCall` succeed while the
    // handset stayed silent.
    selfManaged: false,
    additionalPermissions: [],
  },
};

/** Cached result of the optional native CallKeep module lookup. */
let cachedCallKeep;
let hasLoggedMissingCallKeep = false;
/** Whether `setup()` has completed successfully (guards repeated setup). */
let isConfigured = false;
/**
 * Call ids already surfaced to the OS.
 *
 * The same call can legitimately arrive over several paths at once — the
 * `call.incoming` socket event, a foreground push and a background push all
 * race for the same call — so displaying is deduplicated centrally here rather
 * than in each caller. Without this the OS would show (and ring) the same
 * incoming call more than once.
 */
const displayedCallIds = new Set();

/**
 * Lazily resolve the optional `react-native-callkeep` default export. Returns
 * the RNCallKeep singleton, or `null` when the package is not installed. The
 * lookup is memoised so a missing module is only logged once.
 *
 * @returns {object | null}
 */
export function loadCallKeep() {
  if (cachedCallKeep !== undefined) return cachedCallKeep;
  try {
    const mod = require('react-native-callkeep');
    cachedCallKeep = mod?.default ?? mod ?? null;
  } catch {
    cachedCallKeep = null;
    if (!hasLoggedMissingCallKeep) {
      logWarn('[CallKeep] Native callkeep module not installed; skipping system call UI');
      hasLoggedMissingCallKeep = true;
    }
  }
  return cachedCallKeep;
}

/** Reset the memoised module + configured flag (test hook). */
export function _resetCallKeepCache() {
  cachedCallKeep = undefined;
  hasLoggedMissingCallKeep = false;
  isConfigured = false;
  displayedCallIds.clear();
}

/**
 * Forget that a call was displayed, so a future call reusing the id (or a
 * retried ring after the call ended) can be surfaced again.
 *
 * @param {string} callId
 */
export function clearDisplayedCall(callId) {
  displayedCallIds.delete(callId);
}

/**
 * Whether a CallKeep setup rejection is the benign "no foreground Activity"
 * failure raised when setup runs from a background/headless context (the
 * killed-app push path) rather than a real configuration error.
 *
 * @param {{ code?: string, message?: string } | null | undefined} error
 * @returns {boolean}
 */
function isMissingActivityError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return code === 'E_ACTIVITY_DOES_NOT_EXIST' || /activity doesn't exist/i.test(message);
}

/**
 * Configure CallKeep once. Safe to call repeatedly; subsequent calls are no-ops
 * once setup has succeeded. Returns `false` (never throws) when the native
 * module is unavailable or setup fails.
 *
 * @returns {Promise<boolean>} `true` when CallKeep is configured and ready
 */
export async function setupCallKeep() {
  if (isConfigured) return true;
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.setup !== 'function') return false;

  try {
    try {
      await callKeep.setup(CALLKEEP_SETUP_OPTIONS);
    } catch (error) {
      if (!isMissingActivityError(error)) throw error;
      // A push that cold-starts the app runs in a headless JS context with no
      // foreground Activity, so CallKeep's post-setup phone-account permission
      // prompt rejects. The native half of setup (phone-account registration,
      // event wiring) already ran synchronously before that prompt, so the
      // system call UI is still usable and the call must still ring.
      logWarn('[CallKeep] setup completed without an Activity; skipping permission prompt');
    }
    if (Platform.OS === 'android' && typeof callKeep.setAvailable === 'function') {
      callKeep.setAvailable(true);
    }
    isConfigured = true;
    logInfo('[CallKeep] System call UI configured');
    return true;
  } catch (error) {
    logError('[CallKeep] setup failed', error);
    return false;
  }
}

/**
 * Display the OS incoming-call UI for a call. Returns `false` (never throws)
 * when CallKeep is unavailable or display fails.
 *
 * Duplicate calls for the same `callId` are ignored, so it is safe to invoke
 * this from the socket, foreground-push and background-push paths at once.
 *
 * @param {{ callId: string, callerId?: string | null, hasVideo?: boolean }} opts
 * @returns {Promise<boolean>} `true` when the system UI was shown
 */
export async function displayIncomingCall({ callId, callerId, hasVideo = true } = {}) {
  if (!callId) return false;
  if (displayedCallIds.has(callId)) {
    logInfo('[CallKeep] Incoming call already displayed; ignoring duplicate', { callId });
    return true;
  }
  const ready = await setupCallKeep();
  if (!ready) return false;

  const callKeep = loadCallKeep();
  try {
    const handle = callerId || callId;
    const name = callerId || 'Incoming call';
    displayedCallIds.add(callId);
    callKeep.displayIncomingCall(callId, handle, name, 'generic', hasVideo);
    logInfo('[CallKeep] Displayed incoming call', { callId, callerId: callerId ?? null });
    return true;
  } catch (error) {
    displayedCallIds.delete(callId);
    logError('[CallKeep] displayIncomingCall failed', error);
    return false;
  }
}

/**
 * Inform the OS that a call became connected/active so the system UI shows the
 * in-call controls instead of the ringing state.
 *
 * @param {string} callId
 * @returns {boolean} `true` when the update was sent
 */
export function reportCallConnected(callId) {
  if (!callId) return false;
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.setCurrentCallActive !== 'function') return false;
  try {
    callKeep.setCurrentCallActive(callId);
    return true;
  } catch (error) {
    logError('[CallKeep] reportCallConnected failed', error);
    return false;
  }
}

/**
 * Dismiss the OS call UI for a single call.
 *
 * @param {string} callId
 * @returns {boolean} `true` when the end was sent
 */
export function endCall(callId) {
  if (!callId) return false;
  // Allow the call id to be displayed again if it ever rings anew.
  displayedCallIds.delete(callId);
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.endCall !== 'function') return false;
  try {
    callKeep.endCall(callId);
    return true;
  } catch (error) {
    logError('[CallKeep] endCall failed', error);
    return false;
  }
}

/** Dismiss every active OS call UI (cleanup helper). */
export function endAllCalls() {
  displayedCallIds.clear();
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.endAllCalls !== 'function') return false;
  try {
    callKeep.endAllCalls();
    return true;
  } catch (error) {
    logError('[CallKeep] endAllCalls failed', error);
    return false;
  }
}

/**
 * Bridge the OS answer/end buttons into the app's call flow. Registers
 * `answerCall` and `endCall` listeners and returns an unsubscribe function.
 * No-ops (returning a no-op unsubscribe) when CallKeep is unavailable.
 *
 * @param {{
 *   onAnswer?: (callId: string) => void,
 *   onEnd?: (callId: string) => void,
 * }} handlers
 * @returns {() => void} unsubscribe function
 */
export function registerCallActionListeners({ onAnswer, onEnd } = {}) {
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.addEventListener !== 'function') {
    return () => {};
  }

  const answerHandler = ({ callUUID } = {}) => {
    logInfo('[CallKeep] answerCall', { callUUID });
    onAnswer?.(callUUID);
  };
  const endHandler = ({ callUUID } = {}) => {
    logInfo('[CallKeep] endCall', { callUUID });
    onEnd?.(callUUID);
  };

  try {
    callKeep.addEventListener('answerCall', answerHandler);
    callKeep.addEventListener('endCall', endHandler);
  } catch (error) {
    logError('[CallKeep] registerCallActionListeners failed', error);
    return () => {};
  }

  return () => {
    try {
      // react-native-callkeep tracks a single listener per event name, so it
      // unsubscribes by event name only (no handler reference required).
      callKeep.removeEventListener?.('answerCall');
      callKeep.removeEventListener?.('endCall');
    } catch (error) {
      logWarn('[CallKeep] removeEventListener failed', { message: error?.message });
    }
  };
}
