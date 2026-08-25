import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { useThemedStyles } from '../src/ThemeContext';
import { palettes } from '../src/theme';
import type { ThemeColors } from '../src/theme';

/**
 * `useThemedStyles` caches built stylesheets per `(factory, palette)` pair at
 * module scope, not just per component instance. Without it, every mount of a
 * list row re-ran its style factory and allocated a fresh stylesheet, and a
 * theme switch re-ran every factory in the app.
 */
describe('useThemedStyles caching', () => {
  test('builds a factory once per palette, however many components use it', () => {
    const factory = jest.fn((colors: ThemeColors) => ({
      box: { backgroundColor: colors.background },
    }));

    const results: unknown[] = [];
    function Probe() {
      results.push(useThemedStyles(factory));
      return null;
    }

    act(() => {
      renderer.create(
        <>
          <Probe />
          <Probe />
          <Probe />
        </>,
      );
    });

    expect(results).toHaveLength(3);
    // Built once, then reused.
    expect(factory).toHaveBeenCalledTimes(1);
    // And every consumer got the identical object, so a `StyleSheet` prop is
    // referentially stable across components and across remounts.
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  test('a remount reuses the previously built stylesheet', () => {
    const factory = jest.fn((colors: ThemeColors) => ({
      box: { backgroundColor: colors.background },
    }));

    const results: unknown[] = [];
    function Probe() {
      results.push(useThemedStyles(factory));
      return null;
    }

    let tree: any;
    act(() => {
      tree = renderer.create(<Probe />);
    });
    act(() => {
      tree.unmount();
    });
    act(() => {
      renderer.create(<Probe />);
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
  });

  test('different palettes never share a cached stylesheet', () => {
    const factory = (colors: ThemeColors) => ({ box: { backgroundColor: colors.background } });

    // Exercised directly through the cache rather than through a provider, so
    // the two palettes are unambiguously distinct objects.
    const dark = renderWith(factory, palettes.dark);
    const light = renderWith(factory, palettes.light);

    expect(dark).not.toBe(light);
    expect(dark.box.backgroundColor).toBe(palettes.dark.background);
    expect(light.box.backgroundColor).toBe(palettes.light.background);
  });
});

/**
 * Render a probe that reads `useThemedStyles` under an explicitly supplied
 * palette.
 */
function renderWith(factory: (colors: ThemeColors) => any, colors: ThemeColors) {
  const ThemeContext = require('../src/ThemeContext').default;
  const { buildTheme } = require('../src/ThemeContext');
  let captured: any;

  function Probe() {
    captured = useThemedStyles(factory);
    return null;
  }

  const theme = { ...buildTheme('system', 'dark', () => {}), colors };
  act(() => {
    renderer.create(
      <ThemeContext.Provider value={theme}>
        <Probe />
      </ThemeContext.Provider>,
    );
  });

  return captured;
}
