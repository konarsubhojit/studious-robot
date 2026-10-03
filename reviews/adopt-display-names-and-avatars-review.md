# Grumpy Code Review — copilot/adopt-display-names-and-avatars vs origin/master

_Reviewed ab157a3d3db316c5dfa77da1a639931d98a9f4a2..286a671df18b36bb8dc64fc937ee6e9fa2751559, 70 files changed._

## Summary

Not mergeable yet: one High and one Medium finding remain. The identity/routing separation, authenticated avatar boundary, and scoped provider are sensible, but the new store does not actually recover a mounted unresolved peer after an exact-lookup failure. Its avatar error path also lets an obsolete request impose a cooldown on a replacement picture. Passing tests do not cover either lifecycle sequence.

## Findings

### Critical

None.

### High

- **[HIGH] Exact-profile cooldown has no mounted retry** — `mobile/src/profile/profileStore.ts:123`
  - **Evidence:** For a visible history/chat peer outside the 100-row bootstrap directory, `ensureProfile` records `exactRetryAt = now + RETRY_MS` before the exact request. On a network failure, HTTP failure, or absent match, `fetchPeerProfile` returns `null`; lines 133–140 remove its avatar deadline and call `schedule()`. But `schedule()` at lines 181–201 considers only `deadlines`, never `exactRetryAt`. With an initially unknown peer, there is no avatar key, no deadline, and no changed snapshot to emit. `usePeerProfile` only invokes the lookup from its effect when `[store, userId, profile]` changes (`mobile/src/profile/ProfileContext.tsx:52–57`). Waiting past 60 seconds changes none of those dependencies.
  - **Impact:** A transient failure leaves the name and avatar unresolved indefinitely while the same screen stays mounted, even after connectivity recovers. A later foreground refresh or remount after the cooldown can recover; simply remaining on the screen cannot. The previously reported defect is still present.
  - **Fix:** Include watched unresolved peers' exact-lookup cooldowns in the store's scheduler. At expiry, retry their profile lookup or publish a fresh peer snapshot that causes the hook to retry, without bypassing deduplication/concurrency limits. Remove or ignore retry deadlines for unwatched, blocked, resolved, or disposed peers. Add mounted integration cases for a first exact request failing, then succeeding after the cooldown, with no remount or AppState transition.
  - **Baseline:** The entire profile store/provider is new; the merge base had no equivalent exact-lookup retry machinery. This is introduced by this branch.
  - **Resolution: Fixed.** The scheduler now includes watched unresolved `exactRetryAt` deadlines and retries via the existing deduplicated, two-request-bounded `ensureProfile` queue. Resolved, unwatched, blocked, and disposed peers are ignored; pending exact operations are excluded until cleanup re-arms scheduling, avoiding expired-deadline busy loops. Three mounted chat-list fake-timer cases (network error, HTTP denial, absent match) recover the name and authorized avatar at 60 seconds without remount/foreground changes and preserve raw-ID routing. Direct store tests cover inactive deadlines, pending requests beyond expiry, deduplication, and bounded retry concurrency. All nine new High regression cases failed before the fix and passed afterward.

### Medium

- **[MEDIUM] Obsolete avatar errors throttle the current avatar generation** — `mobile/src/profile/profileStore.ts:226`
  - **Evidence:** The success handler rejects an obsolete request using both the captured avatar `key` and `accessVersion` at lines 211–212. The rejection handler checks only `disposed` and `blocked`, then writes a fresh 60-second deadline at line 227. Concrete sequence: start a download for key A; a directory/profile update seeds key B and clears A's deadline; A's still-pending download rejects. Its catch now stamps B's deadline. Although `finally` notices the changed key and calls `ensureAvatar` at lines 233–234, that call immediately exits on the deadline guard at line 205. The same contamination occurs when a pending request spans a block/unblock cycle.
  - **Impact:** An unrelated, obsolete network failure suppresses the replacement avatar for a full cooldown. The current generation's request never gets a chance to run when the update arrives. The existing changed-key test covers an old successful response, not an old rejected response.
  - **Fix:** Apply the same captured key/access-version fence in the catch handler before setting a retry deadline. Preserve the `finally` replacement retry. Add cases where an old request rejects after a key change and after block/unblock; assert the current download starts without waiting 60 seconds.
  - **Baseline:** Avatar downloads and these per-generation error/cooldown rules are new in this branch; the merge-base primitive rendered initials only.
  - **Resolution: Fixed.** The avatar rejection handler now applies the same captured key/access-version fence as success before writing a retry deadline; the existing `finally` replacement retry remains intact. Key-change and block/unblock rejection tests both reproduced the defect before the fix and now prove that the current download starts immediately, without advancing fake time or explicitly requesting a replacement.

