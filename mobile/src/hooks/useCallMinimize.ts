import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Platform } from 'react-native';

/**
 * Owns whether an active, connected call has been shrunk down to the
 * `FloatingCallBubble` (vs. shown full-screen), including the Android
 * hardware back-button behaviour that minimizes a connected call instead of
 * letting the OS pop the screen / exit the app.
 *
 * Extracted out of `AppShell` so this concern is independently testable and
 * the component itself stays focused on screen routing / composition.
 *
 * @param isCallConnected true once the call flow has a connected
 *   (post-ringing) call; ringing/dialing screens are never minimizable.
 */
export default function useCallMinimize(isCallConnected: boolean): {
    isCallMinimized: boolean;
    setIsCallMinimized: (value: boolean) => void;
    isBubbleDismissed: boolean;
    dismissBubble: () => void;
} {
  // True once the user has explicitly (or automatically, via tab switch /
  // hardware back) shrunk an active call down to the FloatingCallBubble.
  const [isCallMinimized, setIsCallMinimized] = useState(false);

  // True once the user flung the floating bubble off-screen; the slim
  // `InCallBanner` stays, so the call is still one tap away.
  const [isBubbleDismissed, setIsBubbleDismissed] = useState(false);
  const dismissBubble = useCallback(() => setIsBubbleDismissed(true), []);

  // A dismissal only lasts for the current minimize: restoring the call
  // full-screen (or ending it) brings the bubble back next time.
  useEffect(() => {
    if (!isCallMinimized) {
      setIsBubbleDismissed(false);
    }
  }, [isCallMinimized]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    if (!isCallConnected || isCallMinimized) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setIsCallMinimized(true);
      return true;
    });
    return () => subscription.remove();
  }, [isCallConnected, isCallMinimized]);

  return { isCallMinimized, setIsCallMinimized, isBubbleDismissed, dismissBubble };
}
