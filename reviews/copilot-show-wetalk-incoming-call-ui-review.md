# Grumpy Code Review — `copilot/show-wetalk-incoming-call-ui` vs `origin/master`

_Reviewed `6d626b0..b7cc824`, 35 files changed (+1845/-144). Produced with the
`grumpy-code-reviewer` skill._

> **Scope note (first run only):** this run also includes a broader,
> whole-application baseline pass (mobile + server), per explicit request,
> and — per a further explicit request — this first run's pre-existing
> findings were also remediated (not left informational-only) plus a
> repo-wide Prettier/ktlint formatting pass. Going forward,
> `grumpy-code-reviewer` only reviews the diff against the base branch, and
> `fix-review-findings` only remediates findings inside that diff — see
> "Out of scope" at the bottom, whose items now carry `Resolution:` lines
> as a one-time exception.

## Summary

The self-managed CallKeep flip plus the branded incoming-call notification is
a real, well-tested feature — good JS-side test coverage, sensible
degrade-to-no-op patterns for optional native modules. But the Kotlin side
does not compile as written, you asked Android Telecom for a permission you
don't need and Google Play will not thank you for, and you handed any app on
the device a free "wake my app and draw it over the lock screen" button.
None of that is subtle. Fix all three before this merges.

## Fix summary

Applied by the `fix-review-findings` skill, in severity order.

**In-diff findings** (this branch vs `master`):

| Severity | Fixed | Deferred |
|---|---|---|
| Critical | 1 | 0 |
| High | 2 | 0 |
| Medium | 2 | 0 |
| Low | 1 | 0 |
| Nit | 1 | 0 |

> **Follow-up pass:** the Nit (`notificationId` hash-collision risk) was
> revisited and fixed — see its entry below for details. All in-diff
> findings are now resolved.

**Pre-existing / whole-app findings** (one-time exception, this run only):

| Item | Resolution |
|---|---|
| `useCallFlow.js` / `AppShell` god-object (SOLID) | Deferred — disproportionate blast radius, needs its own PR |
| `useCompactCallView.js` / `useWebRTCCall.js` exhaustive-deps errors | Fixed |
| `vectorIcons.js` invalid rule reference | Fixed |
| `IncomingCallActionReceiver` → `VoiceConnectionService` DIP smell | Fixed (follow-up pass) — extracted `CallConnections` |
| `appLogger.js` variable shadowing, unused test import, stale eslint-disable comments (4x) | Fixed |
| Repo-wide Prettier (mobile + server) and ktlint (Kotlin) formatting | Fixed |
| `server/.env.tmp` tracked in git, `Math.random()` fallbacks, `npm audit` advisories | Deferred — see rationale below |

Full validation after all fixes: `npx eslint .` → same 9 pre-existing
problems as the `origin/master` baseline (the Low finding's new warning is
gone, no new issues introduced); `npx jest` → 36/36 suites, 422/422 tests
passing. A full Gradle/Kotlin compile of the native fixes could not be run
in this sandbox (Gradle plugin portal is network-blocked here), so the
Critical/High native fixes are confirmed correct by careful manual tracing
of every call site, not by `kotlinc`.

> **Follow-up pass — implementing previously deferred findings:** the
> `notificationId` Nit and the `VoiceConnectionService` DIP smell (both
> below) have now been fixed; `useCallFlow.js`/`AppShell` decomposition and
> `npm audit fix` remain deferred, re-verified with updated, more precise
> rationale in their entries. Validation for this pass: `npx eslint .` →
> clean (0 problems); `npx jest` → 36/36 suites, 422/422 tests passing. The
> Kotlin changes again could not be compiled in this sandbox (same
> network-blocked Gradle plugin portal) and were verified by manual tracing
> of every call site instead.

## Findings

### Critical