### Low

None.

### Nit

None. No invented style complaints.

## Review coverage

- Origin reports **master** as the actual default branch, not main. The initially shallow clone was unshallowed; `master` was explicitly fetched to `refs/remotes/origin/master`. Review used the computed merge base, not the current base tip.
- Read every changed file's complete patch; new source/test files were read in full. Reviewed source dependencies where needed to trace session recovery, incoming-call state, block visibility, and avatar ownership. No `.github/agents` files were accessed.
- Checked lifecycle/auth scope changes, Strict Mode cleanup, in-flight responses, mounted/offscreen retry behavior, name fallback and raw-ID routing, native call handles and duplicate display, push preview privacy, authorized avatar URLs, cache contents, and list subscriptions.
- Evaluated SRP/OCP/LSP/ISP/DIP across changed hooks, rows, provider boundaries, shared resolver, and server handlers. No additional high-confidence SOLID violation warrants a finding.
- Baseline comparisons used `git show ab157a3:<path>` and `git ls-tree`, including `Avatar.tsx`, `useCallFlow.ts`, `usePresenceSearch.ts`, `callKeep.ts`, and the absent profile directory.
- Per the task's custom-agent validation exception, **no builds, linters, or tests were rerun**, and no baseline worktree was created. Accepted the supplied previous results: mobile targeted 363 + 107 tests; server 141 tests; types/lints passed. The supplied broader mobile run had 2,714 passing assertions and an unrelated teardown-timer hang. These are prior results, not fresh verification by this reviewer.
- Source remained unchanged. Only this requested report was written; no commits.

### Files reviewed (70)

**App, documentation, and shared contracts (9):**

- `mobile/App.tsx`
- `mobile/README.md`
- `mobile/src/AppShell.tsx`
- `mobile/src/types/directory.ts`
- `mobile/testUtils/renderCleanup.ts`
- `server/README.md`
- `shared/README.md`
- `shared/identity.ts`
- `shared/index.ts`

**Mobile profile/native/hooks (9):**

- `mobile/src/callKeep.ts`
- `mobile/src/callLog.ts`
- `mobile/src/hooks/useCallFlow.ts`
- `mobile/src/hooks/usePresenceSearch.ts`
- `mobile/src/profile/ProfileContext.tsx`
- `mobile/src/profile/ProfileProvider.tsx`
- `mobile/src/profile/fetchPeerProfile.ts`
- `mobile/src/profile/profileStore.ts`
- `mobile/src/pushNotifications.ts`

**Mobile UI (17):**

- `mobile/src/components/CallEndSummary.tsx`
- `mobile/src/components/CallScreen.tsx`
- `mobile/src/components/CallStage.tsx`
- `mobile/src/components/CallsScreen.tsx`
- `mobile/src/components/ChatListScreen.tsx`
- `mobile/src/components/FloatingCallBubble.tsx`
- `mobile/src/components/InAppMessageBanner.tsx`
- `mobile/src/components/InCallBanner.tsx`
- `mobile/src/components/IncomingCallScreen.tsx`
- `mobile/src/components/OutgoingCallScreen.tsx`
- `mobile/src/components/PeerProfileScreen.tsx`
- `mobile/src/components/PeoplePickerSheet.tsx`
- `mobile/src/components/RingingAvatar.tsx`
- `mobile/src/components/SearchScreen.tsx`
- `mobile/src/components/SettingsScreen.tsx`
- `mobile/src/components/chat/ChatConversationPresentation.tsx`
- `mobile/src/components/primitives/Avatar.tsx`

