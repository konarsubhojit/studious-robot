import { createContext, useContext, useMemo } from 'react';
import {
  buildPalette,
  DEFAULT_THEME_PREFERENCES,
  getTypographyRevision,
  radius,
  sizes,
  spacing,
  typography,
} from './theme';
import type {
  ColorScheme,
  ResolvedContrast,
  ThemeColors,
  ThemePreferences,
} from './theme';

/** Everything a consumer can read or change about the active theme. */
export type Theme = {
  /** Selected appearance mode; see THEME_MODES. */
  mode: ThemePreferences['mode'];
  /** Palette actually being rendered. */
  scheme: ColorScheme;
  /** Contrast actually being rendered, with the OS setting folded in. */
  contrast: ResolvedContrast;
  /** The user's stored choices, before the OS settings are folded in. */
  preferences: ThemePreferences;
  colors: ThemeColors;
  spacing: typeof spacing;
  radius: typeof radius;
  sizes: typeof sizes;
  typography: typeof typography;
  /** Bumped when the in-app text size changes; keys the stylesheet cache. */
  typographyRevision: number;
  setMode: (mode: ThemePreferences['mode']) => void;
  /** Change one appearance preference, leaving the others alone. */
  setPreference: <K extends keyof ThemePreferences>(key: K, value: ThemePreferences[K]) => void;
};

/**
 * Build the theme object handed to consumers.
 *
 * @param mode - Selected appearance mode (see THEME_MODES).
 * @param scheme - Palette actually being rendered.
 * @param setMode - Persisting setter for the mode.
 * @param options - The wider preference set, when a provider supplies one.
 */
export function buildTheme(
  mode: ThemePreferences['mode'],
  scheme: ColorScheme,
  setMode: (mode: ThemePreferences['mode']) => void,
  options: {
    preferences?: ThemePreferences;
    contrast?: ResolvedContrast;
    setPreference?: <K extends keyof ThemePreferences>(key: K, value: ThemePreferences[K]) => void;
  } = {},
): Theme {
  const preferences = { ...(options.preferences ?? DEFAULT_THEME_PREFERENCES), mode };
  const contrast = options.contrast ?? 'standard';
  return {
    mode,
    scheme,
    contrast,
    preferences,
    colors: buildPalette({
      scheme,
      contrast,
      accent: preferences.accent,
      trueBlack: preferences.trueBlack,
    }),
    spacing,
    radius,
    sizes,
    typography,
    typographyRevision: getTypographyRevision(),
    setMode,
    setPreference: options.setPreference ?? (() => {}),
  };
}

/**
 * Default value used when a component renders outside `ThemeProvider` (for
 * example in isolated unit tests): the dark scheme the app shipped with, with
 * no-op setters.
 */
export const defaultTheme = buildTheme(DEFAULT_THEME_PREFERENCES.mode, 'dark', () => {});

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
  const { colors, typographyRevision } = useTheme();
  return useMemo(
    // `typographyRevision` is not read by the factory — it is read by the
    // cache, which drops everything built at a previous text size. Listing it
    // here is what makes a text-size change reach a component whose palette
    // did not move.
    () => getThemedStyles(factory, colors, typographyRevision),
    [factory, colors, typographyRevision],
  );
}

/**
 * Cache of built stylesheets, keyed first on the factory and then on the exact
 * palette object it was built from.
 *
 * Keyed on the palette *identity* rather than the scheme name so a caller that
 * passes a bespoke palette can never be served another palette's styles.
 */
let themedStyleCache = new WeakMap<(colors: ThemeColors) => unknown, WeakMap<ThemeColors, unknown>>();

/**
 * Text size at which the cache above was populated.
 *
 * The typography tokens are mutated in place when the in-app text size changes
 * (see `setTextScale`), so every stylesheet built before that change holds
 * stale font sizes. The cache is therefore dropped wholesale on a revision
 * change rather than being keyed per entry: a text-size change is rare, and
 * every entry is stale at once.
 */
let cachedTypographyRevision = getTypographyRevision();

/**
 * @returns The cached stylesheet for this factory/palette pair, building it on
 *   first use.
 */
function getThemedStyles<T>(
  factory: (colors: ThemeColors) => T,
  colors: ThemeColors,
  revision: number = getTypographyRevision(),
): T {
  if (revision !== cachedTypographyRevision) {
    themedStyleCache = new WeakMap();
    cachedTypographyRevision = revision;
  }

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
