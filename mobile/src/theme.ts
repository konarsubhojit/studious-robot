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

const darkColors = {
  // Backgrounds / surfaces (midnight blue)
  background: '#0b1020',
  backgroundAlt: '#121a2e',
  surface: '#17213b',
  surfaceRaised: '#1d2947',
  surfaceControl: '#243154',
  surfaceBanner: '#2a3a63',
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

const lightColors = {
  // Backgrounds / surfaces (cool daylight)
  background: '#f4f6fb',
  backgroundAlt: '#e8edf7',
  surface: '#ffffff',
  surfaceRaised: '#f1f4fb',
  surfaceControl: '#e0e7f5',
  surfaceBanner: '#d5def2',
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

/** Selectable appearance modes surfaced in Settings. */
export const THEME_MODES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
};

export const THEME_MODE_VALUES = [THEME_MODES.SYSTEM, THEME_MODES.LIGHT, THEME_MODES.DARK];

/**
 * Resolve the palette to render with from the user's preference and the OS
 * colour scheme.  Unknown modes (e.g. a corrupt persisted value) and an
 * unknown system scheme both fall back to the dark scheme the app shipped
 * with.
 *
 * @param mode - One of THEME_MODES.
 * @param systemScheme - Value from `useColorScheme()`.
 */
export function resolveScheme(mode?: string, systemScheme?: string | null): 'light' | 'dark' {
  if (mode === THEME_MODES.LIGHT) return 'light';
  if (mode === THEME_MODES.DARK) return 'dark';
  return systemScheme === 'light' ? 'light' : 'dark';
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
  minTouchTarget: 56,
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
  | 'body'
  | 'bodyStrong'
  | 'label'
  | 'caption'
  // Legacy aliases, kept so no screen has to change to adopt the scale.
  | 'sectionTitle'
  | 'groupLabel'
  | 'emphasis'
  | 'hint';

export const typography: Record<TypographyToken, TextStyle> = {
  /** Large-title header ("Chats", "Calls"), and the call canvas' peer name. */
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  /** Screen title. */
  title: { fontSize: 28, lineHeight: 34, fontWeight: '600' },
  /** Card / section heading, list-row primary text at emphasis. */
  headline: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  /** List-row primary text. */
  subtitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  /** Default running text: message bodies, row secondary text. */
  body: { fontSize: 14, lineHeight: 20 },
  /** Body weight-emphasised, for a row that has unread content. */
  bodyStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  /** Button and control labels. */
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
  /** Timestamps, hints, badge counts. */
  caption: { fontSize: 12, lineHeight: 16 },

  sectionTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  groupLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  emphasis: { fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 16 },
};

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

