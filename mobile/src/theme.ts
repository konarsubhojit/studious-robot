import type { TextStyle } from 'react-native';

/**
 * Centralised design tokens for the WeTalk UI.
 *
 * Colours, spacing, radii and typography were previously hardcoded and
 * repeated across the inline `StyleSheet` in `App.js`.  Collecting them here
 * gives every component a single source of truth.
 *
 * Colours come in two palettes (`dark` and `light`) exposing exactly the same
 * token names, so a component only has to read the palette handed to it by
 * `ThemeProvider` (see `src/ThemeContext.js`) to support both schemes.  Every
 * text/background pairing in the palettes below meets WCAG AA (4.5:1 for body
 * text, 3:1 for large text and control borders).
 */

/**
 * Material 3 tonal surface roles for the dark scheme.
 *
 * One ladder, four rungs, each a visible step lighter than the last: the page
 * sits on `background`, and anything drawn on top of it picks the rung that
 * says how prominent it is. Every surface in the app used to be one of four
 * hand-picked navies within a couple of percent luminance of each other, so a
 * card, the tab bar and the page behind them all read as the same plane.
 *
 * The legacy `surface*` token names below are aliases onto these rungs, so no
 * screen has to change to gain the depth.
 */
const darkContainers = {
  /** Cards and the tab bar: the first step off the page. */
  surfaceContainerLow: '#17213b',
  /** Grouped content: sheets, list sections, incoming chat bubbles' backdrop. */
  surfaceContainer: '#1e2848',
  /** Controls drawn on a card, and filled (incoming) chat bubbles. */
  surfaceContainerHigh: '#26325a',
  /** The most prominent rung: banners and pressed control fills. */
  surfaceContainerHighest: '#2a3760',
};

const darkColors = {
  // Backgrounds / surfaces (midnight blue)
  background: '#0b1020',
  backgroundAlt: '#121a2e',
  ...darkContainers,
  /** Filled container behind content that must read as a distinct block. */
  surfaceVariant: darkContainers.surfaceContainerHigh,
  surface: darkContainers.surfaceContainerLow,
  surfaceRaised: darkContainers.surfaceContainer,
  surfaceControl: darkContainers.surfaceContainerHigh,
  surfaceBanner: darkContainers.surfaceContainerHighest,
  stage: '#0f172a',
  stageDark: '#070b16',
  pipBackground: '#060a13',

  // Borders (lightened from the original palette so control outlines clear the
  // 3:1 non-text contrast ratio WCAG AA asks for)
  border: '#5a70a4',
  borderStage: '#4d64a0',
  borderInactiveBar: '#4a5f8f',

  // Text
  textPrimary: '#f6f8ff',
  textSecondary: '#b6c5ea',
  textMuted: '#8ca3d5',
  textOnAccent: '#0d1f4a',

  // Accents / semantic
  accent: '#7cb4ff',
  accentButton: '#8eb9ff',
  accentValue: '#98c2ff',
  danger: '#ff7b8a',
  success: '#5be2a2',
  warning: '#ffd27a',
  blob: '#9ec2ff',

  // Translucent tints behind non-info status banners.
  tintSuccess: 'rgba(91,226,162,0.12)',
  tintDanger: 'rgba(255,123,138,0.15)',
  tintWarning: 'rgba(255,210,122,0.15)',

  // Foreground for content drawn on the fixed dark video overlays, which stay
  // dark in both schemes so camera frames are never framed in white.
  onOverlay: '#f6f8ff',

  // Drop shadows. A palette token rather than a literal `'#000'` so the two
  // schemes can diverge later without hunting through component stylesheets.
  shadow: '#000000',

  // Android touch ripple. Translucent so it takes the colour of whatever
  // surface it is drawn on, which is the property that lets one token serve
  // every row, button and tab.
  ripple: 'rgba(246, 248, 255, 0.14)',
  /** Ripple on an accent-filled control, where the foreground is dark. */
  rippleOnAccent: 'rgba(13, 31, 74, 0.18)',

  // ── Semantic aliases ──────────────────────────────────────────────────────
  // Layered over the raw palette above so components stop choosing between
  // `accentValue` and `accentButton` by guesswork. Each alias states the *role*
  // a colour plays; the raw token it points at is an implementation detail.
  onSurface: '#f6f8ff',
  onSurfaceVariant: '#b6c5ea',
  outline: '#5a70a4',
  outlineVariant: '#4a5f8f',
  positive: '#5be2a2',
  negative: '#ff7b8a',
  notice: '#ffd27a',
  /** Background of a large audio-call canvas; deliberately calmer than `stage`. */
  ambient: '#141d38',
};

