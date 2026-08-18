import { getStateFromPath } from '@react-navigation/native';
import linking, { PREFIXES } from '../../src/navigation/linking';
import { CHAT_SCREENS, TABS } from '../../src/navigation/routes';

/** Resolve the leaf route a URL path maps to, mirroring what the container does. */
function resolveLeafRoute(path) {
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

  test('ignores a URL that matches no screen', () => {
    expect(getStateFromPath('/nothing-here', linking.config)).toBeUndefined();
  });
});