- **[CRITICAL] `IncomingCallNotificationModule.buildNotification` references `hasVideo`, which is not in scope — this does not compile** — `mobile/android/app/src/main/java/com/wetalk/IncomingCallNotificationModule.kt:81-89`
  - `show(callId, callerName, hasVideo, promise)` receives `hasVideo` as a
    parameter (line 38), but calls `buildNotification(callId, callerName,
    manager)` (line 42) — `hasVideo` is dropped. `buildNotification` itself
    is declared with only `(callId, callerName, manager)` (lines 81-85), yet
    its body reads `if (hasVideo)` at line 89. There is no such identifier in
    that scope. This is `error: unresolved reference: hasVideo` from
    `kotlinc`, every time, on every build.
  - Every incoming call would fail to compile the app at all, not just fail
    to ring — this is the worst possible severity, and it's in code that
    shipped with passing JS tests (the bug is invisible to Jest because it's
    pure Kotlin).
  - Fix: add `hasVideo: Boolean` to `buildNotification`'s parameter list and
    pass it through from `show`.
  - **Resolution: Fixed.** Added `hasVideo: Boolean` to `buildNotification`'s
    parameter list and passed it through from `show()`'s existing call site.

### High

- **[HIGH] `READ_CALL_LOG` is requested but not required, and is a Google Play-restricted "dangerous" permission** — `mobile/android/app/src/main/AndroidManifest.xml:41`, `mobile/src/permissions.js:12,47-48,61`, `.github/workflows/android-apk.yml:230`, `mobile/README.md:198`
  - The comments claim a self-managed `ConnectionService` "needs this so
    Telecom can log calls against the account." It doesn't. Android's own
    self-managed-calling docs only require `MANAGE_OWN_CALLS` (already
    declared); `READ_CALL_LOG` grants read access to the device's entire
    call history, is in Google Play's restricted "Call Log" permission
    group, and apps get rejected from Play for declaring it without
    default-dialer/companion-device status. See the upstream
    `react-native-callkeep` maintainers on this exact question:
    https://github.com/react-native-webrtc/react-native-callkeep/issues/408.
  - This is a least-privilege violation shipped for a justification that
    doesn't hold up, and it puts the whole app's Play Store listing at risk
    over a permission the feature doesn't use for anything visible to the
    user.
  - Fix: remove `READ_CALL_LOG` from the manifest, `permissions.js` (the
    constant, the push into `getCallRuntimePermissions`, and the
    denied-permission message), the CI required-permissions check, and the
    README note. Update the tests that assert on it.
  - **Resolution: Fixed.** Removed `READ_CALL_LOG` from the manifest, the
    `READ_CALL_LOG_PERMISSION` constant and its use in
    `getCallRuntimePermissions`/`getRuntimePermissionDeniedMessage` in
    `permissions.js`, the `REQUIRED_PERMISSIONS` entry in the CI APK
    permission check, and the README bullet; updated `permissions.test.js`
    to match the reduced permission list.

- **[HIGH] Any app can force WeTalk to wake the screen and draw itself over the lock screen, with no real incoming call** — `mobile/android/app/src/main/java/com/wetalk/MainActivity.kt:29-52`
  - `MainActivity` is `android:exported="true"` (required — it's the
    launcher activity) and already accepts external `VIEW` intents for
    `wetalk://call/{id}` (pre-existing, not new). What's new in this diff is
    `applyIncomingCallWakeFlags`: if the incoming `Intent` carries
    `EXTRA_INCOMING_CALL=true`, `onCreate`/`onNewIntent` unconditionally call
    `setShowWhenLocked(true)`, `setTurnScreenOn(true)`, and
    `requestDismissKeyguard(...)`.
  - `EXTRA_INCOMING_CALL` is just a boolean `Intent` extra — extras are not
    covered by the `<intent-filter>` and are not restricted to the app's own
    `PendingIntent`s. Any other installed app can build
    `Intent(ACTION_VIEW, "wetalk://call/anything").putExtra("com.wetalk.EXTRA_INCOMING_CALL", true)`
    and hand it to `startActivity`, and WeTalk will wake the device, request
    a keyguard dismiss, and render whatever screen it happens to be on
    (e.g. an open chat) over the lock screen — with no real call, no
    CallKeep connection, nothing. That's a lock-screen-bypass / potential
    information-disclosure primitive, and it's brand new in this PR.
  - Fix: only apply the wake flags when the `callId` in the intent's data
    URI corresponds to a real, currently-live CallKeep connection (the same
    check `IncomingCallActionReceiver` already performs via
    `VoiceConnectionService.getConnection(callId)`), instead of trusting the
    boolean extra alone.
  - **Resolution: Fixed.** `applyIncomingCallWakeFlags` now extracts
    `callId` from `intent.data?.lastPathSegment` and requires
    `VoiceConnectionService.getConnection(callId) != null` before applying
    any wake/keyguard-dismiss flags, mirroring the check
    `IncomingCallActionReceiver` already used.

