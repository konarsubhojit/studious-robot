// @ts-check
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logWarn: jest.fn(),
}));

import React from 'react';
import RNFS from 'react-native-fs';
import { BackHandler, Platform, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import AppNavigator from '../../src/navigation/AppNavigator';
import { openChatConversation } from '../../src/navigation/navigationRef';
import { TABS } from '../../src/navigation/routes';

function findByTestID(/** @type {any} */ tree, /** @type {any} */ testID) {
  return tree.root.findAll((/** @type {any} */ node) => node.props?.testID === testID)[0];
}

/** @type {any} */
let currentTree = null;
const originalPlatformOS = Platform.OS;

async function renderNavigator(overrides = {}) {
  const props = {
    renderChatList: () => <Text testID="screen-chat-list">Chats</Text>,
    renderChatConversation: (/** @type {any} */ peerId) => (
      <Text testID="screen-chat-conversation">{peerId}</Text>
    ),
    renderCalls: () => <Text testID="screen-calls">Calls</Text>,
    renderSettings: () => <Text testID="screen-settings">Settings</Text>,
    ...overrides,
  };
  await act(async () => {
    currentTree = renderer.create(<AppNavigator {...props} />);
  });
  return currentTree;
}

describe('AppNavigator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Unmount and drain the tab view's pending animation timers so none of
    // them fire after the test environment has been torn down.
    await act(async () => {
      currentTree?.unmount();
    });
    currentTree = null;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Platform.OS = originalPlatformOS;
  });

  test('starts on the chat list with the shared tab bar', async () => {
    const tree = await renderNavigator();
    expect(findByTestID(tree, 'screen-chat-list')).toBeDefined();
    expect(findByTestID(tree, 'app-tab-bar')).toBeDefined();
  });

  test('switching tabs reports the route and notifies the tab press', async () => {
    const onRouteChange = jest.fn();
    const onTabPress = jest.fn();
    const tree = await renderNavigator({ onRouteChange, onTabPress });

    await act(async () => {
      findByTestID(tree, 'app-tab-calls').props.onPress();
    });

    expect(onTabPress).toHaveBeenCalledWith(TABS.CALLS);
    expect(findByTestID(tree, 'screen-calls')).toBeDefined();
    expect(onRouteChange).toHaveBeenLastCalledWith({
      activeTab: TABS.CALLS,
      chatPeerId: null,
    });
  });

  test('persists the navigation state so the next launch can restore it', async () => {
    const tree = await renderNavigator();

    await act(async () => {
      findByTestID(tree, 'app-tab-settings').props.onPress();
    });

    const [path, contents] = /** @type {jest.Mock} */ (RNFS.writeFile).mock.calls[/** @type {jest.Mock} */ (RNFS.writeFile).mock.calls.length - 1];
    expect(path).toBe('/docs/wetalk-navigation-state.json');
    const saved = JSON.parse(contents);
    expect(saved.routes[saved.index].name).toBe(TABS.SETTINGS);
  });

  test('opening a conversation pushes it onto the chats stack and reports the peer', async () => {
    const onRouteChange = jest.fn();
    const tree = await renderNavigator({ onRouteChange });

    await act(async () => {
      openChatConversation('user-bob');
    });

    expect(findByTestID(tree, 'screen-chat-conversation').props.children).toBe('user-bob');
    expect(onRouteChange).toHaveBeenLastCalledWith({
      activeTab: TABS.CHATS,
      chatPeerId: 'user-bob',
    });
  });

  test('Android hardware back pops an open conversation to the chat list', async () => {
    Platform.OS = 'android';
    /** @type {any} */
    const handlers = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'hardwareBackPress') handlers.push(handler);
      return { remove: jest.fn() };
    });

    const tree = await renderNavigator();
    await act(async () => {
      openChatConversation('user-bob');
    });

    let handled;
    await act(async () => {
      handled = handlers.some((/** @type {any} */ handler) => handler());
    });

    expect(handled).toBe(true);
    expect(findByTestID(tree, 'screen-chat-list')).toBeDefined();
  });
});
