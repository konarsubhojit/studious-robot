const mockCheck = jest.fn();
const mockRequestMultiple = jest.fn();

jest.mock('react-native', () => ({
  PermissionsAndroid: {
    check: (/** @type {any[]} */ ...args: any[]) => mockCheck(...args),
    requestMultiple: (/** @type {any[]} */ ...args: any[]) => mockRequestMultiple(...args),
    PERMISSIONS: {
      CAMERA: 'android.permission.CAMERA',
      RECORD_AUDIO: 'android.permission.RECORD_AUDIO',
      BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
      POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
      READ_MEDIA_IMAGES: 'android.permission.READ_MEDIA_IMAGES',
      READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
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
  ensureAttachmentPermission,
  ensureBluetoothPermission,
  ensureCallPermissions,
  getCallRuntimePermissions,
  getMissingCallPermissions,
  getPhotoLibraryPermission,
  requiresBluetoothConnectPermission,
  requiresPostNotificationsPermission,
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

  test('requests camera, microphone and Bluetooth permissions when missing', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'granted',
      'android.permission.RECORD_AUDIO': 'granted',
      'android.permission.BLUETOOTH_CONNECT': 'granted',
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
    ]);
  });

  test('fails gracefully when a required media permission is denied', async () => {
    mockCheck.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
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
    mockCheck.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.BLUETOOTH_CONNECT': 'denied',
    });

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage: 'Bluetooth permission denied. Call will stay on speaker or earpiece.',
      deniedPermissions: ['android.permission.BLUETOOTH_CONNECT'],
    });
  });

  test('does not require Bluetooth runtime permission before Android 12', () => {
    Platform.Version = 30;
    expect(requiresBluetoothConnectPermission()).toBe(false);
  });

  test('does not require the notifications runtime permission before Android 13', () => {
    Platform.Version = 32;
    expect(requiresPostNotificationsPermission()).toBe(false);
    expect(getCallRuntimePermissions()).not.toContain('android.permission.POST_NOTIFICATIONS');
  });

  test('requests notifications permission from Android 13 onward, alongside the rest', async () => {
    Platform.Version = 33;
    expect(requiresPostNotificationsPermission()).toBe(true);
    expect(getCallRuntimePermissions()).toEqual([
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.POST_NOTIFICATIONS',
    ]);

    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({
      'android.permission.CAMERA': 'granted',
      'android.permission.RECORD_AUDIO': 'granted',
      'android.permission.BLUETOOTH_CONNECT': 'granted',
      'android.permission.POST_NOTIFICATIONS': 'denied',
    });

    await expect(ensureCallPermissions()).resolves.toEqual({
      ok: true,
      warningMessage:
        'Notification permission denied. You may miss incoming call and message alerts — enable it from Settings to fix this.',
      deniedPermissions: ['android.permission.POST_NOTIFICATIONS'],
    });
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

  // ── Non-prompting check used by the answer path ──────────────────────────
  //
  // A push cold start has no foreground Activity, so a runtime prompt cannot be
  // shown; the answer path needs to know *which* permission is missing without
  // triggering one.

  test('getMissingCallPermissions reports camera and microphone without prompting', async () => {
    mockCheck.mockImplementation(async permission => permission !== 'android.permission.CAMERA');

    await expect(getMissingCallPermissions()).resolves.toEqual({
      camera: true,
      microphone: false,
      missing: ['android.permission.CAMERA'],
      message: expect.any(String),
    });
    expect(mockRequestMultiple).not.toHaveBeenCalled();
  });

  test('getMissingCallPermissions reports nothing missing when both are granted', async () => {
    mockCheck.mockResolvedValue(true);

    await expect(getMissingCallPermissions()).resolves.toEqual({
      camera: false,
      microphone: false,
      missing: [],
      message: null,
    });
  });

  test('getMissingCallPermissions is a no-op on non-Android platforms', async () => {
    Platform.OS = 'ios';

    await expect(getMissingCallPermissions()).resolves.toEqual({
      camera: false,
      microphone: false,
      missing: [],
      message: null,
    });
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe('ensureAttachmentPermission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    Platform.Version = 31;
  });

  test('resolves the API-33+ photo permission to READ_MEDIA_IMAGES', () => {
    expect(getPhotoLibraryPermission(33)).toBe('android.permission.READ_MEDIA_IMAGES');
    expect(getPhotoLibraryPermission(32)).toBe('android.permission.READ_EXTERNAL_STORAGE');
  });

  test('is a no-op on iOS', async () => {
    Platform.OS = 'ios';
    await expect(ensureAttachmentPermission('photo')).resolves.toEqual({
      ok: true,
      granted: true,
      message: null,
    });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  test('never prompts for the file picker (Storage Access Framework, no runtime grant)', async () => {
    await expect(ensureAttachmentPermission('file')).resolves.toEqual({
      ok: true,
      granted: true,
      message: null,
    });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  test('skips the prompt when already granted', async () => {
    mockCheck.mockResolvedValue(true);
    await expect(ensureAttachmentPermission('camera')).resolves.toEqual({
      ok: true,
      granted: true,
      message: null,
    });
    expect(mockRequestMultiple).not.toHaveBeenCalled();
  });

  test('requests and reports denial with an actionable message', async () => {
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({ 'android.permission.RECORD_AUDIO': 'denied' });
    const result = await ensureAttachmentPermission('voice');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/microphone/i);
  });

  test('requests and reports the granted photo permission', async () => {
    Platform.Version = 33;
    mockCheck.mockResolvedValue(false);
    mockRequestMultiple.mockResolvedValue({ 'android.permission.READ_MEDIA_IMAGES': 'granted' });
    await expect(ensureAttachmentPermission('photo')).resolves.toEqual({
      ok: true,
      granted: true,
      message: null,
    });
  });
});
