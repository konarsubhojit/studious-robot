# Grumpy Code Review — copilot/concerned-about-screen-sharing vs master

_Reviewed 2908fdb..1266e5d, 26 files changed (9 source, 3 test, 1 patch, 2 build, 11 doc/tooling)._

## Summary

Mergeable, and unusually well-evidenced for a change of this kind: the diff
does not merely assert that `JavaAudioDeviceModule.AudioBufferCallback` exists
and runs after mute-zeroing, it asserts it in a script that fails the build if
it stops being true. The PCM arithmetic is right, including the two things
that are normally wrong — absolute `ByteBuffer` accessors and clamping instead
of wrapping — and using `buffer.capacity()` rather than the `bytesRead`
parameter is not the sloppiness it looks like: libwebrtc branches away when
they differ and passes `capacity()` to native, so the mixer matches it exactly.

The worst thing in it is `applyMicrophoneMute` writing the mute mirror on the
path where the mute was *not* applied. That is the one finding here that can
end with a live microphone under a UI that says "muted". Everything else is a
narrow robustness or diagnostics complaint.

Nothing device-verified, which the diff says loudly and repeatedly rather than
hiding. That is the correct way to ship this.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] `applyMicrophoneMute` records a mute it did not apply** — `mobile/src/screenAudio.ts:247-254`, `mobile/src/hooks/useCallAudioRouting.ts:74-82`
  - `applyMicrophoneMute` sets `microphoneMuted = muted` before it knows whether
    anything will act on it, and returns `false` when there is no mixer. The
    caller then tries `setTrackEnabled`, and when *that* also fails it bails out
    with `updateStatus('Start preview to control audio')` **without** calling
    `setIsMuted`. The UI's `isMuted` and the module's `microphoneMuted` now
    disagree.
  - It matters because `microphoneMuted` is not inert — `attachSystemAudio` →
    `startSystemAudio` replays it into `native.setMicrophoneMuted(...)` when a
    share starts. Reach it from `isMuted === true` with a failed toggle
    (`localStreamRef.current` null, or a stream with no audio track) and the
    mirror latches `false`; starting a screen share then **unmutes the
    microphone while the UI still shows muted**. The opposite direction is
    merely annoying; this direction is a privacy failure.
  - Fix: only record on success. Have `applyMicrophoneMute` write the mirror in
    the branch that calls `native.setMicrophoneMuted`, and export a small
    `recordMicrophoneMute(muted)` that `handleMuteToggle` calls *after* its
    guard passes, alongside `setIsMuted(nextMuted)`.
  - **Resolution: Fixed.** `applyMicrophoneMute` now records only on the branch
    that actually reaches the audio device module; `recordMicrophoneMute` is
    exported and called by `handleMuteToggle` after its guard. Two regression
    tests added in `useCallAudioRouting.test.tsx`, verified to fail against the
    old ordering. Three `screenAudio.test.ts` expectations and two
    `useScreenShare.test.tsx` seeds encoded the old contract and were updated
    to the corrected one — a behaviour change, not a weakened assertion; the
    "declines" case now asserts the mirror is *not* written.

- **[MEDIUM] A second `start()` hangs for the timeout and then lies** — `mobile/android/app/src/main/java/com/wetalk/screenaudio/ScreenAudioMixer.kt:113-120`
  - `startSignal?.countDown()` sits *inside* `if (!capture.isCapturing)`. If
    capture is already running when `start()` is called again, no buffer
    callback ever counts the latch down, so `start()` blocks the full
    `START_TIMEOUT_MS` (2 s) and returns `UNAVAILABLE` — while audio is in fact
    being mixed perfectly well. `ScreenAudioDevice.start()` has no
    already-started guard, and neither does `startSystemAudio`, so a double
    call is a two-second stall followed by JS concluding the share is silent.
  - Fix: move `startSignal?.countDown()` out of the `if`, to just before
    `mixInto(buffer)`, so any delivered buffer settles a pending start.
  - **Resolution: Fixed.** `startSignal?.countDown()` moved out of the
    `if (!capture.isCapturing)` branch, with the failure path counting down
    before its early return so a refused capture still settles the latch.

