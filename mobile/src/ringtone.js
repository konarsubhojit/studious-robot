import { logInfo, logWarn } from './appLogger';

/**
 * JS-layer incoming-call ringtone fallback for the WeTalk mobile app.
 *
 * This module provides a platform-independent fallback for ringing when the
 * system-level call UI (CallKeep) is unavailable.  It wraps the optional
 * `react-native-incall-manager` native package, which exposes audio session /
 * ringtone controls for VoIP apps.
 *
 * Behaviour contract
 * ──────────────────
 * - `startIncomingRingtone()` is idempotent: calling it while already ringing
 *   is a safe no-op.
 * - `stopIncomingRingtone()` is idempotent: calling it when not ringing, or
 *   calling it multiple times, is always safe.
 * - Both helpers return `void` and never throw.
 * - When the native module is absent the helpers degrade gracefully to no-ops
 *   so the JS bundle still builds and runs without the native dependency.
 */

/** Cached result of the optional native InCallManager module lookup. */
let cachedInCallManager;
let hasLoggedMissingInCallManager = false;

/**
 * Lazily resolve the optional `react-native-incall-manager` default export.
 * Returns the InCallManager singleton, or `null` when the package is not
 * installed.  The lookup is memoised so a missing module is only logged once.
 *
 * @returns {object | null}
 */
function loadInCallManager() {
  if (cachedInCallManager !== undefined) return cachedInCallManager;
  try {
    const mod = require('react-native-incall-manager');
    cachedInCallManager = mod?.default ?? mod ?? null;
  } catch {
    cachedInCallManager = null;
    if (!hasLoggedMissingInCallManager) {
      logWarn('[Ringtone] react-native-incall-manager not installed; ringtone fallback unavailable');
      hasLoggedMissingInCallManager = true;
    }
  }
  return cachedInCallManager;
}

/** Reset cached module state (test hook). */
export function _resetRingtoneCache() {
  cachedInCallManager = undefined;
  hasLoggedMissingInCallManager = false;
  _isRinging = false;
}

/** Tracks whether the fallback ringtone is currently playing. */
let _isRinging = false;

/**
 * Start the incoming-call ringtone via InCallManager if available.
 * No-op when already ringing or when the native module is absent.
 */
export function startIncomingRingtone() {
  if (_isRinging) return;
  const manager = loadInCallManager();
  if (!manager) return;

  try {
    // `start` with `ringback: '_BUNDLE_'` plays the system ringtone on Android.
    // The `media: false` flag keeps audio routing in voice-call mode.
    if (typeof manager.start === 'function') {
      manager.start({ media: false, ringback: '_BUNDLE_' });
      _isRinging = true;
      logInfo('[Ringtone] Fallback ringtone started');
    }
  } catch (error) {
    logWarn('[Ringtone] startIncomingRingtone failed', { message: error?.message });
  }
}

/**
 * Stop the incoming-call ringtone.
 * Safe to call multiple times; no-op when not currently ringing.
 */
export function stopIncomingRingtone() {
  if (!_isRinging) return;
  _isRinging = false;

  const manager = loadInCallManager();
  if (!manager) return;

  try {
    if (typeof manager.stop === 'function') {
      manager.stop();
      logInfo('[Ringtone] Fallback ringtone stopped');
    }
  } catch (error) {
    logWarn('[Ringtone] stopIncomingRingtone failed', { message: error?.message });
  }
}
