import { createNavigationContainerRef } from '@react-navigation/native';
import { CHAT_SCREENS, TABS } from './routes';

/**
 * Container ref for the app shell navigator.
 *
 * Lets non-component code (deep-link handling, the composition root's own
 * callbacks) drive navigation without prop-drilling a `navigation` object.
 */
export const navigationRef = createNavigationContainerRef();

/**
 * Navigation requested before the container was ready (or while a full-screen
 * call has temporarily unmounted it). Replayed by `flushPendingNavigation`,
 * which `NavigationContainer.onReady` calls, so a notification tap that cold-
 * starts the app is never dropped. Only the most recent request is kept: an
 * older pending destination is always superseded by a newer one.
 */
let pendingNavigation = null;

function runWhenReady(action) {
  if (navigationRef.isReady()) {
    action();
    return;
  }
  pendingNavigation = action;
}

/** Replay a navigation requested before the container became ready. */
export function flushPendingNavigation() {
  const action = pendingNavigation;
  pendingNavigation = null;
  if (action && navigationRef.isReady()) action();
}

/** Forget any queued navigation (e.g. after signing out). */
export function resetPendingNavigation() {
  pendingNavigation = null;
}

/**
 * Open a conversation with `peerId` inside the Chats tab, switching to that
 * tab first if another one is selected.
 *
 * @param {string | null | undefined} peerId
 */
export function openChatConversation(peerId) {
  if (!peerId) return;
  runWhenReady(() =>
    navigationRef.navigate(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId },
    }),
  );
}

/**
 * Select a bottom tab.
 *
 * @param {'chats'|'calls'|'settings'} tab
 */
export function openTab(tab) {
  runWhenReady(() => navigationRef.navigate(tab));
}

/** Pop the open conversation back to the chat list, if one is open. */
export function closeChatConversation() {
  if (navigationRef.isReady() && navigationRef.canGoBack()) {
    navigationRef.goBack();
  }
}
