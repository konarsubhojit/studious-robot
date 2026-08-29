import React from 'react';
import { AccessibilityInfo } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import AppearanceSettings from '../../src/components/AppearanceSettings';
import ThemeContext, { buildTheme } from '../../src/ThemeContext';
import {
  buildPalette,
  DEFAULT_THEME_PREFERENCES,
  TEXT_SCALES,
  THEME_ACCENTS,
  THEME_CONTRASTS,
  THEME_MODES,
} from '../../src/theme';
import type { ColorScheme, ResolvedContrast, ThemePreferences } from '../../src/theme';

function findByTestID(tree: any, id: string) {
  return tree.root.findAll((n: any) => n.props.testID === id);
}

/** Presses the composite that owns the handler, not its host descendants. */
function pressByTestID(tree: any, id: string) {
  const pressable = tree.root.findAll(
    (n: any) => n.props?.testID === id && typeof n.props?.onPress === 'function',
  )[0];
  act(() => {
    pressable.props.onPress();
  });
}

function render({
  preferences = {},
  scheme = 'dark' as ColorScheme,
  contrast = 'standard' as ResolvedContrast,
  setMode = jest.fn(),
  setPreference = jest.fn(),
}: {
  preferences?: Partial<ThemePreferences>;
  scheme?: ColorScheme;
  contrast?: ResolvedContrast;
  setMode?: jest.Mock;
  setPreference?: jest.Mock;
} = {}) {
  const merged: ThemePreferences = { ...DEFAULT_THEME_PREFERENCES, ...preferences };
  const theme = buildTheme(merged.mode, scheme, setMode, {
    preferences: merged,
    contrast,
    setPreference,
  });

  let tree: any;
  act(() => {
    tree = renderer.create(
      <ThemeContext.Provider value={theme}>
        <AppearanceSettings />
      </ThemeContext.Provider>,
    );
  });
  return { tree, setMode, setPreference };
}

