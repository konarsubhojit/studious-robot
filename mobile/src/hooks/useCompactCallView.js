import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { logInfo } from '../appLogger';
import {
  enterPictureInPicture,
  exitPictureInPicture,
  subscribePictureInPictureMode,
} from '../callService';

/**
 * Manages the compact (Picture-in-Picture) view state for the call screen on
 * Android.  When the app goes to the background or becomes inactive while a
 * call is in progress, it enters compact view and requests native PiP.
 *
 * The authoritative PiP state comes from the activity itself
 * (`onPictureInPictureModeChanged`): AppState alone desyncs whenever the system
 * enters or leaves PiP on its own (Android 12+ auto-enter, the window's expand
 * button, or the user closing the window).
 *
 * Extracted from `useWebRTCCall` so that PiP / display concerns stay isolated
 * from call-lifecycle logic.
 *
 * @param {React.MutableRefObject<boolean>} isInRoomRef - Ref that is `true`
 *   while a call is active.  Read inside the AppState listener so the handler
 *   always sees the current value without needing a re-registration.
 * @param {{ onPictureInPictureClosed?: () => void }} [options] -
 *   `onPictureInPictureClosed` is invoked when the user closes the PiP window,
 *   so the call can be ended instead of continuing invisibly.
 * @returns {{ isCompactView: boolean, setIsCompactView: (value: boolean) => void,
 *   exitCompactView: () => Promise<boolean> }}
 */
export default function useCompactCallView(isInRoomRef, { onPictureInPictureClosed } = {}) {
  const [isCompactView, setIsCompactView] = useState(false);

  const onClosedRef = useRef(onPictureInPictureClosed);
  useEffect(() => {
    onClosedRef.current = onPictureInPictureClosed;
  }, [onPictureInPictureClosed]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', nextState => {
      const shouldUseCompactView =
        isInRoomRef.current && (nextState === 'background' || nextState === 'inactive');
      setIsCompactView(shouldUseCompactView);

      if (shouldUseCompactView) {
        logInfo('App backgrounded during call; requesting Picture-in-Picture', { nextState });
        enterPictureInPicture();
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
