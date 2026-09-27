# webrtc-audio-probe

Re-verifies the libwebrtc Java API facts that
[`docs/android-system-audio-decision.md`](../../docs/android-system-audio-decision.md)
and [`docs/android-native-client-plan.md`](../../docs/android-native-client-plan.md)
are built on.

Both documents reach strong conclusions — "a `patch-package` patch cannot
deliver system audio", "shadowing `WebRtcAudioRecord` is the only Java-level
seam", "a native app's one real advantage is owning its
`PeerConnectionFactory`" — from an inspection of the bundled
`org.jitsi:webrtc` AAR. An inspection recorded in prose goes stale silently. A
WebRTC bump could close the seam, or open a better one, and nothing would say
so until someone had spent device time finding out.

This script turns that inspection into nine assertions over the real bytecode.

## Run

```bash
tools/webrtc-audio-probe/probe.sh            # defaults to 124.0.0
tools/webrtc-audio-probe/probe.sh 125.0.0    # check a candidate upgrade
```

Needs `curl`, `unzip` and `javap` (any JDK). **No Android SDK, no emulator and
no device** — that is the point: it answers what can be answered at a desk, so
scarce hardware time is spent only on what genuinely needs hardware.

The AAR is ~20 MB and is cached under `$TMPDIR/webrtc-audio-probe/<version>/`
(override with `WEBRTC_PROBE_CACHE`). Exit status is 0 when every claim holds
and 1 when any has drifted.

## When to run it

- Before booking device time for the system-audio spike (gate D0 of the plan).
- When bumping `react-native-webrtc`, if the bundled WebRTC version changes.
- When either document above is being revised.

## Reading a failure

A failure is not a broken script; it means a document is now wrong. The affected
claim must be corrected **before** any work proceeds on it. Two failures matter
most:

- *`WebRtcAudioRecord` is package-private / is not final* — the shadowing seam
  has closed. System audio would then need a custom libwebrtc build (option 2 of
  the decision record) on **both** React Native and native Android.
- *`PeerConnectionFactory.Builder.setAudioDeviceModule` is public* — if this
  goes, the two-factory topology disappears and a native rewrite loses the only
  capability it was going to add.

## What it deliberately does not check

Everything that needs a running device: whether a shadowed `WebRtcAudioRecord`
actually feeds a track, whether two audio device modules can initialise in one
process, and whether `AudioPlaybackCaptureConfiguration` captures anything. The
API being *shaped* to allow something is not evidence that it works. Those are
steps D0.1–D0.4 of the plan and they need hardware.
