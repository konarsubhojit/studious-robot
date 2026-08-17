jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
}));

import RNFS from 'react-native-fs';
import {
  loadIdentity,
  loadSettings,
  mergeSettings,
  saveIdentity,
  saveSettings,
} from '../src/settingsStorage';

const DEFAULTS = { autoCameraLightingEnabled: false, speakerEnabledByDefault: true };

describe('settingsStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('mergeSettings', () => {
    test('keeps known keys with matching types', () => {
      const merged = mergeSettings(DEFAULTS, {
        autoCameraLightingEnabled: true,
        speakerEnabledByDefault: false,
      });
      expect(merged).toEqual({ autoCameraLightingEnabled: true, speakerEnabledByDefault: false });
    });

    test('ignores unknown keys and type mismatches', () => {
      const merged = mergeSettings(DEFAULTS, {
        autoCameraLightingEnabled: 'yes',
        unknown: 1,
        speakerEnabledByDefault: false,
      });
      expect(merged).toEqual({ autoCameraLightingEnabled: false, speakerEnabledByDefault: false });
    });

    test('falls back to defaults for non-object input', () => {
      expect(mergeSettings(DEFAULTS, null)).toEqual(DEFAULTS);
      expect(mergeSettings(DEFAULTS, 'nope')).toEqual(DEFAULTS);
    });
  });

  describe('loadSettings', () => {
    test('returns defaults when no file exists', async () => {
      RNFS.exists.mockResolvedValue(false);
      await expect(loadSettings(DEFAULTS)).resolves.toEqual(DEFAULTS);
      expect(RNFS.readFile).not.toHaveBeenCalled();
    });

    test('merges persisted values onto defaults', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(JSON.stringify({ autoCameraLightingEnabled: true }));
      await expect(loadSettings(DEFAULTS)).resolves.toEqual({
        autoCameraLightingEnabled: true,
        speakerEnabledByDefault: true,
      });
    });

    test('falls back to defaults on read/parse errors', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue('not-json');
      await expect(loadSettings(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });
  });

  describe('saveSettings', () => {
    test('writes JSON and resolves true on success', async () => {
      RNFS.writeFile.mockResolvedValue();
      await expect(saveSettings(DEFAULTS)).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-settings.json',
        JSON.stringify(DEFAULTS),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      RNFS.writeFile.mockRejectedValue(new Error('disk full'));
      await expect(saveSettings(DEFAULTS)).resolves.toBe(false);
    });
  });

  describe('loadIdentity', () => {
    test('returns empty identity when no identity file exists', async () => {
      RNFS.exists.mockResolvedValue(false);
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });

    test('returns stored identity when file exists', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(
        JSON.stringify({
          userId: 'alice',
        }),
      );
      await expect(loadIdentity()).resolves.toEqual({ userId: 'alice' });
    });

    test('loads legacy identity files without retaining recovery codes', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(JSON.stringify({ userId: 'alice' }));
      await expect(loadIdentity()).resolves.toEqual({ userId: 'alice' });
    });

    test('falls back to empty identity on read errors', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockRejectedValue(new Error('read failed'));
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });

    test('ignores non-string identity values', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(
        JSON.stringify({
          userId: 42,
        }),
      );
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });
  });

  describe('saveIdentity', () => {
    test('writes JSON and resolves true on success', async () => {
      RNFS.writeFile.mockResolvedValue();
      await expect(
        saveIdentity({ userId: 'bob' }),
      ).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-identity.json',
        JSON.stringify({ userId: 'bob' }),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      RNFS.writeFile.mockRejectedValue(new Error('disk full'));
      await expect(saveIdentity({ userId: 'bob' })).resolves.toBe(false);
    });
  });
});
