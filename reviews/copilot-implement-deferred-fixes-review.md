# Grumpy Code Review — copilot/implement-deferred-fixes vs master

_Reviewed 6337b732..c300bcd0 (this task's two decomposition commits; the full
branch also carries an earlier, already-reviewed `6337b73` commit from a
prior task against merge-base `c70b7533`), 21 files changed (+3253/-1001)._

## Summary

Mergeable. This is a clean, behavior-preserving extraction of `useCallFlow.js`
(2693 → ~1940 lines) into five single-responsibility sub-hooks
(`useIdentity`, `useSession`, `useCallHistory`, `usePresenceSearch`,
`useMessaging`) plus a shared `socketProtocol.js`, and of `App.js`'s
`AppShell` into `useChatSync`, `useCallInitiation`, `useCallMinimize`, and a
pure `deriveCallStreams` helper. Every extracted function body was diffed
line-by-line against the original and is logically identical (same
conditions, same dependency semantics, same edge cases: 401-retry-once,
consecutive-connect-error threshold, typing-indicator throttle/timeout,
optimistic message send/rollback, audio-only-call camera-off deferral,
Android hardware-back minimize). The original 81-test `useCallFlow.test.js`
suite still passes unmodified, plus 91 new focused unit tests were added for
every extracted module. Full suite: 45 suites / 514 tests passing, lint
clean. Found two minor issues during review (a stale-closure-risk dependency
array smell and Prettier formatting drift), both fixed before this report was
finalized; re-verified lint + full suite green afterward.

## Findings

### Critical
None.

### High
None.

### Medium
None.

### Low

- **[LOW] `useCallFlow.js` return object still hand-remaps every field** — `mobile/src/hooks/useCallFlow.js:1846-1930` (approx.)
  - The final `return { ... }` block individually re-exposes every field from
    each sub-hook (e.g. `userId: identity.userId`, `callHistory:
    callHistory.callHistory`) rather than spreading the sub-hook objects and
    overriding only what differs. This is intentional and defensible — it
    keeps the hook's public API pinned to its pre-refactor shape so
    `useCallFlow.test.js` and every consumer keep working unchanged — but it
    does mean adding a new field to a sub-hook later requires remembering to
    also thread it through this return block, which is an easy place to
    forget. Not asking for a change here (spreading would risk silently
    changing the public API's key names/order if a sub-hook's internals
    shift), just flagging it as a maintenance trap for future contributors.

### Nit

- **[NIT] `useCallHistory`/`useMessaging`/`usePresenceSearch` log tags changed** — e.g. `mobile/src/hooks/useCallHistory.js:66` now logs `'[CallHistory] fetchCallHistory failed'` instead of the original `'[CallFlow] fetchCallHistory failed'`. This is a reasonable and arguably better change (log tag now matches the owning module), called out only so nobody searching old log tags in a dashboard is surprised. No action needed.

## Fixes applied during this review

1. **Unnecessary re-creation of `unregisterUser` every render** — `mobile/src/hooks/useCallFlow.js`: the wrapper `unregisterUser` `useCallback` depended on the whole `identity` object (`[identity, sessionIdRef, signalingUrl]`), which is a fresh object literal returned by `useIdentity()` on every render, so the callback was being recreated on every render for no reason (the established pattern elsewhere in this same PR — e.g. `useCallInitiation` — is to depend on individual stable functions instead of a whole hook-return object for exactly this reason). Fixed by destructuring `unregisterUser: identityUnregisterUser` from `identity` alongside the existing `userId`/`verificationCodeRef` destructure and depending on that instead. Re-verified: lint clean (this was actually caught as a hard `react-hooks/exhaustive-deps` error once the dependency changed shape, not just a style nit), full suite still 514/514.
2. **Prettier drift** — `mobile/App.js`, `mobile/src/hooks/useCallFlow.js`, and 4 new test files (`useIdentity.test.js`, `useMessaging.test.js`, `usePresenceSearch.test.js`, `useSession.test.js`) had lines that didn't match the repo's `.prettierrc.js` formatting (long destructures/dependency arrays left on one line instead of wrapped). `eslint .` doesn't enforce Prettier in this repo, so it passed silently. Ran `npx prettier --write` on the six files; diff is whitespace/wrapping only, no logic change. Re-verified: lint clean, full suite 514/514.

## Out of scope (pre-existing, not graded)

- The Kotlin changes (`CallConnections.kt`, `IncomingCallActionReceiver.kt`,
  `IncomingCallNotificationModule.kt`, `MainActivity.kt`) and the
  `reviews/copilot-show-wetalk-incoming-call-ui-review.md` update are from
  commit `6337b73`, an earlier, already-completed and already-reviewed task
  on this same branch (fixing a notificationId collision risk and a DIP
  smell in `VoiceConnectionService`). They are unrelated to this task's
  `useCallFlow.js` / `AppShell` decomposition and were not re-reviewed here.
- `App.js` has no dedicated test file (`App.test.js` does not exist anywhere
  in the repo, before or after this change), so the `AppShell` JSX
  composition/wiring itself carries more residual regression risk than the
  hook logic, which is now covered by focused unit tests. This is a
  pre-existing gap, not introduced by this diff.
- `react-native-fs`'s TypeScript-syntax parse failure under the default Jest
  babel transform (requiring `jest.mock('../src/diagnostics', ...)` in any
  test that transitively imports it) is a pre-existing repo quirk, not
  something introduced by `callStreamHelpers.js` or its test.
