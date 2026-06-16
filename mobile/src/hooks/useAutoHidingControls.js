import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Default inactivity window before the in-call control deck auto-hides. Chosen
 * to stay out of the way during a call while remaining easy to bring back with
 * a single tap.
 */
export const DEFAULT_CONTROLS_HIDE_DELAY_MS = 4000;

/**
 * Auto-hiding control-deck visibility.
 *
 * While `enabled` (i.e. a call is on-screen) the controls reveal themselves and
 * then fade away after `hideDelayMs` of inactivity; any user activity (a tap on
 * the video stage, pressing a control) calls `reveal()` to show them again and
 * restart the timer. When a transient interaction needs the controls to stay up
 * (e.g. an open audio-output menu) `hold(true)` pins them until `hold(false)`.
 *
 * When disabled the deck is always visible and no timer runs, so the lobby and
 * other non-call surfaces are unaffected.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {number} [options.hideDelayMs=DEFAULT_CONTROLS_HIDE_DELAY_MS]
 * @returns {{ visible: boolean, reveal: () => void, hold: (shouldHold: boolean) => void }}
 */
export default function useAutoHidingControls({
  enabled = true,
  hideDelayMs = DEFAULT_CONTROLS_HIDE_DELAY_MS,
} = {}) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef(null);
  const heldRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearTimer();
    if (!enabled || heldRef.current) {
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(false);
    }, hideDelayMs);
  }, [clearTimer, enabled, hideDelayMs]);

  const reveal = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const hold = useCallback(
    (shouldHold) => {
      heldRef.current = Boolean(shouldHold);
      if (shouldHold) {
        clearTimer();
        setVisible(true);
      } else {
        scheduleHide();
      }
    },
    [clearTimer, scheduleHide],
  );

  // Reset visibility whenever the deck becomes enabled/disabled: always visible
  // (and pinned) when disabled, or revealed with a fresh hide timer when a call
  // appears.
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      heldRef.current = false;
      setVisible(true);
      return undefined;
    }
    setVisible(true);
    scheduleHide();
    return clearTimer;
  }, [enabled, clearTimer, scheduleHide]);

  return { visible, reveal, hold };
}
