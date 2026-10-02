import { readFileSync } from 'fs';
import path from 'path';

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
  });

  test('the release APK build is handed the DSN secret', () => {
    expect(apkWorkflow).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
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
