import { Vibration } from 'react-native';

/**
 * Named haptic patterns used across the call experience, expressed as
 * vibration durations in milliseconds.
 *
 * Core React Native's `Vibration` API is used (rather than an extra native
 * haptics module) so haptics need no additional native dependency, while this
 * module stays the single place that decides *whether* a haptic fires.
 */
export const HAPTIC_PATTERNS = {
  /** Light confirmation for a control tap (mute, camera, screen share). */
  tap: 15,
  /** Slightly firmer confirmation for accepting an incoming call. */
  answer: 25,
  /** Media is flowing and the call is now connected. */
  connect: 30,
  /** Call hung up / declined. */
  end: 40,
  /** Attention-grabbing buzz that accompanies the incoming-call UI. */
  incomingRing: 400,
};

/**
 * Whether the user wants haptic feedback. Defaults to `true` so a control tap
 * still answers before the (asynchronous) settings load resolves.
 *
 * This used to be driven by the OS "reduce motion" setting, which conflated two
 * different requests: reduce motion asks for less *animation*, usually because
 * movement causes discomfort or nausea. A vibration is not movement on screen,
 * and for some users it is the only confirmation a tap registered — silencing
 * it removed feedback nobody had asked to lose, from a switch that was not
 * visible anywhere in the app. Motion is now governed by `useReducedMotion`
 * and haptics by this explicit, user-visible preference.
 */
let hapticsEnabled = true;

/**
 * Applies the user's "Haptic feedback" preference.
 *
 * Kept as a module-level setter rather than a hook because `triggerHaptic` is
 * called from plain functions (call state transitions), not only from
 * components.
 */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = Boolean(enabled);
}

/** @returns true when haptics are currently suppressed. */
export function areHapticsSuppressed(): boolean {
  return !hapticsEnabled;
}

/**
 * Fires the named haptic pattern, unless the user turned haptics off. Never
 * throws.
 *
 * @returns true when a vibration was actually triggered.
 */
export function triggerHaptic(pattern: keyof typeof HAPTIC_PATTERNS): boolean {
  const durationMs = HAPTIC_PATTERNS[pattern];
  if (!durationMs) return false;
  if (!hapticsEnabled) return false;

  try {
    Vibration.vibrate(durationMs);
    return true;
  } catch {
    // best-effort
    return false;
  }
}

/** Test-only: resets the cached preference to its default. */
export function resetHapticsForTests() {
  hapticsEnabled = true;
}
