import { readFileSync } from 'fs';
import path from 'path';
import { palettes } from '../src/theme';

/**
 * The one place a palette colour is legitimately duplicated outside
 * `src/theme.ts`.
 *
 * The Android window is created and painted before any JavaScript runs, so the
 * colour of that first frame has to be stated in a resource file. Nothing in
 * the build makes the two agree, and a drifted value is invisible in review and
 * on every warm start — it only shows as a flash of the *previous* palette on a
 * cold launch, which is exactly the defect the resource was added to fix.
 *
 * So the agreement is asserted here instead.
 */
const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

/** The `windowBackground` colour declared in a resource directory. */
function windowBackground(dir: string): string {
  const xml = readFileSync(path.join(RES_DIR, dir, 'colors.xml'), 'utf8');
  const match = xml.match(/<color name="windowBackground">\s*(#[0-9a-fA-F]{6,8})\s*<\/color>/);
  if (!match) throw new Error(`no windowBackground colour in ${dir}/colors.xml`);
  return match[1].toLowerCase();
}

/** The `AppTheme` style body from a resource directory. */
function appTheme(dir: string): string {
  return readFileSync(path.join(RES_DIR, dir, 'styles.xml'), 'utf8');
}

describe('android window background', () => {
  test('the day resource matches the light palette', () => {
    expect(windowBackground('values')).toBe(palettes.light.background.toLowerCase());
  });

  test('the night resource matches the dark palette', () => {
    expect(windowBackground('values-night')).toBe(palettes.dark.background.toLowerCase());
  });

  test('every AppTheme variant paints the window and both system bars', () => {
    // Android replaces the *whole* style for a qualified configuration, so the
    // `-v27` variants necessarily restate the base theme. Anything added to the
    // base theme therefore has to be added here too — and to this list.
    // A variant that overrides the theme but forgets one of these reintroduces
    // the flash on exactly the API levels it applies to.
    ['values', 'values-v27', 'values-night-v27'].forEach(dir => {
      const style = appTheme(dir);
      expect(style).toContain('android:windowBackground">@color/windowBackground');
      expect(style).toContain('android:statusBarColor">@color/windowBackground');
      expect(style).toContain('android:navigationBarColor">@color/windowBackground');
    });
  });

  test('system-bar icons are light-on-dark in night and dark-on-light in day', () => {
    expect(appTheme('values-v27')).toContain('android:windowLightStatusBar">true');
    expect(appTheme('values-v27')).toContain('android:windowLightNavigationBar">true');
    expect(appTheme('values-night-v27')).toContain('android:windowLightStatusBar">false');
    expect(appTheme('values-night-v27')).toContain('android:windowLightNavigationBar">false');
  });
});
