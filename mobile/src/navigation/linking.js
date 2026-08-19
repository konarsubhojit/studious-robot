import { CHAT_SCREENS, TABS } from './routes';

/**
 * URL scheme the app's notifications deep-link with
 * (`wetalk://chat/{conversationId}`, `wetalk://call/{callId}` — see
 * `src/pushNotifications.js` and the Android manifest intent filters).
 */
export const PREFIXES = ['wetalk://'];

/**
 * React Navigation linking configuration for the app shell.
 *
 * Every screen has a stable path so navigation state can be serialised to (and
 * restored from) a URL, and so external links land on a real screen instead of
 * ad-hoc component state.
 *
 * Note that the chat-notification link (`wetalk://chat/{conversationId}`)
 * carries a *conversation* id, which only becomes a peer id once the identity
 * and conversation list are known — an asynchronous lookup a path parser can't
 * do. `useChatDeepLink` therefore resolves it and then navigates through
 * `openChatConversation` (the navigation container ref), so the deep link
 * still ends up driving the navigator rather than local state.
 */
const linking = {
  prefixes: PREFIXES,
  config: {
    screens: {
      [TABS.CHATS]: {
        path: 'chats',
        screens: {
          [CHAT_SCREENS.LIST]: '',
          [CHAT_SCREENS.CONVERSATION]: 'peer/:peerId',
        },
      },
      [TABS.CALLS]: 'calls',
      [TABS.SETTINGS]: 'settings',
    },
  },
};

export default linking;
