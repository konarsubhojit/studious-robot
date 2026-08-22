// @ts-check
import { CHAT_SCREENS, DEFAULT_TAB, deriveShellRoute, TABS } from '../../src/navigation/routes';

describe('deriveShellRoute', () => {
  test('falls back to the default tab for missing or empty state', () => {
    expect(deriveShellRoute(undefined)).toEqual({ activeTab: DEFAULT_TAB, chatPeerId: null });
    expect(deriveShellRoute({ routes: [] })).toEqual({ activeTab: DEFAULT_TAB, chatPeerId: null });
  });

  test('reports the selected tab', () => {
    const state = {
      index: 1,
      routes: [{ name: TABS.CHATS }, { name: TABS.CALLS }, { name: TABS.SETTINGS }],
    };
    expect(deriveShellRoute(state)).toEqual({ activeTab: TABS.CALLS, chatPeerId: null });
  });

  test('reports the peer of the conversation open in the Chats tab', () => {
    const state = {
      index: 0,
      routes: [
        {
          name: TABS.CHATS,
          state: {
            index: 1,
            routes: [
              { name: CHAT_SCREENS.LIST },
              { name: CHAT_SCREENS.CONVERSATION, params: { peerId: 'user-bob' } },
            ],
          },
        },
        { name: TABS.CALLS },
      ],
    };
    expect(deriveShellRoute(state)).toEqual({ activeTab: TABS.CHATS, chatPeerId: 'user-bob' });
  });

  test('reports no peer while the chat list is showing', () => {
    const state = {
      index: 0,
      routes: [
        { name: TABS.CHATS, state: { index: 0, routes: [{ name: CHAT_SCREENS.LIST }] } },
      ],
    };
    expect(deriveShellRoute(state)).toEqual({ activeTab: TABS.CHATS, chatPeerId: null });
  });

  test('falls back to the last chat route when the nested index is missing', () => {
    const state = {
      routes: [
        {
          name: TABS.CHATS,
          state: {
            routes: [
              { name: CHAT_SCREENS.LIST },
              { name: CHAT_SCREENS.CONVERSATION, params: { peerId: 'user-ann' } },
            ],
          },
        },
      ],
    };
    expect(deriveShellRoute(state)).toEqual({ activeTab: TABS.CHATS, chatPeerId: 'user-ann' });
  });
});
