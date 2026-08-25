import { createContext, useContext, useMemo } from 'react';
import { palettes, radius, sizes, spacing, THEME_MODES, typography } from './theme';
import type { ThemeColors } from './theme';

/**
 * Build the theme object handed to consumers for a given mode/scheme pair.
 *
 * @param mode - Selected appearance mode (see THEME_MODES).
 * @param scheme - Palette actually being rendered.
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
 * The results are additionally cached per `(factory, palette)` pair at module
 * scope. `useMemo` is per component *instance*, so every mount of a list row
 * re-ran its factory and allocated a fresh stylesheet, and a theme switch re-ran
 * every factory in the app. Both palettes are long-lived objects and the
 * factories are module-level constants, so a `WeakMap` keyed on the factory
 * holds nothing alive that was not already alive and lets the Nth mount reuse
 * the first mount's stylesheet.
 *
 * @template T
 */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => getThemedStyles(factory, colors), [factory, colors]);
}

/**
 * Cache of built stylesheets, keyed first on the factory and then on the exact
 * palette object it was built from.
 *
 * Keyed on the palette *identity* rather than the scheme name so a caller that
 * passes a bespoke palette can never be served another palette's styles.
 */
const themedStyleCache = new WeakMap<(colors: ThemeColors) => unknown, WeakMap<ThemeColors, unknown>>();

/**
 * @returns The cached stylesheet for this factory/palette pair, building it on
 *   first use.
 */
function getThemedStyles<T>(factory: (colors: ThemeColors) => T, colors: ThemeColors): T {
  let byPalette = themedStyleCache.get(factory);
  if (!byPalette) {
    byPalette = new WeakMap();
    themedStyleCache.set(factory, byPalette);
  }

  if (!byPalette.has(colors)) {
    byPalette.set(colors, factory(colors));
  }

  return (byPalette.get(colors) as T);
}

export default ThemeContext;
