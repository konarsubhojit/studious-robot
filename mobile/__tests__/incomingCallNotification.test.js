// @ts-check
import { NativeModules, Platform } from 'react-native';
import {
  consumePendingCallAction,
  dismissIncomingCallNotification,
  isCallConnectionLive,
  isIncomingCallNotificationAvailable,
  showIncomingCallNotification,
} from '../src/incomingCallNotification';
import { startIncomingRingtone } from '../src/ringtone';

jest.mock('../src/ringtone', () => ({
  startIncomingRingtone: jest.fn(),
}));

const originalPlatform = Platform.OS;

function setNativeModule(/** @type {any} */ module) {
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

  // ── Channel settings are immutable once created ───────────────────────────
  //
  // An install carrying an older, quieter channel (e.g. one created at default
  // importance by an earlier build) posts this notification *silently*: the
  // sound/importance configured here are ignored forever. The native side
  // reports the channel's effective settings so JS can ring instead of
  // assuming the channel will.

  test.each([
    ['importance below IMPORTANCE_HIGH', { shown: true, channelImportance: 3, channelHasSound: true }],
    ['no channel sound', { shown: true, channelImportance: 4, channelHasSound: false }],
  ])('starts the in-app ringtone fallback when the channel will not ring (%s)', async (_label, result) => {
    Platform.OS = 'android';
    setNativeModule({ show: jest.fn().mockResolvedValue(result), dismiss: jest.fn() });

    await expect(showIncomingCallNotification({ callId: 'call-quiet' })).resolves.toBe(true);
    expect(startIncomingRingtone).toHaveBeenCalled();
  });

  test('does not start the fallback when the channel rings on its own', async () => {
    Platform.OS = 'android';
    setNativeModule({
      show: jest.fn().mockResolvedValue({
        shown: true,
        channelImportance: 5,
        channelHasSound: true,
        connectionLive: true,
      }),
      dismiss: jest.fn(),
    });

    await expect(showIncomingCallNotification({ callId: 'call-loud' })).resolves.toBe(true);
    expect(startIncomingRingtone).not.toHaveBeenCalled();
  });

  // ── Persisted Accept / Decline taps (cold start) ──────────────────────────

  test('consumePendingCallAction returns the persisted action', async () => {
    Platform.OS = 'android';
    const pending = { callId: 'call-8', action: 'accept', ageMs: 500, connectionLive: false };
    setNativeModule({
      show: jest.fn(),
      dismiss: jest.fn(),
      consumePendingCallAction: jest.fn().mockResolvedValue(pending),
    });

    await expect(consumePendingCallAction()).resolves.toEqual(pending);
  });

  test('consumePendingCallAction resolves null when nothing is pending or the module is absent', async () => {
    Platform.OS = 'android';
    setNativeModule({
      show: jest.fn(),
      dismiss: jest.fn(),
      consumePendingCallAction: jest.fn().mockResolvedValue(null),
    });
    await expect(consumePendingCallAction()).resolves.toBeNull();

    setNativeModule(null);
    await expect(consumePendingCallAction()).resolves.toBeNull();
  });

  test('consumePendingCallAction swallows native errors', async () => {
    Platform.OS = 'android';
    setNativeModule({
      show: jest.fn(),
      dismiss: jest.fn(),
      consumePendingCallAction: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(consumePendingCallAction()).resolves.toBeNull();
  });

  test('isCallConnectionLive reports whether Telecom still holds the connection', async () => {
    Platform.OS = 'android';
    setNativeModule({
      show: jest.fn(),
      dismiss: jest.fn(),
      isCallConnectionLive: jest.fn().mockResolvedValue(true),
    });
    await expect(isCallConnectionLive('call-9')).resolves.toBe(true);

    setNativeModule(null);
    await expect(isCallConnectionLive('call-9')).resolves.toBeNull();
  });
});
