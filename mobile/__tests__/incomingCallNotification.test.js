import { NativeModules, Platform } from 'react-native';
import {
  dismissIncomingCallNotification,
  isIncomingCallNotificationAvailable,
  showIncomingCallNotification,
} from '../src/incomingCallNotification';

const originalPlatform = Platform.OS;

function setNativeModule(module) {
  if (module === null) {
    delete NativeModules.IncomingCallNotification;
  } else {
    NativeModules.IncomingCallNotification = module;
  }
}

describe('incomingCallNotification', () => {
  afterEach(() => {
    Platform.OS = originalPlatform;
    setNativeModule(null);
    jest.clearAllMocks();
  });

  test('reports unavailable when the native module is missing', () => {
    Platform.OS = 'android';
    setNativeModule(null);
    expect(isIncomingCallNotificationAvailable()).toBe(false);
  });

  test('is unavailable on non-Android platforms even when the module is present', () => {
    Platform.OS = 'ios';
    setNativeModule({ show: jest.fn(), dismiss: jest.fn() });
    expect(isIncomingCallNotificationAvailable()).toBe(false);
  });

  test('shows the notification with the caller identity on Android', async () => {
    Platform.OS = 'android';
    const show = jest.fn().mockResolvedValue(undefined);
    setNativeModule({ show, dismiss: jest.fn() });

    await expect(
      showIncomingCallNotification({ callId: 'call-1', callerId: 'alice', hasVideo: true }),
    ).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith('call-1', 'alice', true);
  });

  test('falls back to a default caller label when none is provided', async () => {
    Platform.OS = 'android';
    const show = jest.fn().mockResolvedValue(undefined);
    setNativeModule({ show, dismiss: jest.fn() });

    await showIncomingCallNotification({ callId: 'call-2' });
    expect(show).toHaveBeenCalledWith('call-2', 'Incoming call', true);
  });

  test('returns false without a callId', async () => {
    Platform.OS = 'android';
    const show = jest.fn();
    setNativeModule({ show, dismiss: jest.fn() });

    await expect(showIncomingCallNotification({})).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  test('returns false when the native module is unavailable', async () => {
    Platform.OS = 'android';
    setNativeModule(null);
    await expect(showIncomingCallNotification({ callId: 'call-3' })).resolves.toBe(false);
  });

  test('returns false (never throws) when the native show() call fails', async () => {
    Platform.OS = 'android';
    const show = jest.fn().mockRejectedValue(new Error('full-screen intent denied'));
    setNativeModule({ show, dismiss: jest.fn() });

    await expect(showIncomingCallNotification({ callId: 'call-4' })).resolves.toBe(false);
  });

  test('dismiss delegates to the native module', () => {
    Platform.OS = 'android';
    const dismiss = jest.fn();
    setNativeModule({ show: jest.fn(), dismiss });

    expect(dismissIncomingCallNotification('call-5')).toBe(true);
    expect(dismiss).toHaveBeenCalledWith('call-5');
  });

  test('dismiss is a safe no-op without a callId or native module', () => {
    Platform.OS = 'android';
    setNativeModule(null);
    expect(dismissIncomingCallNotification()).toBe(false);
    expect(dismissIncomingCallNotification('call-6')).toBe(false);
  });

  test('dismiss swallows native errors', () => {
    Platform.OS = 'android';
    const dismiss = jest.fn(() => {
      throw new Error('boom');
    });
    setNativeModule({ show: jest.fn(), dismiss });

    expect(dismissIncomingCallNotification('call-7')).toBe(false);
  });
});
