import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * The release APK is shrunk: R8 strips unreachable bytecode and AGP strips
 * unreachable resources. Both are silent about what they removed, and both
 * fail only at runtime on a device, so the configuration that makes them safe
 * is asserted here rather than discovered in a crash report.
 */
const ANDROID_DIR = path.join(__dirname, '..', 'android');

const buildGradle = readFileSync(path.join(ANDROID_DIR, 'app', 'build.gradle'), 'utf8');
const proguardRules = readFileSync(path.join(ANDROID_DIR, 'app', 'proguard-rules.pro'), 'utf8');
const keepXml = readFileSync(
  path.join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'raw', 'keep_wetalk.xml'),
  'utf8',
);
const gradleProperties = readFileSync(path.join(ANDROID_DIR, 'gradle.properties'), 'utf8');

/** `org.gradle.jvmargs`, split into individual flags. */
function jvmArgs(): string[] {
  const match = gradleProperties.match(/^org\.gradle\.jvmargs=(.*)$/m);
  if (!match) throw new Error('no org.gradle.jvmargs in gradle.properties');
  return match[1].trim().split(/\s+/);
}

/** A `-Xmx`/`-XX:MaxMetaspaceSize` size, in MiB. */
function sizeMiB(flag: string): number {
  const arg = jvmArgs().find(candidate => candidate.startsWith(flag));
  if (!arg) throw new Error(`no ${flag} in org.gradle.jvmargs`);
  const match = arg.slice(flag.length).match(/^(\d+)([gGmM])$/);
  if (!match) throw new Error(`cannot parse size from ${arg}`);
  return Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1);
}

describe('android release shrinking', () => {
  test('the release build shrinks code and resources', () => {
    expect(buildGradle).toMatch(/def enableProguardInReleaseBuilds = true/);
    expect(buildGradle).toMatch(/minifyEnabled enableProguardInReleaseBuilds/);
    // Resource shrinking is a no-op without code shrinking, so the two are
    // driven by the same flag.
    expect(buildGradle).toMatch(/shrinkResources enableProguardInReleaseBuilds/);
  });

  test('keeps the classes that native code resolves by name', () => {
    // These packages declare `external`/`native` methods bound through JNI's
    // mangled-symbol convention: renaming the class compiles but breaks on the
    // first native call. None of them ship consumer rules of their own.
    ['com.op.sqlite', 'com.margelo.nitro', 'com.swmansion.rnscreens', 'com.swmansion.gesturehandler'].forEach(
      pkg => {
        expect(proguardRules).toContain(`-keep class ${pkg}.** { *; }`);
      },
    );
  });

  test('keeps line numbers so production stack traces stay readable', () => {
    expect(proguardRules).toContain('-keepattributes SourceFile,LineNumberTable');
  });

  test('keeps the resources that are only ever looked up by name', () => {
    // react-native-webrtc resolves the screen-share foreground-service icon
    // with getIdentifier(), which the resource shrinker cannot see.
    expect(keepXml).toContain('@drawable/ic_notification');
    // Play Services reads the google-services generated strings by name.
    ['@string/google_app_id', '@string/gcm_defaultSenderId'].forEach(resource => {
      expect(keepXml).toContain(resource);
    });
  });

  test('the keep file cannot be clobbered by the bundler-generated keep.xml', () => {
    // React Native's bundle step writes its own res/raw/keep.xml into the
    // generated resources folder; a file of the same name in the app source
    // set loses the resource merge and is silently ignored.
    expect(existsSync(path.join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'raw', 'keep.xml'))).toBe(
      false,
    );
  });

  test('the Gradle JVM is sized for R8', () => {
    // R8 holds the whole class graph in memory. Undersized, it does not fail
    // cleanly: the daemon spins on OutOfMemoryError: Metaspace and never
    // exits, so the build hangs until CI cancels the job hours later.
    expect(sizeMiB('-Xmx')).toBeGreaterThanOrEqual(4096);
    expect(sizeMiB('-XX:MaxMetaspaceSize=')).toBeGreaterThanOrEqual(1024);
    // The backstop for that hang: kill the JVM rather than thrash in it.
    expect(jvmArgs()).toContain('-XX:+ExitOnOutOfMemoryError');
  });
});
