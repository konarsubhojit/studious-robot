import {
  overlay,
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
