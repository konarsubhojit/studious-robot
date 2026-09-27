# Grumpy Code Review — copilot/audit-screen-audio-sharing vs master

_Reviewed c233ae6..HEAD, 11 files changed (5 source, 4 test, 1 doc, 1 review)._

## Summary

Mergeable. The diff correctly identifies that screen audio was never a
permission problem — `react-native-webrtc@124` declares
`getDisplayMedia()` with **no parameters**, so the `{ video, audio }`
constraints never reach native, and both native modules build a video-only
stream — and it stops the app lying about a capability it cannot have. The
worst thing in it is that the screen-audio capability now lives in
module-level mutable state in `screenShare.ts`; that is defensible (it is a
device/runtime fact, not per-call state) but it is process-wide, resets on
relaunch, and needs the explicit test seam that was added. Everything else is
small and covered by tests; `tsc`, ESLint and the mobile suite are clean apart
from a pre-existing failure block noted below.

## Findings

### Critical

None.

### High

None. The two correctness bugs the diff *fixes* would each have been High:

- a share started from an audio-only call left the video sender it added on
  the peer connection, freezing the last captured frame on the remote side
  for the rest of the call (`useScreenShare.ts`, `stopScreenShare`);
- a share that threw after the senders were attached left the same wreckage
  behind (`resetFailedScreenShareStart`).

Both are now covered by tests that fail when the fix is reverted (verified by
mutating each branch and re-running the suite).

### Medium

- **[MEDIUM] Screen-audio support is process-wide mutable module state** —
  `mobile/src/screenShare.ts:195`
  - `screenAudioCaptureSupported` is a module-level `let` shared by every
    consumer, so a test (or a future second call surface) can observe state
    written by an earlier capture.
  - Why it matters: hidden global state is the classic source of
    order-dependent tests.
  - Mitigation in the diff: `resetScreenAudioCaptureSupport()` is exported as
    an explicit seam and called from the suite's `beforeEach`. Accepted as-is
    because the fact being cached is genuinely per-device, not per-call;
    promoting it to a store/context would be more machinery than the single
    boolean deserves.

- **[MEDIUM] The learned capability does not survive a relaunch** —
  `mobile/src/screenShare.ts:195`
  - After a restart the first share asks for audio again and the user sees the
    "without system audio" warning once more.
  - Why it matters: one avoidable warning per app launch on devices that can
    never capture screen audio.
  - Suggested fix (deliberately not taken here): persist the flag through
    `settingsStorage`. Left out to keep this change surgical — one warning per
    launch is a large improvement on one per share, and persisting a
    *negative* capability risks pinning the feature off if a future
    `react-native-webrtc` starts returning an audio track.

### Low

- **[LOW] `attachScreenVideo` returns a flag derivable from `cameraTrack`** —
  `mobile/src/hooks/useScreenShare.ts:257`
  - `addedVideoSender` is true exactly when `cameraTrack` is null, because the
    `getSenders` predicate only matches a sender that already has a video
    track.
  - Why it matters: two fields that must stay in agreement.
  - Kept deliberately: the coupling is an accident of the predicate, and
    naming the fact the stop path actually needs ("did we create this
    sender?") is clearer than re-deriving it from a null check.

### Nit

- **[NIT] `removeScreenSender`'s `kind` parameter only feeds a log line** —
  `mobile/src/hooks/useScreenShare.ts:95`. Acceptable: without it the two call
  sites produce indistinguishable warnings.

## Out of scope (pre-existing, not graded)

- 12 tests in `mobile/__tests__/hooks/useCallFlow.test.tsx` ("answer path")
  fail identically on `master` (`getSocketHandler('call.incoming')` returns
  `undefined` → `TypeError: handler is not a function`). Verified by running
  the suite on the merge base; untouched by this diff.
- **iOS screen sharing still produces no frames at all**: ReplayKit needs a
  Broadcast Upload Extension target plus `RTCAppGroupIdentifier` in
  `Info.plist`, which `ios/StudiousRobot.xcodeproj` does not have. Already
  documented under "Required native setup" in `mobile/README.md`; adding an
  Xcode target is a separate, unverifiable-in-CI piece of work.
- **System audio cannot be delivered by the current WebRTC stack at all.**
  On Android it would need `AudioPlaybackCaptureConfiguration` feeding a
  custom `AudioDeviceModule`; the bundled `org.jitsi:webrtc:124`
  `JavaAudioDeviceModule.Builder` exposes no external audio input
  (`setAudioSource(int)` only), so there is no supported way to push captured
  PCM into a WebRTC audio track from Java. That is why this diff makes the app
  honest about the limit rather than pretending to fix it.
