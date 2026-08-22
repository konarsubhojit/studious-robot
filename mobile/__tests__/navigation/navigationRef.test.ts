// @ts-check
jest.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    isReady: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    canGoBack: jest.fn(),
    reset: jest.fn(),
  }),
}));

import {
  closeChatConversation,
  openPeerProfile,
  openSearch,
  flushPendingNavigation,
  navigationRef,
  openChatConversation,
  openTab,
  resetNavigation,
  resetPendingNavigation,
} from '../../src/navigation/navigationRef';
import { CHAT_SCREENS, DEFAULT_TAB, TABS } from '../../src/navigation/routes';

describe('navigationRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPendingNavigation();
  });

  test('openChatConversation navigates into the Chats stack when ready', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openChatConversation('user-bob');
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId: 'user-bob', messageId: null },
    });
  });

  test('openChatConversation carries the message to deep-link to', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openChatConversation('user-bob', { messageId: 'msg-1' });
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId: 'user-bob', messageId: 'msg-1' },
    });
  });

  test('openSearch navigates to the search screen in the Chats stack', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openSearch();
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.SEARCH,
    });
  });

  test('openPeerProfile navigates to the profile screen, ignoring an empty id', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openPeerProfile('user-bob');
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.PROFILE,
      params: { peerId: 'user-bob' },
    });

    /** @type {jest.Mock} */ (navigationRef.navigate).mockClear();
    openPeerProfile('');
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  test('ignores an empty peer id', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openChatConversation(null);
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  test('queues navigation requested before the container is ready and replays it', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(false);
    openChatConversation('user-bob');
    expect(navigationRef.navigate).not.toHaveBeenCalled();

    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId: 'user-bob', messageId: null },
    });

    // Replayed only once.
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledTimes(1);
  });

  test('keeps only the most recent queued destination', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(false);
    openChatConversation('user-bob');
    openTab(TABS.SETTINGS);

    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledTimes(1);
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.SETTINGS);
  });

  test('openTab navigates to the tab', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    openTab(TABS.CALLS);
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CALLS);
  });

  test('resetNavigation drops every route back to the default tab', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    resetNavigation();
    expect(navigationRef.reset).toHaveBeenCalledWith({
      index: 0,
      routes: [{ name: DEFAULT_TAB }],
    });
  });

  test('resetNavigation discards a queued destination', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(false);
    openChatConversation('user-bob');
    resetNavigation();

    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    flushPendingNavigation();
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  test('closeChatConversation navigates to the chat list when ready', () => {
    /** @type {jest.Mock} */ (navigationRef.isReady).mockReturnValue(true);
    closeChatConversation();
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.LIST,
    });
  });
});
