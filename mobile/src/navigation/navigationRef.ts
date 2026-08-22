import { createNavigationContainerRef } from '@react-navigation/native';
import { CHAT_SCREENS, DEFAULT_TAB, TABS } from './routes';

/**
 * Container ref for the app shell navigator.
 *
 * Lets non-component code (deep-link handling, the composition root's own
 * callbacks) drive navigation without prop-drilling a `navigation` object.
 */
export const navigationRef = createNavigationContainerRef();

/**
 * The app shell does not declare a static param list, so React Navigation types
 * `navigate`/`reset` arguments as `never`. This structurally-typed view keeps
 * the call sites below checkable without inventing a param-list declaration.
 */
const nav: {
    navigate: (screen: string, params?: object) => void;
    reset: (state: { index: number; routes: { name: string; }[]; }) => void;
} = (navigationRef as any);

/**
 * Navigation requested before the container was ready (or while a full-screen
 * call has temporarily unmounted it). Replayed by `flushPendingNavigation`,
 * which `NavigationContainer.onReady` calls, so a notification tap that cold-
 * starts the app is never dropped. Only the most recent request is kept: an
 * older pending destination is always superseded by a newer one.
 */
let pendingNavigation: (() => void) | null = null;

/** @param action */
function runWhenReady(action: () => void) {
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
 * @param options `messageId` deep-links to a
 *   specific message (a search result), which the conversation screen scrolls
 *   to and highlights.
 */
export function openChatConversation(peerId: string | null | undefined, { messageId }: { messageId?: string | null; } = {}) {
  if (!peerId) return;
  runWhenReady(() =>
    nav.navigate(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId, messageId: messageId ?? null },
    }),
  );
}

/**
 * Open the unified search screen.  It lives in the Chats tab's stack, so
 * opening it from the Calls tab switches tabs first — search spans both.
 */
export function openSearch() {
  runWhenReady(() => nav.navigate(TABS.CHATS, { screen: CHAT_SCREENS.SEARCH }));
}

/**
 * Open the profile screen for `peerId`.
 */
export function openPeerProfile(peerId: string | null | undefined) {
  if (!peerId) return;
  runWhenReady(() =>
    nav.navigate(TABS.CHATS, {
      screen: CHAT_SCREENS.PROFILE,
      params: { peerId },
    }),
  );
}

/** Pop the current screen, if anything is stacked above the tab's root. */
export function goBack() {
  if (navigationRef.isReady() && navigationRef.canGoBack()) {
    navigationRef.goBack();
  }
}

/**
 * Select a bottom tab.
 */
export function openTab(tab: 'chats' | 'calls' | 'settings') {
  runWhenReady(() => nav.navigate(tab));
}

/**
 * Drop every route and return to the default tab's root — used on sign-out so
 * the next session (and anything persisted right after) can't carry the
 * previous user's open conversation.
 */
export function resetNavigation() {
  resetPendingNavigation();
  if (navigationRef.isReady()) {
    nav.reset({ index: 0, routes: [{ name: DEFAULT_TAB }] });
  }
}

/** Pop the open conversation back to the chat list, if one is open. */
export function closeChatConversation() {
  if (navigationRef.isReady()) {
    nav.navigate(TABS.CHATS, { screen: CHAT_SCREENS.LIST });
  }
}
