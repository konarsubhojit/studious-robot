import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Platform } from 'react-native';
import useCompactCallView from '../../src/hooks/useCompactCallView';

jest.mock('../../src/appLogger', () => ({ logInfo: jest.fn() }));
jest.mock('../../src/callService', () => ({
  enterPictureInPicture: jest.fn(),
  exitPictureInPicture: jest.fn(() => Promise.resolve(true)),
  setPictureInPictureMuted: jest.fn(),
  subscribePictureInPictureAction: jest.fn(() => jest.fn()),
  subscribePictureInPictureMode: jest.fn(() => jest.fn()),
}));

const {
  enterPictureInPicture,
  exitPictureInPicture,
  setPictureInPictureMuted,
  subscribePictureInPictureAction,
  subscribePictureInPictureMode,
} = require('../../src/callService');

const originalPlatformOS = Platform.OS;

/**
 * Renders the hook under test and exposes its latest return value via
 * `resultRef.current`.  Using a plain object ref avoids React overhead while
 * still giving access to the last render's result after each `act()` block.
 */
function TestHook({ isInRoomRef, resultRef, options }: any) {
  const result = useCompactCallView(isInRoomRef, options);
  resultRef.current = result;
  return null;
}

describe('useCompactCallView', () => {
  let capturedListener: any;
  let capturedPipListener: any;
  let capturedActionListener: any;
  let mockRemove: any;

  beforeEach(() => {
    capturedListener = null;
    capturedPipListener = null;
    capturedActionListener = null;
    mockRemove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      capturedListener = listener;
      return { remove: mockRemove };
    });
    jest.clearAllMocks();
    (subscribePictureInPictureMode as jest.Mock).mockImplementation(listener => {
      capturedPipListener = listener;
      return jest.fn();
    });
    (subscribePictureInPictureAction as jest.Mock).mockImplementation(listener => {
      capturedActionListener = listener;
      return jest.fn();
    });
    (exitPictureInPicture as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    Platform.OS = originalPlatformOS;
    jest.restoreAllMocks();
  });

  test('does not register an AppState listener on non-Android platforms', () => {
    Platform.OS = 'ios';
    const isInRoomRef = { current: false };
    const resultRef: { current: any; } = { current: null };

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
    const resultRef: { current: any; } = { current: null };

    let instance: any;
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
    const resultRef: { current: any; } = { current: null };

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
    const resultRef: { current: any; } = { current: null };

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
    const resultRef: { current: any; } = { current: null };

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
    const resultRef: { current: any; } = { current: null };

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
    const resultRef: { current: any; } = { current: null };

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

  test('mirrors the native Picture-in-Picture state instead of guessing from AppState', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedPipListener({ isInPictureInPictureMode: true, dismissed: false });
    });
    expect(resultRef.current.isCompactView).toBe(true);

    act(() => {
      capturedPipListener({ isInPictureInPictureMode: false, dismissed: false });
    });
    expect(resultRef.current.isCompactView).toBe(false);
  });

  test('ends the call when the user closes the Picture-in-Picture window', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };
    const onPictureInPictureClosed = jest.fn();

    act(() => {
      renderer.create(
        <TestHook
          isInRoomRef={isInRoomRef}
          resultRef={resultRef}
          options={{ onPictureInPictureClosed }}
        />,
      );
    });

    act(() => {
      capturedPipListener({ isInPictureInPictureMode: false, dismissed: true });
    });

    expect(onPictureInPictureClosed).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isCompactView).toBe(false);
  });

  test('does not end a call that is not running when the window is closed', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: false };
    const resultRef: { current: any; } = { current: null };
    const onPictureInPictureClosed = jest.fn();

    act(() => {
      renderer.create(
        <TestHook
          isInRoomRef={isInRoomRef}
          resultRef={resultRef}
          options={{ onPictureInPictureClosed }}
        />,
      );
    });

    act(() => {
      capturedPipListener({ isInPictureInPictureMode: false, dismissed: true });
    });

    expect(onPictureInPictureClosed).not.toHaveBeenCalled();
  });

  test('exitCompactView leaves native PiP and drops the compact flag', async () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };

    act(() => {
      renderer.create(<TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} />);
    });

    act(() => {
      capturedPipListener({ isInPictureInPictureMode: true, dismissed: false });
    });
    expect(resultRef.current.isCompactView).toBe(true);

    await act(async () => {
      await resultRef.current.exitCompactView();
    });

    expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isCompactView).toBe(false);
  });

  test('publishes the mute state so the window control is labelled correctly', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };

    let instance: any;
    act(() => {
      instance = renderer.create(
        <TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} options={{ isMuted: false }} />,
      );
    });
    expect(setPictureInPictureMuted).toHaveBeenLastCalledWith(false);

    act(() => {
      instance.update(
        <TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} options={{ isMuted: true }} />,
      );
    });
    expect(setPictureInPictureMuted).toHaveBeenLastCalledWith(true);
  });

  test('does not publish the mute state on non-Android platforms', () => {
    Platform.OS = 'ios';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };

    act(() => {
      renderer.create(
        <TestHook isInRoomRef={isInRoomRef} resultRef={resultRef} options={{ isMuted: true }} />,
      );
    });

    expect(setPictureInPictureMuted).not.toHaveBeenCalled();
    expect(subscribePictureInPictureAction).not.toHaveBeenCalled();
  });

  test('routes the window controls to the mute and hang-up handlers', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: true };
    const resultRef: { current: any; } = { current: null };
    const onToggleMute = jest.fn();
    const onEndCall = jest.fn();

    act(() => {
      renderer.create(
        <TestHook
          isInRoomRef={isInRoomRef}
          resultRef={resultRef}
          options={{ onToggleMute, onEndCall }}
        />,
      );
    });

    act(() => {
      capturedActionListener('mute');
      capturedActionListener('hangUp');
    });

    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  test('ignores window controls once the call is over', () => {
    Platform.OS = 'android';
    const isInRoomRef = { current: false };
    const resultRef: { current: any; } = { current: null };
    const onToggleMute = jest.fn();
    const onEndCall = jest.fn();

    act(() => {
      renderer.create(
        <TestHook
          isInRoomRef={isInRoomRef}
          resultRef={resultRef}
          options={{ onToggleMute, onEndCall }}
        />,
      );
    });

    act(() => {
      capturedActionListener('mute');
      capturedActionListener('hangUp');
    });

    expect(onToggleMute).not.toHaveBeenCalled();
    expect(onEndCall).not.toHaveBeenCalled();
  });
});