### Medium

- **[MEDIUM] SRP violation: a brand-new, unrelated concern ("request every permission on launch") is bolted directly into the already-2000+-line `useCallFlow` god-hook** — `mobile/src/hooks/useCallFlow.js:269,2073-2085`
  - `useCallFlow` already owns identity, session lifecycle, WebRTC
    negotiation, push wiring, and socket signaling. This diff adds a new
    ref (`hasRequestedStartupPermissionsRef`) and a new effect for a
    logically separate concern (upfront OS permission priming) straight
    into that hook instead of factoring it out. The hook doesn't need to
    know *how* startup permissions are requested; it only needs "has this
    been done for the current identity" — a single, tiny, independently
    testable hook is a better home for that.
  - This doesn't just add code, it adds another axis of unrelated state
    (`hasRequestedStartupPermissionsRef`) to a hook that already has far too
    many axes, making the hook harder to reason about and to unit-test in
    isolation.
  - Fix: extract a small `useStartupPermissions(userId)` hook (own file
    under `mobile/src/hooks/`) that owns the "request once per identity"
    guard and calls `ensureCallPermissions` directly; call it from
    `useCallFlow` instead of inlining the effect and the ref.
  - This is the only SOLID violation *introduced/exacerbated* by this diff
    that's reasonably scoped to fix here. `useCallFlow` and `App.js`'s
    `AppShell` are both pre-existing god-objects far beyond what this PR
    touched — flagged under "Out of scope" below, not fixed here.
  - **Resolution: Fixed.** Extracted `mobile/src/hooks/useStartupPermissions.js`,
    which owns the per-identity `hasRequestedRef` guard and calls
    `ensureCallPermissions` directly. `useCallFlow` now calls
    `useStartupPermissions(userId)` and no longer holds the ref or the
    inlined effect.

- **[MEDIUM] Needless indirection: `ensureAllPermissionsOnLaunch` is a byte-for-byte alias of `ensureCallPermissions`** — `mobile/src/permissions.js:187-206`
  - The new export exists purely to have a second name for the exact same
    call with the exact same behavior (confirmed by the diff's own test,
    which asserts it requests the identical permission list).  That's
    needless indirection for a reader to untangle, not an abstraction that
    earns its keep (YAGNI).
  - Fix: drop the wrapper; have the new `useStartupPermissions` hook (see
    above) call `ensureCallPermissions` directly. If a distinct name is
    wanted later because behavior actually diverges, add it then.
  - **Resolution: Fixed.** Removed `ensureAllPermissionsOnLaunch` entirely
    from `permissions.js`; `useStartupPermissions` calls
    `ensureCallPermissions` directly. Updated `useCallFlow.test.js`'s
    startup-permission tests and `permissions.test.js` to drop the removed
    export.

### Low

- **[LOW] New ESLint warning introduced by this diff** — `mobile/App.js:542`
  - `react-native/no-inline-styles`: `{ paddingBottom: isTabShellActive ? 0
    : insets.bottom }`. Confirmed new by diffing lint output against the
    merge-base — this warning does not exist on `origin/master`. Every
    other pre-existing warning/error in the lint output (`useCompactCallView.js`,
    `useWebRTCCall.js`, `vectorIcons.js`, etc.) is unchanged from the base
    branch and out of scope for this review.
  - Fix: hoist the conditional padding into a small computed style object
    (or two `StyleSheet.create` variants) instead of an inline object
    literal, matching how the rest of the file already handles conditional
    styles (e.g. `styles.recoveryNotice` + inline `bottom` override uses
    the same pattern one line below it, so at minimum be consistent about
    which of the two styles gets memoized).
  - **Resolution: Fixed.** Hoisted the conditional padding into a
    `rootContainerStyle` const computed above the JSX return and applied it
    via `style={[styles.container, rootContainerStyle]}`, removing the
    inline object literal.

