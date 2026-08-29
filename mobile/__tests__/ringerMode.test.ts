import { NativeModules, Platform } from 'react-native';
import {
  getRingerMode,
  RINGER_MODES,
  shouldRingAudibly,
  shouldVibrateForRing,
} from '../src/ringerMode';

const originalPlatform = Platform.OS;

function setNativeModule(module: any) {
  if (module === null) {
    delete NativeModules.IncomingCallNotification;
  } else {
    NativeModules.IncomingCallNotification = module;
  }
}

describe('ringerMode', () => {
  afterEach(() => {
    Platform.OS = originalPlatform;
    setNativeModule(null);
    jest.clearAllMocks();
  });

  test('reads the ringer mode from the native module on Android', async () => {
    Platform.OS = 'android';
    setNativeModule({ getRingerMode: jest.fn().mockResolvedValue(RINGER_MODES.VIBRATE) });

    await expect(getRingerMode()).resolves.toBe(RINGER_MODES.VIBRATE);
  });

  test('is unknown on platforms that do not expose the ringer mode', async () => {
    Platform.OS = 'ios';
    setNativeModule({ getRingerMode: jest.fn().mockResolvedValue(RINGER_MODES.SILENT) });

    await expect(getRingerMode()).resolves.toBeNull();
  });

  test('is unknown when the native module is missing or reports nonsense', async () => {
    Platform.OS = 'android';
    setNativeModule(null);
    await expect(getRingerMode()).resolves.toBeNull();

    setNativeModule({ getRingerMode: jest.fn().mockResolvedValue('loud') });
    await expect(getRingerMode()).resolves.toBeNull();
  });

  test('is unknown when the native call rejects', async () => {
    Platform.OS = 'android';
    setNativeModule({ getRingerMode: jest.fn().mockRejectedValue(new Error('boom')) });

    await expect(getRingerMode()).resolves.toBeNull();
  });

  test('silent suppresses both the ringtone and the haptic', async () => {
    Platform.OS = 'android';
    setNativeModule({ getRingerMode: jest.fn().mockResolvedValue(RINGER_MODES.SILENT) });

    await expect(shouldRingAudibly()).resolves.toBe(false);
    await expect(shouldVibrateForRing()).resolves.toBe(false);
  });

  test('vibrate suppresses the ringtone but still buzzes', async () => {
    Platform.OS = 'android';
    setNativeModule({ getRingerMode: jest.fn().mockResolvedValue(RINGER_MODES.VIBRATE) });

    await expect(shouldRingAudibly()).resolves.toBe(false);
    await expect(shouldVibrateForRing()).resolves.toBe(true);
  });

  test('an unknown mode rings, so a missing module never silences calls', async () => {
    Platform.OS = 'android';
    setNativeModule(null);

    await expect(shouldRingAudibly()).resolves.toBe(true);
    await expect(shouldVibrateForRing()).resolves.toBe(true);
  });
});
