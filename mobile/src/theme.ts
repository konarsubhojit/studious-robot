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
 * @param {string} [mode] - One of THEME_MODES.
 * @param {string|null} [systemScheme] - Value from `useColorScheme()`.
 * @returns {'light'|'dark'}
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
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 18,
  pill: 999,
};

/** Minimum recommended dimensions (dp) for reliable touch targets. */
export const sizes = {
  minTouchTarget: 56,
};

/**
 * `hitSlop` (dp, per edge) that grows a control rendered at `size` dp up to
 * `sizes.minTouchTarget`, so small icon buttons stay comfortably tappable
 * without inflating the visual design.
 *
 * @param {number} size - Rendered width/height of the control, in dp.
 * @returns {number} slop to apply on every edge (0 when the control is already big enough).
 */
export function touchSlop(size: number): number {
  return Math.max(0, Math.ceil((sizes.minTouchTarget - size) / 2));
}

/**
 * Text style tokens. Typed as React Native text styles so spreading a token
 * into a `StyleSheet.create` entry keeps its literal `fontWeight` type.
 *
 * @type {Record<
 *   'title'|'sectionTitle'|'groupLabel'|'body'|'label'|'emphasis'|'hint',
 *   import('react-native').TextStyle
 * >}
 */
export const typography: Record<'title' | 'sectionTitle' | 'groupLabel' | 'body' | 'label' | 'emphasis' | 'hint', import('react-native').TextStyle> = {
  title: { fontSize: 28, fontWeight: '600' },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  groupLabel: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  body: { fontSize: 14 },
  label: { fontWeight: '600' },
  emphasis: { fontWeight: '700' },
  hint: { fontSize: 12 },
};