- **[MEDIUM] `AudioRecord` is released while a read may still be in flight** — `mobile/android/app/src/main/java/com/wetalk/screenaudio/SystemAudioCapture.kt:182-198`
  - `stopLocked()` clears `keepAlive`, `join`s the reader for up to 2 s, and
    only *then* calls `active.stop()` / `active.release()`. But the reader
    blocks inside `active.read(...)`, and `keepAlive` is only re-checked at the
    top of the loop. If a read ever outlives the join — a stalled or revoked
    projection is the realistic case — `release()` deletes the native object
    underneath a thread still sitting in `read()`, which is a native crash in
    the middle of a live call, not a caught exception.
  - Fix: call `active.stop()` *before* the `join`. `stop()` is what unblocks a
    pending `read`, so the join then almost always returns immediately and
    `release()` is safe. Keep the existing `IllegalStateException` guard around
    it.
  - **Resolution: Fixed.** `stopLocked` now stops the record before joining the
    reader and releases it afterwards, keeping the `IllegalStateException`
    guard.

### Low

- **[LOW] `status().state` can never report `UNAVAILABLE`** — `mobile/android/app/src/main/java/com/wetalk/screenaudio/ScreenAudioDevice.kt:276-281`
  - `status()` forwards `mixer.state`, which is `capture.state`, and that only
    yields `UNSUPPORTED_PLATFORM`, `IDLE`, `CAPTURING` or `SILENT`. So when the
    audio device module failed to install at startup, JS is handed
    `{ installed: false, state: 'idle' }` — a state that says "supported,
    nothing running" about a build where the seam is absent. `unavailableReason`
    carries the truth, but the field a reader will look at first is wrong.
  - Fix: return `ScreenAudioState.UNAVAILABLE` from `status()` when
    `audioDeviceModule == null`, mirroring what `start()` already returns.
  - **Resolution: Fixed.** `status()` reports `UNAVAILABLE` when the module was
    never installed, instead of forwarding the mixer's `IDLE`.

- **[LOW] `stop()` assumes the noise suppressor was on** — `mobile/android/app/src/main/java/com/wetalk/screenaudio/ScreenAudioDevice.kt:253-256`
  - `start()` disables it, `stop()` sets it unconditionally to `true`. If
    anything else ever turns it off, the first screen share silently turns it
    back on and it stays on.
  - Fix: capture `setNoiseSuppressorEnabled(false)`'s return value (or read the
    prior state) in `start()` and restore that value in `stop()`.
  - **Resolution: Deferred.** Not expressible: `JavaAudioDeviceModule` has no
    getter for the setting, and `setNoiseSuppressorEnabled`'s return value
    reports whether the change applied, not the prior value (confirmed with
    `javap` — the only other member is the static
    `isBuiltInNoiseSuppressorSupported`). Faking a restore would have been
    worse than asserting a default. `stop()` now documents that `true` is
    WebRTC's default and is only safe because this object is the app's sole
    writer.

- **[LOW] Probe check 4 needs `node_modules`, which its README says it doesn't** — `tools/webrtc-audio-probe/probe.sh:196-198`, `tools/webrtc-audio-probe/README.md:30-33`
  - `assert_file` reads
    `mobile/node_modules/react-native-webrtc/.../WebRTCModuleOptions.java`, but
    the README promises the script needs "only curl, unzip and javap … no
    Android SDK, no emulator and no device". On a clean checkout that check
    fails as *"react-native-webrtc accepts an injected audio device module —
    file not found"*, which reads like the seam closed rather than like
    `npm install` has not been run.
  - Fix: either state the `npm install` prerequisite in the README next to the
    tool list, or have `assert_file` distinguish "file absent" from "pattern
    absent" and skip with an explicit `npm install` hint.
  - **Resolution: Fixed.** The README lists `npm install` in `mobile/` as a
    prerequisite for the two repository-reading checks, and `assert_file`
    appends that hint when a missing path is under `mobile/node_modules/`.

