# Grumpy Code Review — copilot/adopt-display-names-and-avatars vs origin/master

_Reviewed ab157a3d3db316c5dfa77da1a639931d98a9f4a2..18c9481fbb2c16e7fe0db8b423ea8022a0c7743d, 71 files changed (70 implementation/documentation/test files and the initial review report)._

## Summary

Mergeable on this review: **zero open findings**. The two previously reported defects are fixed, and the full branch—not merely the last fix commit—contains no additional evidence-backed security, correctness, performance, or SOLID issue that warrants a finding. Names remain presentation data; routing and native handles retain raw IDs. No invented complaints to fill the page. Parent-owned CodeQL and merge checks remain separate gates.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

None.

### Nit

None.

## Re-review of the original findings

The initial report, `reviews/adopt-display-names-and-avatars-review.md`, is preserved, including both original findings and their **Fixed** resolutions.

- **Mounted exact-profile cooldown retry — verified fixed.** `mobile/src/profile/profileStore.ts:184–212` schedules `exactRetryAt` only for watched, unresolved, unblocked peers without an outstanding exact operation. Expiry calls the existing `ensureProfile`, not a second lookup implementation. `exactRequests` is populated synchronously before another caller can enqueue the same peer (`111–155`), and both initial and retried operations use the same two-active-request queue (`106–149`). Pending operations include bootstrap waits and queued requests; excluding them from scheduling prevents expired deadlines from continuously rearming timers. Operation cleanup removes the pending entry and re-arms scheduling. Resolved, unwatched, and blocked peers are excluded by the eligibility predicate; disposal clears the timer and prevents scheduling or new requests.
  - Read the mounted network-error, HTTP-denial, and absent-match recovery cases in `mobile/__tests__/components/IdentityIntegration.test.tsx:196–238`: recovery occurs at 60 seconds without remount or foreground transition, issues one exact retry and one authorized avatar request, and preserves raw-ID navigation.
  - Read the inactive-peer, long-pending-request, deduplication, and bounded-concurrency regressions in `mobile/__tests__/profileStore.test.ts:344–421`. These cover the scheduler behavior rather than merely invoking another manual lookup after cooldown.
- **Obsolete avatar rejection contaminating the current generation — verified fixed.** The rejection handler at `mobile/src/profile/profileStore.ts:237–240` now applies the same captured avatar-key and access-version fences as the success handler (`221–223`) before writing a cooldown. Key replacement clears the old deadline (`73–76`); block/unblock changes access versions and clears deadlines (`282–300`). Cleanup still removes the old pending entry and immediately attempts the replacement generation (`241–249`), while blocked/disposed guards prevent unauthorized or dead-scope requests.
  - Read `mobile/__tests__/profileStore.test.ts:550–576`: both key replacement and block/unblock reject the old promise, assert that time has not advanced, and prove the current download starts immediately and remains deduplicated.

## Full-branch review coverage

- Read the shared severity rubric before classifying findings. The clone is not shallow; explicitly fetched `master` into `refs/remotes/origin/master` and recomputed the merge base. Reviewed every changed file and hunk from that merge base; new source and test files were read in full. No `.github/agents` files were accessed.
- Reviewed authenticated exact-directory lookup, self-exclusion and bidirectional block visibility, stored-profile provenance for push names, and the existing avatar-download authorization/ownership boundary. Caller-supplied profile rows cannot inject signed URLs. Download results validate owner, key, URL scheme, and expiry; signed URLs are not persisted in the directory cache.
- Traced account/server scope replacement, signed-out behavior, Strict Mode retention, disposal, late responses, foreground refresh, watched/offscreen timers, queue deduplication, and avatar generation changes. Profile transport and narrow call selectors avoid coupling profile lifetime to changing call samples; unchanged snapshots keep unrelated subscribers from rerendering.
- Reviewed names, initials, accessible labels, image-error fallbacks, call media mode, all modified chat/call/search/settings surfaces, native handles, cold-start push parsing, and generic notification-preview privacy. Raw identifiers remain the inputs to routing, dialing, messaging, blocking, muting, and profile lookup. The bounded socket-name lookup aborts at 750 ms and checks call/account/server scope before displaying late results.
- Evaluated SRP, OCP, LSP, ISP, and DIP throughout the changed provider/store/hooks, extracted identity rows, shared resolver, contracts, and server handlers. Responsibilities remain cohesive and use existing transport/selector/authorization seams; no concrete SOLID violation was found.
- Used `git show ab157a3:<path>` to compare adjacent baseline behavior in `Avatar.tsx`, `useCallFlow.ts`, `callKeep.ts`, and `usePresenceSearch.ts`; `git ls-tree` confirms the profile directory is new.
- Source remained read-only. Only this final report was added; the initial report was not changed. Commits and CodeQL checks are owned by the parent.

### Validation evidence

Per the task's custom-agent validation exception, **no lint, build, typecheck, or test commands were rerun**, and no baseline worktree was created. The following are supplied results, not newly executed verification by this reviewer:

- Fix-agent focused mobile run: **5 suites, 84 tests passed**.
- Fix-agent full mobile run: **160 suites, 2,731 tests passed**, exit 0.
- Fix-agent mobile lint and typecheck: **passed**; existing ESLintRC deprecation warning only.
- Prior server validation: **141 tests passed**.
- Fix-agent `git diff --check`: **passed**.

### Files reviewed (71)

**App, documentation, shared contracts, and review artifact (10):**

- `mobile/App.tsx`
- `mobile/README.md`
- `mobile/src/AppShell.tsx`
- `mobile/src/types/directory.ts`
- `mobile/testUtils/renderCleanup.ts`
- `reviews/adopt-display-names-and-avatars-review.md`
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

- Native incoming-call deduplication checks the displayed-call set before asynchronous setup/account checks, and call-flow fallback ringing runs for any `shown: false` result. Both placements exist at the merge base; no finding is attributed to this branch.
- The supplied full mobile run still emitted unrelated `callContextIsolation.test.tsx` post-teardown React/native-import warnings, but completed successfully. Those warnings were left untouched and are not counted as regressions.
- No new lint/build/test failure is claimed without execution or baseline evidence.