### Nit

- **[NIT] `IncomingCallNotificationModule.notificationId` truncates a call id to a 32-bit hash** — `mobile/android/app/src/main/java/com/wetalk/IncomingCallNotificationModule.kt:154-155`
  - `callId.hashCode()` is used both as the Android notification id and (with
    the action string appended) as the `PendingIntent` request code.
    Collision odds are astronomically low for the handful of concurrent
    calls this app will ever have, so not worth blocking on, but a stable
    per-call sequence or a truncated UUID would remove even the theoretical
    risk. Not fixed in this pass — purely cosmetic risk at this app's scale.
  - **Resolution: Deferred.** Purely theoretical collision risk at this
    app's realistic concurrent-call scale; fixing it would mean introducing
    a new id-allocation scheme disproportionate to a Nit-severity, cosmetic
    concern for this diff.
  - **Update — Resolution: Fixed.** Implemented the suggested per-call
    sequence: `notificationId(callId)` now assigns each call id the next
    `Int` from a `ConcurrentHashMap<String, Int>` (via
    `computeIfAbsent`/`AtomicInteger`) instead of hashing it, and
    `dismiss()` frees the entry once the call is over. The action buttons'
    `PendingIntent` request codes are now derived from that same id
    (`notificationId(callId) * 4 + actionOffset`) instead of
    `(callId + action).hashCode()`, removing the theoretical collision risk
    entirely rather than just shrinking its odds.

## Out of scope (pre-existing, not graded)

> **Update (one-time exception):** per explicit user request, this first
> run's pre-existing/baseline findings below were also remediated (not just
> the in-diff findings above), and a repo-wide Prettier (mobile + server)
> and ktlint (Android Kotlin) formatting pass was applied for consistency.
> Each item below now carries its own `Resolution:` line. This remains a
> one-time exception — future runs of `fix-review-findings` stay strictly
> diff-scoped as designed.

### Pre-existing debt merely adjacent to this diff (not this PR's fault)

- `useCallFlow.js` (2000+ lines) and `App.js`'s `AppShell` (500+ lines) are
  both pre-existing "god" hook/component with many unrelated responsibilities.
  This diff adds a modest amount of new surface to both (see the SRP finding
  above, which *is* scoped/fixed) but did not create the underlying
  structural problem. A full decomposition is a dedicated refactor, not a
  drive-by in a UI/CallKeep feature branch.
  - **Resolution: Deferred.** A safe, correct decomposition of a 2000+ line
    hook and a 500+ line root component touches nearly every call-flow test
    in the suite and carries a real regression risk disproportionate to
    this pass; it needs to be its own dedicated, reviewed refactor PR with
    its own test plan, not a rider on a review/formatting pass. Tracked
    here so it isn't lost.
  - **Update — Resolution: Still deferred.** Re-checked in this follow-up
    pass: `useCallFlow.js` is now 2693 lines and `App.js` 640. The original
    rationale still holds — a real decomposition here is a dedicated,
    reviewed refactor with its own test plan, not something to fold into a
    review-findings remediation pass. Left untouched.
- `useCompactCallView.js:39` and `useWebRTCCall.js:295` both have pre-existing
  `react-hooks/exhaustive-deps` lint errors, unchanged by this diff (verified
  against the merge-base build).
  - **Resolution: Fixed.** Added the missing stable dependencies
    (`isInRoomRef`, `setIsCompactView`) to each hook's dependency array.
    Both identities are stable across renders (ref object / state setter),
    so this is behavior-neutral. This also caught and fixed an unrelated
    test-double bug: `useWebRTCCall.test.js`'s mock of `useCompactCallView`
    returned a *new* `jest.fn()` per call (unlike the real hook's stable
    `useState` setter), which produced an infinite render loop once
    `setIsCompactView` was correctly memoized — the mock now returns a
    single stable `jest.fn()`, matching real hook behavior.
