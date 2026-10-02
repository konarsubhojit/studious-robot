# Android screen-share system audio — capability decision

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.

**Status: implemented on Android; physical-device verification is not established
by this record.** Captured playback is mixed into the microphone buffer WebRTC
already sends. The system-audio mix needs no second sender, peer connection or
renegotiation; screen-video sharing still has its own sender lifecycle. iOS
does not use this Android capture path.

## 1. Why a separate native client was unnecessary

The app does not obtain playback audio from a display-media audio constraint.
Instead, Kotlin captures playback using `AudioPlaybackCaptureConfiguration` and
mixes PCM through the substituted WebRTC build's audio-buffer callback.

This is native audio integration inside the React Native app, not a reason to
rewrite its UI, signalling and call state. The rejected rewrite rationale is in
[android-native-client-plan.md](./android-native-client-plan.md).

## 2. Receive-side compatibility

The mixed playback arrives on the existing microphone track, so a peer does
not need a separate system-audio track protocol.

The separate-audio receive helpers in `usePeerConnection.ts`
(`isAdditionalAudioOnlyRemoteStream` / `mergeScreenAudioTracks`) remain for
additional audio-only streams. They are not the transport used by this mixer.

## 3. What was actually blocking it

The useful seam is `JavaAudioDeviceModule.AudioBufferCallback`, supplied by
`io.github.webrtc-sdk:android:125.6422.07`, selected in
`mobile/android/build.gradle`. `ScreenAudioDevice.install()` supplies the custom
ADM via `WebRTCModuleOptions.audioDeviceModule` before the React Native bridge
constructs WebRTC.

The callback must run after microphone mute-zeroing and before native handoff.
That ordering lets playback remain audible while the microphone is muted.
The checked-in [audio probe](../tools/webrtc-audio-probe/README.md) checks this
bytecode ordering, the callback signature, injection/projection paths, and
camera-facing APIs. This audit inspected the implementation and probe; it did
not rerun binary compatibility checks or establish device behaviour.

### Implementation

| Piece | Source | Role |
| --- | --- | --- |
| Dependency substitution | `mobile/android/build.gradle` | Selects the audio-buffer-capable AAR app-wide, including ordinary camera calls. |
| `ScreenAudioDevice` | `mobile/android/app/src/main/java/com/wetalk/screenaudio/ScreenAudioDevice.kt` | Installs the custom ADM from `MainApplication.onCreate`; routes microphone mute and noise suppression. |
| `SystemAudioCapture` | Same directory | Captures playback at the sample rate/channel count supplied by the WebRTC recording callback. |
| `PcmRingBuffer` | Same directory | Bounded FIFO; drops old data on overflow. |
| `PcmMixer` / `ScreenAudioMixer` | Same directory | Mixes signed 16-bit PCM with clamping, without advancing the WebRTC buffer cursor. |
| Projection bridge | `mobile/patches/react-native-webrtc+124.0.7.patch` | Makes the active screen-capture projection available through `ScreenCaptureController`. |
| JS façade | `mobile/src/screenAudio.ts` | Guarded Android-only native module, status mapping and mute mirror. |
| Call integration | `useScreenShare.ts`, `useCallAudioRouting.ts` | Starts/stops the mix with screen sharing and uses ADM mute rather than disabling the shared audio track. |

Borrowing the active screen projection avoids a second consent/capture session.
Disabling the shared microphone track would silence both inputs; microphone
mute is therefore routed through the ADM while sharing is active.

## 4. Tradeoffs

- One track means the receiver cannot adjust microphone and playback volumes
  independently.
- The AAR seam is version-sensitive. Re-run the existing probe before a WebRTC
  dependency change; the app-wide substitution also warrants camera checks.
- Capturing playback does not guarantee the source app allows capture or that
  the resulting mix is intelligible on every device.

## 5. What still needs hardware

This record does not contain completed device results. On API 29+ test both a
source that permits capture and one that blocks it:

1. Capture initialisation from the borrowed projection, including Android
   foreground-service rules.
2. Intelligibility, clipping, drift and ring-buffer overflow behaviour.
3. Microphone mute leaving playback audible at the remote peer.
4. Echo when local playback also enters the microphone acoustically.
5. Start/stop, projection revocation and capability/status reporting.

## 6. Capture is never universally available

The source app's playback-capture policy can prevent recording. The native
`ScreenAudioState.kt` and JS `SystemAudioState` expose **five** states:

| State | Meaning |
| --- | --- |
| `unsupported_platform` | Android below API 29. |
| `unavailable` | No installed mixing ADM, no active projection, or capture failure. |
| `idle` | Available but not running. |
| `capturing` | Running and non-silent audio has been observed. |
| `silent` | Running but no non-silent audio has been observed. |

Silence cannot distinguish an idle source from a source that blocks capture.
Do not promise that starting screen sharing guarantees audible system audio.

## 7. Verification status

Source evidence is the native capture/mixer directory, the Gradle substitution,
the WebRTC patch and the JS/hook integration above. Focused coverage exists in
`mobile/__tests__/screenAudio.test.ts` and the call-hook suites.

The probe checks API/bytecode prerequisites, not playback quality, Android
permission behaviour or end-to-end mute. Those still require the §5 device
checks; no new test or hardware run was performed in this documentation audit.
