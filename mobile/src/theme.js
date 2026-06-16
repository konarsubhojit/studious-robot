/**
 * Centralised design tokens for the TCalling UI.
 *
 * Colours, spacing, radii and typography were previously hardcoded and
 * repeated across the inline `StyleSheet` in `App.js`.  Collecting them here
 * gives every component a single source of truth and makes future theming
 * (for example a light/dark toggle) tractable.  The values intentionally match
 * the original "warm & cozy" palette so the visual result is unchanged.
 */

export const colors = {
  // Backgrounds / surfaces (warm dark browns)
  background: '#2d2329',
  backgroundAlt: '#2e242a',
  surface: '#45313a',
  surfaceRaised: '#3d2d35',
  surfaceControl: '#4b3741',
  surfaceBanner: '#5a434d',
  stage: '#3a2c34',
  stageDark: '#201a1e',
  pipBackground: '#1f171c',

  // Borders
  border: '#6d5057',
  borderStage: '#7d5962',
  borderInactiveBar: '#78606b',

  // Text
  textPrimary: '#fff5e8',
  textSecondary: '#dec8b5',
  textMuted: '#f1ddcb',
  textOnAccent: '#3a2127',

  // Accents / semantic
  accent: '#ffd4a3',
  accentButton: '#f3cfa9',
  accentValue: '#ffd4a3',
  danger: '#f08d89',
  success: '#8be7a5',
  warning: '#ffd9a8',
  blob: '#f9d2a8',
};

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

/**
 * Modular font-size and line-height scale.  Components should reference these
 * tokens instead of hardcoding `fontSize` so typography stays consistent and
 * Dynamic Type scaling can be reasoned about in one place.
 */
export const fontSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 28,
};

export const lineHeights = {
  xs: 16,
  sm: 20,
  md: 22,
  lg: 26,
  xl: 34,
};

export const fontWeights = {
  regular: '400',
  medium: '600',
  bold: '700',
};

/** Opacity scale for disabled / pressed / decorative states. */
export const opacity = {
  disabled: 0.55,
  pressed: 0.88,
  decorative: 0.14,
};

/** Square hit targets for icon buttons (min 44pt for accessibility). */
export const iconButton = {
  sm: 36,
  md: 44,
  lg: 56,
};

/** Animation durations (ms) for consistent motion across the app. */
export const durations = {
  fast: 150,
  base: 250,
  slow: 400,
};

/**
 * Elevation presets (cross-platform shadow tokens).  Spreading one of these
 * into a style gives a consistent raised look on both iOS (shadow*) and
 * Android (elevation).
 */
export const elevation = {
  low: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 2,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 6,
  },
};

export const typography = {
  title: { fontSize: fontSizes.xl, lineHeight: lineHeights.xl, fontWeight: fontWeights.medium },
  sectionTitle: { fontSize: fontSizes.md, lineHeight: lineHeights.md, fontWeight: fontWeights.bold },
  body: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm },
  label: { fontWeight: fontWeights.medium },
  emphasis: { fontWeight: fontWeights.bold },
  hint: { fontSize: fontSizes.xs, lineHeight: lineHeights.xs },
};

export const theme = {
  colors,
  spacing,
  radius,
  fontSizes,
  lineHeights,
  fontWeights,
  opacity,
  iconButton,
  durations,
  elevation,
  typography,
};

export default theme;
