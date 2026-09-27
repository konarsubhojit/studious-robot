# Android screen-share system audio — capability decision

Decision record for the "share system audio with the screen" request. This is a
design decision and a spike protocol, not an implementation authorization.

> **Status: no-go, pending a spike.** Android system audio is **not shipped**.
> The UI says so rather than offering a toggle that cannot work
> (`mobile/src/screenShare.ts`, `mobile/src/hooks/useScreenShare.ts`). Shipping
> it requires accepting one of the three trade-offs in §4, and option 1 — the
> only one achievable without owning a libwebrtc build — contradicts the
> "muting the microphone must not mute system audio" requirement. Run the spike
> in §5 before choosing. Do not start by writing a `patch-package` patch; §3
> explains why that cannot work.

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

## 2. What the receive side already supports

Worth stating because it is *not* the blocker, and a future implementation
should not re-litigate it:

- `usePeerConnection.ts` `ontrack` already detects an additional audio-only
  remote stream and merges it into the active remote stream
  (`isAdditionalAudioOnlyRemoteStream` / `mergeScreenAudioTracks`).
- Mute is scoped to the local camera/mic stream via
  `setTrackEnabled(stream, 'audio', …)` in `mobile/src/mediaControls.ts`, so it
  cannot reach a separate screen-audio sender.
- `useScreenShare` already adds the screen-audio track as an independent sender
  and renegotiates, and removes only that sender on stop.

The send side is shaped for this feature. The constraint is below it.

## 3. Why a `patch-package` patch cannot deliver it

Patching `react-native-webrtc` to forward the constraint and build an
`AudioRecord` would get you PCM, and then leave you with nowhere to put it. The
wall is one layer further down, in libwebrtc itself. From `javap` over the
bundled `org.jitsi:webrtc:124.0.0` AAR:

- `PeerConnectionFactory.createAudioSource(MediaConstraints)` is the only way to
  construct an `AudioSource`, and it always binds the process-global audio
  device module. There is no external, push, or custom audio source.
- `JavaAudioDeviceModule.Builder` accepts only `setAudioSource(int)` — a
  `MediaRecorder.AudioSource` constant. An `AudioPlaybackCaptureConfiguration`
  cannot be expressed as one. `SamplesReadyCallback` reads samples *out*, not in.
- The `AudioDeviceModule` interface exposes only
  `getNativeAudioDeviceModulePointer()`, so a replacement must be a C++ object.
  The AAR ships prebuilt `.so` files and a jar with **no headers** — there is
  nothing to compile against.
- Subclassing the Java plumbing does not help either.
  `JavaAudioDeviceModule`'s private constructor and its
  `nativeCreateAudioDeviceModule` JNI entry point both take the **concrete**
  `org.webrtc.audio.WebRtcAudioRecord` type, and the methods JNI drives
  (`initRecording`, `createAudioRecordOnMOrHigher`) are `private`.

There is exactly one Java-level seam. `WebRtcAudioRecord` is package-private and
non-final, so an app can **shadow** it — ship a copy at the same package and
class name in its own source set, which Gradle's classpath ordering puts ahead
of the AAR — and build the `AudioRecord` inside it with
`setAudioPlaybackCaptureConfig(...)`. This is what community threads mean by
"modify `WebRtcAudioRecord.java`".

**That seam costs the microphone.** The ADM is one input stream per
`PeerConnectionFactory`, and every audio track that factory creates reads from
it. Capture playback through it and the mic is gone.
`PeerConnectionFactory.Builder.setAudioDeviceModule()` makes a second factory
with a second ADM look tempting, but native objects are not interchangeable
across factories: a track from factory B cannot be attached to a peer
connection from factory A. Two independent local audio tracks is not something
this stack does.

## 4. The three honest outcomes

Pick one **before** spiking, so the spike confirms a decision rather than
discovering it.

