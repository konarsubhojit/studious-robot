import {
  baseTypography,
  buildPalette,
  DEFAULT_THEME_PREFERENCES,
  getTextScale,
  normalizeThemePreferences,
  overlay,
  palettes,
  resolveScheme,
  sizes,
  resolveContrast,
  setTextScale,
  TEXT_SCALE_FACTORS,
  TEXT_SCALE_VALUES,
  TEXT_SCALES,
  THEME_ACCENT_VALUES,
  THEME_ACCENTS,
  THEME_CONTRASTS,
  THEME_MODE_VALUES,
  THEME_MODES,
  touchSlop,
  typography,
} from '../src/theme';
import type { ThemeAccent, ThemeColors, TextScale } from '../src/theme';
import type { ThemeMode } from '../src/theme';

/** Relative luminance of a #rrggbb colour, per WCAG 2.1. */
function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Flatten `rgba(r, g, b, a)` onto an opaque `#rrggbb` backdrop, so a
 * translucent overlay can be measured for contrast like any other colour.
 */
function composite(rgba: string, backdrop: string) {
  const parts = rgba.match(/[\d.]+/g);
  if (!parts || parts.length < 4) throw new Error(`not an rgba() colour: ${rgba}`);
  const [r, g, b, alpha] = parts.map(Number);
  const back = [1, 3, 5].map(i => parseInt(backdrop.slice(i, i + 2), 16));
  const mixed = [r, g, b].map((channel, i) =>
    Math.round(channel * alpha + back[i] * (1 - alpha)),
  );
  return `#${mixed.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['background', 'backgroundAlt', 'surface', 'surfaceRaised', 'surfaceControl'];

/**
 * The surfaces a tinted notice can end up sitting on.
 *
 * `Banner`'s warning and negative tones *replace* its own `surfaceRaised` fill
 * with a translucent tint, so the tint composites over whatever the screen puts
 * behind it rather than over the banner's base. Today every call site resolves
 * to `background` — `AppShell` and `CallsScreen` set it explicitly, and
 * `SearchScreen` and `ChatConversationScreen` have transparent roots that
 * inherit it — but `surface` and `surfaceRaised` are asserted too so a screen
 * that raises its own background later cannot silently drop a tone below AA.
 */
const TINTED_NOTICE_SURFACES = ['background', 'surface', 'surfaceRaised'];
const FOREGROUNDS = [
  'textPrimary',
  'textSecondary',
  'textMuted',
  'accent',
  'accentValue',
  'danger',
  'success',
  'warning',
  // Semantic aliases layered over the raw palette. They point at the tokens
  // above today, but the pairing has to be asserted independently or a future
  // retune of, say, `positive` could silently break contrast everywhere the
  // alias is used.
  'onSurface',
  'onSurfaceVariant',
  'positive',
  'negative',
  'notice',
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
    // Badges and the success-variant icon button paint their foreground on
    // these too. `'#fff'` used to be hardcoded at those call sites, which fails
    // outright against the dark scheme's bright `danger`/`success`.
    expect(contrast(colors.textOnAccent, colors.success)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['light', 'dark'])('%s overlay content stays legible in both schemes', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    // The scrims are drawn over `stage`, which is dark in both schemes, so the
    // worst case for the foreground is the *lightest* composite: the softest
    // scrim over the lightest thing it can sit on.
    const scrims = [overlay.scrimSoft, overlay.scrimMedium, overlay.scrimStrong];
    scrims.forEach(value => {
      expect(contrast(colors.onOverlay, composite(value, colors.stage))).toBeGreaterThanOrEqual(4.5);
    });
    // `textPrimary` inverts between schemes, so pairing it with an overlay is
    // the bug `onOverlay` exists to prevent — assert the difference is real.
    expect(contrast(colors.onOverlay, composite(overlay.scrimStrong, colors.stage))).toBeGreaterThan(
      contrast(palettes.light.textPrimary, composite(overlay.scrimStrong, colors.stage)),
    );
  });

  test.each(['light', 'dark'])('%s control borders meet the 3:1 non-text ratio', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    expect(contrast(colors.border, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.border, colors.background)).toBeGreaterThanOrEqual(3);
    // `outline` is the semantic alias screens now reach for; it has to clear
    // the same bar as the raw token it fronts.
    expect(contrast(colors.outline, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.outline, colors.background)).toBeGreaterThanOrEqual(3);
  });

  test.each(['light', 'dark'])('%s audio-call canvas keeps its content legible', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    // `ambient` backs the audio-call canvas and, like `stage`, stays dark in
    // both schemes — so its foreground is `onOverlay`, never `textPrimary`.
    expect(contrast(colors.onOverlay, colors.ambient)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.onOverlay, colors.ambient)).toBeGreaterThan(
      contrast(palettes.light.textPrimary, colors.ambient),
    );
  });

  test.each(['light', 'dark'])('%s Banner tones stay legible on every surface a banner sits on', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    const scale = (colors as Record<string, string>);
    // Banner copy is `typography.hint` — small, so the bar is the full 4.5:1
    // rather than the 3:1 large-text allowance. The tightest pairing in the
    // theme today is dark `danger` over `tintDanger` on `surfaceRaised` at
    // 4.60:1, so that is where the headroom runs out first if these are retuned.
    TINTED_NOTICE_SURFACES.forEach(bg => {
      expect(contrast(colors.warning, composite(colors.tintWarning, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.danger, composite(colors.tintDanger, scale[bg]))).toBeGreaterThanOrEqual(4.5);
    });
    // The `neutral` and `accent` tones keep the opaque `surfaceRaised` fill and
    // the default `textSecondary` copy, so there is nothing to flatten.
    expect(contrast(colors.textSecondary, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['light', 'dark'])("%s Banner's accent rule meets the 3:1 non-text ratio", scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    const scale = (colors as Record<string, string>);
    // Tone `accent` carries no tint and no icon: the 3dp left border is the
    // *only* thing marking the banner, which makes it a non-text indicator that
    // has to clear 3:1 against the banner's own fill…
    expect(contrast(colors.accent, colors.surfaceRaised)).toBeGreaterThanOrEqual(3);
    // …and against the surface the banner is drawn on, since the rule runs the
    // full height of the banner edge and is read against both.
    TINTED_NOTICE_SURFACES.forEach(bg => {
      expect(contrast(colors.accent, scale[bg])).toBeGreaterThanOrEqual(3);
    });
  });

  test.each(['light', 'dark'])('%s Toast tones stay legible over their tint', scheme => {
    const colors = palettes[(scheme as 'light'|'dark')];
    const scale = (colors as Record<string, string>);
    // `Toast` has no call site yet, so there is no single surface to measure
    // against — it is checked over the same set as `Banner` so the pairing is
    // already proven whenever a screen does mount one. `tintSuccess` has no
    // other consumer, and would otherwise ship completely unasserted.
    TINTED_NOTICE_SURFACES.forEach(bg => {
      expect(contrast(colors.positive, composite(colors.tintSuccess, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.negative, composite(colors.tintDanger, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      // The optional action label keeps `accentValue` on top of the tone tint.
      expect(contrast(colors.accentValue, composite(colors.tintSuccess, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accentValue, composite(colors.tintDanger, scale[bg]))).toBeGreaterThanOrEqual(4.5);
    });
    // Tone `info` keeps the untinted fill.
    expect(contrast(colors.onSurface, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  });

  test('notice tints stay translucent so they take the surface behind them', () => {
    // The assertions above are only meaningful while these are `rgba()`: if a
    // tint were ever flattened to a hex the composite would be a no-op and the
    // tone would quietly stop tracking the surface it is drawn on.
    (['light', 'dark'] as const).forEach(scheme => {
      const colors = palettes[scheme];
      [colors.tintWarning, colors.tintDanger, colors.tintSuccess].forEach(tint => {
        expect(tint).toMatch(/^rgba\(/);
      });
    });
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
    expect(resolveScheme(('sepia' as ThemeMode), 'light')).toBe('light');
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

/**
 * Flatten a colour to an opaque `#rrggbb` over a backdrop, whether or not it is
 * translucent. The cross-product assertions below run over palette variants
 * that may state a tint either way, so they cannot assume `rgba()`.
 */
function flatten(color: string, backdrop: string) {
  return color.startsWith('rgba') ? composite(color, backdrop) : color;
}

/** Every palette variant a user can select, as `(label, palette)` pairs. */
function everyVariant(): Array<[string, ThemeColors]> {
  const variants: Array<[string, ThemeColors]> = [];
  (['light', 'dark'] as const).forEach(scheme => {
    (['standard', 'high'] as const).forEach(contrastLevel => {
      THEME_ACCENT_VALUES.forEach((accent: ThemeAccent) => {
        [false, true].forEach(trueBlack => {
          // True black is a dark-scheme treatment; in light it is a no-op and
          // would only duplicate the variant above it.
          if (trueBlack && scheme === 'light') return;
          variants.push([
            `${scheme}/${contrastLevel}/${accent}${trueBlack ? '/true-black' : ''}`,
            buildPalette({ scheme, contrast: contrastLevel, accent, trueBlack }),
          ]);
        });
      });
    });
  });
  return variants;
}

describe('palette variants', () => {
  test('there is a variant for every combination a user can select', () => {
    // 2 schemes x 2 contrasts x 5 accents, plus true black on the dark half.
    expect(everyVariant()).toHaveLength(30);
  });

  test('the default variant is the shipped palette itself', () => {
    // Identity, not equality: `useThemedStyles` caches stylesheets keyed on the
    // palette object, so a default-preferences user must keep hitting the same
    // cache entries every isolated component already built.
    expect(buildPalette({ scheme: 'dark' })).toBe(palettes.dark);
    expect(buildPalette({ scheme: 'light' })).toBe(palettes.light);
    expect(
      buildPalette({ scheme: 'dark', contrast: 'standard', accent: THEME_ACCENTS.DEFAULT }),
    ).toBe(palettes.dark);
  });

  test('a variant is built once and thereafter returned by identity', () => {
    const first = buildPalette({ scheme: 'dark', accent: THEME_ACCENTS.TEAL });
    expect(buildPalette({ scheme: 'dark', accent: THEME_ACCENTS.TEAL })).toBe(first);
  });

  test('true black has no effect in the light scheme', () => {
    expect(buildPalette({ scheme: 'light', trueBlack: true })).toBe(palettes.light);
  });

  test('true black takes the base surface to black without flattening the stack', () => {
    const black = buildPalette({ scheme: 'dark', trueBlack: true });
    expect(black.background).toBe('#000000');
    // Elevation still has to read: a card and the page behind it are two
    // things, and collapsing every surface to black erases the difference.
    const stack = [black.background, black.surface, black.surfaceRaised, black.surfaceControl];
    expect(new Set(stack).size).toBe(stack.length);
  });

  test.each(everyVariant())('%s exposes exactly the shipped token set', (_label, colors) => {
    // A variant that forgot a token would fall back to `undefined` at the call
    // site, which React Native renders as "no colour" rather than as an error.
    expect(Object.keys(colors).sort()).toEqual(Object.keys(palettes.dark).sort());
  });

  test.each(everyVariant())('%s keeps text legible on every surface', (_label, colors) => {
    const scale = (colors as unknown as Record<string, string>);
    FOREGROUNDS.forEach(fg => {
      SURFACES.forEach(bg => {
        expect(contrast(scale[fg], scale[bg])).toBeGreaterThanOrEqual(4.5);
      });
    });
  });

  test.each(everyVariant())('%s keeps accent controls legible', (_label, colors) => {
    expect(contrast(colors.textOnAccent, colors.accentButton)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textOnAccent, colors.danger)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textOnAccent, colors.success)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(everyVariant())('%s keeps control borders at the 3:1 non-text ratio', (_label, colors) => {
    [colors.border, colors.outline].forEach(line => {
      expect(contrast(line, colors.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(line, colors.background)).toBeGreaterThanOrEqual(3);
    });
  });

  test.each(everyVariant())('%s keeps notice tones legible over their tint', (_label, colors) => {
    const scale = (colors as unknown as Record<string, string>);
    TINTED_NOTICE_SURFACES.forEach(bg => {
      expect(contrast(colors.warning, flatten(colors.tintWarning, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.danger, flatten(colors.tintDanger, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.positive, flatten(colors.tintSuccess, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accentValue, flatten(colors.tintSuccess, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.accentValue, flatten(colors.tintDanger, scale[bg]))).toBeGreaterThanOrEqual(4.5);
      // The `accent` tone's 3dp rule is the only mark on that banner.
      expect(contrast(colors.accent, scale[bg])).toBeGreaterThanOrEqual(3);
    });
  });

  test.each(everyVariant())('%s keeps overlay content legible over the fixed-dark stage', (_label, colors) => {
    [overlay.scrimSoft, overlay.scrimMedium, overlay.scrimStrong].forEach(scrim => {
      expect(contrast(colors.onOverlay, composite(scrim, colors.stage))).toBeGreaterThanOrEqual(4.5);
    });
    expect(contrast(colors.onOverlay, colors.ambient)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(
    everyVariant().filter(([label]) => label.includes('/high/')),
  )('%s clears AAA for body text, which is the point of it', (_label, colors) => {
    const scale = (colors as unknown as Record<string, string>);
    // High contrast that only matched the standard palette's 4.5:1 would be a
    // control that changes nothing.
    ['textPrimary', 'textSecondary', 'textMuted', 'onSurface', 'onSurfaceVariant'].forEach(fg => {
      SURFACES.forEach(bg => {
        expect(contrast(scale[fg], scale[bg])).toBeGreaterThanOrEqual(7);
      });
    });
    // …and its borders clear the text bar rather than the non-text one.
    [colors.border, colors.outline].forEach(line => {
      expect(contrast(line, colors.background)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('theme preferences', () => {
  test('the defaults are the appearance the app shipped with', () => {
    expect(DEFAULT_THEME_PREFERENCES).toEqual({
      mode: THEME_MODES.SYSTEM,
      contrast: THEME_CONTRASTS.SYSTEM,
      accent: THEME_ACCENTS.DEFAULT,
      trueBlack: false,
      textScale: TEXT_SCALES.DEFAULT,
    });
    expect(
      buildPalette({
        scheme: 'dark',
        contrast: resolveContrast(DEFAULT_THEME_PREFERENCES.contrast, false),
        accent: DEFAULT_THEME_PREFERENCES.accent,
        trueBlack: DEFAULT_THEME_PREFERENCES.trueBlack,
      }),
    ).toBe(palettes.dark);
  });

  test('every field falls back on its own', () => {
    // A corrupt accent must not also discard a pinned dark mode.
    expect(
      normalizeThemePreferences({
        mode: 'dark',
        contrast: 'lurid',
        accent: 'chartreuse',
        trueBlack: 'yes',
        textScale: 'large',
      }),
    ).toEqual({
      mode: 'dark',
      contrast: THEME_CONTRASTS.SYSTEM,
      accent: THEME_ACCENTS.DEFAULT,
      trueBlack: false,
      textScale: TEXT_SCALES.LARGE,
    });
  });

  test('a non-object yields the defaults rather than throwing', () => {
    expect(normalizeThemePreferences(null)).toEqual(DEFAULT_THEME_PREFERENCES);
    expect(normalizeThemePreferences('nonsense')).toEqual(DEFAULT_THEME_PREFERENCES);
  });
});

describe('resolveContrast', () => {
  test('defers to the OS until the user chooses', () => {
    expect(resolveContrast(THEME_CONTRASTS.SYSTEM, true)).toBe('high');
    expect(resolveContrast(THEME_CONTRASTS.SYSTEM, false)).toBe('standard');
    expect(resolveContrast(undefined, true)).toBe('high');
  });

  test('an explicit choice outranks the OS setting in both directions', () => {
    expect(resolveContrast(THEME_CONTRASTS.STANDARD, true)).toBe('standard');
    expect(resolveContrast(THEME_CONTRASTS.HIGH, false)).toBe('high');
  });
});

describe('text size', () => {
  afterEach(() => {
    setTextScale(TEXT_SCALES.DEFAULT);
  });

  test('the default scale leaves the shipped sizes untouched', () => {
    expect(getTextScale()).toBe(TEXT_SCALES.DEFAULT);
    expect(typography.body).toEqual(baseTypography.body);
  });

  test.each(TEXT_SCALE_VALUES)('%s scales font size and line height together', scale => {
    setTextScale((scale as TextScale));
    const factor = TEXT_SCALE_FACTORS[(scale as TextScale)];

    (Object.keys(baseTypography) as Array<keyof typeof baseTypography>).forEach(token => {
      const base = baseTypography[token];
      const live = typography[token];
      if (typeof base.fontSize === 'number') {
        expect(live.fontSize).toBe(Math.round(base.fontSize * factor));
      }
      if (typeof base.lineHeight === 'number') {
        expect(live.lineHeight).toBe(Math.round(base.lineHeight * factor));
        // A line box that stops growing with its glyphs crowds them; the whole
        // reason the scale states line heights is that they are a decision.
        // 1.15 rather than the usual 1.2 because `display` ships at 32/38 —
        // large type is set tighter on purpose — and rounding at each step can
        // cost another hundredth.
        expect(live.lineHeight).toBeGreaterThanOrEqual((live.fontSize as number) * 1.15);
      }
    });
  });

  test('sizes are recomputed from the base, so repeated changes cannot drift', () => {
    setTextScale(TEXT_SCALES.LARGER);
    setTextScale(TEXT_SCALES.SMALL);
    setTextScale(TEXT_SCALES.LARGE);
    expect(typography.body.fontSize).toBe(
      Math.round((baseTypography.body.fontSize as number) * TEXT_SCALE_FACTORS.large),
    );
  });

  test('reports whether anything changed, so a no-op cannot force a re-render', () => {
    expect(setTextScale(TEXT_SCALES.LARGE)).toBe(true);
    expect(setTextScale(TEXT_SCALES.LARGE)).toBe(false);
  });

  test('an unknown scale falls back to the default rather than mangling the tokens', () => {
    setTextScale(('gigantic' as TextScale));
    expect(getTextScale()).toBe(TEXT_SCALES.DEFAULT);
    expect(typography.body).toEqual(baseTypography.body);
  });
});
