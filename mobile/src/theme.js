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

  // Borders
  border: '#33456f',
  borderStage: '#3a4d7c',
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

export const typography = {
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

export const theme = { colors, spacing, radius, typography };

export default theme;
