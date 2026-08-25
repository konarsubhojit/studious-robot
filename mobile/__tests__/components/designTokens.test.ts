import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Design-system guard.
 *
 * Colours were repeatedly reintroduced as literals inside component
 * stylesheets — `'#fff'` on a `colors.danger` badge (illegible against the dark
 * scheme's bright `danger`), `colors.textPrimary` on a fixed-dark video scrim
 * (invisible in the light scheme), `'rgba(0,0,0,0.45)'` copied between five
 * files at four slightly different opacities.
 *
 * Every one of those is a *palette* decision, so the palette has to be the only
 * place they are written. This test fails the build if a component spells a
 * colour itself instead of reading a token from `src/theme.ts`.
 */

const COMPONENTS_DIR = path.join(__dirname, '..', '..', 'src', 'components');

/** `#abc` / `#aabbcc` / `#aabbccdd`, and `rgb()` / `rgba()` / `hsl()`. */
const COLOR_LITERAL = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\()/;

/**
 * Every component file, including the shared primitives in
 * `components/primitives/`. The walk is recursive because the primitives are
 * exactly the files that must not spell a colour — they are the ones every
 * screen now paints with.
 */
function componentFiles(dir: string = COMPONENTS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('design tokens', () => {
  test('no component spells a colour itself', () => {
    const offenders: string[] = [];

    componentFiles().forEach(file => {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (COLOR_LITERAL.test(line)) {
            offenders.push(`${path.basename(file)}:${index + 1}  ${line.trim()}`);
          }
        });
    });

    expect(offenders).toEqual([]);
  });

  test('there is at least one component to check', () => {
    // Guards against the glob silently matching nothing and the test above
    // passing for the wrong reason.
    expect(componentFiles().length).toBeGreaterThan(20);
  });
});
