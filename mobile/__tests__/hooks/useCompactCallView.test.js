import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Platform } from 'react-native';
import useCompactCallView from '../../src/hooks/useCompactCallView';

jest.mock('../../src/appLogger', () => ({ logInfo: jest.fn() }));
jest.mock('../../src/callService', () => ({ enterPictureInPicture: jest.fn() }));

const { enterPictureInPicture } = require('../../src/callService');

const originalPlatformOS = Platform.OS;

/**
 * Renders the hook under test and exposes its latest return value via
 * `resultRef.current`.  Using a plain object ref avoids React overhead while
 * still giving access to the last render's result after each `act()` block.
 */
function TestHook({ isInRoomRef, resultRef }) {
  const result = useCompactCallView(isInRoomRef);
  resultRef.current = result;
  return null;
}

describe('useCompactCallView', () => {
  let capturedListener;
  let mockRemove;

  beforeEach(() => {
    capturedListener = null;
    mockRemove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      capturedListener = listener;
      return { remove: mockRemove };
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
    jest.restoreAllMocks();
  });

  test('does not register an AppState listener on non-Android platforms', () => {
    Platform.OS = 'ios';
    const isInRoomRef = { current: false };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(capturedListener).toBeNull();
    expect(resultRef.current.isCompactView).toBe(false);
  });

  test('registers and removes the AppState listener on Android', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: false };
    const resultRef = { current: null };

    let instance;
    act(() => {
      instance = renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    act(() => {
      instance.unmount();
    });

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  test('sets compact view true when backgrounded while in room', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedListener('background');
    });

    expect(resultRef.current.isCompactView).toBe(true);
    expect(enterPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test('sets compact view true when inactive while in room', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedListener('inactive');
    });

    expect(resultRef.current.isCompactView).toBe(true);
    expect(enterPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test('does not set compact view when backgrounded while not in room', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: false };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedListener('background');
    });

    expect(resultRef.current.isCompactView).toBe(false);
    expect(enterPictureInPicture).not.toHaveBeenCalled();
  });

  test('returns to non-compact view when app becomes active again', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedListener('background');
    });
    expect(resultRef.current.isCompactView).toBe(true);

    act(() => {
      capturedListener('active');
    });
    expect(resultRef.current.isCompactView).toBe(false);
  });

  test('exposes setIsCompactView to allow external reset (e.g. on leaveRoom)', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedListener('background');
    });
    expect(resultRef.current.isCompactView).toBe(true);

    act(() => {
      resultRef.current.setIsCompactView(false);
    });
    expect(resultRef.current.isCompactView).toBe(false);
  });
});
