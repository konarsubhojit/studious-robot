import { THIRD_PARTY_LICENSES, summarizeLicenses } from '../src/licenses';

const packageJson = require('../package.json');

describe('THIRD_PARTY_LICENSES', () => {
  test('covers exactly the runtime dependencies, so the notice cannot drift', () => {
    // The list is checked in rather than generated, so this is the thing that
    // keeps "checked in" from meaning "stale": adding a dependency without its
    // notice fails here.
    const declared = Object.keys(packageJson.dependencies ?? {}).sort();
    const listed = THIRD_PARTY_LICENSES.map(entry => entry.name).sort();
    expect(listed).toEqual(declared);
  });

  test('names an SPDX licence for every entry', () => {
    THIRD_PARTY_LICENSES.forEach(entry => {
      expect(typeof entry.license).toBe('string');
      expect(entry.license.trim().length).toBeGreaterThan(0);
    });
  });

  test('lists each package once', () => {
    const names = THIRD_PARTY_LICENSES.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('excludes development-only dependencies, which do not ship', () => {
    const devDependencies = Object.keys(packageJson.devDependencies ?? {});
    const listed = new Set(THIRD_PARTY_LICENSES.map(entry => entry.name));
    devDependencies
      .filter(name => !(packageJson.dependencies ?? {})[name])
      .forEach(name => {
        expect(listed.has(name)).toBe(false);
      });
  });
});

describe('summarizeLicenses', () => {
  test('counts the libraries and names every distinct licence', () => {
    const summary = summarizeLicenses();
    expect(summary).toContain(String(THIRD_PARTY_LICENSES.length));
    new Set(THIRD_PARTY_LICENSES.map(entry => entry.license)).forEach(license => {
      expect(summary).toContain(license);
    });
  });
});
