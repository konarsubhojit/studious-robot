#!/usr/bin/env bash
#
# Verifies, against the real libwebrtc bytecode, the API facts that Android
# system-audio screen sharing depends on.
#
#   docs/android-system-audio-decision.md
#   mobile/android/build.gradle                 (the dependency substitution)
#   mobile/android/app/src/main/java/com/wetalk/screenaudio/
#   mobile/patches/react-native-webrtc+124.0.7.patch
#
# Sharing the device's audio works by mixing captured playback into the
# microphone buffer WebRTC is already sending, through
# `JavaAudioDeviceModule.AudioBufferCallback`. That seam is not part of a
# stable public contract: it exists in the `io.github.webrtc-sdk` build and not
# in every libwebrtc distribution. This script makes the inspection repeatable,
# so a WebRTC version bump that closes the seam is caught here instead of as
# silent audio on a user's device. Every assertion below is a fact the feature
# relies on; if one fails, system-audio sharing is broken on that version and
# the substitution must not be moved to it.
#
# Needs: curl, unzip, javap (any JDK). No Android SDK and no device.
#
# Usage:  tools/webrtc-audio-probe/probe.sh [version]

set -euo pipefail

VERSION="${1:-125.6422.07}"
BASE_URL="https://repo1.maven.org/maven2/io/github/webrtc-sdk/android/${VERSION}"
CACHE_DIR="${WEBRTC_PROBE_CACHE:-${TMPDIR:-/tmp}/webrtc-audio-probe}/${VERSION}"

AAR="${CACHE_DIR}/android-${VERSION}.aar"
CLASSES="${CACHE_DIR}/classes"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

failures=0
checks=0

pass() {
  checks=$((checks + 1))
  printf 'ok    %s\n' "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  local detail
  for detail in "$@"; do printf '      %s\n' "${detail}"; done
}

# Records one claim. `pattern` is matched against `javap` output for `class`.
# `expectation` is `present` (the claim is that the member exists) or `absent`.
assert_member() {
  local description="$1" class="$2" pattern="$3" expectation="${4:-present}"

  local output
  if ! output="$(javap -p -classpath "${CLASSES}" "${class}" 2>&1)"; then
    fail "${description}" "class not found: ${class}"
    return
  fi

  local found=absent
  if grep -qE -- "${pattern}" <<<"${output}"; then
    found=present
  fi

  if [[ "${found}" == "${expectation}" ]]; then
    pass "${description}"
  else
    fail "${description}" "expected ${expectation}, found ${found}" \
      "class:   ${class}" "pattern: ${pattern}"
  fi
}

# Records a claim about a file in this repository, so the parts of the
# mechanism that live outside the AAR are checked by the same run.
assert_file() {
  local description="$1" path="$2" pattern="$3"

  if [[ ! -f "${REPO_ROOT}/${path}" ]]; then
    fail "${description}" "file not found: ${path}"
    return
  fi
  if grep -qE -- "${pattern}" "${REPO_ROOT}/${path}"; then
    pass "${description}"
  else
    fail "${description}" "no match in ${path}" "pattern: ${pattern}"
  fi
}

# Records a claim about the *order* of three operations in one method's
# bytecode. The ordering is what makes the mechanism correct rather than
# merely possible, so it is asserted instead of assumed.
assert_bytecode_order() {
  local description="$1" class="$2" first="$3" second="$4" third="$5"

  local code
  if ! code="$(javap -c -p -classpath "${CLASSES}" "${class}" 2>&1)"; then
    fail "${description}" "class not found: ${class}"
    return
  fi

  local first_at second_at third_at
  first_at="$(grep -nE -- "${first}" <<<"${code}" | head -1 | cut -d: -f1)"
  second_at="$(grep -nE -- "${second}" <<<"${code}" | head -1 | cut -d: -f1)"
  third_at="$(grep -nE -- "${third}" <<<"${code}" | head -1 | cut -d: -f1)"

  if [[ -z "${first_at}" || -z "${second_at}" || -z "${third_at}" ]]; then
    fail "${description}" "not all three operations were found" \
      "${first} -> ${first_at:-missing}" \
      "${second} -> ${second_at:-missing}" \
      "${third} -> ${third_at:-missing}"
    return
  fi

  if (( first_at < second_at && second_at < third_at )); then
    pass "${description}"
  else
    fail "${description}" \
      "expected ascending order, got ${first_at}, ${second_at}, ${third_at}"
  fi
}

fetch() {
  if [[ -f "${AAR}" ]]; then
    printf 'Using cached AAR: %s\n' "${AAR}"
    return
  fi
  mkdir -p "${CACHE_DIR}"
  printf 'Downloading io.github.webrtc-sdk:android:%s (~30 MB)...\n' "${VERSION}"
  curl -fsSL -o "${AAR}" "${BASE_URL}/android-${VERSION}.aar"
}

