// @ts-check
jest.mock('../src/settingsStorage', () => ({
  loadThemeMode: jest.fn(),
  saveThemeMode: jest.fn(),
}));

import React from 'react';
import { useColorScheme } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { loadThemeMode, saveThemeMode } from '../src/settingsStorage';
import { useTheme, useThemedStyles } from '../src/ThemeContext';
import ThemeProvider from '../src/ThemeProvider';
import { palettes, THEME_MODES } from '../src/theme';

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'dark'),
}));

function Probe(/** @type {any} */ { onRender }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  onRender({ theme, styles });
  return null;
}

const createStyles = (/** @type {any} */ colors) => ({ box: { backgroundColor: colors.background } });

async function renderWithProvider(/** @type {any} */ onRender) {
  /** @type {any} */
  let tree;
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
    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('dark');
    /** @type {jest.Mock} */ (loadThemeMode).mockResolvedValue(THEME_MODES.SYSTEM);
    /** @type {jest.Mock} */ (saveThemeMode).mockResolvedValue(true);
  });

  test('follows the OS colour scheme in system mode', async () => {
    const onRender = jest.fn();
    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('light');
    await renderWithProvider(onRender);

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.scheme).toBe('light');
    expect(theme.colors).toBe(palettes.light);
  });

  test('re-renders with the dark palette when the device switches theme', async () => {
    const onRender = jest.fn();
    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('light');
    const tree = await renderWithProvider(onRender);
    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('light');

    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('dark');
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
    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('dark');
    await renderWithProvider(onRender);

    await act(async () => {
      onRender.mock.calls.at(-1)[0].theme.setMode(THEME_MODES.LIGHT);
    });

    const { theme } = onRender.mock.calls.at(-1)[0];
    expect(theme.mode).toBe(THEME_MODES.LIGHT);
    expect(theme.scheme).toBe('light');
    expect(saveThemeMode).toHaveBeenCalledWith(THEME_MODES.LIGHT);
  });

  test('restores the persisted mode on mount', async () => {
    const onRender = jest.fn();
    /** @type {jest.Mock} */ (loadThemeMode).mockResolvedValue(THEME_MODES.LIGHT);
    /** @type {jest.Mock} */ (useColorScheme).mockReturnValue('dark');
    await renderWithProvider(onRender);

    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('light');
  });

  test('keeps the dark palette when the persisted mode cannot be read', async () => {
    const onRender = jest.fn();
    /** @type {jest.Mock} */ (loadThemeMode).mockRejectedValue(new Error('unreadable'));
    await renderWithProvider(onRender);

    expect(onRender.mock.calls.at(-1)[0].theme.scheme).toBe('dark');
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
