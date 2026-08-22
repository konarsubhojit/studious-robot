import {
  palettes,
  resolveScheme,
  sizes,
  THEME_MODE_VALUES,
  THEME_MODES,
  touchSlop,
} from '../src/theme';

/** Relative luminance of a #rrggbb colour, per WCAG 2.1. */
function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['background', 'backgroundAlt', 'surface', 'surfaceRaised', 'surfaceControl'];
const FOREGROUNDS = [
  'textPrimary',
  'textSecondary',
  'textMuted',
  'accent',
  'accentValue',
  'danger',
  'success',
  'warning',
];

describe('theme palettes', () => {
  test('light and dark expose exactly the same tokens', () => {
    expect(Object.keys(palettes.light).sort()).toEqual(Object.keys(palettes.dark).sort());
  });

  test.each(['light', 'dark'])('%s text colours meet WCAG AA on every surface', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    FOREGROUNDS.forEach(fg => {
      SURFACES.forEach(bg => {
        const scale = (colors as Record<string, string>);
        expect(contrast(scale[fg], scale[bg])).toBeGreaterThanOrEqual(4.5);
      });
    });
  });

  test.each(['light', 'dark'])('%s accent buttons meet WCAG AA for their label', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    expect(contrast(colors.textOnAccent, colors.accentButton)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textOnAccent, colors.danger)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['light', 'dark'])('%s control borders meet the 3:1 non-text ratio', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    expect(contrast(colors.border, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.border, colors.background)).toBeGreaterThanOrEqual(3);
  });
});

describe('resolveScheme', () => {
  test('follows the OS scheme in system mode', () => {
    expect(resolveScheme(THEME_MODES.SYSTEM, 'light')).toBe('light');
    expect(resolveScheme(THEME_MODES.SYSTEM, 'dark')).toBe('dark');
  });

  test('honours a manual override regardless of the OS scheme', () => {
    expect(resolveScheme(THEME_MODES.LIGHT, 'dark')).toBe('light');
    expect(resolveScheme(THEME_MODES.DARK, 'light')).toBe('dark');
  });

  test('falls back to dark for unknown modes and an unknown OS scheme', () => {
    expect(resolveScheme('sepia', 'light')).toBe('light');
    expect(resolveScheme(THEME_MODES.SYSTEM, null)).toBe('dark');
    expect(resolveScheme(undefined, undefined)).toBe('dark');
  });

  test('THEME_MODE_VALUES lists every selectable mode', () => {
    expect(THEME_MODE_VALUES).toEqual(['system', 'light', 'dark']);
  });
});

describe('touchSlop', () => {
  test('grows a small control up to the minimum touch target', () => {
    expect(24 + 2 * touchSlop(24)).toBeGreaterThanOrEqual(sizes.minTouchTarget);
    expect(36 + 2 * touchSlop(36)).toBeGreaterThanOrEqual(sizes.minTouchTarget);
  });

  test('adds nothing to a control that already meets the target', () => {
    expect(touchSlop(sizes.minTouchTarget)).toBe(0);
    expect(touchSlop(72)).toBe(0);
  });
});
