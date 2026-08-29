jest.mock('../src/settingsStorage', () => ({
  loadThemePreferences: jest.fn(),
  saveThemePreferences: jest.fn(),
}));

import React from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { loadThemePreferences, saveThemePreferences } from '../src/settingsStorage';
import { useTheme, useThemedStyles } from '../src/ThemeContext';
import ThemeProvider from '../src/ThemeProvider';
import {
  buildPalette,
  DEFAULT_THEME_PREFERENCES,
  palettes,
  setTextScale,
  TEXT_SCALES,
  THEME_ACCENTS,
  THEME_CONTRASTS,
  THEME_MODES,
} from '../src/theme';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'dark'),
}));

function Probe({ onRender }: any) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  onRender({ theme, styles });
  return null;
}

const createStyles = (colors: any) => ({ box: { backgroundColor: colors.background } });

async function renderWithProvider(onRender: any) {
  let tree: any;
  await act(async () => {
    tree = renderer.create(
      <ThemeProvider>
        <Probe onRender={onRender} />
      </ThemeProvider>,
    );
  });
  return tree;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setTextScale(TEXT_SCALES.DEFAULT);
    (useColorScheme as jest.Mock).mockReturnValue('dark');
    (loadThemePreferences as jest.Mock).mockResolvedValue({ ...DEFAULT_THEME_PREFERENCES });
    (saveThemePreferences as jest.Mock).mockResolvedValue(true);
    // Android reports high contrast, iOS reports "darken colors"; the hook
    // reads whichever the platform has, so both are stubbed.
    jest.spyOn(AccessibilityInfo, 'isHighTextContrastEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'isDarkerSystemColorsEnabled').mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setTextScale(TEXT_SCALES.DEFAULT);
  });

  test('follows the OS colour scheme in system mode', async () => {
    const onRender = jest.fn();
    (useColorScheme as jest.Mock).mockReturnValue('light');
    await renderWithProvider(onRender);

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.scheme).toBe('light');
    expect(theme.colors).toBe(palettes.light);
  });

  test('re-renders with the dark palette when the device switches theme', async () => {
    const onRender = jest.fn();
    (useColorScheme as jest.Mock).mockReturnValue('light');
    const tree = await renderWithProvider(onRender);
    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('light');

    (useColorScheme as jest.Mock).mockReturnValue('dark');
    await act(async () => {
      tree.update(
        <ThemeProvider>
          <Probe onRender={onRender} />
        </ThemeProvider>,
      );
    });

    const { theme, styles } = onRender.mock.calls.at(-1)[0];
    expect(theme.scheme).toBe('dark');
    expect(styles.box.backgroundColor).toBe(palettes.dark.background);
  });

  test('a manual override wins over the OS scheme and is persisted', async () => {
    const onRender = jest.fn();
    (useColorScheme as jest.Mock).mockReturnValue('dark');
    await renderWithProvider(onRender);

    await act(async () => {
      onRender.mock.calls.at(-1)[0].theme.setMode(THEME_MODES.LIGHT);
    });

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.mode).toBe(THEME_MODES.LIGHT);
    expect(theme.scheme).toBe('light');
    expect(saveThemePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ mode: THEME_MODES.LIGHT }),
    );
  });

  test('restores the persisted mode on mount', async () => {
    const onRender = jest.fn();
    (loadThemePreferences as jest.Mock).mockResolvedValue({
      ...DEFAULT_THEME_PREFERENCES,
      mode: THEME_MODES.LIGHT,
    });
    (useColorScheme as jest.Mock).mockReturnValue('dark');
    await renderWithProvider(onRender);

    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('light');
  });

  test('keeps the dark palette when the persisted preferences cannot be read', async () => {
    const onRender = jest.fn();
    (loadThemePreferences as jest.Mock).mockRejectedValue(new Error('unreadable'));
    await renderWithProvider(onRender);

    // The gate exists to prevent a wrong-scheme frame, not to make an
    // unreadable store fatal: the tree still mounts, on the shipped palette.
    expect(onRender).toHaveBeenCalled();
    expect(onRender.mock.calls.at(-1)[0].theme.colors).toBe(palettes.dark);
  });

  test('renders nothing but a background until the preferences resolve', async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    (loadThemePreferences as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
    );

    const onRender = jest.fn();
    let tree: any;
    await act(async () => {
      tree = renderer.create(
        <ThemeProvider>
          <Probe onRender={onRender} />
        </ThemeProvider>,
      );
    });

    expect(onRender).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ testID: 'theme-loading' })).toBeTruthy();

    await act(async () => {
      resolveLoad({ ...DEFAULT_THEME_PREFERENCES, mode: THEME_MODES.LIGHT });
    });

    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('light');
  });

  test('a restored accent and true black reach the palette', async () => {
    const onRender = jest.fn();
    (loadThemePreferences as jest.Mock).mockResolvedValue({
      ...DEFAULT_THEME_PREFERENCES,
      mode: THEME_MODES.DARK,
      accent: THEME_ACCENTS.TEAL,
      trueBlack: true,
    });
    await renderWithProvider(onRender);

    const { theme, styles } = onRender.mock.calls.at(-1)[0];
    expect(theme.colors).toBe(
      buildPalette({ scheme: 'dark', accent: THEME_ACCENTS.TEAL, trueBlack: true }),
    );
    expect(styles.box.backgroundColor).toBe(theme.colors.background);
  });

  test('setPreference persists one field and leaves the others alone', async () => {
    const onRender = jest.fn();
    await renderWithProvider(onRender);

    await act(async () => {
      onRender.mock.calls.at(-1)[0].theme.setPreference('accent', THEME_ACCENTS.ROSE);
    });

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.preferences).toEqual({
      ...DEFAULT_THEME_PREFERENCES,
      accent: THEME_ACCENTS.ROSE,
    });
    expect(saveThemePreferences).toHaveBeenCalledWith({
      ...DEFAULT_THEME_PREFERENCES,
      accent: THEME_ACCENTS.ROSE,
    });
  });

  test('a text-size change rebuilds stylesheets that were already cached', async () => {
    const onRender = jest.fn();
    await renderWithProvider(onRender);
    const before = onRender.mock.calls.at(-1)[0].theme.typography.body.fontSize;

    await act(async () => {
      onRender.mock.calls.at(-1)[0].theme.setPreference('textScale', TEXT_SCALES.LARGER);
    });

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.typography.body.fontSize).toBeGreaterThan(before);
  });

  test('follows the OS high-contrast setting until the user chooses', async () => {
    (AccessibilityInfo.isHighTextContrastEnabled as jest.Mock).mockResolvedValue(true);
    (AccessibilityInfo.isDarkerSystemColorsEnabled as jest.Mock).mockResolvedValue(true);
    const onRender = jest.fn();
    await renderWithProvider(onRender);

    expect(onRender.mock.calls.at(-1)[0].theme.contrast).toBe('high');

    await act(async () => {
      onRender.mock.calls.at(-1)[0].theme.setPreference('contrast', THEME_CONTRASTS.STANDARD);
    });

    expect(onRender.mock.calls.at(-1)[0].theme.contrast).toBe('standard');
  });
});

describe('useTheme outside a provider', () => {
  test('falls back to the dark palette so isolated components still render', () => {
    const onRender = jest.fn();
    act(() => {
      renderer.create(<Probe onRender={onRender} />);
    });
    expect(onRender.mock.calls.at(-1)[0].theme.colors).toBe(palettes.dark);
  });
});