**Server source (5):**

- `server/src/domain/notifications.ts`
- `server/src/push/envelopes.ts`
- `server/src/push/types.ts`
- `server/src/routes/directory.routes.ts`
- `server/src/signaling/messageHandlers/delivery.ts`

**Mobile tests (25):**

- `mobile/__tests__/AppShell.test.tsx`
- `mobile/__tests__/callKeep.test.ts`
- `mobile/__tests__/callLog.test.ts`
- `mobile/__tests__/components/CallScreen.test.tsx`
- `mobile/__tests__/components/CallStage.test.tsx`
- `mobile/__tests__/components/CallsScreen.test.tsx`
- `mobile/__tests__/components/ChatConversationScreen.test.tsx`
- `mobile/__tests__/components/ChatListScreen.test.tsx`
- `mobile/__tests__/components/FloatingCallBubble.test.tsx`
- `mobile/__tests__/components/IdentityIntegration.test.tsx`
- `mobile/__tests__/components/InAppMessageBanner.test.tsx`
- `mobile/__tests__/components/InCallBanner.test.tsx`
- `mobile/__tests__/components/IncomingCallScreen.test.tsx`
- `mobile/__tests__/components/OutgoingCallScreen.test.tsx`
- `mobile/__tests__/components/PeerProfileScreen.test.tsx`
- `mobile/__tests__/components/PeoplePickerSheet.test.tsx`
- `mobile/__tests__/components/SearchScreen.test.tsx`
- `mobile/__tests__/components/SettingsScreen.test.tsx`
- `mobile/__tests__/hooks/useCallFlow.test.tsx`
- `mobile/__tests__/identity.test.ts`
- `mobile/__tests__/profile/ProfileProvider.test.tsx`
- `mobile/__tests__/profile/fetchPeerProfile.test.ts`
- `mobile/__tests__/profileStore.test.ts`
- `mobile/__tests__/pushNotifications.test.ts`
- `mobile/__tests__/storage/resourceCache.test.tsx`

**Server tests (5):**

- `server/test/directory.test.ts`
- `server/test/push-identity-integration.test.ts`
- `server/test/push-internals.test.ts`
- `server/test/push-notification-hub.test.ts`
- `server/test/push-payload-contract.test.ts`

## Out of scope (pre-existing, not graded)

- Native incoming-call deduplication only checks `displayedCallIds` before asynchronous setup/account checks. That placement and the call-flow fallback ringtone on any `shown: false` result already existed at the merge base; they are not attributed to display-name changes.
- No new lint/build/test failure is claimed. The supplied broader mobile teardown hang is explicitly excluded, not silently counted as a branch regression.

## Fix validation — 2026-10-03

- Fixed: **1 High, 1 Medium**. Deferred: **0**. Original findings retained above.
- Decision: extend the existing scheduler/queue rather than adding another retry mechanism; fence obsolete error-side writes rather than changing replacement-download behavior. No dependencies, unrelated fixes, commits, or additional reviewer invocation.
- `cd mobile && npm test -- --runInBand --ci --forceExit __tests__/profileStore.test.ts __tests__/components/IdentityIntegration.test.tsx __tests__/profile __tests__/identity.test.ts`: **5 suites, 84 tests passed**, exit 0.
- `cd mobile && npm run typecheck`: **passed**, exit 0.
- `cd mobile && npm run lint`: **passed**, exit 0; existing ESLintRC deprecation warning only.
- `cd mobile && timeout --signal=TERM --kill-after=10s 300s npm test -- --runInBand --ci --forceExit`: **160 suites, 2,731 tests passed**, exit 0, 28.286 seconds; no timeout. Existing `callContextIsolation.test.tsx` post-teardown React/native-import warnings still occurred and were left untouched.
- `git diff --check`: **passed**. Changes restricted to `profileStore.ts`, its directly covering store/mounted integration tests, and this report.
- No remaining defect identified in these two fixes. The parent-owned final grumpy re-review remains pending; the unrelated call-context teardown issue remains out of scope.
