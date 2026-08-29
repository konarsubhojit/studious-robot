import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The OS "reduce motion" accessibility preference, as React state.
 *
 * The setting used to be read only by `haptics.ts`, into a module-level
 * variable that nothing else could see, so every *visual* animation in the app
 * ran regardless: the incoming-call pulse, the call-chrome fade, the
 * message-bubble spring and the overlay transitions all ignored a preference
 * the app had already been told about. This hook is the shared reader, and it
 * now governs animation *only* — vibration is a separate, user-visible
 * preference (`Settings › Calls & media › Haptic feedback`), because reduce
 * motion asks for less movement on screen, not for less feedback.
 *
 * Callers should branch on it rather than skipping the animation entirely —
 * jump straight to the final value so the UI still ends up in the right state:
 *
 *     const reduceMotion = useReducedMotion();
 *     withTiming(1, { duration: reduceMotion ? 0 : motion.duration.fast });
 *
 * Defaults to `false` so animations work during the (asynchronous) first read,
 * and never throws: on a platform without the accessibility API the hook simply
 * reports "motion is fine".
 */
export default function useReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    try {
      const result = AccessibilityInfo.isReduceMotionEnabled?.();
      if (result?.then) {
        result
          .then(enabled => {
            if (!cancelled) setReduceMotion(Boolean(enabled));
          })
          .catch(() => {
            // best-effort: keep the default
          });
      }
    } catch {
      // best-effort
    }

    let subscription: { remove?: () => void } | null = null;
    try {
      subscription =
        AccessibilityInfo.addEventListener?.('reduceMotionChanged', enabled => {
          if (!cancelled) setReduceMotion(Boolean(enabled));
        }) ?? null;
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
  }, []);

  return reduceMotion;
}
