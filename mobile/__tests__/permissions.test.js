const mockCheck = jest.fn();
const mockRequestMultiple = jest.fn();

jest.mock('react-native', () => ({
  PermissionsAndroid: {
    check: (...args) => mockCheck(...args),
    requestMultiple: (...args) => mockRequestMultiple(...args),
    PERMISSIONS: {
      CAMERA: 'android.permission.CAMERA',
      RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      READ_CALL_LOG: 'android.permission.READ_CALL_LOG',
    },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
  },
  Platform: {
    OS: 'android',
    Version: 31,
  },
}));

import { Platform } from 'react-native';
import {
  ensureBluetoothPermission,
  ensureCallPermissions,
  getCallRuntimePermissions,
  requiresBluetoothConnectPermission,
} from '../src/permissions';

describe('permissions helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    Platform.Version = 31;
  });

  test('returns the expected Android runtime permission list', () => {
    expect(getCallRuntimePermissions()).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.READ_CALL_LOG',
    ]);
  });

  test('skips Android runtime prompts on non-Android platforms', async () => {
    Platform.OS = 'ios';

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage: null,
      deniedPermissions: [],
    });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockRequestMultiple).not.toHaveBeenCalled();
  });

  test('requests camera, microphone, Bluetooth and call-log permissions when missing', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'granted',
      'android.permission.RECORD_AUDIO': 'granted',
      'android.permission.BLUETOOTH_CONNECT': 'granted',
      'android.permission.READ_CALL_LOG': 'granted',
    });

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage: null,
      deniedPermissions: [],
    });
    expect(mockRequestMultiple).toHaveBeenCalledWith([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.READ_CALL_LOG',
    ]);
  });

  test('fails gracefully when a required media permission is denied', async () => {
    mockCheck
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'denied',
      'android.permission.RECORD_AUDIO': 'granted',
    });

    await expect(ensureCallPermissions()).resolves.toMatchObject({
      ok: false,
      message: 'Camera permission is required to start a call',
      deniedPermissions: ['android.permission.CAMERA'],
    });
  });

  test('warns but does not block the call when Bluetooth permission is denied', async () => {
    mockCheck
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.BLUETOOTH_CONNECT': 'denied',
    });

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
      deniedPermissions: ['android.permission.BLUETOOTH_CONNECT'],
    });
  });

  test('warns but does not block the call when call-log permission is denied', async () => {
    mockCheck
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.READ_CALL_LOG': 'denied',
    });

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage: 'Call log permission denied. Calls will still ring normally.',
      deniedPermissions: ['android.permission.READ_CALL_LOG'],
    });
  });

  test('does not require Bluetooth runtime permission before Android 12', () => {
    Platform.Version = 30;
    expect(requiresBluetoothConnectPermission()).toBe(false);
  });

  test('requests Bluetooth permission on demand for route changes', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.BLUETOOTH_CONNECT': 'granted',
    });

    await expect(ensureBluetoothPermission({ requestIfNeeded: true })).resolves.toEqual({
      ok: true,
      granted: true,
      requested: true,
    });
  });

  test('returns a non-throwing error result when Bluetooth routing stays denied', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.BLUETOOTH_CONNECT': 'never_ask_again',
    });

    await expect(ensureBluetoothPermission({ requestIfNeeded: true })).resolves.toEqual({
      ok: false,
      granted: false,
      requested: true,
      message: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
    });
  });
});