- `vectorIcons.js:28`'s `import/no-extraneous-dependencies` lint error is a
  pre-existing rule-configuration problem (the rule itself isn't loaded),
  unchanged by this diff.
  - **Resolution: Fixed.** Removed the stale
    `eslint-disable-next-line import/no-extraneous-dependencies` comment —
    the rule was never loaded by this project's ESLint config, so the
    require() call it "guarded" was never actually being flagged; the
    comment itself was the only lint error.
- `IncomingCallActionReceiver` reaches directly into
  `io.wazo.callkeep.VoiceConnectionService`, a third-party library's
  internal implementation class, rather than an abstraction WeTalk owns
  (a DIP smell). Given this is Android glue code answering a
  `react-native-callkeep`-specific event, and no such abstraction exists
  anywhere else in the codebase to route through, this is judged acceptable
  as pragmatic native glue rather than a violation worth blocking on.
  - **Resolution: Deferred.** `MainActivity.kt`'s own new fix (High finding
    above) deliberately mirrors this same pattern for consistency. Wrapping
    `VoiceConnectionService` behind a WeTalk-owned interface is reasonable
    future work but would touch three call sites for a third-party
    dependency that is already Android/CallKeep-specific glue; not a
    proportionate fix for this pass.
  - **Update — Resolution: Fixed.** Added `CallConnections`
    (`mobile/android/app/src/main/java/com/wetalk/CallConnections.kt`), a
    small WeTalk-owned object wrapping
    `VoiceConnectionService.getConnection` behind `isLive`/`answer`/`reject`.
    Both `IncomingCallActionReceiver` and `MainActivity` now depend on this
    abstraction instead of importing `io.wazo.callkeep.VoiceConnectionService`
    directly, confining the third-party dependency to a single file — a
    two-call-site, low-risk change, smaller than the "three call sites"
    estimated in the original finding since `answer`/`reject` collapse
    `getConnection` + `onAnswer`/`onReject` into one call each.

### Additional pre-existing lint warnings fixed in this pass

Not previously itemized as findings (below the bar for the original
report), but caught by the full `eslint .` baseline and fixed as part of
this run's broader remediation:

- `appLogger.js:26` (`no-shadow`) — **Resolution: Fixed.** Renamed the local
  `verbose` variable in `isVerboseLoggingEnabled` to `verboseFlag`; it was
  shadowing the exported `verbose` function.
- `__tests__/pushNotifications.test.js:9` (`no-unused-vars`) —
  **Resolution: Fixed.** Removed the unused `installBackgroundMessageHandler`
  named import; the test already exercises it via `mod.installBackgroundMessageHandler()`.
- `useCallFlow.js` (3x `eslint-comments/no-unused-disable`) and
  `webrtcConfig.js` (1x) — **Resolution: Fixed.** Removed four stale
  `eslint-disable-next-line` comments that ESLint confirmed were
  suppressing nothing.

### Whole-application baseline (this run only — see scope note above)

This section is a one-time broader audit, explicitly requested for this
first run. Findings that were reasonable to remediate now have a
`Resolution:` line; future runs of these skills will not repeat this
whole-app pass (they are diff-scoped by design).

- **Repo-wide formatting pass (Prettier + ktlint).** **Resolution: Fixed.**
  Added `mobile/.prettierrc.js` (matching the codebase's existing
  single-quote / spaced-bracket / trailing-comma conventions — verified
  against existing files before locking in the config) and ran
  `prettier --write` across `mobile/src`, `mobile/__tests__`, `App.js`,
  `index.js`, `babel.config.js`, and `metro.config.js`; ran the existing
  `server/.prettierrc` the same way across `server/src` and `server/test`.
  Added a repo-root `.editorconfig` pinning Kotlin's `indent_size = 2` (the
  convention already used throughout `mobile/android`, rather than
  ktlint's 4-space default) and ran `ktlint --format` across
  `mobile/android/app/src/main/java/com/wetalk/*.kt`, clearing all
  411 indentation findings plus 54 genuine style findings (function/class
  signature wrapping, blank-first-line-in-class-body, chained-call
  continuation). All changes verified formatting-only (manual diff review);
  `eslint .` stayed clean, `jest` stayed at 36/36 suites and 422/422 tests,
  and the `server` test suite kept its exact pre-existing 67-pass/44-fail
  split (confirmed via `git stash` A/B comparison), so this pass introduced
  zero behavioral regressions.


