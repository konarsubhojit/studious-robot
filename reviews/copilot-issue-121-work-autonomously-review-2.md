# Grumpy Code Review — copilot/issue-121-work-autonomously vs 615edc9

_Reviewed 615edc9..ae8fdd3, 71 files changed (this pass focuses on the commits added
after the first review: `e863e14`..`ae8fdd3`)._

## Summary

Mergeable. It is a JSDoc-typing migration, so most of the diff is comments, and both
projects are green (`tsc --noEmit`, `eslint`, 926 mobile tests, 373 server tests + 1
skipped). The worst thing in it is a pair of quiet **behaviour** changes smuggled in
under the guise of "typing": swapping `error?.message` for `error instanceof Error ?
error.message : ''` in `cameraLighting.js` and `authService.js` narrows the set of
values those predicates recognise, and both predicates exist precisely to classify
errors thrown by native modules — which are frequently *not* `Error` instances.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] `isNotImplementedError` stops recognising non-`Error` rejections** — `mobile/src/cameraLighting.js:12`
  - Was `Boolean(error) && /not implemented/i.test(error.message || '')`; now
    `error instanceof Error && /not implemented/i.test(error.message || '')`.
    The file's own comment says these come from "react-native-webrtc on Android",
    i.e. across the native bridge, where a rejection is routinely a plain object
    `{ message: 'Not implemented.', code: … }` rather than an `Error`.
  - Why it matters: such a value now falls through to
    `logError('Failed to read camera state for lighting adjustment', …)` on every
    single `getSettings`/`getCapabilities` probe, which is exactly the error-level
    log spam the predicate was written to prevent. The existing unit test only
    throws a real `Error`, so the regression is invisible to CI.
  - Fix: use the shared helper this branch just introduced —
    `import { errorMessage } from './errorMessage';` and test
    `/not implemented/i.test(errorMessage(error))`. It handles `Error`, plain
    objects with a string `message`, and stringifies everything else.

- **[MEDIUM] `isFirebaseAppUnavailableError` narrows the same way** — `mobile/src/authService.js:20`
  - `const message = error?.message || ''` became
    `const message = error instanceof Error ? error.message : ''`.
  - Why it matters: this predicate is what turns a raw Firebase failure into the
    friendly `auth/app-not-configured` error the sign-in UI relies on. A
    `@react-native-firebase` rejection that arrives as a plain object now skips
    that mapping and the user sees the raw native message instead of
    "Firebase is not configured in this build…".
  - Fix: same as above — `errorMessage(error)` instead of the `instanceof` ternary.

### Low

- **[LOW] Third `toMessage`/`errorMessage` implementation** — `server/src/security.js:57`
  - The branch already has `toMessage` in `server/src/messageBus.js` and
    `errorMessage` in `mobile/src/errorMessage.js`; this adds a third copy with
    the same body. Mobile's duplication was consolidated in this very branch, so
    the server side is now the inconsistent half.
  - Fix: move `toMessage` into `server/src/lib/normalize.js` (already
    `@ts-check`ed and already the home of small value-normalising helpers) and
    import it from `security.js` and `messageBus.js`.

- **[LOW] `SafeRTCViewProps` opts out of prop checking** — `mobile/src/SafeRTCView.js:21`
  - `{ streamURL?: string, … } & Record<string, any>` means any misspelled prop
    passed to `<SafeRTCView>` is accepted, so the annotation buys documentation
    but no checking for the `...rtcProps` pass-through.
  - Fix: acceptable for now because `RTCView`'s own props are untyped in this
    project, but note it in `TYPESCRIPT_MIGRATION.md` as a follow-up so it isn't
    mistaken for a checked surface.

- **[LOW] `normaliseId(...) ?? ''` silently changes the lookup key** — `server/src/signaling/callHandlers.js:74,175`
  - A rejected id used to be `null` and is now `''`. Behaviourally identical
    (`state.calls` is keyed by non-empty ids, so both miss and produce the same
    `call_not_found` ack), but the empty string reads like a valid key.
  - Fix: either keep it and add a one-line comment saying "`''` can never match a
    stored call id", or reject early with the existing `call_not_found` ack when
    `normaliseId` returns `null`.

### Nit

- **[NIT] `(result.success && result.path) || null`** — `mobile/src/ErrorBoundary.js:41`
  - Correct, but it leans on `&&`/`||` coercion where the intent is "path when the
    save succeeded". `result.success ? result.path ?? null : null` says the same
    thing without the falsy-empty-string edge case.

## Resolution

All Medium and Low findings above were fixed in a follow-up commit:
`cameraLighting.js` and `authService.js` now read messages through the shared
`errorMessage` helper, the server's duplicated `toMessage` helpers were replaced
by `toLogMessage` in `server/src/lib/normalize.js`, and the `ErrorBoundary`
ternary was made explicit. The `SafeRTCViewProps` note is recorded as a
follow-up in `TYPESCRIPT_MIGRATION.md`.

## Out of scope (pre-existing, not graded)

- `server/` has no `lint` npm script, so the server half of this branch is checked
  by `tsc` and `node --test` only. Not introduced here.
- `mobile/src/appLogger.js` (48 errors) and `mobile/src/telemetry.js` (14) were
  opted into `@ts-check` and backed out again during this session; they remain
  unchecked, as do `useCallFlow.js`, `useMessaging.js`, `ChatConversationScreen.js`,
  `server/src/lib/state.js`, `persistence.js`, `calls.routes.js` and
  `messages.routes.js`. That is the documented incremental plan, not a defect.
- The jest run prints "A worker process has failed to exit gracefully"; this
  predates the branch.