/**
 * The same four rungs for the light scheme.
 *
 * Light steps the other way — a container is *darker* than the paper it sits
 * on, as Material 3 specifies — but the roles mean the same thing, so a
 * component picks a rung by what it is, not by which scheme is active.
 */
const lightContainers = {
  surfaceContainerLow: '#f1f4fb',
  surfaceContainer: '#e8edf7',
  surfaceContainerHigh: '#e0e7f5',
  surfaceContainerHighest: '#d8e0f2',
};

const lightColors = {
  // Backgrounds / surfaces (cool daylight)
  background: '#f4f6fb',
  backgroundAlt: lightContainers.surfaceContainer,
  ...lightContainers,
  surfaceVariant: lightContainers.surfaceContainer,
  surface: '#ffffff',
  surfaceRaised: lightContainers.surfaceContainerLow,
  surfaceControl: lightContainers.surfaceContainerHigh,
  surfaceBanner: lightContainers.surfaceContainerHighest,
  // The video stage stays dark in both schemes: letterboxing camera frames in
  // white is glaring and hides the (light) overlay controls drawn on top.
  stage: '#0f172a',
  stageDark: '#070b16',
  pipBackground: '#060a13',

  // Borders
  border: '#7286ab',
  borderStage: '#6a80b8',
  borderInactiveBar: '#5d6f95',

  // Text
  textPrimary: '#101a30',
  textSecondary: '#44506e',
  textMuted: '#4b5877',
  textOnAccent: '#ffffff',

  // Accents / semantic
  accent: '#1d4ed8',
  accentButton: '#1d4ed8',
  accentValue: '#1a45c0',
  danger: '#b3261e',
  success: '#116b45',
  warning: '#8a5300',
  blob: '#4a7bd6',

  tintSuccess: 'rgba(17,107,69,0.10)',
  tintDanger: 'rgba(179,38,30,0.10)',
  tintWarning: 'rgba(138,83,0,0.10)',

  onOverlay: '#f6f8ff',

  shadow: '#000000',

  ripple: 'rgba(16, 26, 48, 0.12)',
  rippleOnAccent: 'rgba(255, 255, 255, 0.24)',

  // ── Semantic aliases (see the dark palette for the rationale) ─────────────
  onSurface: '#101a30',
  onSurfaceVariant: '#44506e',
  outline: '#7286ab',
  outlineVariant: '#5d6f95',
  positive: '#116b45',
  negative: '#b3261e',
  notice: '#8a5300',
  /** Audio-call canvas stays dark in both schemes, like `stage`. */
  ambient: '#141d38',
};

/**
 * Surfaces drawn on top of the video stage, and behind modal sheets.
 *
 * Deliberately not part of the palettes: the stage stays dark in both schemes
 * (see `stage`), so anything layered on it is scheme-independent, and pairing
 * these with `colors.textPrimary` — which inverts between schemes — is the bug
 * they exist to prevent. Foreground on any of them is `colors.onOverlay`.
 *
 * The scrims are a three-step scale rather than one value per call site, so
 * the overlay surfaces stay visibly related and can be tuned together.
 */
export const overlay = {
  /** Control chrome over video, and modal backdrops. */
  scrimSoft: 'rgba(0, 0, 0, 0.45)',
  /** Banners and badges that must stay legible over bright camera frames. */
  scrimMedium: 'rgba(0, 0, 0, 0.6)',
  /** Veils that replace content outright, e.g. the camera-off PiP. */
  scrimStrong: 'rgba(0, 0, 0, 0.72)',
  /** Tint behind an advisory badge (e.g. the recording-policy notice). */
  warningTint: 'rgba(255, 210, 122, 0.28)',
  /** Unfilled track of a meter, as a faded `onOverlay`. */
  inactiveTrack: 'rgba(246, 248, 255, 0.35)',
};

