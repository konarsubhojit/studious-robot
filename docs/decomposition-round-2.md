# Decomposition round 2 — evidence-based plan

Follow-up to the decomposition epic (#211, PRs #218–#221, #252) and to the four
lifetime defects fixed in #263. The [complexity baseline](./complexity-baseline.md)
records the gate itself; this document records what is left to decompose, what
is deliberately being left alone, and the status of each item.

## The one rule this round is judged against

Every defect fixed in #263 was decomposition residue in which **a resource's
lifetime ended up straddling a file boundary**: an unmount cleanup with a live
dependency array, an interval created in one hook and cleared by another, an
ICE-restart timer cleared on one path but not the other, and a subscription
effect whose dependency chain silently cancelled a debounced timer.

So each item below states explicitly whether any timer, subscription, listener
or ref lifetime would end up split across the proposed boundary. An item that
would split one is not an improvement, and is recorded in
[§3 Leave alone](#3-leave-alone) instead.

## Status

| # | Item | Status |
| --- | --- | --- |
| 1.1 | [Dedupe the operator-token check](#11-dedupe-the-operator-token-check) | ✅ Done |
| 1.6 | [Remove verified dead surface](#16-remove-verified-dead-surface) | ✅ Done |
| 1.5 | [Reduce the functions sitting at 14–15](#15-reduce-the-functions-sitting-at-1415) | ⬜ Not started |
| 1.4 | [Extract the pure chat timeline model](#14-extract-the-pure-chat-timeline-model) | ✅ Done |
| 1.2 | [Extract `useCallQualityStats`](#12-extract-usecallqualitystats) | ✅ Done |
| 1.3 | [Extract `useCallAudioRoutes`](#13-extract-usecallaudioroutes) | ⬜ Not started |
| 2.1 | [Extract `useDraftPersistence`](#21-extract-usedraftpersistence) | ⬜ Not started |
| 2.2 | [Split the message-bubble subtree](#22-split-the-message-bubble-subtree) | ⬜ Not started |
| 2.3 | [`useOutboxDrain`](#23-useoutboxdrain) | ⛔ Deferred by design |

## 0. Baseline

Measured on the pre-change checkout. `cd mobile && npx eslint .` exits 0 with
zero warnings, and the server gate is equally clean, so there is no *measured*
function-level debt. The open question is file size, module cohesion and
responsibility count.

Largest files:

| `mobile/src` | Lines | `server/src`, `shared/` | Lines |
| --- | --- | --- | --- |
| `hooks/useCallFlow.ts` | 3483 | `domain/calls.ts` | 584 |
| `components/chat/ChatConversationPresentation.tsx` | 2552 | `domain/notifications.ts` | 515 |
| `hooks/useMessaging.ts` | 1017 | `lib/state.ts` | 496 |
| `theme.ts` | 944 | `createServer/index.ts` | 479 |
| `pushNotifications.ts` | 922 | `telemetry.ts` | 450 |
| `components/SettingsScreen.tsx` | 887 | `signaling/connection/registerSocketHandlers.ts` | 406 |
| `hooks/useCallRecovery.ts` | 801 | `cache.ts` | 400 |
| `callKeep.ts` | 643 | `routes/calls.routes.ts` | 382 |
| `AppShell.tsx` | 542 | `shared/schema.ts` | 241 |

Re-running the gate at `warn, 8` reads the actual scores. Nothing exceeds 15
anywhere; these are the ones close enough to breach on the next change:

| Score | Location |
| --- | --- |
| 15 | `mobile/src/attachmentDownload.ts:215` `downloadAttachment` |
| 15 | `mobile/src/audioRouting.ts:244` `chooseAudioRoute` |
| 15 | `mobile/src/components/InCallBanner.tsx:35` |
| 15 | `mobile/src/components/SettingsScreen.tsx:333` `StorageSettings` |
| 15 | `mobile/src/components/chat/ChatConversationPresentation.tsx:1034` `MessageRowComponent` |
| 15 | `mobile/src/components/chat/ChatConversationPresentation.tsx:1219` `ConversationHeader` |
| 15 | `server/src/signaling/callHandlers.ts:160` `handleRtcRelay` |
| 15 | `server/src/signaling/messageHandlers/validation.ts:34` `validateAttachment` |
| 14 | `mobile/src/AppShell.tsx:176`, `ChatConversationPresentation.tsx:1427`, `useCallFlow.ts:1809`, `CallsScreen.tsx:173`, `RegistrationScreen.tsx:234`, `primitives/ListItem.tsx:131`, `callUx.ts:215`, `storageUsage.ts:187`, `server/src/routes/turnCredentials.routes.ts:110` |

`useCallFlow.ts` census: 25 `useState`, 42 `useRef`, 30 `useEffect`, 43
`useCallback`, 115 keys in the returned object, 28 section banners.

## Tier 1 — high value, low risk

### 1.1 Dedupe the operator-token check

**Status: ✅ Done.**

`server/src/routes/metrics.routes.ts` and `server/src/routes/calls.routes.ts`
each carried their own constant-time check of `DEBUG_API_TOKEN`, and they were
not equivalent. The metrics copy padded both buffers to a fixed 256 bytes before
`timingSafeEqual`; the calls copy compared lengths *before* the constant-time
compare and returned early on a mismatch, leaking the configured token's length
by timing — precisely the leak the metrics copy's comment says it exists to
avoid.

The padded implementation now lives once, as `hasOperatorToken` in
`server/src/lib/auth.ts` alongside `getSessionFromRequest` and
`resolveSocketIdentity`; both routers import it and both local copies are gone.

**Safety:** a pure predicate over the request headers. No timer, subscription,
listener or ref is involved, so no lifetime crosses the new boundary.

**Benefit:** one auth predicate instead of two divergent ones, and the weaker of
the two is gone.

### 1.6 Remove verified dead surface

**Status: ✅ Done.**

- `shared/schema.ts` — the `isOptional` field on `Schema<T>` was written in four
  places and read nowhere in `mobile/`, `server/`, `shared/` or either test
  tree. The field and the `meta` plumbing that existed only to carry it are
  gone; `createSchema` no longer takes a `meta` argument at all.
- `mobile/src/telemetry.ts` — `trackSignalingConnected` had no caller. Because
  it was the only writer of `signalingConnectedAtMs`, the derived
  `signalingLatencyMs` in the emitted QoS summary was permanently `null`, and it
  had no readers either. The whole chain — setter, entry field, derived metric
  and the usage line in the module doc comment — is removed rather than left as
  a metric that can never report anything.
- `mobile/src/appLogger.ts` — `logBackgroundError` had no references at all.
  (Its sibling `logBackgroundWarn` is used by `pushNotifications.ts` and stays.)

**Safety:** trivial, and TypeScript proves it. Verified with `npm run typecheck`
in both packages, `npx eslint .` in `mobile/`, and the `telemetry` and
`appLogger` suites.

### 1.5 Reduce the functions sitting at 14–15

**Status: ⬜ Not started.**

The functions tabulated in §0. These are what the gate is *not* catching and
what will break the build on the next feature touch. All are single-function,
intra-file simplifications — guard-clause flattening and local helper
extraction — **not** file splits.

**Safety:** no code moves between files, so no lifetime can be split.

### 1.4 Extract the pure chat timeline model

**Status: ✅ Done.**

~270 lines of pure functions with zero state, effects or refs now live in
`mobile/src/components/chat/chatTimelineModel.ts`: `getMessageStatus`,
`messageAccessibilityLabel`, `isCallEntry`, `entryKey`,
`formatMessageTimestamp`, `isSameCalendarDay`, `formatDateSeparator`,
`isSameCallRun`, `findUnreadAnchorKey`, `appendDateSeparator`,
`callListItemAt`, `isMessageGroupEnd`, `buildListItems` and
`messageContentKind`, together with the `TimelineEntry`, `ListItem`,
`MessageStatus` and `MessageContentKind` types and the two grouping-window
constants they are the only readers of.

`ChatConversationPresentation.tsx` imports them back and re-exports
`findUnreadAnchorKey` plus the three public types, so `ChatConversationScreen.tsx`
and every existing consumer import is unchanged — the same facade convention as
`server/src/createServer.ts`.

**Safety:** no hooks, no timers, no subscriptions. Nothing to straddle.

**Result:** `ChatConversationPresentation.tsx` 2552 → 2295 lines. Verified with
`npm run typecheck`, `npx eslint src/components/chat`, and the
`ChatConversationScreen` suite (79 tests passing), which includes the
unread-divider cases that pin `findUnreadAnchorKey`'s behaviour.

### 1.2 Extract `useCallQualityStats`

**Status: ✅ Done.**

Now `mobile/src/hooks/useCallQualityStats.ts`. Owns `qualitySmootherRef`, `connectionStatsRef`,
`selectedCandidatePairRef`, the `connectionQuality` and `selectedCandidatePair`
state, and `noteSelectedCandidatePair`.

**What moves:** the whole polling effect, including its `setInterval` *and* its
`AppState` subscription. **What stays:** `peerConnectionRef`, `activeCallIdRef`
and `updateStatus`, passed in as refs and callbacks — the pattern
`useScreenShare.ts` and `useCallRecovery.ts` already use.

**Safety:** the interval and the AppState subscription are born and die inside
the same effect, whose cleanup already does
`cancelled = true; stopPolling(); subscription?.remove?.()`. That effect moved
whole. Nothing for this cluster sat in `useCallFlow`'s aggregate unmount
teardown and nothing needed to be added there.

**Two touchpoints outside the original line range had to be handled explicitly
rather than left straddling the boundary:**

- `connectionQualityRef` (the mirror the call-end summary reads for its quality
  label) moved into the hook together with the effect that writes it, and is
  returned. Previously the state and its mirror could have ended up on opposite
  sides of the split — precisely the #263 failure mode.
- `closePeerConnection` also reset `connectionQuality` and `connectionStatsRef`
  inline. It now calls the hook's `resetConnectionQuality`, which is
  `useCallback(..., [])` and therefore permanently stable, so
  `closePeerConnection`'s own identity is unchanged and no effect downstream of
  it can be re-run by this refactor.

**Result:** `useCallFlow.ts` 3483 → 3321 lines; new hook 251 lines. Verified
with `npm run typecheck`, `npx eslint`, and the `useCallFlow` suite
(144 tests passing), which includes the quality-polling cases at
`__tests__/hooks/useCallFlow.test.tsx:4198–4310`.

### 1.3 Extract `useCallAudioRoutes`

**Status: ⬜ Not started.**

`useCallFlow.ts:3230–3332` plus `chooseAudioOutput` and
`applyAutomaticAudioRoute`. Owns `manualAudioRouteRef`, `selectedAudioRouteRef`,
and the `isSpeakerEnabled` and `audioDevices` state. Three effects: audio
session start/stop, the device subscription, and the speaker-route apply.

**Inputs:** `isInCall`, `speakerEnabledByDefault`, `updateStatus`.

**What must NOT move:** `handleMuteToggle` looks like an audio concern but
manipulates `localStreamRef`'s tracks. Moving it would split media-track
ownership across a file boundary. It stays with the local stream.

**Safety:** the only subscription is `subscribeAudioDevices`, whose unsubscriber
*is* the effect's cleanup return, so it moves as one unit.
`startAudioSession`/`stopAudioSession` are likewise paired inside one effect.
The `manualAudioRouteRef` reset on `!isInCall` lives in the same effect as the
subscription and must move with it.

## Tier 2 — high value, higher risk: tests first

### 2.1 Extract `useDraftPersistence`

**Status: ⬜ Not started.**

A lifetime **repair**, not merely a split. The chat screen component is ~977
lines with 10 state, 14 refs, 12 effects, 21 callbacks and 5 memos. The draft
cluster — the `draft` state, `draftPersistTimerRef`, `didMountDraftPersistRef`,
`persistDraftNow`, the debounce effect and the AppState/unmount flush effect —
is the same shape of debounced-timer cluster involved in the fourth defect fixed
by #263. It is correct today, but its owner is spread across five declarations
inside a 977-line function, which is exactly how it went wrong before.

Move the whole cluster to `mobile/src/components/chat/useDraftPersistence.ts`,
returning `{ draft, setDraft, persistDraftNow }`.

**Safety:** this *reduces* fragmentation — creation, debounce cleanup,
foreground flush and unmount flush all end up in one small file. **All four must
move together**; leaving the AppState flush behind while moving the timer would
reproduce defect #4 exactly.

**Coverage required first:** the chat screen suite must assert that the draft is
saved once after the debounce, that backgrounding flushes immediately, and that
unmount flushes. Do not start without the last two.

### 2.2 Split the message-bubble subtree

**Status: ⬜ Not started.**

`ChatConversationPresentation.tsx:397–1150` is a self-contained render tree from
`BubbleContent` through `MessageRow`. It moves to
`components/chat/MessageRow.tsx`. `MessageRow`'s only local state is
`isReactionBarOpen`; it owns no timer and no subscription.

**Gesture-coverage warning:** `MessageRow` renders inside `SwipeableRow`, and
`mobile/__mocks__/react-native-gesture-handler.js` stubs `GestureDetector` as a
pass-through that only records callbacks. The swipe/long-press arbitration
(activation offset 10 vs fail offset 24, `Gesture.Race(pan, longPress)`) has no
meaningful automated coverage. The move must be a pure relocation that changes
no wrapping — in particular it must not introduce a `Pressable` around
swipeable content, which `SwipeableRow`'s own comment forbids. Any change to
the wrapping requires on-device verification of swipe and long-press first.

### 2.3 `useOutboxDrain`

**Status: ⛔ Deferred by design.**

The outbox cluster in `useMessaging.ts` (`outboxRef`, `drainTimerRef`,
`drainAttemptRef`, `isDrainingRef`, `drainOutboxRef`, `pendingSendCount`,
`persistOutbox`, `scheduleDrain`, `sendOutboxItem`, `drainOutbox`, the
foreground-drain AppState effect and the unmount `clearTimeout`) is separable,
but it is worth ~130 lines out of 1017 and needs `socketRef`/`signalingRef`
threaded through.

If it is ever done: the backoff `setTimeout` is created in `scheduleDrain` and
cleared by the unmount effect, and **both must move together** — leaving the
unmount clear behind would reproduce the `useCallHeartbeat`/`useCallFlow`
interval defect from #263 exactly. Likewise the AppState listener and its
`remove()` are one effect and move as one.

**Recommendation: do this only if the outbox is being changed anyway.** The
churn is not otherwise justified by the line count.

## 3. Leave alone

Named and defended. These are large because they are cohesive, or because
splitting them would fragment lifetime management.

**`useCallFlow.ts` — `connectSocket` and its 17 event handlers.** The function
creates the socket, wraps it in `createSignalingClient`, attaches the Engine.IO
manager `ping` listener and registers 17 handlers; its disposal path is
`disconnectSocket`. Every handler closes over the *same* socket instance.
Splitting the handlers out would put listener registration in one file and
socket creation/teardown in another — the textbook version of the #263 failure
mode. The only safe local improvement is extracting the *body* of the
`SESSION_INVALID` handler into a pure helper while the `signaling.on(...)`
registration stays put.

**`useCallFlow.ts` — the CallKeep / answer-replay bridge.** ~175 lines, but
mediated by six refs updated by sibling effects in the same file, and its
mount-once effect owns two detach functions. `react-native-callkeep` tracks one
listener per event name and unsubscribes by name only, so this is a native
listener registry that cannot tolerate double registration. Moving it means
shipping six refs across a file boundary to reach it. Not worth it.

**`useCallFlow.ts` — the aggregate unmount teardown.** Correct as-is and
load-bearing: empty deps, with the teardown callbacks read from `teardownRef` at
teardown time. Any newly extracted hook must own its own unmount cleanup — as
`useCallHeartbeat` and `useCallRecovery` now do — rather than adding a line
here.

**`useCallFlow.ts` — presence auto-connect.** Its cleanup calls
`disconnectSocket()`, which closes over `socketRef`/`signalingRef`. Splitting
the effect from those refs splits the socket's lifetime.

**`useCallRecovery.ts` and `useCallHeartbeat.ts`.** The output of the last
round, correct precisely because each clears the timer it creates. Both are
under the gate with room. Do not split further.

**`theme.ts`.** A palette/token table: large because it enumerates one thing
exhaustively. Splitting it adds import churn and fights the design-token test.

**`pushNotifications.ts` and `callKeep.ts`.** Native-module boundaries with
module-scope listener registries. Worst functions score 9–10. Splitting a native
listener registry across files is the same hazard as the CallKeep bridge.

**`CallProvider.tsx`, `AppShell.tsx`, `TabShell.tsx`, `AppNavigator.tsx`.**
Cohesive. `CallProvider`'s store (`useCallStore`, `shallowEqual`,
`useCallSelector`) was recently verified and is under render-count test — do not
redesign it. `AppShell`'s main component scores 14, but that is JSX ternaries in
one render function rather than tangled logic, and its three announcement hooks
are already extracted. `TabShell` is seven `renderX` callbacks and nothing else.

**`server/src/domain/calls.ts`, `domain/notifications.ts`, `lib/state.ts`.** One
domain each; the server's worst score is 13. No measured debt.

**`SwipeableRow.tsx` and `usePictureInPicturePip.ts`.** Under the gate, and
untestable in CI for the reasons given in §2.2. There is no complexity or size
justification for touching either, and any refactor that does must be
device-verified for swipe activation, the long-press race and PiP drag.

## Reproducing the measurements

```bash
cd mobile && npx eslint .          # gate: zero warnings expected
cd server && npm run lint          # server/ and shared/
```

To read the actual scores rather than only gate breaches, temporarily lower
`sonarjs/cognitive-complexity` to `['warn', 8]` in the relevant config.
