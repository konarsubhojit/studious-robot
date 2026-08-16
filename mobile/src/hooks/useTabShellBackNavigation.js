import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

/**
 * Makes the Android hardware back button navigate *within* the hand-rolled
 * tab shell instead of always falling through to the OS default (which
 * closes/backgrounds the whole app), mirroring what a real back stack would
 * do: close an open chat conversation back to the chat list, or return to
 * the Chats tab from another tab, before finally letting the OS handle back
 * (exit) once already at that root view.
 *
 * Only registers the listener while the tab shell itself is on screen
 * (`enabled`); a full-screen call takes over back-handling itself (see
 * `useCallMinimize`) and this hook stays out of its way.
 *
 * @param {{
 *   enabled: boolean,
 *   chatPeerId: string | null,
 *   onCloseChat: () => void,
 *   activeTab: string,
 *   defaultTab: string,
 *   onNavigateToDefaultTab: (tab: string) => void,
 * }} params
 */
export default function useTabShellBackNavigation({
  enabled,
  chatPeerId,
  onCloseChat,
  activeTab,
  defaultTab,
  onNavigateToDefaultTab,
}) {
  useEffect(() => {
    if (Platform.OS !== 'android' || !enabled) return undefined;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (chatPeerId) {
        onCloseChat();
        return true;
      }
      if (activeTab !== defaultTab) {
        onNavigateToDefaultTab(defaultTab);
        return true;
      }
      // Already at the root of the tab shell: let the OS handle back as usual.
      return false;
    });

    return () => subscription.remove();
  }, [enabled, chatPeerId, onCloseChat, activeTab, defaultTab, onNavigateToDefaultTab]);
}
