/**
 * Centralised design tokens for the WeTalk UI.
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
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 18,
  pill: 999,
};

export const typography = {
  title: { fontSize: 28, fontWeight: '600' },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 14 },
  label: { fontWeight: '600' },
  emphasis: { fontWeight: '700' },
  hint: { fontSize: 12 },
};

export const theme = { colors, spacing, radius, typography };

export default theme;
