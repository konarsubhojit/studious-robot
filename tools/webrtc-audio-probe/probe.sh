#!/usr/bin/env bash
#
# Verifies, against the real libwebrtc bytecode, the API facts that the
# screen-share system-audio decision and the native-client plan depend on.
#
#   docs/android-system-audio-decision.md   §3
#   docs/android-native-client-plan.md      §3, §4
#
# Those documents were written from a one-off inspection. This script makes the
# inspection repeatable, so a WebRTC version bump that removes the shadowing
# seam is caught here instead of halfway through a spike. Every assertion below
# is a claim one of those documents makes; if an assertion fails, the document
# is now wrong and must be corrected before any work proceeds on it.
#
# Needs: curl, unzip, javap (any JDK). No Android SDK and no device.
#
# Usage:  tools/webrtc-audio-probe/probe.sh [version]

set -euo pipefail

VERSION="${1:-124.0.0}"
BASE_URL="https://repo1.maven.org/maven2/org/jitsi/webrtc/${VERSION}"
CACHE_DIR="${WEBRTC_PROBE_CACHE:-${TMPDIR:-/tmp}/webrtc-audio-probe}/${VERSION}"

AAR="${CACHE_DIR}/webrtc-${VERSION}.aar"
CLASSES="${CACHE_DIR}/classes"

failures=0
checks=0

# Records one claim. `pattern` is matched against `javap` output for `class`.
# `expectation` is `present` (the claim is that the member exists) or `absent`.
assert_member() {
  local description="$1" class="$2" pattern="$3" expectation="${4:-present}"
  checks=$((checks + 1))

  local output
  if ! output="$(javap -p -classpath "${CLASSES}" "${class}" 2>&1)"; then
    printf 'FAIL  %s\n      class not found: %s\n' "${description}" "${class}"
    failures=$((failures + 1))
    return
  fi

  local found=absent
  if grep -qE -- "${pattern}" <<<"${output}"; then
    found=present
  fi

  if [[ "${found}" == "${expectation}" ]]; then
    printf 'ok    %s\n' "${description}"
  else
    printf 'FAIL  %s\n      expected %s, found %s\n      class:   %s\n      pattern: %s\n' \
      "${description}" "${expectation}" "${found}" "${class}" "${pattern}"
    failures=$((failures + 1))
  fi
}

fetch() {
  if [[ -f "${AAR}" ]]; then
    printf 'Using cached AAR: %s\n' "${AAR}"
    return
  fi
  mkdir -p "${CACHE_DIR}"
  printf 'Downloading org.jitsi:webrtc:%s (~20 MB)...\n' "${VERSION}"
  curl -fsSL -o "${AAR}" "${BASE_URL}/webrtc-${VERSION}.aar"
}

extract() {
  # The Java API lives in libs/libwebrtc.jar inside the AAR, not classes.jar.
  rm -rf "${CLASSES}"
  mkdir -p "${CLASSES}"
  local staging="${CACHE_DIR}/aar"
  rm -rf "${staging}"
  unzip -oq "${AAR}" -d "${staging}"
  unzip -oq "${staging}/libs/libwebrtc.jar" -d "${CLASSES}"
}

main() {
  fetch
  extract

  printf '\norg.jitsi:webrtc:%s\n\n' "${VERSION}"

  # 1. The shadowing seam. Package-private (no `public` modifier on the type)
  #    and non-final, so an app-supplied class at the same fully-qualified name
  #    can precede the AAR's on the classpath. If this class ever becomes
  #    public+final, or moves, the seam closes and system audio is off the table
  #    without a custom libwebrtc build.
  assert_member 'WebRtcAudioRecord is package-private (shadowing seam open)' \
    'org.webrtc.audio.WebRtcAudioRecord' '^(final )?class org\.webrtc\.audio\.WebRtcAudioRecord'
  assert_member 'WebRtcAudioRecord is not final' \
    'org.webrtc.audio.WebRtcAudioRecord' '^final class org\.webrtc\.audio\.WebRtcAudioRecord' absent

  # 2. Why shadowing is the ONLY seam: the JNI entry point is typed to the
  #    concrete class, so a subclass cannot be substituted.
  assert_member 'nativeCreateAudioDeviceModule takes the concrete WebRtcAudioRecord' \
    'org.webrtc.audio.JavaAudioDeviceModule' \
    'native long nativeCreateAudioDeviceModule\(.*org\.webrtc\.audio\.WebRtcAudioRecord,'

  # 3. The sentinel-audio-source route into a shadowed class. The audio source
  #    is a plain int carried from JavaAudioDeviceModule.Builder.setAudioSource
  #    into a WebRtcAudioRecord field, and the JNI entry points never read it.
  #    That is what makes "playback capture for one ADM, microphone for the
  #    other" expressible at all (plan §3, step 1).
  assert_member 'JavaAudioDeviceModule.Builder.setAudioSource(int) exists' \
    'org.webrtc.audio.JavaAudioDeviceModule$Builder' \
    'public org\.webrtc\.audio\.JavaAudioDeviceModule\$Builder setAudioSource\(int\)'
  assert_member 'WebRtcAudioRecord has a public constructor taking the audio source' \
    'org.webrtc.audio.WebRtcAudioRecord' \
    'public org\.webrtc\.audio\.WebRtcAudioRecord\(android\.content\.Context,'

  # 4. A shadow must reimplement the whole class: AudioRecord construction is
  #    private static, so it cannot be overridden or delegated to.
  assert_member 'createAudioRecordOnMOrHigher is private static (shadow must reimplement)' \
    'org.webrtc.audio.WebRtcAudioRecord' \
    'private static android\.media\.AudioRecord createAudioRecordOnMOrHigher\('

  # 5. The two-factory topology the native-client plan hangs on (§3): an app
  #    that owns its PeerConnectionFactory can give each one its own ADM.
  #    react-native-webrtc owns its factory and exposes no such hook, which is
  #    the single capability a native app adds.
  assert_member 'PeerConnectionFactory.Builder.setAudioDeviceModule is public' \
    'org.webrtc.PeerConnectionFactory$Builder' \
    'public org\.webrtc\.PeerConnectionFactory\$Builder setAudioDeviceModule\(org\.webrtc\.audio\.AudioDeviceModule\)'

  # 6. No external/push audio source exists: the only way to build an
  #    AudioSource binds the factory's process-global ADM, and the ADM
  #    interface hands out nothing but a native pointer. This is why PCM
  #    cannot simply be fed in, and why a patch-package patch cannot work.
  assert_member 'createAudioSource(MediaConstraints) is the only AudioSource route' \
    'org.webrtc.PeerConnectionFactory' \
    'public org\.webrtc\.AudioSource createAudioSource\(org\.webrtc\.MediaConstraints\)'
  assert_member 'AudioDeviceModule exposes only a native pointer (no PCM input)' \
    'org.webrtc.audio.AudioDeviceModule' \
    '(setAudioSamples|pushSamples|ExternalAudio)' absent

  printf '\n%d checks, %d failures\n' "${checks}" "${failures}"
  if (( failures > 0 )); then
    printf '\nA failure means the AAR no longer matches what the decision records\n'
    printf 'claim. Correct docs/android-system-audio-decision.md and\n'
    printf 'docs/android-native-client-plan.md before relying on them.\n'
    return 1
  fi
}

main "$@"
