jest.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({
    isReady: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    canGoBack: jest.fn(),
  }),
}));

import {
  closeChatConversation,
  flushPendingNavigation,
  navigationRef,
  openChatConversation,
  openTab,
  resetPendingNavigation,
} from '../../src/navigation/navigationRef';
import { CHAT_SCREENS, TABS } from '../../src/navigation/routes';

describe('navigationRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPendingNavigation();
  });

  test('openChatConversation navigates into the Chats stack when ready', () => {
    navigationRef.isReady.mockReturnValue(true);
    openChatConversation('user-bob');
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId: 'user-bob' },
    });
  });

  test('ignores an empty peer id', () => {
    navigationRef.isReady.mockReturnValue(true);
    openChatConversation(null);
    expect(navigationRef.navigate).not.toHaveBeenCalled();
  });

  test('queues navigation requested before the container is ready and replays it', () => {
    navigationRef.isReady.mockReturnValue(false);
    openChatConversation('user-bob');
    expect(navigationRef.navigate).not.toHaveBeenCalled();

    navigationRef.isReady.mockReturnValue(true);
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CHATS, {
      screen: CHAT_SCREENS.CONVERSATION,
      params: { peerId: 'user-bob' },
    });

    // Replayed only once.
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledTimes(1);
  });

  test('keeps only the most recent queued destination', () => {
    navigationRef.isReady.mockReturnValue(false);
    openChatConversation('user-bob');
    openTab(TABS.SETTINGS);

    navigationRef.isReady.mockReturnValue(true);
    flushPendingNavigation();
    expect(navigationRef.navigate).toHaveBeenCalledTimes(1);
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.SETTINGS);
  });

  test('openTab navigates to the tab', () => {
    navigationRef.isReady.mockReturnValue(true);
    openTab(TABS.CALLS);
    expect(navigationRef.navigate).toHaveBeenCalledWith(TABS.CALLS);
  });

  test('closeChatConversation pops the stack only when there is something to pop', () => {
    navigationRef.isReady.mockReturnValue(true);
    navigationRef.canGoBack.mockReturnValue(false);
    closeChatConversation();
    expect(navigationRef.goBack).not.toHaveBeenCalled();

    navigationRef.canGoBack.mockReturnValue(true);
    closeChatConversation();
    expect(navigationRef.goBack).toHaveBeenCalledTimes(1);
  });
});
