import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { logInfo, logVerbose, logWarn } from '../appLogger';
import {
  exitPictureInPicture,
  setPictureInPictureMuted,
  subscribePictureInPictureAction,
  subscribePictureInPictureMode,
} from '../callService';

/**
 * Manages the compact (Picture-in-Picture) view state for the call screen on
 * Android.  When the app goes to the background or becomes inactive while a
 * call is in progress, it switches to the compact view.
 *
 * Entering PiP itself is the activity's job, not this hook's: Android only
 * grants PiP to a *resumed* activity, so `MainActivity.onUserLeaveHint()` (and
 * Android 12+ auto-enter for the Back gesture) makes the request while the
 * activity still qualifies. Requesting it from the AppState `background`
 * transition, as this hook used to, is always too late and is refused.
 *
 * The authoritative PiP state comes from the activity itself
 * (`onPictureInPictureModeChanged`): AppState alone desyncs whenever the system
 * enters or leaves PiP on its own (Android 12+ auto-enter, the window's expand
 * button, or the user closing the window).
 *
 * The PiP window's own controls (mute / hang up) are drawn by the system, not
 * by React: a PiP window never delivers touches to the app's views, so any
 * in-window buttons this app rendered would be dead pixels. Taps on the system
 * controls arrive as native events and are forwarded to `onToggleMute` /
 * `onEndCall`.
 *
 * Extracted from the call hook so that PiP / display concerns stay isolated
 * from call-lifecycle logic.
 *
 * @param isInRoomRef - Ref that is `true`
 *   while a call is active.  Read inside the AppState listener so the handler
 *   always sees the current value without needing a re-registration.
 * @param options -
 *   `onPictureInPictureClosed` is invoked when the user closes the PiP window,
 *   so the call can be ended instead of continuing invisibly.
 *   `isMuted` keeps the PiP window's mute control labelled correctly, and
 *   `onToggleMute` / `onEndCall` handle taps on those controls.
 */
export default function useCompactCallView(isInRoomRef: React.MutableRefObject<boolean>, { onPictureInPictureClosed, onToggleMute, onEndCall, isMuted = false }: { onPictureInPictureClosed?: () => void; onToggleMute?: () => void; onEndCall?: () => void; isMuted?: boolean; } = {}): {
    isCompactView: boolean; setIsCompactView: (value: boolean) => void;
    exitCompactView: () => Promise<boolean>;
} {
  const [isCompactView, setIsCompactView] = useState(false);

  const onClosedRef = useRef(onPictureInPictureClosed);
  useEffect(() => {
    onClosedRef.current = onPictureInPictureClosed;
  }, [onPictureInPictureClosed]);

  const onToggleMuteRef = useRef(onToggleMute);
  const onEndCallRef = useRef(onEndCall);
  useEffect(() => {
    onToggleMuteRef.current = onToggleMute;
    onEndCallRef.current = onEndCall;
  }, [onEndCall, onToggleMute]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', nextState => {
      const shouldUseCompactView =
        isInRoomRef.current && (nextState === 'background' || nextState === 'inactive');
      setIsCompactView(shouldUseCompactView);

      if (shouldUseCompactView) {
        // PiP is *not* requested here: by the time AppState reports
        // `background` the activity has already left the resumed state, and
        // Android answers `enterPictureInPictureMode()` with
        // "Activity must be resumed to enter picture-in-picture". The request
        // is made natively from `MainActivity.onUserLeaveHint()` — which fires
        // while the activity is still resumed — and by Android 12+ auto-enter
        // for the Back gesture. This listener only tracks the resulting view
        // state; the authoritative one arrives via
        // `subscribePictureInPictureMode`.
        logVerbose('App backgrounded during call; Picture-in-Picture is entered by the activity', {
          nextState,
        });
      }
    });

    return () => subscription.remove();
  }, [isInRoomRef]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    return subscribePictureInPictureMode(({ isInPictureInPictureMode, dismissed }) => {
      logInfo('Picture-in-Picture mode changed', { isInPictureInPictureMode, dismissed });
      setIsCompactView(isInPictureInPictureMode);
      if (dismissed && isInRoomRef.current) {
        logInfo('Picture-in-Picture window closed; ending the call');
        onClosedRef.current?.();
      }
    });
  }, [isInRoomRef]);

  // Keep the PiP window's mute control in step with the real track state, so a
  // mute made from the full-screen deck (or from the window itself) is
  // reflected the next time the window is drawn.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    setPictureInPictureMuted(isMuted);
  }, [isMuted]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    return subscribePictureInPictureAction(control => {
      if (!isInRoomRef.current) {
        // The system kept the window's controls alive past the end of the
        // call; nothing to act on, but it is a mismatch worth seeing.
        logWarn('Ignoring Picture-in-Picture control with no call in progress', { control });
        return;
      }
      logInfo('Picture-in-Picture control tapped', { control });
      if (control === 'mute') {
        onToggleMuteRef.current?.();
      } else {
        onEndCallRef.current?.();
      }
    });
  }, [isInRoomRef]);

  /** Leave PiP (e.g. on call teardown) and drop back to the full-screen view. */
  const exitCompactView = useCallback(async () => {
    setIsCompactView(false);
    if (Platform.OS !== 'android') {
      return false;
    }
    return exitPictureInPicture();
  }, []);

  return { isCompactView, setIsCompactView, exitCompactView };
}
