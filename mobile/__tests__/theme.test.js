import { theme, fontSizes, iconButton, opacity, elevation, typography } from '../src/theme';

describe('theme design tokens', () => {
  test('exposes a typography scale derived from font-size tokens', () => {
    expect(typography.title.fontSize).toBe(fontSizes.xl);
    expect(typography.body.fontSize).toBe(fontSizes.sm);
    expect(typography.hint.fontSize).toBe(fontSizes.xs);
  });

  test('exposes accessible icon-button hit targets (>= 44pt for md)', () => {
    expect(iconButton.md).toBeGreaterThanOrEqual(44);
  });

  test('exposes an opacity scale', () => {
    expect(opacity.disabled).toBeGreaterThan(0);
    expect(opacity.pressed).toBeLessThanOrEqual(1);
  });

  test('exposes cross-platform elevation presets', () => {
    expect(elevation.low.elevation).toBeDefined();
    expect(elevation.medium.shadowRadius).toBeGreaterThan(0);
  });

  test('aggregates all token groups under the default theme export', () => {
    expect(theme.colors).toBeDefined();
    expect(theme.spacing).toBeDefined();
    expect(theme.iconButton).toBeDefined();
    expect(theme.elevation).toBeDefined();
    expect(theme.durations).toBeDefined();
  });
});
