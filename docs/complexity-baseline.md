# Cognitive complexity baseline

Phase 1 of the decomposition epic (#211). This document is the measurement that
Phases 2–5 are judged against: before it existed, "this method is too complex"
was a matter of taste.

## The gate

`sonarjs/cognitive-complexity` is enabled at a threshold of **15** in both
packages:

| Package | Config | Scope |
| --- | --- | --- |
| `server/` | [`server/eslint.config.js`](../server/eslint.config.js) | `server/`, `shared/` |
| `mobile/` | [`mobile/.eslintrc.js`](../mobile/.eslintrc.js) | `mobile/` (including `__tests__/`) |

*Cognitive* complexity was chosen over ESLint's built-in `complexity` rule,
which measures *cyclomatic* complexity. The two are related but not the same:
cyclomatic complexity counts branches, so a flat chain of ten guard clauses
scores the same as ten nested `if`s. Cognitive complexity penalises nesting and
rewards flat early-return code, which is much closer to what actually makes a
method hard to read — and therefore much closer to what this epic is trying to
fix. `eslint-plugin-sonarjs` supports ESLint 8, 9 and 10, so it drops into the
mobile package's legacy `.eslintrc.js` and the server's flat config without
dependency friction; no substitution was needed.

The rule is set to **`warn`, not `error`**. There are 35 pre-existing
violations, listed in full below, and turning them into errors would make
`backend-ci.yml` and `mobile-ci.yml` fail on every commit. Warnings keep the
number visible on every lint run without blocking unrelated work. The level is
raised to `error` when the phases below have cleared the backlog.

**No inline suppressions were added, and no source was changed in this phase.**
Measuring and fixing in one change makes it impossible to tell whether the gate
is calibrated correctly. Nothing is exempted: every method over the threshold
appears in the table below, including the ones that may turn out to be
irreducible.

Reproduce the numbers with:

```bash
cd server && npm run lint      # server/ and shared/
cd mobile && npm run lint
```

## Every violation, worst first

Baseline taken at the merge-base of the Phase 1 branch. 35 violations: 28 in
`mobile/`, 7 in `server/`, 0 in `shared/`.

| # | Score | File | Method | Phase |
| --- | --- | --- | --- | --- |
| 1 | 65 | `mobile/src/components/ChatConversationScreen.tsx:662` | `MessageRowComponent` | — |
| 2 | 64 | `mobile/src/components/ChatConversationScreen.tsx:364` | `MessageContent` | — |
| 3 | 39 | `mobile/src/components/ChatConversationScreen.tsx:932` | `ChatConversationScreen` | — |
| 4 | 35 | `mobile/src/hooks/useCallFlow.ts:3849` | `pollStats` (stats-polling effect) | 5 |
| 5 | 33 | `mobile/src/components/CallControls.tsx:48` | `CallControls` | — |
| 6 | 32 | `server/src/routes/turnCredentials.routes.ts:110` | `GET /turn-credentials` handler | — |
| 7 | 32 | `mobile/src/components/SettingsScreen.tsx:128` | `SettingsScreen` | — |
| 8 | 31 | `mobile/src/components/PeerProfileScreen.tsx:121` | `PeerProfileScreen` | — |
| 9 | 29 | `server/src/telemetry.ts:218` | `recordCallTransition` | — |
| 10 | 29 | `mobile/src/components/RegistrationScreen.tsx:50` | `RegistrationScreen` | — |
| 11 | 27 | `mobile/src/hooks/useScreenShare.ts:161` | `startScreenShare` | 5 |
| 12 | 25 | `mobile/src/screenShare.ts:102` | `startScreenCapture` | 5 |
| 13 | 24 | `server/src/signaling/messageHandlers.ts:210` | `message:send` handler | 3 |
| 14 | 24 | `mobile/src/components/ChatConversationScreen.tsx:267` | `buildListItems` | — |
| 15 | 22 | `mobile/src/AppShell.tsx:44` | `AppShell` | — |
| 16 | 21 | `mobile/src/components/ChatListScreen.tsx:143` | `renderConversationRow` | — |
| 17 | 21 | `mobile/src/components/primitives/ListItem.tsx:63` | `ListItem` | — |
| 18 | 19 | `server/src/domain/callTimeline.ts:128` | `augmentConversationsWithCalls` | — |
| 19 | 19 | `mobile/src/attachmentDownload.ts:160` | `downloadAttachment` | 4 |
| 20 | 19 | `mobile/src/components/MediaViewer.tsx:88` | `MediaViewer` | — |
| 21 | 19 | `mobile/src/hooks/useCallFlow.ts:1911` | `endActiveCall` | 5 |
| 22 | 19 | `mobile/src/hooks/useCallFlow.ts:2211` | `call.state_changed` handler | 5 |
| 23 | 19 | `mobile/src/hooks/useScreenShare.ts:79` | `stopScreenShare` | 5 |
| 24 | 18 | `mobile/src/components/CallsScreen.tsx:165` | `renderItem` | — |
| 25 | 17 | `mobile/src/components/CallScreen.tsx:31` | `CallScreen` | — |
| 26 | 17 | `mobile/src/components/CallsScreen.tsx:90` | `CallsScreen` | — |
| 27 | 17 | `mobile/src/pushNotifications.ts:489` | `sendPushReceipt` | — |
| 28 | 17 | `mobile/src/storageUsage.ts:232` | `clearCachedMedia` | — |
| 29 | 17 | `mobile/src/webrtcConfig.ts:239` | `getIceServersForCall` | 5 |
| 30 | 16 | `server/src/callPersistence.ts:121` | `hydrateCallsAndEventsFromDb` | 2 |
| 31 | 16 | `server/src/telemetry.ts:313` | `recordDbQuery` | — |
| 32 | 16 | `server/test/call-history.test.ts:33` | `compilePredicate` (test helper) | — |
| 33 | 16 | `mobile/src/components/AudioAttachmentPlayer.tsx:33` | `AudioAttachmentPlayer` | — |
| 34 | 16 | `mobile/src/components/CallStage.tsx:53` | `CallStage` | — |
| 35 | 16 | `mobile/src/components/primitives/Banner.tsx:58` | `Banner` | — |

## Top offenders

The three worst methods are all in `ChatConversationScreen.tsx`, and two of
them score more than four times the threshold:

1. **`MessageRowComponent` (65)** and **`MessageContent` (64)** —
   `ChatConversationScreen.tsx`. One render function per message kind, branching
   on attachment type, own/peer, reply, reaction and selection state in a single
   nested expression.
2. **`ChatConversationScreen` (39)** — the same file's screen component.
3. **`pollStats` (35)** — `useCallFlow.ts`. The WebRTC stats poller, which
   walks the report graph with nested conditionals.
4. **`CallControls` (33)** — one component rendering every combination of
   audio/video, screen-share, and connection state.
5. **`GET /turn-credentials` (32)** — a single route handler doing cache
   validation, credential minting, fallback and error mapping inline.

## Files over ~500 lines

Source files (`server/src`, `server/db`, `shared/`, `mobile/src`):

| Lines | File | Phase |
| --- | --- | --- |
| 4222 | `mobile/src/hooks/useCallFlow.ts` | 5 |
| 2095 | `mobile/src/components/ChatConversationScreen.tsx` | — |
| 1367 | `mobile/src/hooks/useMessaging.ts` | 4 |
| 1289 | `server/src/push.ts` | 2 |
| 944 | `mobile/src/theme.ts` | — |
| 934 | `server/src/messageStore.ts` | 2 |
| 899 | `mobile/src/pushNotifications.ts` | — |
| 781 | `mobile/src/components/SettingsScreen.tsx` | — |
| 721 | `server/src/signaling/messageHandlers.ts` | 3 |
| 643 | `mobile/src/callKeep.ts` | — |
| 612 | `mobile/src/components/SearchScreen.tsx` | — |
| 584 | `server/src/domain/calls.ts` | — |
| 515 | `server/src/domain/notifications.ts` | — |
| 501 | `server/src/signaling/index.ts` | 3 |

Test files, for completeness — they are not a decomposition target, but the
largest of them mirrors the largest source file and will have to move with it:

| Lines | File |
| --- | --- |
| 4957 | `mobile/__tests__/hooks/useCallFlow.test.tsx` |
| 1897 | `mobile/__tests__/components/ChatConversationScreen.test.tsx` |
| 1202 | `mobile/__tests__/hooks/useMessaging.test.tsx` |
| 1055 | `mobile/__tests__/pushNotifications.test.ts` |
| 958 | `server/test/messages.test.ts` |
| 866 | `server/test/message-store.test.ts` |
| 817 | `server/test/db-persistence.test.ts` |
| 787 | `server/test/calls.test.ts` |
| 700 | `server/test/security.test.ts` |
| 674 | `server/test/stale-calls.test.ts` |
| 628 | `mobile/__tests__/webrtcConfig.test.ts` |
| 554 | `mobile/__tests__/AppShell.test.tsx` |
| 537 | `server/test/push-fallback.test.ts` |
| 527 | `mobile/__tests__/components/SettingsScreen.test.tsx` |
| 526 | `server/test/messages-rich.test.ts` |
| 525 | `mobile/__tests__/theme.test.ts` |
| 519 | `server/test/reconnect.test.ts` |

## Which phase clears which cluster

| Cluster | Violations | Cleared by |
| --- | --- | --- |
| Server data layer — `callPersistence.ts` DB hydration | 1 (#30) | Phase 2 (#213) |
| Signaling — `messageHandlers.ts` socket handlers | 1 (#13) | Phase 3 (#214) |
| Messaging client — `attachmentDownload.ts` | 1 (#19) | Phase 4 (#215) |
| Call path — `useCallFlow.ts`, `useScreenShare.ts`, `screenShare.ts`, `webrtcConfig.ts` | 7 (#4, #11, #12, #21, #22, #23, #29) | Phase 5 (#216) |
| **Chat UI** — `ChatConversationScreen.tsx`, `ChatListScreen.tsx` | 5 (#1, #2, #3, #14, #16) | **Unassigned** |
| **Call UI** — `CallControls`, `CallsScreen`, `CallScreen`, `CallStage` | 5 (#5, #24, #25, #26, #34) | **Unassigned** |
| **Other screens and primitives** — `SettingsScreen`, `PeerProfileScreen`, `RegistrationScreen`, `AppShell`, `ListItem`, `MediaViewer`, `AudioAttachmentPlayer`, `Banner` | 8 (#7, #8, #10, #15, #17, #20, #33, #35) | **Unassigned** |
| **Mobile services** — `pushNotifications.ts`, `storageUsage.ts` | 2 (#27, #28) | **Unassigned** |
| **Server odds and ends** — `turnCredentials.routes.ts`, `telemetry.ts`, `callTimeline.ts`, and one test helper | 5 (#6, #9, #18, #31, #32) | **Unassigned** |

The honest reading of that table: Phases 2–5 as scoped account for **10 of the
35** violations. They target the largest *files*, and the largest files are not
where the highest-scoring *methods* live. Two results make that concrete:

- `server/src/push.ts` (1,289 lines) and `server/src/messageStore.ts` (934
  lines) — the whole of Phase 2 — contain **no method over the threshold**.
  They are long because they hold many functions, not complex ones. Phase 2 is
  still worth doing for reviewability, but it will not move this number.
- The three worst methods in the repository are React components in
  `ChatConversationScreen.tsx`, a file no phase currently owns.

Clearing the backlog to zero, and so promoting the rule from `warn` to `error`,
needs one further piece of work covering the presentational layer and the
residual server helpers. That is stated here rather than quietly assumed: the
epic's success criterion ("no method exceeds the threshold, or every exception
is documented") cannot be met without it.

## Progress against the baseline

| Phase | Violations cleared | Now |
| --- | --- | --- |
| Phase 4 (#215) | #19 `downloadAttachment` (19) | under the threshold; the per-directory attempt is its own function |

Phase 4 also split `mobile/src/hooks/useMessaging.ts` (1,367 lines) into
`mobile/src/messaging/` — identity/ordering, message history, the send and
receive pipelines, conversations and unread accounting, drafts, and the
snapshot mirror — leaving the hook at ~1,000 lines of composition. None of the
extracted modules contains a method over the threshold, and none of them needs
an exemption.

## Exemptions

None. No method has been exempted from the rule, and no inline suppression
comment was added. If a genuinely irreducible method is found during a later
phase — a `switch` over a wire protocol, say — the exemption belongs in this
document with its reasoning, next to the score it is excused from.
