import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The OS high-contrast accessibility preference, as React state.
 *
 * Deliberately shaped like `useReducedMotion`: the platform tells the app what
 * the user already asked for, and the app should honour it without making them
 * find a second switch. Android exposes "high contrast text"
 * (`isHighTextContrastEnabled` / `highTextContrastChanged`); iOS exposes
 * "darken colors" (`isDarkerSystemColorsEnabled` / `darkerSystemColorsChanged`).
 * Both mean the same thing here — *this palette is not contrasty enough* — so
 * one hook reads whichever the platform has.
 *
 * Defaults to `false` so the standard palette renders during the
 * (asynchronous) first read, and never throws: on a platform without the API
 * the hook simply reports "the standard palette is fine".
 */
export default function useHighContrast(): boolean {
  const [highContrast, setHighContrast] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const isIOS = Platform.OS === 'ios';
    const read = isIOS
      ? AccessibilityInfo.isDarkerSystemColorsEnabled
      : AccessibilityInfo.isHighTextContrastEnabled;
    const event = isIOS ? 'darkerSystemColorsChanged' : 'highTextContrastChanged';

    try {
      const result = read?.();
      if (result?.then) {
        result
          .then(enabled => {
            if (!cancelled) setHighContrast(Boolean(enabled));
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
        AccessibilityInfo.addEventListener?.(event, enabled => {
          if (!cancelled) setHighContrast(Boolean(enabled));
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

  return highContrast;
}