### Nit

- **[NIT] Bare `$webrtcSdkVersion` where the repo says `rootProject.ext.`** — `mobile/android/build.gradle:44-46`
  - It resolves (Gradle falls back to the parent project's extra properties),
    but `app/build.gradle:94-95` spells the same kind of lookup
    `rootProject.ext.ndkVersion`. Match the neighbours.
  - **Resolution: Fixed.** Now `${rootProject.ext.webrtcSdkVersion}`.

- **[NIT] `dispose()` clears the static capturer unconditionally** — `mobile/patches/react-native-webrtc+124.0.7.patch`
  - A disposing controller clears `activeScreenCapturer` even if a different
    controller published the current capturer. Only one screen share can exist
    at a time today, so this is theoretical; compare-and-set against its own
    capturer would be strictly more correct and no harder to read.
  - **Resolution: Fixed.** `clearActiveScreenCapturer` compare-and-sets against
    the capturer being disposed; the projection's own `onStop` still clears
    unconditionally, which is what it means. Patch regenerated and recompiled
    against the 125 AAR.

## Resolution summary

8 findings, all addressed: **3 Medium fixed**, **2 of 3 Low fixed, 1 deferred**
(no public API exists to implement it), **2 Nit fixed**. No Critical or High.

Re-validated after the fixes: `tsc --noEmit` clean; `npm run lint` clean; 152
suites / **2563** tests passing; `tools/webrtc-audio-probe/probe.sh` 11/11;
`kotlinc` compiles all 10 `com.wetalk.screenaudio` classes against the real
android-36, React Android, WebRTC 125 and patched `react-native-webrtc` jars;
the patched `react-native-webrtc` Java compiles cleanly (61 classes); and the
PCM harness re-run from the current sources passes 18/18.

## Verified, not findings

Recording these so the next reviewer does not re-litigate them:

- **`PcmMixer.mix` uses `buffer.capacity()`, not the `bytesRead` argument** —
  correct. `WebRtcAudioRecord$AudioRecordThread.run()` branches to its error
  path at offset 383 when `bytesRead != byteBuffer.capacity()`, and passes
  `capacity()` (offset 598) to `nativeDataIsRecorded`. The mixer covers exactly
  the bytes native will read.
- **Signed 16-bit decode and clamping** — `readSample` sign-extends the high
  byte and masks the low one; `coerceIn(-32768, 32767)` prevents the wrap that
  is audible as a click. The odd-length loop guard (`index + 1 < usable`) does
  not over-read.
- **`PcmRingBuffer` overflow accounting** — drop-oldest is implemented
  correctly, including a write larger than the whole buffer keeping only its
  tail, and `count == free` not being miscounted as an overflow.
- **`set -e` and the `[[ -f ]] && unzip` loop in `extract()`** — safe: the
  failing command is not the one following the final `&&`, so it is exempt.
  Empirically confirmed by the 125 AAR, which has no `libs/libwebrtc.jar`.
- **Test doubles were strengthened, not weakened** — `makeStream` in
  `useCallAudioRouting.test.tsx` previously returned a fresh track object per
  `getTracks()` call, making `enabled` assertions vacuous.

## Out of scope (pre-existing, not graded)

- Mobile Jest still reports *"A worker process has failed to exit gracefully"*
  and needs `--forceExit`. Present on the merge base; untouched here.
- iOS screen sharing produces no frames at all without a Broadcast Upload
  Extension target. Documented in `mobile/README.md`; unchanged by this diff,
  which is explicitly Android-only.
- Nothing in this change is device-verified, by design — CI has no Android
  device. That is a gap in evidence, not a defect in the diff, and
  `docs/android-system-audio-decision.md` §5 enumerates it.