/**
 * Palette handed to components by `ThemeProvider`; both schemes expose exactly
 * the same token names.
 */
export type ThemeColors = typeof darkColors;

/** Both palettes, keyed by the colour scheme they implement. */
export const palettes = {
  dark: darkColors,
  light: lightColors,
};

/** The colour scheme a palette implements. */
export type ColorScheme = 'light' | 'dark';

/** Selectable appearance modes surfaced in Settings. */
export const THEME_MODES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
} as const;

/** One of {@link THEME_MODES}. */
export type ThemeMode = (typeof THEME_MODES)[keyof typeof THEME_MODES];

export const THEME_MODE_VALUES: readonly ThemeMode[] = [
  THEME_MODES.SYSTEM,
  THEME_MODES.LIGHT,
  THEME_MODES.DARK,
];

/**
 * Contrast preference.
 *
 * `SYSTEM` defers to the OS high-contrast accessibility setting, so a user who
 * has already asked the platform for stronger contrast gets it without finding
 * a second switch in this app; choosing either explicit value pins it.
 */
export const THEME_CONTRASTS = {
  SYSTEM: 'system',
  STANDARD: 'standard',
  HIGH: 'high',
} as const;

export type ThemeContrast = (typeof THEME_CONTRASTS)[keyof typeof THEME_CONTRASTS];

export const THEME_CONTRAST_VALUES: readonly ThemeContrast[] = [
  THEME_CONTRASTS.SYSTEM,
  THEME_CONTRASTS.STANDARD,
  THEME_CONTRASTS.HIGH,
];

/** Contrast actually rendered, once the OS setting has been folded in. */
export type ResolvedContrast = 'standard' | 'high';

/**
 * Selectable accent colours.
 *
 * A fixed set rather than a colour picker: each entry is a *designed triple*
 * (see {@link accentOverrides}) whose contrast against every surface is
 * asserted in `__tests__/theme.test.ts`. An arbitrary hue picked from a wheel
 * cannot carry that guarantee, and an accent that fails contrast is invisible
 * exactly where it matters most — a disabled-looking primary button.
 */
export const THEME_ACCENTS = {
  DEFAULT: 'default',
  VIOLET: 'violet',
  TEAL: 'teal',
  AMBER: 'amber',
  ROSE: 'rose',
} as const;

export type ThemeAccent = (typeof THEME_ACCENTS)[keyof typeof THEME_ACCENTS];

export const THEME_ACCENT_VALUES: readonly ThemeAccent[] = [
  THEME_ACCENTS.DEFAULT,
  THEME_ACCENTS.VIOLET,
  THEME_ACCENTS.TEAL,
  THEME_ACCENTS.AMBER,
  THEME_ACCENTS.ROSE,
];

/** Human-readable accent names, for the Settings control and its a11y label. */
export const THEME_ACCENT_LABELS: Record<ThemeAccent, string> = {
  default: 'Blue',
  violet: 'Violet',
  teal: 'Teal',
  amber: 'Amber',
  rose: 'Rose',
};

/** In-app text size steps, multiplied onto the {@link typography} scale. */
export const TEXT_SCALES = {
  SMALL: 'small',
  DEFAULT: 'default',
  LARGE: 'large',
  LARGER: 'larger',
} as const;

export type TextScale = (typeof TEXT_SCALES)[keyof typeof TEXT_SCALES];

export const TEXT_SCALE_VALUES: readonly TextScale[] = [
  TEXT_SCALES.SMALL,
  TEXT_SCALES.DEFAULT,
  TEXT_SCALES.LARGE,
  TEXT_SCALES.LARGER,
];

export const TEXT_SCALE_LABELS: Record<TextScale, string> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  larger: 'Larger',
};

/**
 * Multiplier per step.
 *
 * Deliberately gentle, and 1.3 is a ceiling rather than a starting point: this
 * composes *with* the OS font-size setting rather than replacing it, so a user
 * already at 200% system type who then picks "Larger" gets 260%.
 *
 * Note what does **not** protect the fixed-height surfaces here.
 * `fontScaleCaps` caps `maxFontSizeMultiplier`, which limits the *OS* scale
 * applied on top of a token — but this scale changes the token's `fontSize`
 * itself, so a capped `Text` still grows by the full factor. The bottom-pinned
 * call deck, the tab bar and anything sized from `sizes` are therefore
 * protected only by this table staying modest. Raising a factor means
 * re-walking §3.4 of `docs/UX_REDESIGN_PLAN.md` on a device.
 */
