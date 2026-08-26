import { Platform } from 'react-native';
import { getPermissionPrimerItems, shouldShowPermissionPrimer } from '../src/permissionsPrimer';

describe('getPermissionPrimerItems', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  });

  /** @param os */
  function setPlatform(os: string) {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  test('explains nothing on iOS, which asks at the point of use', () => {
    setPlatform('ios');

    // A primer there would precede no dialog at all: iOS uses the purpose
    // strings in Info.plist when the feature is first used.
    expect(getPermissionPrimerItems(17)).toEqual([]);
    expect(shouldShowPermissionPrimer(17)).toBe(false);
  });

  test('explains camera and microphone on every Android version', () => {
    setPlatform('android');

    const keys = getPermissionPrimerItems(29).map(item => item.key);
    expect(keys).toContain('android.permission.CAMERA');
    expect(keys).toContain('android.permission.RECORD_AUDIO');
    expect(shouldShowPermissionPrimer(29)).toBe(true);
  });

  test('explains Bluetooth only where Android asks for it', () => {
    setPlatform('android');

    expect(getPermissionPrimerItems(30).map(item => item.key)).not.toContain(
      'android.permission.BLUETOOTH_CONNECT',
    );
    expect(getPermissionPrimerItems(31).map(item => item.key)).toContain(
      'android.permission.BLUETOOTH_CONNECT',
    );
  });

  test('explains notifications only where Android asks for them', () => {
    setPlatform('android');

    expect(getPermissionPrimerItems(32).map(item => item.key)).not.toContain(
      'android.permission.POST_NOTIFICATIONS',
    );
    expect(getPermissionPrimerItems(33).map(item => item.key)).toContain(
      'android.permission.POST_NOTIFICATIONS',
    );
  });

  test('gives every explained permission a reason, not just a name', () => {
    setPlatform('android');

    getPermissionPrimerItems(34).forEach(item => {
      // The system dialog already says the name; the reason is the only thing
      // this screen adds.
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
      expect(typeof item.required).toBe('boolean');
    });
  });

  test('marks camera and microphone as required and the rest as optional', () => {
    setPlatform('android');

    const byKey = Object.fromEntries(
      getPermissionPrimerItems(34).map(item => [item.key, item]),
    );
    expect(byKey['android.permission.RECORD_AUDIO'].required).toBe(true);
    expect(byKey['android.permission.CAMERA'].required).toBe(true);
    expect(byKey['android.permission.POST_NOTIFICATIONS'].required).toBe(false);
    expect(byKey['android.permission.BLUETOOTH_CONNECT'].required).toBe(false);
  });
});
