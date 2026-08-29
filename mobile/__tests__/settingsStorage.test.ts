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
  loadOnboardingState,
  loadSettings,
  loadThemeMode,
  loadThemePreferences,
  mergeSettings,
  saveIdentity,
  saveOnboardingState,
  saveSettings,
  saveThemeMode,
  saveThemePreferences,
} from '../src/settingsStorage';
import { DEFAULT_THEME_PREFERENCES } from '../src/theme';
import type { ThemeMode, ThemePreferences } from '../src/theme';

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
      existsMock.mockResolvedValue(false);
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveThemeMode('dark')).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-theme.json',
        JSON.stringify({ ...DEFAULT_THEME_PREFERENCES, mode: 'dark' }),
        'utf8',
      );
    });

    test('normalises an unknown mode to system before writing', async () => {
      existsMock.mockResolvedValue(false);
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveThemeMode(('sepia' as ThemeMode))).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-theme.json',
        JSON.stringify(DEFAULT_THEME_PREFERENCES),
        'utf8',
      );
    });

    test('keeps the other appearance preferences a mode change did not touch', async () => {
      // Read-modify-write: writing `{ mode }` alone used to be harmless when
      // the mode was the only preference, and would now silently reset the
      // accent and text size the user had chosen.
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify({ mode: 'system', accent: 'teal', textScale: 'large', trueBlack: true }),
      );
      writeFileMock.mockResolvedValue(undefined);

      await expect(saveThemeMode('dark')).resolves.toBe(true);

      const written = JSON.parse((writeFileMock.mock.calls.at(-1) as string[])[1]);
      expect(written).toEqual({
        ...DEFAULT_THEME_PREFERENCES,
        mode: 'dark',
        accent: 'teal',
        textScale: 'large',
        trueBlack: true,
      });
    });

    test('resolves false on write failure', async () => {
      existsMock.mockResolvedValue(false);
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveThemeMode('dark')).resolves.toBe(false);
    });
  });

  describe('theme preferences', () => {
    test('a fresh install gets the shipped appearance', async () => {
      existsMock.mockResolvedValue(false);
      await expect(loadThemePreferences()).resolves.toEqual(DEFAULT_THEME_PREFERENCES);
    });

    test('reads every persisted preference', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(
        JSON.stringify({
          mode: 'light',
          contrast: 'high',
          accent: 'rose',
          trueBlack: true,
          textScale: 'larger',
        }),
      );
      await expect(loadThemePreferences()).resolves.toEqual({
        mode: 'light',
        contrast: 'high',
        accent: 'rose',
        trueBlack: true,
        textScale: 'larger',
      });
    });

    test('a corrupt field falls back on its own, keeping the rest', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ mode: 'dark', accent: 'chartreuse' }));
      await expect(loadThemePreferences()).resolves.toEqual({
        ...DEFAULT_THEME_PREFERENCES,
        mode: 'dark',
      });
    });

    test('falls back to the defaults on read errors', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockRejectedValue(new Error('read failed'));
      await expect(loadThemePreferences()).resolves.toEqual(DEFAULT_THEME_PREFERENCES);
    });

    test('normalises before writing so bad values never reach the disk', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(
        saveThemePreferences(({
          mode: 'dark',
          contrast: 'lurid',
          accent: 'teal',
          trueBlack: 'yes',
          textScale: 'large',
        } as unknown as ThemePreferences)),
      ).resolves.toBe(true);

      const written = JSON.parse((writeFileMock.mock.calls.at(-1) as string[])[1]);
      expect(written).toEqual({
        mode: 'dark',
        contrast: 'system',
        accent: 'teal',
        trueBlack: false,
        textScale: 'large',
      });
    });

    test('resolves false on write failure', async () => {
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveThemePreferences(DEFAULT_THEME_PREFERENCES)).resolves.toBe(false);
    });
  });

  describe('onboarding state', () => {
    test('a fresh install has answered nothing', async () => {
      existsMock.mockResolvedValue(false);
      await expect(loadOnboardingState()).resolves.toEqual({ permissionsPrimerSeen: false });
    });

    test('reads the persisted answer', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ permissionsPrimerSeen: true }));
      await expect(loadOnboardingState()).resolves.toEqual({ permissionsPrimerSeen: true });
    });

    test('a corrupt file falls back to unanswered rather than throwing', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue('not json');
      // Showing the explanation one extra time beats never showing it.
      await expect(loadOnboardingState()).resolves.toEqual({ permissionsPrimerSeen: false });
    });

    test('ignores a value of the wrong type', async () => {
      existsMock.mockResolvedValue(true);
      readFileMock.mockResolvedValue(JSON.stringify({ permissionsPrimerSeen: 'yes' }));
      await expect(loadOnboardingState()).resolves.toEqual({ permissionsPrimerSeen: false });
    });

    test('writes to its own file, so a settings write cannot clobber it', async () => {
      writeFileMock.mockResolvedValue(undefined);
      await expect(saveOnboardingState({ permissionsPrimerSeen: true })).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-onboarding.json',
        JSON.stringify({ permissionsPrimerSeen: true }),
        'utf8',
      );
    });

    test('resolves false on write failure', async () => {
      writeFileMock.mockRejectedValue(new Error('disk full'));
      await expect(saveOnboardingState({ permissionsPrimerSeen: true })).resolves.toBe(false);
    });
  });
});