export const TEXT_SCALE_FACTORS: Record<TextScale, number> = {
  small: 0.9,
  default: 1,
  large: 1.15,
  larger: 1.3,
};

/**
 * Everything the user can choose about how the app looks.
 *
 * One shape rather than five loose fields, because they are loaded, validated
 * and persisted together — and because `buildPalette` is memoised on exactly
 * this tuple.
 */
export type ThemePreferences = {
  mode: ThemeMode;
  contrast: ThemeContrast;
  accent: ThemeAccent;
  trueBlack: boolean;
  textScale: TextScale;
};

/** Defaults chosen so an existing install looks exactly as it did before. */
export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  mode: THEME_MODES.SYSTEM,
  contrast: THEME_CONTRASTS.SYSTEM,
  accent: THEME_ACCENTS.DEFAULT,
  trueBlack: false,
  textScale: TEXT_SCALES.DEFAULT,
};

/**
 * Coerce an arbitrary (persisted, possibly corrupt) value into a usable set of
 * preferences.
 *
 * Each field falls back **independently**: a file whose `accent` was hand-edited
 * to nonsense must not also throw away the user's pinned dark mode.
 */
export function normalizeThemePreferences(raw: unknown): ThemePreferences {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;

  return {
    mode: pick(source.mode, THEME_MODE_VALUES, DEFAULT_THEME_PREFERENCES.mode),
    contrast: pick(source.contrast, THEME_CONTRAST_VALUES, DEFAULT_THEME_PREFERENCES.contrast),
    accent: pick(source.accent, THEME_ACCENT_VALUES, DEFAULT_THEME_PREFERENCES.accent),
    trueBlack:
      typeof source.trueBlack === 'boolean'
        ? source.trueBlack
        : DEFAULT_THEME_PREFERENCES.trueBlack,
    textScale: pick(source.textScale, TEXT_SCALE_VALUES, DEFAULT_THEME_PREFERENCES.textScale),
  };
}

/**
 * Resolve the palette to render with from the user's preference and the OS
 * colour scheme.  Unknown modes (e.g. a corrupt persisted value) and an
 * unknown system scheme both fall back to the dark scheme the app shipped
 * with.
 *
 * @param mode - One of THEME_MODES.
 * @param systemScheme - Value from `useColorScheme()`.
 */
export function resolveScheme(mode?: ThemeMode, systemScheme?: string | null): ColorScheme {
  if (mode === THEME_MODES.LIGHT) return 'light';
  if (mode === THEME_MODES.DARK) return 'dark';
  return systemScheme === 'light' ? 'light' : 'dark';
}

/**
 * Fold the OS high-contrast setting into the stored preference.
 *
 * @param contrast - Stored preference.
 * @param systemHighContrast - Whether the OS asks for higher contrast.
 */
export function resolveContrast(
  contrast: ThemeContrast | undefined,
  systemHighContrast: boolean,
): ResolvedContrast {
  if (contrast === THEME_CONTRASTS.HIGH) return 'high';
  if (contrast === THEME_CONTRASTS.STANDARD) return 'standard';
  return systemHighContrast ? 'high' : 'standard';
}

/**
 * True-black surface overrides for the dark scheme.
 *
 * An OLED panel draws a literal black pixel at zero power, so the point is
 * `background: '#000000'` — but only the *base* layer goes to black. The raised
 * surfaces stay a step apart from it, because collapsing them all would erase
 * the elevation the whole layout depends on: a card and the page behind it must
 * still read as two things.
 *
 * Light has no equivalent, so this is dark-only (see {@link buildPalette}).
 */
const trueBlackContainers = {
  surfaceContainerLow: '#101319',
  surfaceContainer: '#171b23',
  surfaceContainerHigh: '#20252f',
  surfaceContainerHighest: '#272d3a',
};

