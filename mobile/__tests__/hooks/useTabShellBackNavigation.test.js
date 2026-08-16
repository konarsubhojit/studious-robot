import React from 'react';
import { BackHandler, Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useTabShellBackNavigation from '../../src/hooks/useTabShellBackNavigation';

function TestHook({ resultRef, props }) {
  useTabShellBackNavigation(props);
  resultRef.current = true;
  return null;
}

function setup(props) {
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} props={props} />);
  });
  return { resultRef, tree };
}

describe('useTabShellBackNavigation', () => {
  const originalPlatformOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatformOS;
    jest.restoreAllMocks();
  });

  test('registers a hardware back handler on Android when enabled', () => {
    Platform.OS = 'android';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup({
      enabled: true,
      chatPeerId: null,
      onCloseChat: jest.fn(),
      activeTab: 'chats',
      defaultTab: 'chats',
      onNavigateToDefaultTab: jest.fn(),
    });
    expect(addListenerSpy).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
  });

  test('does not register a back handler on iOS', () => {
    Platform.OS = 'ios';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup({
      enabled: true,
      chatPeerId: null,
      onCloseChat: jest.fn(),
      activeTab: 'chats',
      defaultTab: 'chats',
      onNavigateToDefaultTab: jest.fn(),
    });
    expect(addListenerSpy).not.toHaveBeenCalled();
  });

  test('does not register a back handler when disabled (e.g. a full-screen call is showing)', () => {
    Platform.OS = 'android';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup({
      enabled: false,
      chatPeerId: null,
      onCloseChat: jest.fn(),
      activeTab: 'chats',
      defaultTab: 'chats',
      onNavigateToDefaultTab: jest.fn(),
    });
    expect(addListenerSpy).not.toHaveBeenCalled();
  });

  function pressBack(props) {
    Platform.OS = 'android';
    let handler;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, cb) => {
      handler = cb;
      return { remove: jest.fn() };
    });
    setup(props);
    let handled;
    act(() => {
      handled = handler();
    });
    return handled;
  }

  test('pressing back closes an open chat conversation instead of exiting the app', () => {
    const onCloseChat = jest.fn();
    const onNavigateToDefaultTab = jest.fn();
    const handled = pressBack({
      enabled: true,
      chatPeerId: 'user-bob',
      onCloseChat,
      activeTab: 'chats',
      defaultTab: 'chats',
      onNavigateToDefaultTab,
    });

    expect(handled).toBe(true);
    expect(onCloseChat).toHaveBeenCalledTimes(1);
    expect(onNavigateToDefaultTab).not.toHaveBeenCalled();
  });

  test('pressing back on a non-default tab returns to the default tab instead of exiting the app', () => {
    const onCloseChat = jest.fn();
    const onNavigateToDefaultTab = jest.fn();
    const handled = pressBack({
      enabled: true,
      chatPeerId: null,
      onCloseChat,
      activeTab: 'settings',
      defaultTab: 'chats',
      onNavigateToDefaultTab,
    });

    expect(handled).toBe(true);
    expect(onCloseChat).not.toHaveBeenCalled();
    expect(onNavigateToDefaultTab).toHaveBeenCalledWith('chats');
  });

  test('pressing back at the root of the tab shell defers to the OS default (app exit)', () => {
    const onCloseChat = jest.fn();
    const onNavigateToDefaultTab = jest.fn();
    const handled = pressBack({
      enabled: true,
      chatPeerId: null,
      onCloseChat,
      activeTab: 'chats',
      defaultTab: 'chats',
      onNavigateToDefaultTab,
    });

    expect(handled).toBe(false);
    expect(onCloseChat).not.toHaveBeenCalled();
    expect(onNavigateToDefaultTab).not.toHaveBeenCalled();
  });
});