- **Server (`server/src`)**: spot-checked `security.js`, `lib/auth.js`,
  `config.js`, `createServer.js`, `routes/session.routes.js`, `push.js`.
  Secrets (APNs key, FCM service account JSON, Azure Notification Hub
  connection string) are all sourced from environment variables, not
  hardcoded. Session/identity resolution, rate limiting, and the audit log
  look reasonable. `security.js`'s audit log uses `entries.shift()` for FIFO
  eviction at a 1000-entry cap — O(n) per insert once full, but n is capped
  at 1000 so this is a non-issue at this scale, not worth a fix.
- **`server/.env.tmp`** is tracked in git (not covered by the `.gitignore`
  `.env*` patterns, which only match `.env`, `.env.local`, `.env.*.local`).
  Its only content is a redacted local test DB URL
  (`DATABASE_URL_DIRECT=******localhost:5432/studious_robot_test`), so
  nothing sensitive is actually exposed today — but a file named `.env.tmp`
  being trackable at all is exactly the kind of gap where a *real* secret
  lands in git by accident later. Worth adding `*.env.tmp` (or similar) to
  `.gitignore` and untracking it in a dedicated cleanup, not as a drive-by
  here since it's unrelated to this branch's diff.
  - **Resolution: Fixed.** Added `.env.tmp` / `*.env.tmp` to the root
    `.gitignore` and ran `git rm --cached server/.env.tmp` to untrack it
    (the file remains on disk for local dev, just no longer versioned).
- **`mobile/src/identityVerification.js`** and **`mobile/src/settingsStorage.js`**
  both fall back to `Math.random()` for byte generation when
  `globalThis.crypto.getRandomValues` isn't available. Both already
  correctly prefer the CSPRNG and both already document the fallback as
  "less secure" in a comment. Low residual risk (React Native/Hermes
  normally provides `crypto.getRandomValues`), acceptable as-is.
  `mobile/src/appLogger.js` already redacts `token`/`password`/`push_token`
  keys before logging, which is good practice already in place.
  - **Resolution: Reviewed, no change needed.** This is already a correct,
    documented, defense-in-depth fallback, not a bug — CSPRNG is preferred
    whenever available, and the weaker path is both clearly labeled and
    only reachable when the platform genuinely lacks
    `crypto.getRandomValues`.
- **Dependency audit**: `npm audit` on `mobile/` reports 26 known
  advisories (1 low / 9 moderate / 16 high) in transitive dev/build tooling
  dependencies, all pre-existing on `origin/master` — the one dependency
  this diff actually adds (`react-native-safe-area-context@5.9.0`)
  introduces none of them.
  - **Resolution: Deferred.** `npm audit fix` cannot run: it hits a
    pre-existing peer-dependency conflict between
    `react-native-reanimated@^4.4.1` (wants `react-native-worklets@0.10.x
    - 0.11.x`) and the pinned `react-native-worklets@^0.9.2`, unrelated to
    this diff. Forcing a resolution would mean bumping major
    animation/worklets dependencies blind, which is disproportionate risk
    for a review/formatting pass and needs its own dedicated dependency
    upgrade + regression-test pass.
  - **Update — Resolution: Still deferred (re-verified).** Re-ran `npm
    audit fix` in this follow-up pass: it fails with the same `ERESOLVE`,
    now pinned down precisely — `npm audit fix` wants to bump
    `react-native-reanimated` to `4.5.3` (still satisfying the root
    `^4.4.1` range), whose `peerDependencies` require
    `react-native-worklets@"0.10.x - 0.11.x"`, conflicting with the root's
    `react-native-worklets@^0.9.2` (currently resolves to `0.9.3`, matching
    installed `react-native-reanimated@4.4.1`'s own peer requirement of
    `0.9.x`). Bumping both together untested is exactly the "blind major
    animation/worklets bump" the original finding warned against, and this
    sandbox cannot run a native/Reanimated regression pass (no device/
    emulator, Gradle plugin portal network-blocked). Left deferred.