const trueBlackSurfaces = {
  background: '#000000',
  backgroundAlt: '#0a0d14',
  ...trueBlackContainers,
  surfaceVariant: trueBlackContainers.surfaceContainerHigh,
  surface: trueBlackContainers.surfaceContainerLow,
  surfaceRaised: trueBlackContainers.surfaceContainer,
  surfaceControl: trueBlackContainers.surfaceContainerHigh,
  surfaceBanner: trueBlackContainers.surfaceContainerHighest,
};

/**
 * High-contrast overrides, per scheme.
 *
 * Text tokens are pushed past 7:1 on every surface (WCAG AAA for body text)
 * and borders past 4.5:1 — well above the 3:1 the standard palettes target —
 * so control outlines survive a glare-lit screen.
 *
 * The notice tints go the *other* way and lose alpha, which looks backwards
 * until you notice that a tint is the same hue as the tone drawn on it: a
 * stronger `tintDanger` moves the backdrop towards `danger` and makes the
 * warning text harder to read, not easier (it costs 0.06 of the 4.5:1 the
 * standard palette clears by). High contrast means a louder foreground and a
 * quieter background. They stay `rgba()` so a banner keeps compositing over
 * whatever surface it is drawn on, which is the property its contrast
 * assertions rely on.
 */
const highContrastOverrides = {
  dark: {
    textPrimary: '#ffffff',
    textSecondary: '#e4ebff',
    textMuted: '#d3ddf7',
    onSurface: '#ffffff',
    onSurfaceVariant: '#e4ebff',
    border: '#a9bcea',
    borderStage: '#a9bcea',
    borderInactiveBar: '#9db1e4',
    outline: '#a9bcea',
    outlineVariant: '#9db1e4',
    tintSuccess: 'rgba(91,226,162,0.08)',
    tintDanger: 'rgba(255,123,138,0.08)',
    tintWarning: 'rgba(255,210,122,0.08)',
  },
  light: {
    textPrimary: '#000000',
    textSecondary: '#1b2338',
    textMuted: '#232c44',
    onSurface: '#000000',
    onSurfaceVariant: '#1b2338',
    border: '#3d4b6b',
    borderStage: '#3d4b6b',
    borderInactiveBar: '#333f5c',
    outline: '#3d4b6b',
    outlineVariant: '#333f5c',
    tintSuccess: 'rgba(17,107,69,0.07)',
    tintDanger: 'rgba(179,38,30,0.07)',
    tintWarning: 'rgba(138,83,0,0.07)',
  },
};

/**
 * Accent overrides, per scheme.
 *
 * Each entry is a designed quadruple — the accent itself, the button fill, the
 * slightly stronger "value" shade used for accented text, and the foreground
 * that goes *on* the fill — rather than one hue with the rest computed. The
 * dark entries are light tints (they sit on dark surfaces) and the light
 * entries are deep shades (they sit on white); deriving one from the other
 * automatically is what produces the classic 3:1 "pretty but unreadable"
 * accent.
 *
 * `default` restates the shipped palette so it can be selected explicitly and
 * so `buildPalette` has nothing to special-case.
 */
const accentOverrides: Record<ColorScheme, Record<ThemeAccent, Record<string, string>>> = {
  dark: {
    default: {
      accent: '#7cb4ff',
      accentButton: '#8eb9ff',
      accentValue: '#98c2ff',
      textOnAccent: '#0d1f4a',
      blob: '#9ec2ff',
    },
    violet: {
      accent: '#c4a8ff',
      accentButton: '#c9b1ff',
      accentValue: '#cdb6ff',
      textOnAccent: '#21103f',
      blob: '#c9b1ff',
    },
    teal: {
      accent: '#5fd6c4',
      accentButton: '#68dccb',
      accentValue: '#77e0d1',
      textOnAccent: '#04241f',
      blob: '#68dccb',
    },
    amber: {
      accent: '#f2b95c',
      accentButton: '#f5c069',
      accentValue: '#f7c877',
      textOnAccent: '#2e1c00',
      blob: '#f5c069',
    },
    rose: {
      accent: '#ff9db4',
      accentButton: '#ffa8bd',
      accentValue: '#ffb0c3',
      textOnAccent: '#3d0a1a',
      blob: '#ffa8bd',
    },
  },
  light: {
    default: {
      accent: '#1d4ed8',
      accentButton: '#1d4ed8',
      accentValue: '#1a45c0',
      textOnAccent: '#ffffff',
      blob: '#4a7bd6',
    },
    violet: {
      accent: '#6b21a8',
      accentButton: '#6b21a8',
      accentValue: '#5b1b90',
      textOnAccent: '#ffffff',
      blob: '#8b4fc4',
    },
    teal: {
      accent: '#0f6f66',
      accentButton: '#0f6f66',
      accentValue: '#0c5b54',
      textOnAccent: '#ffffff',
      blob: '#2f9c91',
    },
    amber: {
      accent: '#8a5300',
      accentButton: '#8a5300',
      accentValue: '#734500',
      textOnAccent: '#ffffff',
      blob: '#b57400',
    },
    rose: {
      accent: '#a3184f',
      accentButton: '#a3184f',
      accentValue: '#8b1443',
      textOnAccent: '#ffffff',
      blob: '#c94b7c',
    },
  },
};

