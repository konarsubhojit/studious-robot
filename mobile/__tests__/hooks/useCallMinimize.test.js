import React from 'react';
import { BackHandler, Platform } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import useCallMinimize from '../../src/hooks/useCallMinimize';

function TestHook({ resultRef, isCallConnected }) {
  resultRef.current = useCallMinimize(isCallConnected);
  return null;
}

function setup(isCallConnected) {
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} isCallConnected={isCallConnected} />);
  });
  return { resultRef, tree };
}

describe('useCallMinimize', () => {
  const originalPlatformOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatformOS;
    jest.restoreAllMocks();
  });

  test('starts with isCallMinimized false', () => {
    const { resultRef } = setup(false);
    expect(resultRef.current.isCallMinimized).toBe(false);
  });

  test('setIsCallMinimized updates the state', () => {
    const { resultRef } = setup(true);
    act(() => {
      resultRef.current.setIsCallMinimized(true);
    });
    expect(resultRef.current.isCallMinimized).toBe(true);
  });

  test('registers a hardware back handler on Android when a call is connected and not minimized', () => {
    Platform.OS = 'android';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup(true);
    expect(addListenerSpy).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
  });

  test('pressing back minimizes a connected call on Android', () => {
    Platform.OS = 'android';
    let handler;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, cb) => {
      handler = cb;
      return { remove: jest.fn() };
    });

    const { resultRef } = setup(true);
    let handled;
    act(() => {
      handled = handler();
    });

    expect(handled).toBe(true);
    expect(resultRef.current.isCallMinimized).toBe(true);
  });

  test('does not register a back handler on iOS', () => {
    Platform.OS = 'ios';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup(true);
    expect(addListenerSpy).not.toHaveBeenCalled();
  });

  test('does not register a back handler when there is no connected call', () => {
    Platform.OS = 'android';
    const addListenerSpy = jest.spyOn(BackHandler, 'addEventListener');
    setup(false);
    expect(addListenerSpy).not.toHaveBeenCalled();
  });
});
