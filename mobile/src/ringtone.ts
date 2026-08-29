import { logInfo, logWarn } from './appLogger';
import { errorMessage } from './errors';
import { shouldRingAudibly } from './ringerMode';

/**
 * JS-layer incoming-call ringtone fallback for the WeTalk mobile app.
 *
 * This module provides a platform-independent fallback for ringing when the
 * system-level call UI (CallKeep) is unavailable.  It wraps the optional
 * `react-native-incall-manager` native package, which exposes audio session /
 * ringtone controls for VoIP apps.
 *
 * Only the *receiving* side ever rings: a caller waiting for the callee to
 * pick up gets no ringback tone, so placing a call never makes noise on a
 * device whose owner asked for silence, and the caller's audio session is left
 * untouched until the call is actually connected.
 *
 * Behaviour contract
 * ──────────────────
 * - `startIncomingRingtone()` is idempotent: calling it while already ringing
 *   is a safe no-op, and it never rings when the device ringer is on silent or
 *   vibrate.
 * - `stopIncomingRingtone()` is idempotent: calling it when not playing, or
 *   calling it multiple times, is always safe.
 * - Neither helper throws.
 * - When the native module is absent the helpers degrade gracefully to no-ops
 *   so the JS bundle still builds and runs without the native dependency.
 */

/**
 * The subset of the optional `react-native-incall-manager` surface this module
 * uses. Every member is optional because older versions of the package (and the
 * test doubles) expose only part of it, which the call sites already probe for.
 */
export type InCallManager = {
  start?: (options: { media: boolean; ringback?: string }) => void;
  stop?: () => void;
};

/**
 * Cached result of the optional native InCallManager module lookup.
 */
let cachedInCallManager: InCallManager | null | undefined;
let hasLoggedMissingInCallManager = false;

/**
 * Lazily resolve the optional `react-native-incall-manager` default export.
 * Returns the InCallManager singleton, or `null` when the package is not
 * installed.  The lookup is memoised so a missing module is only logged once.
 */
function loadInCallManager(): InCallManager | null {
  if (cachedInCallManager !== undefined) return cachedInCallManager;
  try {
    const mod = require('react-native-incall-manager');
    cachedInCallManager = ((mod?.default ?? mod ?? null) as InCallManager | null);
  } catch {
    cachedInCallManager = null;
    if (!hasLoggedMissingInCallManager) {
      logWarn(
        '[Ringtone] react-native-incall-manager not installed; ringtone fallback unavailable',
      );
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
  _ringEpoch = 0;
}

/** Tracks whether the fallback ringtone is currently playing. */
let _isRinging = false;

/**
 * Bumped by every `stopIncomingRingtone()` so a start that is still reading the
 * (asynchronous) ringer state can tell that the call it was ringing for has
 * already been answered or cancelled, and stay quiet.
 */
let _ringEpoch = 0;

/**
 * Start the incoming-call ringtone via InCallManager if available.
 *
 * No-op when already ringing, when the device ringer is set to silent or
 * vibrate, or when the native module is absent.
 *
 * @returns whether the ringtone is now playing.
 */
export async function startIncomingRingtone(): Promise<boolean> {
  if (_isRinging) return true;
  const epoch = _ringEpoch;

  if (!(await shouldRingAudibly())) {
    logInfo('[Ringtone] Device ringer is silent; skipping fallback ringtone');
    return false;
  }

  // The ringer state is read asynchronously, so the call may have been answered
  // (or another start may have won the race) in the meantime.
  if (_isRinging) return true;
  if (epoch !== _ringEpoch) {
    logInfo('[Ringtone] Ringing was stopped before the ringer state resolved');
    return false;
  }

  const manager = loadInCallManager();
  if (!manager) return false;

  try {
    // `start` with `ringback: '_BUNDLE_'` plays the system ringtone on Android.
    // On iOS, InCallManager does not provide a separate ringback ringtone via
    // this API; the iOS CallKit / CallKeep path is the preferred ringing
    // mechanism.  If CallKeep is unavailable on iOS, this call is a safe no-op
    // (manager.start runs without error but produces no audible output).
    // The `media: false` flag keeps audio routing in voice-call mode.
    if (typeof manager.start === 'function') {
      manager.start({ media: false, ringback: '_BUNDLE_' });
      _isRinging = true;
      logInfo('[Ringtone] Fallback ringtone started');
    }
  } catch (error) {
    logWarn('[Ringtone] startIncomingRingtone failed', { message: errorMessage(error) });
  }

  return _isRinging;
}

/**
 * Stop the incoming-call ringtone.
 * Safe to call multiple times; no-op when not currently ringing.
 */
export function stopIncomingRingtone() {
  _ringEpoch += 1;
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
    logWarn('[Ringtone] stopIncomingRingtone failed', { message: errorMessage(error) });
  }
}
