# Android screen-share system audio — capability decision

Decision record for the "share system audio with the screen" request, and a
description of how the shipped implementation works.

> **Status: implemented on Android, not yet device-verified.** Sharing the
> screen now also shares what the device is playing, by mixing captured
> playback into the microphone buffer WebRTC is already sending
> ([§3](#3-what-was-actually-blocking-it)). This needs no libwebrtc fork, no
> second peer connection and **no renegotiation**, and muting the microphone
> leaves the shared audio audible. iOS remains video-only.
>
> An earlier revision of this record concluded *no-go*. That conclusion rested
> on a property of the bundled WebRTC build, not of Android or of React Native,
> and [§3.1](#31-what-changed) records what changed. Every API fact below is
> asserted by [`tools/webrtc-audio-probe`](../tools/webrtc-audio-probe/README.md)
> against real bytecode; what remains unverified is listed in
> [§7](#7-verification-status).

## 1. Symptom and first-order cause

Requesting `getDisplayMedia({ video: true, audio: true })` returns screen video
and no audio track. This is not a permissions fault. The manifest already
declares `RECORD_AUDIO` and `FOREGROUND_SERVICE_MEDIA_PROJECTION`, and
`MainApplication.onCreate` already enables the projection foreground service —
that is everything Android's playback capture asks for.

The audio constraint never reaches Android. It is dropped at three independent
layers, each verified against installed source rather than typings:

| Layer | Evidence |
| --- | --- |
| JS wrapper | `react-native-webrtc@124.0.7` `src/getDisplayMedia.ts` (and the compiled `lib/commonjs/getDisplayMedia.js` that RN actually loads) declares `getDisplayMedia()` with **no parameters** and calls `WebRTCModule.getDisplayMedia()` with no arguments. It then destructures `const { streamId, track }` and builds `tracks: [track]` — singular. |
| RN bridge | `WebRTCModule.java:772` — `public void getDisplayMedia(Promise promise)`. No constraints parameter exists on the bridge method. |
| Android native | `GetUserMediaImpl.createScreenStream()` calls `createScreenTrack()` and resolves `createStream(new MediaStreamTrack[] {track}, …)`. Video-only. Grepping the module for `AudioPlaybackCapture` or `AudioRecord` returns nothing. |

iOS drops it the same way (`WebRTCModule+RTCMediaStream.m`, single
`RTCVideoTrack`). Upstream `react-native-webrtc` has not implemented
display-media audio in any release up to 124.0.8.

Fixing those three layers is not enough on its own, which is what §3 is about.

## 2. What the receive side already supported

Worth stating because it was never the blocker:

- `usePeerConnection.ts` `ontrack` already detects an additional audio-only
  remote stream and merges it into the active remote stream
  (`isAdditionalAudioOnlyRemoteStream` / `mergeScreenAudioTracks`).
- `useScreenShare` already added a screen-audio track as an independent sender
  and renegotiated, and removed only that sender on stop.

The shipped implementation does not use either path — the shared audio arrives
on the existing microphone track — but both remain correct and are what a
future separate-track implementation would build on.

## 3. What was actually blocking it

Forwarding the constraint and building an `AudioRecord` would produce PCM and
then leave nowhere to put it. libwebrtc has no external or push audio source:
`PeerConnectionFactory.createAudioSource(MediaConstraints)` is the only way to
construct an `AudioSource` and it always binds the process-global audio device
module, whose interface exposes nothing but a native pointer. That much is
still true, and the probe still asserts it.

The blocker was therefore never React Native, Android, or the app's
architecture. It was that **the bundled WebRTC build exposed no seam to reach
the audio the device is already sending.** `org.jitsi:webrtc:124.0.0` has none.

### 3.1 What changed

`io.github.webrtc-sdk:android` — the libwebrtc build used by LiveKit and
flutter-webrtc — exposes one:

```java
JavaAudioDeviceModule.Builder.setAudioBufferCallback(AudioBufferCallback)
long onBuffer(ByteBuffer buffer, int audioFormat, int channelCount,
              int sampleRate, int bytesRead, long captureTimeNs)
```

It hands out the recording buffer itself, once per 10 ms. Three properties of
where it sits — all asserted by the probe against bytecode — are what make the
feature work rather than merely be expressible:

1. **It runs after the microphone has been read**, so system audio can be
   *added* to real microphone audio instead of replacing it. One track carries
   both; no second sender, no SDP change, and therefore **no renegotiation**.
2. **It runs after libwebrtc zeroes the buffer for a muted microphone.** Muting
   the microphone silences the microphone and leaves shared system audio
   audible. This is the requirement the earlier revision of this record
   believed was unsatisfiable without a custom libwebrtc build.
3. **It runs before the buffer is handed to native code**, so the mix is what
   gets encoded.

`react-native-webrtc` already reads `WebRTCModuleOptions.audioDeviceModule` and
passes it to `PeerConnectionFactory.Builder.setAudioDeviceModule()`, so the app
can supply such a module without patching the module's factory code at all —
correcting the earlier claim that react-native-webrtc owns its factory and
exposes no hook.

### 3.2 How it is assembled

| Piece | Where | Does |
| --- | --- | --- |
| Dependency substitution | `mobile/android/build.gradle` | Replaces `org.jitsi:webrtc` with `io.github.webrtc-sdk:android`, the build that has the seam. |
| `ScreenAudioDevice` | `mobile/android/app/src/main/java/com/wetalk/screenaudio/` | Builds a `JavaAudioDeviceModule` carrying the mixer and installs it in `WebRTCModuleOptions` from `Application.onCreate`, before the WebRTC module is constructed. |
| `SystemAudioCapture` | same | `AudioPlaybackCaptureConfiguration` + `AudioRecord`, at the exact sample rate and channel count WebRTC reports, so nothing is resampled. |
| `PcmRingBuffer` | same | Bounded FIFO between the capture thread and WebRTC's recording thread. Drops the oldest audio on overflow, so a stall is a glitch rather than permanent drift. |
| `PcmMixer` / `ScreenAudioMixer` | same | Adds the two 16-bit streams with clamping, using absolute `ByteBuffer` accessors so the buffer's cursor is never disturbed. |
| `react-native-webrtc` patch | `mobile/patches/react-native-webrtc+124.0.7.patch` | Publishes the running screen capture's `MediaProjection`. |
| `screenAudio.ts` | `mobile/src/` | JS façade; no-ops without the native module, so iOS and tests need no branching. |

**The projection must be borrowed, not requested.** Android permits one
`MediaProjection` at a time and stops the existing one when a new one starts, so
asking the user for a second consent would stop the very screen share the audio
was meant to accompany. That is the only reason a patch to
`react-native-webrtc` is involved: `ScreenCapturerAndroid.getMediaProjection()`
is public, but the capturer holding it is not reachable from outside.

**Mute has to be routed.** Both streams travel on one track, so disabling that
track would silence both. While system audio is being shared,
`useCallAudioRouting` mutes at the audio device module instead, which property 2
above makes correct.

## 4. What this does and does not buy

| | |
| --- | --- |
| **Gets** | System audio reaches the far end. No custom libwebrtc, no second peer connection, no signalling change — an unmodified peer hears it. Mute stays independent. |
| **Costs** | One track: the far end cannot balance microphone against system audio separately. The WebRTC AAR version becomes load-bearing, because the seam is not a stable public contract — hence the probe. |
| **Does not address** | iOS, which needs a Broadcast Upload Extension and is a separate piece of work. |

Genuinely separate tracks would still need a custom libwebrtc build exposing an
external audio source, with the native-toolchain ownership and security-patch
treadmill that implies. Nothing here forecloses that; it is simply not the
price this feature is worth.

### On rewriting in Kotlin

A full Kotlin rewrite would not have helped, and the shipped implementation
demonstrates why: React Native was never in the audio path. The capture module
is Kotlin either way, with UI, signalling and call state on the other side of
the bridge. The rewrite request is evaluated in full in the
[native Android client plan](./android-native-client-plan.md).

## 5. What still needs hardware

CI has no Android device or emulator, so the following are reasoned and
statically verified but **not observed**. Test against an app that permits
capture *and* one that sets `ALLOW_CAPTURE_BY_NONE`, on API 29+:

1. That `AudioPlaybackCaptureConfiguration` initialises against a projection
   created by another component, and that Android 14's foreground-service type
   rules accept it.
2. That the mixed audio is intelligible: no clipping, no drift, and that the
   capture and recording clocks stay close enough that ring-buffer overflows
   stay rare.
3. That muting the microphone leaves shared audio audible, end to end.
4. That local playback leaking back into the microphone is tolerable. The far
   end hears the shared audio twice — once mixed, once through the room — and
   whether the echo canceller handles this is a device question.
5. That the four states in §6 are each reachable and correctly reported.

## 6. Capture is never universally available

Playback capture is opt-out **per source app**: anything setting
`ALLOW_CAPTURE_BY_NONE` is silently unrecordable, and DRM-protected audio never
is. The implementation therefore distinguishes four states rather than a
boolean, in `ScreenAudioState` and its JS mirror:

| State | Means |
| --- | --- |
| `unsupported_platform` | Below API 29, or no mixing audio device module. |
| `unavailable` | No screen share to borrow a projection from, or capture was refused. |
| `capturing` | Running, and audio has been heard. |
| `silent` | Running, but everything captured has been digital silence — nothing is playing, or the source app blocks capture. |

`silent` is the state that matters: the UI says "no system audio captured yet"
rather than promising audio the far end will never receive. Do not document or
present system audio as guaranteed.

## 7. Verification status

| Claim | How verified |
| --- | --- |
| The seam exists, has the expected signature, and sits between mute-zeroing and the native handoff | `tools/webrtc-audio-probe/probe.sh` — 11 assertions over real bytecode, including a bytecode **ordering** check |
| The substituted AAR is a drop-in for `react-native-webrtc` | Public-API diff (0 classes missing; 3 unrelated member differences) plus a clean `javac` of every `react-native-webrtc` Java source against both AARs |
| The substitution does not change the **camera** surface — it is applied app-wide (`configurations.configureEach` in `mobile/android/build.gradle`), not scoped to screen sharing, so ordinary camera capture runs on the substituted AAR too | `tools/webrtc-audio-probe/probe.sh` — 10 further assertions over real bytecode for `CameraEnumerator`, `Camera1Enumerator`, `Camera2Enumerator`, `CameraVideoCapturer` (incl. `CameraEventsHandler`), `SurfaceTextureHelper`, `VideoCapturer`, `VideoSource`, `SurfaceViewRenderer`, `EglBase`. Confirmed byte-for-byte identical public API between `org.jitsi:webrtc:124.0.0` and `io.github.webrtc-sdk:android:125.6422.07`, and the new AAR is a pure superset of classes (adds classes, removes none) |
| Ring buffer and PCM mixing arithmetic | Executed on a JVM: overflow, wrap-around, clamping, endianness and buffer-cursor behaviour |
| JS façade, capability reporting, mute routing, start/stop unwind | Jest — `mobile/__tests__/screenAudio.test.ts` and the hook suites |
| **Everything in §5** | **Not verified. Needs a device.** |

Re-run the probe on any WebRTC version bump. A failure in checks 1–6 means
system-audio sharing is broken on that version; a failure in check group 7
means the camera is at risk instead, because the substitution in
`mobile/android/build.gradle` is app-wide. Either way, the substitution must
not be moved to that version.
