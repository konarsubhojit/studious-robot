import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { logInfo } from '../appLogger';
import { enterPictureInPicture } from '../callService';

/**
 * Manages the compact (Picture-in-Picture) view state for the call screen on
 * Android.  When the app goes to the background or becomes inactive while a
 * call is in progress, it enters compact view and requests native PiP.
 *
 * Extracted from `useWebRTCCall` so that PiP / display concerns stay isolated
 * from call-lifecycle logic.
 *
 * @param {React.MutableRefObject<boolean>} isInRoomRef - Ref that is `true`
 *   while a call is active.  Read inside the AppState listener so the handler
 *   always sees the current value without needing a re-registration.
 * @returns {{ isCompactView: boolean, setIsCompactView: (value: boolean) => void }}
 */
export default function useCompactCallView(isInRoomRef) {
  const [isCompactView, setIsCompactView] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const subscription = AppState.addEventListener('change', (nextState) => {
      const shouldUseCompactView =
        isInRoomRef.current && (nextState === 'background' || nextState === 'inactive');
      setIsCompactView(shouldUseCompactView);

      if (shouldUseCompactView) {
        logInfo('App backgrounded during call; requesting Picture-in-Picture', { nextState });
        enterPictureInPicture();
      }
    });

    return () => subscription.remove();
  }, []);

  return { isCompactView, setIsCompactView };
}
