import { AccessibilityInfo, Vibration } from 'react-native';

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
 * Whether haptics are currently suppressed because the OS accessibility
 * settings ask for reduced motion. Defaults to `false` so haptics still work
 * before the (asynchronous) first accessibility read resolves.
 */
let reduceMotionEnabled = false;

/**
 * Subscribes to the OS "reduce motion" accessibility setting so haptics stop
 * firing for users who asked for reduced motion, and starts an initial read of
 * the current value.
 *
 * Safe to call more than once; each call returns its own unsubscribe function.
 *
 * @returns {() => void} unsubscribe
 */
export function initHaptics(): () => void {
  let cancelled = false;

  try {
    const result = AccessibilityInfo.isReduceMotionEnabled?.();
    if (result?.then) {
      result
        .then(enabled => {
          if (!cancelled) reduceMotionEnabled = Boolean(enabled);
        })
        .catch(() => {
          // best-effort: keep the current preference
        });
    }
  } catch {
    // best-effort
  }

  let subscription = null;
  try {
    subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', enabled => {
      reduceMotionEnabled = Boolean(enabled);
    });
  } catch {
    // best-effort
  }

  return () => {
    cancelled = true;
    try {
      subscription?.remove?.();
    } catch {
      // best-effort
    }
  };
}

/** @returns {boolean} true when haptics are suppressed by accessibility settings. */
export function areHapticsSuppressed(): boolean {
  return reduceMotionEnabled;
}

/**
 * Fires the named haptic pattern, unless the OS accessibility settings ask for
 * reduced motion. Never throws.
 *
 * @param {keyof typeof HAPTIC_PATTERNS} pattern
 * @returns {boolean} true when a vibration was actually triggered.
 */
export function triggerHaptic(pattern: keyof typeof HAPTIC_PATTERNS): boolean {
  const durationMs = HAPTIC_PATTERNS[pattern];
  if (!durationMs) return false;
  if (reduceMotionEnabled) return false;

  try {
    Vibration.vibrate(durationMs);
    return true;
  } catch {
    // best-effort
    return false;
  }
}

/** Test-only: resets the cached accessibility preference. */
export function resetHapticsForTests() {
  reduceMotionEnabled = false;
}
