import { getStateFromPath } from '@react-navigation/native';
import linking, { PREFIXES } from '../../src/navigation/linking';
import { CHAT_SCREENS, TABS } from '../../src/navigation/routes';

/** Resolve the leaf route a URL path maps to, mirroring what the container does. */
function resolveLeafRoute(/** @type {any} */ path: any) {
  let state = getStateFromPath(path, linking.config);
  let route = state?.routes?.[state.routes.length - 1];
  while (route?.state) {
    state = route.state;
    route = state.routes[state.routes.length - 1];
  }
  return route;
}

describe('linking config', () => {
  test('declares the app deep-link scheme', () => {
    expect(PREFIXES).toContain('wetalk://');
    expect(linking.prefixes).toBe(PREFIXES);
  });

  test('maps each tab to a path', () => {
    expect(resolveLeafRoute('/calls')?.name).toBe(TABS.CALLS);
    expect(resolveLeafRoute('/settings')?.name).toBe(TABS.SETTINGS);
    expect(resolveLeafRoute('/chats')?.name).toBe(CHAT_SCREENS.LIST);
  });

  test('maps a conversation path to the chat conversation screen', () => {
    const route = resolveLeafRoute('/chats/peer/user-bob');
    expect(route?.name).toBe(CHAT_SCREENS.CONVERSATION);
    expect(route?.params).toEqual({ peerId: 'user-bob' });
  });

  test('maps the search and profile paths to their screens', () => {
    expect(resolveLeafRoute('/chats/search')?.name).toBe(CHAT_SCREENS.SEARCH);
    const profile = resolveLeafRoute('/chats/profile/user-bob');
    expect(profile?.name).toBe(CHAT_SCREENS.PROFILE);
    expect(profile?.params).toEqual({ peerId: 'user-bob' });
  });

  test('ignores a URL that matches no screen', () => {
    expect(getStateFromPath('/nothing-here', linking.config)).toBeUndefined();
  });

  test('leaves the notification chat link to useChatDeepLink to resolve', () => {
    // `wetalk://chat/{conversationId}` carries a conversation id, not a peer
    // id, so it deliberately matches no route: `useChatDeepLink` resolves the
    // peer first and then navigates.
    expect(getStateFromPath('/chat/alice:bob', linking.config)).toBeUndefined();
  });
});