describe('AppearanceSettings', () => {
  afterEach(() => jest.clearAllMocks());

  describe('appearance mode', () => {
    test('marks the active mode as selected', () => {
      const { tree } = render({ preferences: { mode: THEME_MODES.LIGHT }, scheme: 'light' });
      expect(findByTestID(tree, 'settings-theme-light')[0].props.accessibilityState).toEqual({
        selected: true,
        checked: true,
      });
      expect(findByTestID(tree, 'settings-theme-system')[0].props.accessibilityState).toEqual({
        selected: false,
        checked: false,
      });
    });

    test('choosing a mode calls setMode with it', () => {
      const { setMode } = render({ preferences: { mode: THEME_MODES.SYSTEM } });
      // Recreated through the same helper so the press hits the live tree.
      const { tree } = render({ preferences: { mode: THEME_MODES.SYSTEM }, setMode });
      pressByTestID(tree, 'settings-theme-dark');
      expect(setMode).toHaveBeenCalledWith(THEME_MODES.DARK);
    });
  });

  describe('accent colour', () => {
    test('offers every accent, each painted in the accent it applies', () => {
      const { tree } = render({ scheme: 'dark' });
      const teal = findByTestID(tree, 'settings-accent-teal')[0];
      const rose = findByTestID(tree, 'settings-accent-rose')[0];

      // A row of identically coloured swatches would make the choice invisible,
      // so each is painted from *its own* variant's palette.
      const flatten = (node: any) =>
        [node.props.style]
          .flat(3)
          .filter(Boolean)
          .reduce((acc: any, entry: any) => ({ ...acc, ...entry }), {});
      const tealStyle = flatten({ props: { style: teal.props.style({ pressed: false }) } });
      const roseStyle = flatten({ props: { style: rose.props.style({ pressed: false }) } });

      expect(tealStyle.backgroundColor).toBe(
        buildPalette({ scheme: 'dark', accent: THEME_ACCENTS.TEAL }).accentButton,
      );
      expect(roseStyle.backgroundColor).toBe(
        buildPalette({ scheme: 'dark', accent: THEME_ACCENTS.ROSE }).accentButton,
      );
      expect(tealStyle.backgroundColor).not.toBe(roseStyle.backgroundColor);
    });

    test('reports the selected accent as a radio, not just as a fill', () => {
      const { tree } = render({ preferences: { accent: THEME_ACCENTS.VIOLET } });
      expect(findByTestID(tree, 'settings-accent-violet')[0].props.accessibilityState).toEqual({
        selected: true,
        checked: true,
      });
      expect(findByTestID(tree, 'settings-accent-amber')[0].props.accessibilityState).toEqual({
        selected: false,
        checked: false,
      });
    });

    test('choosing an accent persists exactly that preference', () => {
      const { tree, setPreference } = render();
      pressByTestID(tree, 'settings-accent-amber');
      expect(setPreference).toHaveBeenCalledWith('accent', THEME_ACCENTS.AMBER);
    });
  });

  describe('text size', () => {
    test('marks the active step and persists a new one', () => {
      const { tree, setPreference } = render({ preferences: { textScale: TEXT_SCALES.LARGE } });
      expect(findByTestID(tree, 'settings-text-scale-large')[0].props.accessibilityState).toEqual({
        selected: true,
        checked: true,
      });

      pressByTestID(tree, 'settings-text-scale-larger');
      expect(setPreference).toHaveBeenCalledWith('textScale', TEXT_SCALES.LARGER);
    });
  });

  describe('high contrast', () => {
    test('reports the resolved contrast, so an OS-driven one shows as on', () => {
      const { tree } = render({
        preferences: { contrast: THEME_CONTRASTS.SYSTEM },
        contrast: 'high',
      });
      const control = tree.root.findAll(
        (n: any) =>
          n.props?.testID === 'settings-high-contrast' && n.props?.accessibilityState !== undefined,
      )[0];
      expect(control.props.accessibilityState).toEqual(
        expect.objectContaining({ checked: true }),
      );
    });

    test('touching it pins an explicit choice rather than leaving it on the OS', () => {
      const { tree, setPreference } = render({
        preferences: { contrast: THEME_CONTRASTS.SYSTEM },
        contrast: 'high',
      });
      pressByTestID(tree, 'settings-high-contrast');
      expect(setPreference).toHaveBeenCalledWith('contrast', THEME_CONTRASTS.STANDARD);
    });
  });

  describe('true black', () => {
    test('is offered in the dark scheme', () => {
      const { tree, setPreference } = render({ scheme: 'dark' });
      pressByTestID(tree, 'settings-true-black');
      expect(setPreference).toHaveBeenCalledWith('trueBlack', true);
    });

    test('is hidden in the light scheme rather than shipped as a dead control', () => {
      const { tree } = render({ preferences: { mode: THEME_MODES.LIGHT }, scheme: 'light' });
      expect(findByTestID(tree, 'settings-true-black')).toHaveLength(0);
    });
  });

  describe('preview', () => {
    test('shows the surfaces the choices change', () => {
      const { tree } = render();
      expect(findByTestID(tree, 'settings-appearance-preview').length).toBeGreaterThan(0);
    });

    test('is hidden from assistive technology, being a picture of a chat and not one', () => {
      const { tree } = render();
      const preview = findByTestID(tree, 'settings-appearance-preview')[0];
      expect(preview.props.accessibilityElementsHidden).toBe(true);
      expect(preview.props.importantForAccessibility).toBe('no-hide-descendants');
    });
  });

  describe('announcements', () => {
    test('a change is spoken, since its confirmation is otherwise purely visual', () => {
      const announce = jest
        .spyOn(AccessibilityInfo, 'announceForAccessibility')
        .mockImplementation(() => {});

      const { tree } = render();
      pressByTestID(tree, 'settings-accent-teal');
      expect(announce).toHaveBeenCalledWith('Accent colour: Teal');

      pressByTestID(tree, 'settings-text-scale-small');
      expect(announce).toHaveBeenCalledWith('Text size: Small');

      pressByTestID(tree, 'settings-true-black');
      expect(announce).toHaveBeenCalledWith('True black: On');

      announce.mockRestore();
    });
  });
});