| # | Approach | Gets | Costs |
| --- | --- | --- | --- |
| 1 | Mix mic + playback PCM into the single shadowed ADM stream | System audio reaches the far end; no custom libwebrtc; existing call flow unchanged | One audio track. Muting the mic mutes system audio, and the far end cannot balance them. Contradicts the separate-track requirement. |
| 2 | Custom libwebrtc build exposing an external audio source | Genuinely separate mic and system-audio tracks | Ownership of a native toolchain, four-ABI cross-compilation, and a security-patch treadmill on a codebase with a live CVE stream. |
| 3 | Do not ship system audio on Android | No new surface or maintenance | Feature absent, honestly labelled. **Current state.** |

### On rewriting in Kotlin

A full Kotlin rewrite does **not** improve this. A native app links the same
libwebrtc and inherits the same single-ADM constraint. React Native is not in
the audio path at all; the bridge is not what blocks this. A rewrite arrives at
exactly these three options, months later.

The corollary: even under option 2, maintaining a custom libwebrtc does not
argue for going native. The custom build sits under a thin Kotlin capture module
either way, with React Native on the other side of it. The two decisions are
independent, and coupling them turns this into a rewrite that was never needed.

The right shape, if this ships, is a native Android capture module exposing
`startScreenAudioCapture()` / `stopScreenAudioCapture()` to JS, with UI,
signalling, call state, and business logic staying in React Native.

The rewrite request is evaluated in full — including the one seam a native app
does open, and the staged plan and tracker that apply if it is taken — in the
[native Android client plan](./android-native-client-plan.md).

## 5. Spike protocol — ordered to fail fast

Run this in a **throwaway app, not this repository**, and on real hardware. The
obvious ordering (MediaProjection → `AudioPlaybackCaptureConfiguration` →
`AudioRecord` → WebRTC) hides the only step that can fail and will look like it
is succeeding until the last moment. Those first steps are ordinary,
well-documented Android; they are not the hard part. Invert it:

1. **Prove the sink before the source.** Shadow `WebRtcAudioRecord` in
   `org.webrtc.audio` and feed it a **synthetic tone**, not real playback
   capture. Confirm a second device hears it. *Decision gate — if a sine wave
   will not traverse a WebRTC audio track, no amount of correct MediaProjection
   code will help, and you have learned it in a day instead of a fortnight.*
2. **Try to keep a live microphone track at the same time.** Expect it to die.
   This is the finding that settles the architecture, and it is step 7 in the
   naive ordering — far too late.
3. **Only then** wire up real `MediaProjection` +
   `AudioPlaybackCaptureConfiguration`. Gate to **API 29+**; this app's
   `minSdkVersion` is 24. Test against an app that permits capture *and* one
   that sets `ALLOW_CAPTURE_BY_NONE`.
4. Return with the chosen option from §4. The JS side is already shaped for the
   result: `screenShare.ts` learns the capability at runtime rather than
   assuming it, and the receive path in §2 already merges a second audio track.

## 6. Capture is never universally available

Even with a working implementation, playback capture is opt-out **per source
app**: anything setting `ALLOW_CAPTURE_BY_NONE` is silently unrecordable, and
DRM-protected audio never is. Any implementation must therefore distinguish four
states rather than a boolean — capture supported; supported but nothing
capturable is playing; user denied MediaProjection; platform/device cannot do
playback capture at all. Do not document or present system audio as guaranteed.

## 7. Verification note

Everything above is from source and binary inspection. The API facts in §3 are
now re-checkable on demand: [`tools/webrtc-audio-probe`](../tools/webrtc-audio-probe/README.md)
asserts them against the real AAR bytecode (9/9 passing at
`org.jitsi:webrtc:124.0.0`) and should be re-run on any WebRTC version bump. One
finding it adds: the published `webrtc-124.0.0-sources.jar` is a stub, so a
shadowed `WebRtcAudioRecord` must be reimplemented rather than patched — see the
[native client plan §3.1](./android-native-client-plan.md#31-static-verification--done-and-repeatable).

The runtime behaviour is still unverified: CI has no Android device or emulator,
so §5 needs a human with hardware.
