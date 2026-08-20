// @ts-check
/**
 * Route names for the app shell navigators.
 *
 * The tab route names deliberately match the keys `AppTabBar` already uses
 * (`chats` / `calls` / `settings`) so the existing tab bar can be plugged into
 * the bottom-tab navigator as a custom `tabBar` without any name mapping.
 */
export const TABS = {
  CHATS: 'chats',
  CALLS: 'calls',
  SETTINGS: 'settings',
};

/** Screens of the native stack nested inside the Chats tab. */
export const CHAT_SCREENS = {
  LIST: 'chatList',
  CONVERSATION: 'chatConversation',
  /** Full-screen unified search (contacts, conversations, messages, calls). */
  SEARCH: 'search',
  /** Per-contact screen: presence, call actions, block/mute. */
  PROFILE: 'peerProfile',
};

/** Tab shown first, and the one Android back returns to from another tab. */
export const DEFAULT_TAB = TABS.CHATS;

/**
 * One entry of a React Navigation state's `routes`, narrowed to the fields
 * this module reads (a nested navigator carries its own `state`).
 *
 * @typedef {{
 *   name?: string,
 *   params?: { peerId?: string },
 *   state?: { index?: number, routes?: NavigationRoute[] },
 * }} NavigationRoute
 */

/**
 * Extract the parts of the navigation state the composition root still needs:
 * which tab is selected and, when a conversation is open, its peer id.
 *
 * @param {{ index?: number, routes?: NavigationRoute[] } | undefined} state
 *   navigation state of the tab navigator.
 * @returns {{ activeTab: string, chatPeerId: string | null }}
 */
export function deriveShellRoute(state) {
  const routes = state?.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    return { activeTab: DEFAULT_TAB, chatPeerId: null };
  }
  const tabRoute = routes[state?.index ?? 0];
  if (!tabRoute?.name) {
    return { activeTab: DEFAULT_TAB, chatPeerId: null };
  }
  if (tabRoute.name !== TABS.CHATS) {
    return { activeTab: tabRoute.name, chatPeerId: null };
  }

  const chatRoutes = tabRoute.state?.routes;
  const chatRoute = Array.isArray(chatRoutes)
    ? chatRoutes[tabRoute.state?.index ?? chatRoutes.length - 1]
    : null;
  const peerId =
    chatRoute?.name === CHAT_SCREENS.CONVERSATION ? chatRoute?.params?.peerId : null;
  return { activeTab: TABS.CHATS, chatPeerId: peerId || null };
}
