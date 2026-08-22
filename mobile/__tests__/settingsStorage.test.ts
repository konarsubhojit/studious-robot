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
  loadThemeMode,
  mergeSettings,
  saveIdentity,
  saveSettings,
  saveThemeMode,
} from '../src/settingsStorage';

const existsMock = (RNFS.exists as jest.Mock);
const readFileMock = (RNFS.readFile as jest.Mock);
const writeFileMock = (RNFS.writeFile as jest.Mock);

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
      existsMock.mockResolvedValue(false);
      await expect(loadSettings(DEFAULTS)).resolves.toEqual(DEFAULTS);
      expect(RNFS.readFile).not.toHaveBeenCalled();
    });

    test('merges persisted values onto defaults', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ autoCameraLightingEnabled: true }));
      await expect(loadSettings(DEFAULTS)).resolves.toEqual({
        autoCameraLightingEnabled: true,
        speakerEnabledByDefault: true,
      });
    });

    test('falls back to defaults on read/parse errors', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue('not-json');
      await expect(loadSettings(DEFAULTS)).resolves.toEqual(DEFAULTS);
    });
  });

  describe('saveSettings', () => {
    test('writes JSON and resolves true on success', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveSettings(DEFAULTS)).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-settings.json',
        JSON.stringify(DEFAULTS),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveSettings(DEFAULTS)).resolves.toBe(false);
    });
  });

  describe('loadIdentity', () => {
    test('returns empty identity when no identity file exists', async () => {
      existsMock.mockResolvedValue(false);
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });

    test('returns stored identity when file exists', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify({
          userId: 'alice',
        }),
      );
      await expect(loadIdentity()).resolves.toEqual({ userId: 'alice' });
    });

    test('loads legacy identity files without retaining recovery codes', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ userId: 'alice' }));
      await expect(loadIdentity()).resolves.toEqual({ userId: 'alice' });
    });

    test('falls back to empty identity on read errors', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockRejectedValue(new Error('read failed'));
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });

    test('ignores non-string identity values', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify({
          userId: 42,
        }),
      );
      await expect(loadIdentity()).resolves.toEqual({ userId: '' });
    });
  });

  describe('saveIdentity', () => {
    test('writes JSON and resolves true on success', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveIdentity({ userId: 'bob' })).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-identity.json',
        JSON.stringify({ userId: 'bob' }),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveIdentity({ userId: 'bob' })).resolves.toBe(false);
    });
  });

  describe('loadThemeMode', () => {
    test('defaults to system when no theme file exists', async () => {
      existsMock.mockResolvedValue(false);
      await expect(loadThemeMode()).resolves.toBe('system');
    });

    test('returns the persisted mode', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ mode: 'light' }));
      await expect(loadThemeMode()).resolves.toBe('light');
    });

    test('ignores an unknown persisted mode', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ mode: 'sepia' }));
      await expect(loadThemeMode()).resolves.toBe('system');
    });

    test('falls back to system on read errors', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockRejectedValue(new Error('read failed'));
      await expect(loadThemeMode()).resolves.toBe('system');
    });
  });

  describe('saveThemeMode', () => {
    test('writes the mode and resolves true on success', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveThemeMode('dark')).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-theme.json',
        JSON.stringify({ mode: 'dark' }),
        'utf8',
      );
    });

    test('normalises an unknown mode to system before writing', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveThemeMode('sepia')).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-theme.json',
        JSON.stringify({ mode: 'system' }),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveThemeMode('dark')).resolves.toBe(false);
    });
  });
});
