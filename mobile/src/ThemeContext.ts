import { createContext, useContext, useMemo } from 'react';
import { palettes, radius, sizes, spacing, THEME_MODES, typography } from './theme';
import type { ThemeColors } from './theme';

/**
 * Build the theme object handed to consumers for a given mode/scheme pair.
 *
 * @param {string} mode - Selected appearance mode (see THEME_MODES).
 * @param {'light'|'dark'} scheme - Palette actually being rendered.
 * @param {(mode: string) => void} setMode
 */
export function buildTheme(mode: string, scheme: 'light' | 'dark', setMode: (mode: string) => void) {
  return {
    mode,
    scheme,
    colors: palettes[scheme],
    spacing,
    radius,
    sizes,
    typography,
    setMode,
  };
}

/**
 * Default value used when a component renders outside `ThemeProvider` (for
 * example in isolated unit tests): the dark scheme the app shipped with, with
 * a no-op setter.
 */
export const defaultTheme = buildTheme(THEME_MODES.SYSTEM, 'dark', () => {});

const ThemeContext = createContext(defaultTheme);

/**
 * Access the active theme: `{ mode, scheme, colors, spacing, radius, sizes,
 * typography, setMode }`.
 */
export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Build a `StyleSheet` from the active palette.
 *
 * Styles that used to be created once at module scope (and so froze the dark
 * palette in) become a `colors => StyleSheet.create({...})` factory that this
 * hook re-evaluates whenever the scheme changes.  Module-level factories are
 * stable references, so the memo only recomputes on an actual theme switch.
 *
 * @template T
 * @param {(colors: import('./theme').ThemeColors) => T} factory
 * @returns {T}
 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [factory, colors]);
}

export default ThemeContext;
