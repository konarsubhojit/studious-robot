import { readFileSync } from 'fs';
import path from 'path';
import { transformSync } from '@babel/core';

/**
 * Crash reporting is wired as an *optional* native module: the JS loader is
 * absent-safe (see `crashReporting.test.ts`), and the build-side wiring must
 * stay credential-free so CI — which has no Sentry secrets — still assembles.
 * None of that fails loudly; it fails as a silently unreported crash or a
 * broken release build, so the wiring is asserted here.
 */
const MOBILE_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(MOBILE_DIR, '..');

const read = (...segments: string[]) => readFileSync(path.join(...segments), 'utf8');

const packageJson = JSON.parse(read(MOBILE_DIR, 'package.json'));
const babelConfig = read(MOBILE_DIR, 'babel.config.js');
const rootBuildGradle = read(MOBILE_DIR, 'android', 'build.gradle');
const appBuildGradle = read(MOBILE_DIR, 'android', 'app', 'build.gradle');
const podfile = read(MOBILE_DIR, 'ios', 'Podfile');
const apkWorkflow = read(REPO_DIR, '.github', 'workflows', 'android-apk.yml');

describe('crash reporting native wiring', () => {
  test('the SDK is a declared dependency', () => {
    expect(packageJson.dependencies['@sentry/react-native']).toBeDefined();
  });

  test('the DSN is inlined into the bundle like the other build-time config', () => {
    expect(babelConfig).toContain("'SIGNALING_URL'");
    expect(babelConfig).toContain("'SENTRY_DSN'");
    expect(babelConfig).toContain("'SENTRY_RELEASE'");
    expect(babelConfig).toContain("'SENTRY_DIST'");
  });

  test('the release APK build is handed the DSN secret', () => {
    expect(apkWorkflow).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
  });

  test('runtime release and dist are inlined from the same build identifiers as the upload', () => {
    expect(apkWorkflow).toContain('SENTRY_RELEASE: com.wetalk@${{ github.sha }}');
    expect(apkWorkflow).toContain('SENTRY_DIST: ${{ github.run_id }}.${{ github.run_attempt }}');
    const previousRelease = process.env.SENTRY_RELEASE;
    const previousDist = process.env.SENTRY_DIST;
    try {
      process.env.SENTRY_RELEASE = 'com.wetalk@test-commit';
      process.env.SENTRY_DIST = '123.2';
      const compiled = transformSync(read(MOBILE_DIR, 'src', 'crashReporting.ts'), {
        filename: path.join(MOBILE_DIR, 'src', 'crashReporting.ts'),
        cwd: MOBILE_DIR,
      })?.code;
      expect(compiled).toMatch(/release:\s*"com\.wetalk@test-commit"/);
      expect(compiled).toMatch(/dist:\s*"123\.2"/);
      expect(compiled).not.toContain('process.env.SENTRY_RELEASE');
      expect(compiled).not.toContain('process.env.SENTRY_DIST');
      expect(compiled).not.toContain('SENTRY_AUTH_TOKEN');
    } finally {
      if (previousRelease === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = previousRelease;
      if (previousDist === undefined) delete process.env.SENTRY_DIST;
      else process.env.SENTRY_DIST = previousDist;
    }
  });

  test('the Gradle bundle cache tracks the inlined Sentry configuration', () => {
    const cacheInputs = appBuildGradle.match(
      /tasks\.withType\(com\.facebook\.react\.tasks\.BundleHermesCTask\)\.configureEach \{\s*\[([^\]]*)\]\.each \{ key ->\s*inputs\.property\(key, System\.getenv\(key\) \?: ""\)/,
    );
    expect(cacheInputs).not.toBeNull();
    // Other inlined values may share the list; only the Sentry identity is asserted here.
    const trackedKeys = cacheInputs![1].split(',').map(key => key.trim().replace(/"/g, ''));
    expect(trackedKeys).toEqual(
      expect.arrayContaining(['SENTRY_DSN', 'SENTRY_RELEASE', 'SENTRY_DIST']),
    );
  });

  test('only non-PR builds upload the composed Hermes map before publishing an APK', () => {
    const upload = apkWorkflow.split('- name: Upload Hermes source maps to Sentry')[1]
      .split('- name: Upload release APK')[0];
    expect(upload).toContain("if: github.event_name != 'pull_request'");
    expect(upload).toContain('if [[ -z "${SENTRY_DSN:-}" ]]');
    expect(upload).toContain('${SENTRY_AUTH_TOKEN:?');
    expect(upload).toContain('${SENTRY_ORG:?');
    expect(upload).toContain('${SENTRY_PROJECT:?');
    expect(upload).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
    expect(upload).toContain('generated/assets/react/release/index.android.bundle');
    expect(upload).toContain('generated/sourcemaps/react/release/index.android.bundle.map');
    expect(upload).not.toContain('intermediates/sourcemaps');
    expect(upload).toContain('test -s "$BUNDLE"');
    expect(upload).toContain('test -s "$SOURCEMAP"');
    expect(upload).toContain('sentry-cli react-native gradle');
    expect(upload).toContain('--release "$SENTRY_RELEASE"');
    expect(upload).toContain('--dist "$SENTRY_DIST"');
    expect(upload).toContain('--wait');
    expect(apkWorkflow.split('- name: Upload Hermes source maps to Sentry')[0])
      .not.toContain('SENTRY_AUTH_TOKEN');
    expect(babelConfig).not.toContain('SENTRY_AUTH_TOKEN');
  });

  test('Sentry\'s Gradle plugin is on the build classpath', () => {
    expect(rootBuildGradle).toMatch(/classpath\("io\.sentry:sentry-android-gradle-plugin:[\d.]+"\)/);
  });

  test('the Gradle integration is applied only when credentials are present', () => {
    // Same conditional shape as the Google Services plugin: a build without
    // credentials must still assemble, so neither the upload-capable plugin
    // nor sentry.gradle may be applied unconditionally.
    expect(appBuildGradle).toMatch(
      /if \(file\("\.\.\/sentry\.properties"\)\.exists\(\)\) \{[\s\S]*apply plugin: "io\.sentry\.android\.gradle"/,
    );
    expect(appBuildGradle).toMatch(
      /if \(file\("\.\.\/sentry\.properties"\)\.exists\(\)\) \{[\s\S]*sentry\.gradle/,
    );
    expect(appBuildGradle).not.toMatch(/^apply plugin: "io\.sentry\.android\.gradle"/m);
  });

  test('the plugin never installs a second sentry-android', () => {
    // A mismatched pair crashes at startup with "Sentry SDK has detected a mix
    // of versions"; @sentry/react-native already ships its own sentry-android.
    expect(appBuildGradle).toMatch(/autoInstallation \{\s*enabled = false\s*\}/);
  });

  test('iOS links the SDK through autolinking, with no credentials', () => {
    expect(podfile).toContain('use_native_modules!');
    expect(podfile).toContain('@sentry/react-native');
    expect(podfile).not.toContain('sentry-cli');
  });
});
