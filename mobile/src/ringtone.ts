// @ts-check
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
 * - `startIncomingRingtone()` / `startOutgoingRingback()` are idempotent:
 *   calling either while already playing is a safe no-op.
 * - `stopIncomingRingtone()` / `stopOutgoingRingback()` are idempotent: calling
 *   them when not playing, or calling them multiple times, is always safe.
 * - Both helpers return `void` and never throw.
 * - When the native module is absent the helpers degrade gracefully to no-ops
 *   so the JS bundle still builds and runs without the native dependency.
 */

/**
 * The subset of the optional `react-native-incall-manager` surface this module
 * uses. Every member is optional because older versions of the package (and the
 * test doubles) expose only part of it, which the call sites already probe for.
 */
export type InCallManager = { start?: (options: { media: boolean, ringback?: string }) => void; stop?: () => void; stopRingback?: () => void; };

/**
 * Cached result of the optional native InCallManager module lookup.
 *
 * @type {InCallManager | null | undefined}
 */
let cachedInCallManager: InCallManager | null | undefined;
let hasLoggedMissingInCallManager = false;

/**
 * Lazily resolve the optional `react-native-incall-manager` default export.
 * Returns the InCallManager singleton, or `null` when the package is not
 * installed.  The lookup is memoised so a missing module is only logged once.
 *
 * @returns {InCallManager | null}
 */
function loadInCallManager(): InCallManager | null {
  if (cachedInCallManager !== undefined) return cachedInCallManager;
  try {
    const mod = require('react-native-incall-manager');
    cachedInCallManager = /** @type {InCallManager | null} */ (
      /** @type {unknown} */ (mod?.default ?? mod ?? null)
    );
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

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/** Reset cached module state (test hook). */
export function _resetRingtoneCache() {
  cachedInCallManager = undefined;
  hasLoggedMissingInCallManager = false;
  _isRinging = false;
  _isRingbackPlaying = false;
}

/** Tracks whether the fallback ringtone is currently playing. */
let _isRinging = false;
let _isRingbackPlaying = false;

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
    logWarn('[Ringtone] stopIncomingRingtone failed', { message: errorMessage(error) });
  }
}

/**
 * Start an outgoing ringback tone so the caller gets audible feedback while the
 * remote side is ringing.  Uses the same native module as the incoming fallback
 * and degrades to a no-op when unavailable.
 */
export function startOutgoingRingback() {
  if (_isRingbackPlaying) return;
  const manager = loadInCallManager();
  if (!manager) return;

  try {
    if (typeof manager.start !== 'function') {
      logWarn('[Ringtone] startOutgoingRingback unavailable; native module has no start');
      return;
    }
    if (typeof manager.stopRingback !== 'function') {
      logWarn('[Ringtone] startOutgoingRingback unavailable; native module has no stopRingback');
      return;
    }
    manager.start({ media: false, ringback: '_BUNDLE_' });
    _isRingbackPlaying = true;
    logInfo('[Ringtone] Outgoing ringback started');
  } catch (error) {
    logWarn('[Ringtone] startOutgoingRingback failed', { message: errorMessage(error) });
  }
}

/**
 * Stop the outgoing ringback tone.
 */
export function stopOutgoingRingback() {
  if (!_isRingbackPlaying) return;
  _isRingbackPlaying = false;

  const manager = loadInCallManager();
  if (!manager) return;

  try {
    if (typeof manager.stopRingback === 'function') {
      manager.stopRingback();
      logInfo('[Ringtone] Outgoing ringback stopped');
    } else {
      logWarn('[Ringtone] stopOutgoingRingback unavailable; native module has no stopRingback');
    }
  } catch (error) {
    logWarn('[Ringtone] stopOutgoingRingback failed', { message: errorMessage(error) });
  }
}
