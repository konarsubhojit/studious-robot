# webrtc-audio-probe

Asserts, against real libwebrtc bytecode, the API facts that Android
system-audio screen sharing depends on — see
[`docs/android-system-audio-decision.md`](../../docs/android-system-audio-decision.md).

Sharing the device's audio works by mixing captured playback into the
microphone buffer WebRTC is already sending, through
`JavaAudioDeviceModule.AudioBufferCallback`. **That seam is not a stable public
contract.** It exists in the `io.github.webrtc-sdk` build and not in every
libwebrtc distribution — `org.jitsi:webrtc:124.0.0`, which
`react-native-webrtc` pulls in by default, does not have it, which is why
`mobile/android/build.gradle` substitutes the dependency.

A version bump that closes the seam would otherwise surface as silent audio on
a user's device. This script catches it at a desk instead.

## Run

```bash
tools/webrtc-audio-probe/probe.sh                 # defaults to 125.6422.07
tools/webrtc-audio-probe/probe.sh 125.6422.08     # check a candidate upgrade
```

Needs `curl`, `unzip` and `javap` (any JDK). **No Android SDK, no emulator and
no device** — that is the point: it answers what can be answered at a desk, so
scarce hardware time is spent only on what genuinely needs hardware.

The AAR is ~30 MB and is cached under `$TMPDIR/webrtc-audio-probe/<version>/`
(override with `WEBRTC_PROBE_CACHE`). Exit status is 0 when every claim holds
and 1 when any has drifted.

## When to run it

- Before changing the WebRTC version in `mobile/android/build.gradle`.
- When bumping `react-native-webrtc`.
- When revising the decision record.

## What it checks

Eleven claims, in six groups:

1. **The seam** — `AudioBufferCallback` exists, `onBuffer` has the signature the
   mixer implements, and `Builder.setAudioBufferCallback` installs it.
2. **The ordering**, read out of `AudioRecordThread.run()`'s bytecode: mute
   zeroing happens *before* the callback and the native handoff *after*. This is
   what makes muting the microphone leave shared audio audible; if libwebrtc
   ever reorders these, mute would silence the shared audio too.
3. **Mute and noise suppression** stay reachable on the module the app built,
   which matters because `WebRTCModule` releases the native side immediately
   after building its factory.
4. **The injection path** — both the libwebrtc hook and the
   `react-native-webrtc` option that feeds it.
5. **The projection can be borrowed** — `ScreenCapturerAndroid.getMediaProjection()`
   is public, and the `patch-package` patch that publishes the running capturer
   is present. Android allows one `MediaProjection` at a time, so requesting a
   second would stop the screen share.
6. **There is still no external audio source.** If one ever appears it would be
   a cleaner mechanism than mixing into the microphone track, and the design
   should be revisited.

Checks 4 and 5 read files in this repository, so the halves of the mechanism
that live outside the AAR are covered by the same run. Running the probe
against a version without the seam fails at check 1 — that behaviour is the
whole point of the script.

## Reading a failure

A failure means **system-audio sharing does not work on that WebRTC version**.
Do not move the substitution in `mobile/android/build.gradle` to it, and correct
the decision record.

## What it deliberately does not check

Everything that needs a running device: whether `AudioPlaybackCaptureConfiguration`
actually captures anything, whether the mixed audio is intelligible, and whether
the echo canceller copes with locally played audio returning through the
microphone. The API being *shaped* to allow something is not evidence that it
works. Those are listed in
[the decision record §5](../../docs/android-system-audio-decision.md#5-what-still-needs-hardware).