extract() {
  rm -rf "${CLASSES}"
  mkdir -p "${CLASSES}"
  local staging="${CACHE_DIR}/aar"
  rm -rf "${staging}"
  unzip -oq "${AAR}" -d "${staging}"
  # Distributions disagree on where the Java API lives: `io.github.webrtc-sdk`
  # ships it as the AAR's own classes.jar, `org.jitsi` as libs/libwebrtc.jar.
  local jar
  for jar in "${staging}/classes.jar" "${staging}/libs/libwebrtc.jar"; do
    [[ -f "${jar}" ]] && unzip -oq "${jar}" -d "${CLASSES}"
  done
  if [[ ! -d "${CLASSES}/org/webrtc" ]]; then
    printf 'No org/webrtc classes found in %s\n' "${AAR}" >&2
    return 1
  fi
}

main() {
  fetch
  extract

  printf '\nio.github.webrtc-sdk:android:%s\n\n' "${VERSION}"

  # 1. The seam the whole feature rests on: a callback that receives the
  #    recording buffer itself, so system audio can be added to it. No other
  #    libwebrtc API accepts PCM from outside (see check 6).
  assert_member 'AudioBufferCallback exists' \
    'org.webrtc.audio.JavaAudioDeviceModule$AudioBufferCallback' \
    'interface org\.webrtc\.audio\.JavaAudioDeviceModule\$AudioBufferCallback'
  assert_member 'onBuffer has the signature the mixer implements' \
    'org.webrtc.audio.JavaAudioDeviceModule$AudioBufferCallback' \
    'long onBuffer\(java\.nio\.ByteBuffer, int, int, int, int, long\)'
  assert_member 'Builder.setAudioBufferCallback installs it' \
    'org.webrtc.audio.JavaAudioDeviceModule$Builder' \
    'setAudioBufferCallback\(org\.webrtc\.audio\.JavaAudioDeviceModule\$AudioBufferCallback\)'

  # 2. The ordering that makes mute work. libwebrtc zeroes the microphone
  #    buffer for a muted mic *before* the callback runs, and hands the buffer
  #    to native code *after*, so muting the microphone leaves shared system
  #    audio audible. If this order ever changes, muting would silence the
  #    shared audio too — the exact behaviour this design exists to avoid.
  assert_bytecode_order 'mute is applied before mixing, and mixing before the native handoff' \
    'org.webrtc.audio.WebRtcAudioRecord$AudioRecordThread' \
    'Field org/webrtc/audio/WebRtcAudioRecord\.microphoneMute' \
    'InterfaceMethod org/webrtc/audio/JavaAudioDeviceModule\$AudioBufferCallback\.onBuffer' \
    'Method org/webrtc/audio/WebRtcAudioRecord\.nativeDataIsRecorded'

  # 3. Mute and noise suppression have to stay reachable on the module the app
  #    built, because `WebRTCModule` releases the native side immediately after
  #    building its factory. Both are plain Java passthroughs, so they survive.
  assert_member 'JavaAudioDeviceModule.setMicrophoneMute is public' \
    'org.webrtc.audio.JavaAudioDeviceModule' 'public void setMicrophoneMute\(boolean\)'
  assert_member 'JavaAudioDeviceModule.setNoiseSuppressorEnabled is public' \
    'org.webrtc.audio.JavaAudioDeviceModule' 'public boolean setNoiseSuppressorEnabled\(boolean\)'

  # 4. The custom module has to reach the factory react-native-webrtc builds.
  #    Both halves are checked: the libwebrtc hook, and the react-native-webrtc
  #    option that feeds it.
  assert_member 'PeerConnectionFactory.Builder.setAudioDeviceModule is public' \
    'org.webrtc.PeerConnectionFactory$Builder' \
    'setAudioDeviceModule\(org\.webrtc\.audio\.AudioDeviceModule\)'
  assert_file 'react-native-webrtc accepts an injected audio device module' \
    'mobile/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/WebRTCModuleOptions.java' \
    'public AudioDeviceModule audioDeviceModule;'

  # 5. Playback capture needs the screen share's MediaProjection: Android
  #    allows one at a time and stops the old one when a new one starts, so
  #    requesting a second would kill the video share. The accessor is public
  #    here; the patch publishes the capturer that holds it.
  assert_member 'ScreenCapturerAndroid.getMediaProjection is public (projection can be borrowed)' \
    'org.webrtc.ScreenCapturerAndroid' \
    'public android\.media\.projection\.MediaProjection getMediaProjection\(\)'
  assert_file 'the patch publishes the running screen capture projection' \
    'mobile/patches/react-native-webrtc+124.0.7.patch' \
    '^\+.*public static MediaProjection getActiveMediaProjection\(\)'

  # 6. Why the buffer callback is the only route: there is still no external
  #    audio source. If one ever appears it would be a cleaner mechanism than
  #    mixing into the microphone track, and this design should be revisited.
  assert_member 'AudioDeviceModule still exposes no PCM input' \
    'org.webrtc.audio.AudioDeviceModule' \
    '(setAudioSamples|pushSamples|ExternalAudio)' absent

  printf '\n%d checks, %d failures\n' "${checks}" "${failures}"
  if (( failures > 0 )); then
    printf '\nA failure means system-audio screen sharing does not work on this\n'
    printf 'WebRTC version. Do not move the substitution in\n'
    printf 'mobile/android/build.gradle to it, and correct\n'
    printf 'docs/android-system-audio-decision.md.\n'
    return 1
  fi
}

main "$@"
