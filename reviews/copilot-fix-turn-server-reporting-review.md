# Grumpy Code Review — copilot/fix-turn-server-reporting vs master

_Reviewed 3e4b547..HEAD, 14 files changed (5 source, 2 Kotlin, 5 test, 1 doc)._

## Summary

Mergeable. Two unrelated defects, both fixed at the cause rather than at the
symptom: the TURN summary no longer leans on React Native's `URL` polyfill
(whose `hostname` getter only matches `^https?://`, so every `turn:` URI came
back host-less), and Picture-in-Picture is no longer requested from an
`AppState` transition that Android is guaranteed to refuse. `npm test` (1035
tests), `npm run lint` and `npm run typecheck` are clean in `mobile/`; master
was clean before the change, so nothing here is a new lint/build regression.
The worst thing left is that the Kotlin half cannot be compiled in this
environment (no Android SDK), so `MainActivity.requestPictureInPicture` and the
rewritten bridge method are reviewed by reading only.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] Kotlin changes are unverified by any local build** —
  `mobile/android/app/src/main/java/com/wetalk/MainActivity.kt:373`,
  `mobile/android/app/src/main/java/com/wetalk/CallServiceModule.kt:80`
  - No Android SDK is available in this environment, so neither file was
    compiled. The API-level guards were checked by inspection: `minSdkVersion`
    is 24, `isInPictureInPictureMode` is API 24, and every API 26 call sits
    behind an `SDK_INT < O` early return.
  - Matters because a Kotlin compile error would only surface in the Android
    APK workflow.
  - Fix: rely on the repository's `Android APK` workflow (currently
    `action_required`, i.e. awaiting approval, not failing) to compile the
    branch before merge.

### Low

- **[LOW] `resetPictureInPictureRequestThrottle` exists mainly for tests** —
  `mobile/src/callService.ts:72`
  - It is now also called from `startCallService`, so a new call never
    inherits the previous call's 1 s request window; without that call it would
    be a test-only export.
  - Fixed in this branch; noted so the extra export is not mistaken for dead
    code.

### Nit

- **[NIT] Nested ternary for `relaySide`** — `mobile/src/hooks/useCallFlow.ts:3309`
  - Three-way nesting is dense, though it matches the ternary-heavy style of
    the surrounding candidate-pair block and passes lint. Left as is.

## Out of scope (pre-existing, not graded)

- `signalingHost()` and `deriveStunUrlsFromTurnUrl()` in
  `mobile/src/webrtcConfig.ts` still use `new URL(...)`, but only ever with
  `http`/`https` inputs, which the React Native polyfill does parse correctly.
- The React `act(...)` warnings printed by `__tests__/hooks/useCallFlow.test.tsx`
  pre-date this branch.