/** The palette variant a set of preferences resolves to. */
export type PaletteVariant = {
  scheme: ColorScheme;
  contrast: ResolvedContrast;
  accent: ThemeAccent;
  trueBlack: boolean;
};

/**
 * Cache of built palettes, keyed on the variant they implement.
 *
 * **Load-bearing.** `useThemedStyles` caches built stylesheets in a `WeakMap`
 * keyed on *palette identity*, so a `buildPalette` that allocated a fresh
 * object per render would silently defeat that cache and re-run every style
 * factory in the app on every render. The variant key is a small closed set, so
 * a plain `Map` holding one palette per combination is bounded.
 */
const paletteCache = new Map<string, ThemeColors>();

/**
 * The palette for a variant, built once and thereafter returned by identity.
 *
 * The default variant returns the shipped palette object itself, so nothing
 * that compares against `palettes.dark` / `palettes.light` has to change.
 */
export function buildPalette({
  scheme,
  contrast = 'standard',
  accent = THEME_ACCENTS.DEFAULT,
  trueBlack = false,
}: {
  scheme: ColorScheme;
  contrast?: ResolvedContrast;
  accent?: ThemeAccent;
  trueBlack?: boolean;
}): ThemeColors {
  // True black is a dark-scheme treatment; asking for it in light is not an
  // error, it simply has no effect (and the control is hidden there).
  const blackened = trueBlack && scheme === 'dark';
  const isDefault = contrast === 'standard' && accent === THEME_ACCENTS.DEFAULT && !blackened;
  if (isDefault) return palettes[scheme];

  const key = `${scheme}|${contrast}|${accent}|${blackened}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;

  const built = {
    ...palettes[scheme],
    ...(blackened ? trueBlackSurfaces : null),
    ...(contrast === 'high' ? highContrastOverrides[scheme] : null),
    ...accentOverrides[scheme][accent],
  } as ThemeColors;

  paletteCache.set(key, built);
  return built;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  /** Gutters of a large-title header, and the gap between grouped sections. */
  '2xl': 32,
  /** Vertical rhythm of a full-screen empty state or an identity card. */
  '3xl': 48,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 18,
  pill: 999,
};

/**
 * Drop-shadow tokens as a four-step elevation scale.
 *
 * Every card in the app used to hand-roll `shadowOpacity` / `shadowRadius` /
 * `elevation`, so two surfaces at the same conceptual height rendered at
 * different depths. Spread one of these into a `StyleSheet.create` entry
 * instead, passing the palette's `shadow` token as the colour.
 *
 * @param shadowColor - `colors.shadow` from the active palette.
 */
export function elevation(shadowColor: string) {
  return {
    /** Flush with its background: a divider or an inset row. */
    none: {},
    /** Resting card, list section, chat bubble. */
    low: {
      shadowColor,
      shadowOpacity: 0.12,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    /** Raised affordance that floats over content: FAB, toast, banner. */
    medium: {
      shadowColor,
      shadowOpacity: 0.2,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    /** Modal layer: bottom sheets, the draggable call bubble. */
    high: {
      shadowColor,
      shadowOpacity: 0.3,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
  };
}

/**
 * Motion tokens.
 *
 * Durations and easing curves were previously written as literals at each call
 * site (the 180 ms control fade and the 3000 ms chrome auto-hide in
 * `CallScreen`, the 220 ms swipe spring in `SwipeableRow`), so two animations
 * that should have felt identical did not. Anything that animates reads from
 * here, and gates itself on `useReducedMotion()`.
 */
export const motion = {
  duration: {
    /** Press feedback, chip selection: barely perceptible. */
    instant: 90,
    /** Fades and cross-dissolves — the app's default. */
    fast: 180,
    /** Sheet present/dismiss, screen-level transitions. */
    normal: 240,
    /** Large surfaces travelling a long distance (the call canvas). */
    slow: 320,
  },
  delay: {
    /** How long call chrome stays visible before auto-hiding. */
    autoHide: 3000,
  },
  spring: {
    /** Bubbles, swipe rows, draggable PiP: settles without visible bounce. */
    gentle: { damping: 20, stiffness: 180, mass: 1 },
    /** Sheets and the FAB: a little overshoot reads as responsive. */
    lively: { damping: 15, stiffness: 240, mass: 1 },
  },
};

/** Minimum recommended dimensions (dp) for reliable touch targets. */
export const sizes = {
  minTouchTarget: 48,
  /**
   * Material 3 list-row heights: 56dp for a single line, 72dp once a row also
   * carries a description or a wrapped value.
   */
  row: {
    singleLine: 56,
    twoLine: 72,
  },
  /** Height of a standard control: a segment, a filled button, a text field. */
  control: 40,
  /** Avatar diameters, keyed by the `Avatar` primitive's `size` prop. */
  avatar: {
    xs: 24,
    sm: 32,
    md: 44,
    lg: 64,
    xl: 112,
  },
  /** Floating action button diameter. */
  fab: 56,
  /**
   * Ceiling for a scrollable list inside a `Sheet`, so a long list (the
   * licence roll) scrolls within the sheet instead of pushing it off-screen.
   */
  sheetListMaxHeight: 320,
};

/**
 * `hitSlop` (dp, per edge) that grows a control rendered at `size` dp up to
 * `sizes.minTouchTarget`, so small icon buttons stay comfortably tappable
 * without inflating the visual design.
 *
 * @param size - Rendered width/height of the control, in dp.
 * @returns slop to apply on every edge (0 when the control is already big enough).
 */
export function touchSlop(size: number): number {
  return Math.max(0, Math.ceil((sizes.minTouchTarget - size) / 2));
}

/**
 * Text style tokens. Typed as React Native text styles so spreading a token
 * into a `StyleSheet.create` entry keeps its literal `fontWeight` type.
 *
 * The scale is `display → title → headline → subtitle → body → label →
 * caption`, each with an explicit `lineHeight`. Line heights used to be left to
 * the platform, which meant a row's height changed under a larger system font
 * in ways the layout had never been checked against; stating them makes the
 * vertical rhythm the design's decision, and dynamic-type behaviour testable.
 *
 * `title` / `sectionTitle` / `groupLabel` / `emphasis` / `hint` are retained as
 * aliases onto the scale so existing screens keep their current appearance.
 */
type TypographyToken =
  | 'display'
  | 'title'
  | 'headline'
  | 'subtitle'
  | 'bodyLarge'
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  // Legacy aliases, kept so no screen has to change to adopt the scale.
  | 'sectionTitle'
  | 'groupLabel'
  | 'emphasis'
  | 'hint';

const BASE_TYPOGRAPHY: Record<TypographyToken, TextStyle> = {
  /** M3 `headlineMedium`: large-title header ("Chats", "Calls"). */
  display: { fontSize: 28, lineHeight: 36, fontWeight: '700' },
  /** M3 `titleLarge`: screen title, and the call canvas' peer name. */
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  /** M3 `titleMedium`: card / section heading, list-row primary at emphasis. */
  headline: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  /** M3 `bodyLarge` at title weight: list-row primary text. */
  subtitle: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  /** M3 `bodyLarge`: message bodies and other primary running text. */
  bodyLarge: { fontSize: 16, lineHeight: 24 },
  /** M3 `bodyMedium`: secondary running text, row descriptions. */
  body: { fontSize: 14, lineHeight: 20 },
  /** Body weight-emphasised, for a row that has unread content. */
  bodyStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  /** M3 `labelLarge`: button and control labels. */
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  /** M3 `labelMedium`: timestamps, tab labels, badge counts. */
  caption: { fontSize: 12, lineHeight: 16 },

  sectionTitle: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  groupLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  emphasis: { fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 16 },
};

/**
 * The live text style tokens every stylesheet spreads.
 *
 * **This object is mutated in place** by {@link setTextScale}, and that is
 * deliberate. Roughly a hundred style factories across `src/components` spread
 * `typography.body` at build time; threading a scaled copy through all of them
 * would mean touching every one of those call sites, and a text-size control
 * that only reached the screens that had been migrated would be a half-dead
 * control. Mutating the single object every factory already reads, and then
 * invalidating the themed-stylesheet cache (see `ThemeContext`), makes one
 * setting apply everywhere at once.
 *
 * The sizes are always recomputed from {@link BASE_TYPOGRAPHY}, never from the
 * current values, so repeated changes cannot drift.
 */
export const typography: Record<TypographyToken, TextStyle> = cloneTypography(BASE_TYPOGRAPHY);

let activeTextScale: TextScale = TEXT_SCALES.DEFAULT;
let typographyRevision = 0;

/** Shallow-copy the token table so callers cannot alias `BASE_TYPOGRAPHY`. */
function cloneTypography(source: Record<TypographyToken, TextStyle>): Record<TypographyToken, TextStyle> {
  return Object.fromEntries(
    Object.entries(source).map(([token, style]) => [token, { ...style }]),
  ) as Record<TypographyToken, TextStyle>;
}

/**
 * Apply an in-app text size, rescaling every token's `fontSize` and
 * `lineHeight` together.
 *
 * Line heights are scaled by the same factor rather than left alone, because
 * the scale states them explicitly so that vertical rhythm is the design's
 * decision — growing the glyphs inside a fixed line box would just crowd them.
 *
 * @returns whether anything changed, so a caller can skip a needless re-render.
 */
export function setTextScale(scale: TextScale): boolean {
  const next = TEXT_SCALE_VALUES.includes(scale) ? scale : TEXT_SCALES.DEFAULT;
  if (next === activeTextScale) return false;

  const factor = TEXT_SCALE_FACTORS[next];
  (Object.keys(BASE_TYPOGRAPHY) as TypographyToken[]).forEach(token => {
    const base = BASE_TYPOGRAPHY[token];
    const live = typography[token];
    if (typeof base.fontSize === 'number') live.fontSize = Math.round(base.fontSize * factor);
    if (typeof base.lineHeight === 'number') live.lineHeight = Math.round(base.lineHeight * factor);
  });

  activeTextScale = next;
  typographyRevision += 1;
  return true;
}

/** The text size currently applied to {@link typography}. */
export function getTextScale(): TextScale {
  return activeTextScale;
}

/**
 * Bumped whenever {@link setTextScale} changes the tokens.
 *
 * `ThemeContext` keys its stylesheet cache on this, so a text-size change
 * rebuilds every stylesheet exactly once — a palette-only cache key would
 * happily serve styles built at the previous size.
 */
export function getTypographyRevision(): number {
  return typographyRevision;
}

/**
 * The unscaled token table, for tests and for documenting the scale itself.
 *
 * A copy, not the table {@link setTextScale} recomputes from: handing out the
 * original by reference would let one stray mutation silently rebase every
 * later text-size change, and the result would look like a wrong font size
 * rather than an error.
 */
export const baseTypography: Record<TypographyToken, TextStyle> = cloneTypography(BASE_TYPOGRAPHY);

/**
 * Cap on how far the OS font-size setting may scale a given text token.
 *
 * Applied as `maxFontSizeMultiplier` on text whose container cannot grow — a
 * badge count, a tab label, a fixed-height control deck — so 200% system type
 * degrades to "slightly smaller than requested" rather than to truncated or
 * clipped text. Running text (message bodies, row titles) is deliberately
 * absent: it scales without limit.
 */
export const fontScaleCaps = {
  /** Badge counts and other glyph-sized numerals inside a fixed circle. */
  badge: 1.3,
  /** Tab-bar labels, segmented-control labels, control-deck captions. */
  control: 1.4,
  /** Row timestamps, which sit beside a growing title. */
  meta: 1.6,
};

