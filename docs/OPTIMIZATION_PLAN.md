# Optimization Plan — UI, Architecture & Performance

Current implementation inventory and retained design decisions, audited
**2026-10-02** against `origin/master` at
`ab7591677e979d0a86b1137e99743fc5f3bdc5fd`. Status means source and named
regression coverage were inspected. The parent separately validated both
packages' lint, typechecks and full test suites; server DB-gated tests were
skipped, and mobile needed `--forceExit` and reported existing asynchronous
React warnings. Neither establishes device/production behavior. Historical
suite totals and timings are not current evidence.

## Operating assumptions

| Question | Answer | Consequence |
| -------- | ------ | ----------- |
| Instance count | Target topology: two signaling VMs behind a load balancer, separate Postgres/Redis host | Redis must share sessions, presence, calls, cache and fan-out; each VM needs a distinct `INSTANCE_ID`. Actual production configuration was not inspected. |
| Process manager | Plain systemd on Oracle Linux, service user `opc` | The unit and deployment documentation, not a PM2 configuration, describe the supported deployment. |
| Concurrent users | Planning assumption: approximately ten | Not a measured load or scalability guarantee. Boot reads are bounded regardless; directory scaling remains deferred. |

## Status

Legend: ✅ implemented in the stated scope · 🚧 partial / remaining gate ·
⬜ not implemented · ⏸️ deliberately deferred. Device and production validation
are separate from implementation.

### Phase 1 — Quick wins, low risk

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P3.4 | Heartbeat requires explicit opt-in | ✅ `server/src/signaling/callHandlers.ts`: `handleRtcRelay` requires both `options.recordsHeartbeat === true` and `value?.heartbeat === true`; `server/test/stale-calls.test.ts` covers ordinary media-state frames not refreshing liveness. |
| P2.2 | Delete unreferenced `DraggableCallControls` | ✅ No component or test with that name remains under `mobile/src` / `mobile/__tests__`. |
| P1.5 | Bound JSON bodies / socket frames; gate verbose allocation | ✅ `server/src/createServer/index.ts` configures `express.json` and `maxHttpBufferSize`, and checks verbose logging before constructing request metadata; `server/test/request-limits.test.ts`. Compression remains deliberately excluded. |
| P3.3 | Shared call timing | ✅ `shared/signaling/timing.ts`, consumed by client/server; `server/test/heartbeat-timing.test.ts` checks the timing relationships. |

### Phase 2 — Render performance (P1.1)

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P1.1a | Stable screen renderer context / callbacks | ✅ `mobile/src/navigation/AppNavigator.tsx` memoizes `ScreenRenderersContext`; `mobile/src/components/TabShell.tsx` uses stable renderer callbacks. |
| P1.1b | Keep elapsed seconds local to duration displays | ✅ `mobile/src/hooks/useCallElapsedSeconds.ts`; the flow publishes `callConnectedAtMs`, rather than ticking elapsed seconds through providers. |
| P1.1c | Memoize leaf screens | 🚧 `ChatListScreen`, `SettingsScreen` and `chat/ChatConversationPresentation` are memoized; `CallsScreen.tsx` currently exports an ordinary function, not a `memo` wrapper. Stable renderers remain the primary isolation boundary. |
| P1.1d | Render-count regression | ✅ `mobile/__tests__/callTimerRenderIsolation.test.tsx` checks timer-only isolation and genuine state updates; `callContextIsolation.test.tsx` checks selector isolation. |

### Phase 3 — Startup / bundle

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P1.6a | Metro `inlineRequires` | ✅ `mobile/metro.config.js` enables it. |
| P1.6b | Module-level themed style cache | ✅ `mobile/src/ThemeContext.ts` implements `useThemedStyles` using factory/palette-keyed `WeakMap`s; `mobile/__tests__/useThemedStyles.test.tsx`. |

### Phase 4 — Server memory

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P1.3 | Retain only a bounded terminal-call working set | ✅ `server/src/domain/calls.ts` evicts terminal calls and their event entries together; `server/test/call-retention.test.ts`. Durable history is separate. |

### Phase 5 — Architecture & docs

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P3.1 | Document and expose state affinity | ✅ `server/src/lib/instances.ts`, `server/src/stores/redis.ts`, `server/src/createServer/index.ts` and deployment docs now support shared-state topology; `/health` distinguishes shared/sticky affinity. The old single-instance-only description is obsolete. |
| P1.4 | Directory / boot scaling | 🚧 Boot hydration is bounded in `server/src/callPersistence.ts`; directory-scale work is ⏸️ deferred under the planning load assumption, not the boot read. |
| P3.2 | Declaration formatting guards | ✅ `mobile/.eslintrc.js` and `server/eslint.config.js` retain declaration-scoped `max-len`; both CI workflows run their package lint command. |

### Previously deferred, implemented or partially complete

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| P2.1 | Reanimated gestures | ✅ `mobile/src/components/MediaViewer.tsx` and `SwipeableRow.tsx` use composed RNGH gestures and worklet callbacks; their component tests cover the gesture rules. Device behavior remains a QA concern. |
| P2.3 | Accessibility sweep | ✅ The scoped fixes exist: unread counts in accessible tab/row names, selected call-toggle state, and font caps for fixed geometry (`AppTabBar`, `ChatListScreen`, `IconButton`, `RingingAvatar`; `components/accessibility.test.tsx`). This is not certification of all current screens. |
| P2.4 | Loading / empty / error completeness | ✅ The directory-error distinction exists in `usePresenceSearch.ts` / `SearchScreen.tsx` and their tests; it does not imply every network operation has an error UI. |
| P2.5 | Design-system consolidation | ✅ The scoped contrast/overlay fixes use theme tokens in call and chat components; `theme.test.ts` checks contrast. Future UI must continue using those tokens. |
| B4 | Optimistic attachment progress / cancel / retry | ✅ `mobile/src/hooks/useMessaging.ts` creates the bubble before upload, tracks progress and retains failures for retry; `hooks/useMessaging.test.tsx` covers the attachment lifecycle. |
| P1.2 | Decompose `useCallFlow` | 🚧 Pure rules and concern-hooks are extracted; `mobile/src/hooks/useCallFlow.ts` is **2,442 lines** at this audit. CP1–CP6 are implemented, CP7 retains ordered teardown in the root; device QA remains outstanding. See the note below and [extraction decision record](CALLFLOW_EXTRACTION.md). |
| P1.7 | Replace the JSON chat document with SQLite | ✅ Implemented through `mobile/src/storage/chatDb.ts`, `chatRecords.ts` and `localDatabase.ts`; no longer deferred. Incremental serialization still depends on producer identity preservation, which has remaining gaps below. Device startup/flush latency is unmeasured. |
| — | Load-rig phase and hold validity | ✅ `tools/loadrig/rig.mjs` schedules ramp batches against absolute deadlines, labels traffic using actual connection-attempt completion, and starts the full hold after setup; `tools/loadrig/rig.test.mjs` covers delayed connections. No production load run was performed. |

### Still deferred or gated

| ID | Task | Remaining work |
| -- | ---- | -------------- |
| P1.6c | Release shrinking / signing | 🚧 R8 and `shrinkResources` are enabled in `mobile/android/app/build.gradle`, with `androidReleaseShrinking.test.ts` coverage. Release still uses `signingConfigs.debug`; upload signing and shrunk-APK device QA remain. |
| — | Permissions / i18n | ⏸️ `CALL_PHONE` and `READ_PHONE_STATE` remain in `AndroidManifest.xml`; review actual native requirements before removal. Translation infrastructure/copy extraction remains separate work. |

### Phase 6 — Chat & calling UX pass

| ID | Task | Status / current evidence |
| -- | ---- | ------------------------- |
| — | Swipeable message bubbles | ✅ `SwipeableRow` races long press with pan and separates horizontal activation from vertical failure; the conversation presentation composes it into message rows. |
| A2 | Coalesce chat persistence | ✅ `useChatSnapshotMirror.ts` uses a 750 ms coalescing window; `chatDb.ts` uses a separate 250 ms write window. Background/non-active transitions and mirror unmount request immediate flushes. See P1.7 for test limits. |
| A3 | Pause stats in background | ✅ `useConnectionQuality.ts` stops in `background`, samples immediately on restart, and also polls in `inactive`; `hooks/useConnectionQuality.test.tsx`. This is not a strict active-only gate. |
| A4 | Call-history list shaping | ✅ `CallsScreen.tsx` memoizes `SectionList` sections and defines row rendering outside the JSX. The server already pages durable `/calls` history; client UI behavior is a separate concern. |
| B1 | Per-conversation drafts | ✅ `chat/ChatConversationPresentation.tsx` restores text/reply targets, debounces draft callbacks at 750 ms and flushes those callbacks on leave/non-active state; `ChatListScreen` previews drafts. SQLite stores them per scope. |
| B3 | Jump-to-latest / unread divider | ✅ Conversation presentation retains the jump control and `findUnreadAnchorKey`; `components/ChatConversationScreen.test.tsx` covers the frozen unread count. |
| B6 | Badge cap / mute | ✅ `components/primitives/Badge.tsx` caps display at `99+`; `ChatListScreen.tsx` exposes mute actions and muted-row indication. |
| C1 | Quality hysteresis | ✅ `smoothConnectionQuality` in `callUx.ts`, consumed by `useConnectionQuality`: upgrade immediately, downgrade after consecutive worse samples; `callUx.test.ts`. |
| C2 | Honest media/audio failure reporting | ✅ `mediaControls.ts` reads back track state; `call/audioRouteRules.ts` / `useCallAudioRouting.ts` handle detachable-route loss. PiP has no user-request refusal trigger: native entry is from `onUserLeaveHint`. |
| C4 | Busy controls during screen-share changes | ✅ `CallControls.tsx` shows disabled, busy Starting/Stopping states from `isTogglingScreenShare`; component tests cover them. This is not a blanket lock on every renegotiation. |
| D1 | Call/chat navigation | ✅ Conversation header call actions and call-history swipe-to-Message actions exist in conversation presentation / `CallsScreen`. |
| — | Qualified screen-share confirmation | ✅ `useScreenShare.ts` publishes `screenShareDelivery` from `verifyScreenShareFrames`; unreadable stats remain `unverified`, not confirmed. Tests cover the distinction. Outbound frames are not proof of actual remote rendering. |
| — | Message-sent haptic | ✅ `useMessaging.ts` invokes `triggerHapticUnlessSilent` on successful acknowledgment, not optimistic enqueue; its tests cover queued sends and backlog replay. |
| C6 | Audio-only presentation | ✅ `deriveCallStreams` in `callStreamHelpers.ts` uses camera-enabled flags; `call/pushRehydration.ts` parses additive media-state flags. This UI rule is distinct from native audio-only negotiation. |
| — | First-run search affordance | ✅ Empty chat/call lists provide Search for people links in `ChatListScreen` / `CallsScreen`. |
| A1 | Selective call subscriptions | ✅ `CallProvider.tsx` publishes through a stable store; `useCallSelector` subscribes selectively, while provider actions read `callFlowRef`. `callContextIsolation.test.tsx` checks both isolation and selected-field updates. |

### Chat & calling UX pass — deferred

| ID | Task | Reason / boundary |
| -- | ---- | ----------------- |
| B2 | Message editing | ⏸️ No `message.edit` / `editedAt` contract exists in current shared/server/mobile code; an edit window and compatibility coverage must land together. |
| B5 | Presence freshness / last seen | ⏸️ User `lastSeenAt` semantics are not implemented; Redis fan-out probe peer timestamps are not user presence. |
| C3 | Recovery endgame | 🚧 Recovery escalation/budget handling exists in `useCallRecovery`; device QA of real ICE failure remains, and the proposed dedicated recovery Call back card is not evidenced by ordinary timeline call-back actions. |
| C5 | Caller ringback | ⏸️ `mobile/src/ringtone.ts` explicitly avoids caller ringback. Audio-session behavior needs device validation before changing that contract. |
| D2–D5 | Larger messaging/calling features | Separate epics, not blanket “not started” claims about every voice-message or preview feature. Group calls/chat are outside this scoped pass. |
| E1–E3 | Decomposition / SQLite / i18n | E1 is partial as P1.2 records; E2 storage is implemented as P1.7 records; i18n remains deferred. |

## Phase 7 — Target-architecture rebuild

| ID | Decision | Status |
| -- | -------- | ------ |
| D3 | Plain systemd deployment | ✅ Unit and deployment surface implemented; missing-instance-id observability gap below. |
| D2 | Redis shared-state role | ✅ Shared sessions, calls, presence, cache and fan-out implementations exist. Fleet health must be checked operationally. |
| D4.1 | Session lifetime and expiring Redis keys | ✅ Implemented; zero application TTL does not produce immortal Redis keys. |
| D4.2 | Session tokens out of HTTP query strings | ✅ Header resolvers/call sites implemented; body fallback remains intentional. |
| D4.3 | DB retention and bounded hydration | ✅ Implemented; default message retention remains disabled. |
| D4.4 | Usable message-page cache | ✅ Message pages are cached independently of live call enrichment. |
| D1 | Postgres messages and conversation projection | ✅ Mongo replacement and transactional projection implemented; current read shape below. |
| D5 | Android release / storage / permissions / i18n / layout | 🚧 SQLite and shrinking implemented; production signing, device QA, permission review and i18n remain. Variable-height message layout intentionally lacks `getItemLayout`. |

### D3 — Deployment surface

`deploy/robot-signal.service` targets Oracle Linux / `opc`, waits for
`network-online.target`, and retains sandboxing (`NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome=read-only`, private devices and kernel
protections, restricted address families / system calls). Its base memory
settings are `MemoryHigh=768M` / `MemoryMax=1G`; deployed drop-ins may override
them, so these are not observed production limits.

`ProtectHome=true` would hide the checkout under `/home/opc`; moving it outside
home would allow tighter isolation. `server/src/lib/instances.ts` reads
`INSTANCE_ID` / `SIGNAL_INSTANCE_ID`, not PM2 variables.

**Known gap:** a fleet missing those variables can appear to be instance zero.
The guard cannot infer the second host; the startup warning proposed for
`REDIS_URL` without an instance id is not implemented there.

### D2 — Redis

The target is shared state, not merely a shared Socket.IO adapter. Without
`state.callState`, `sharedCalls.ts` uses the local transition authority;
`shared-call-state.test.ts` checks that fallback and cross-instance transitions.
With shared state, hydration refreshes a stale local ringing cache before
authorizing RTC/cancel handling. That regression is covered in the same suite.

Load distribution belongs to the OCI NLB policy. `deploy/README.md` now names
Caddy as the OCI TLS proxy, with nginx/certbot as the Ubuntu alternative.
Shared affinity alone is not proof that cross-instance fan-out is healthy:
check the fan-out probe as well as `/health`.

### D4.1 — Session lifetime

`server/src/config.ts` defines a seven-day default `SESSION_TTL_MS`; sessions
are swept on the existing maintenance cadence. `server/src/stores/redis.ts`
always supplies `PX`, bounded by `SHARED_SESSION_MAX_TTL_MS`, including when
application TTL is disabled. `SESSION_TTL_MS=0` restores non-expiring application
records, **not** non-expiring Redis keys. Client HTTP refresh and
`useSignalingSocket`'s invalid-session handling provide recovery paths.

### D4.2 — Session id out of URLs

`mobile/src/authHeaders.ts` builds bearer headers; both resolvers in
`server/src/lib/auth.ts` read Authorization/body, not `req.query.sessionId`.
A bearer query token would leak into proxy logs/history. The body fallback is
deliberate, including push-device and session-refresh requests; socket
authentication is a separate transport.

### D4.3 — Retention and bounded hydration

`server/src/lib/retention.ts` deletes in bounded batches. Defaults in
`server/src/config.ts` are 5,000 rows per batch, a six-hour sweep, 90-day call
retention and 180-day audit retention; zero disables a retention window.
Only terminal calls qualify, and the call-event FK cascades their deletion.
`0009_retention_indexes.sql` provides sweep indexes.

`server/src/callPersistence.ts` hydrates newest calls by
`updatedAt DESC, callId DESC`, using **`DEFAULT_MAX_RETAINED_CALLS` (500)**,
then scopes events to those ids. This is not the runtime
`MAX_RETAINED_CALLS` override used by the hot-map sweep. Events for the selected
calls are scoped, but are not independently row-limited.

Message retention defaults to off: automatic deletion of user content is not a
neutral storage optimization. When enabled, `pruneExpiredMessages` uses a
bounded `ctid` delete for the composite-key table and rebuilds affected
conversation projections in the same transaction. It is no longer a
row-at-a-time delete. `server/test/retention.test.ts` covers retention behavior.

### D4.4 — Message-page cache

`server/src/routes/messages.routes.ts` caches message pages according to their
cursor/page shape rather than excluding every `include=calls` request. Calls
are merged live, with participant/block checks retained. This avoids trading
cache hits for stale call entries.

### D1 — Postgres consolidation and the conversation projection

`server/src/messageStore/pgStore.ts` uses the `messages` table keyed by
`(conversation_id, message_id)`; Mongo is no longer the storage implementation.
Migration `0010_messages_table.sql` defines conversation paging, directional
participant, unread-partial and body-trigram indexes.

**Retained decisions:**

- Search is literal case-insensitive substring matching via `pg_trgm` on
  `lower(body)`, with escaped LIKE metacharacters. `tsvector` word stemming would
  change the API's semantics and disagree with the memory store.
- The original development dataset did not require a Mongo data migration.
  That historical decision is not permission to discard a production dataset.
- Timestamps are normalized on ingress to fixed-width UTC ISO so Postgres text
  representations cannot misorder call/message timelines or fail Hermes parsing.

**Current conversation read:** `listConversations` first filters the
`conversations` projection by either participant, orders by
`last_created_at DESC, last_message_id DESC`, and applies
`MAX_CONVERSATION_LIMIT` before joining the selected message pointers to
`messages` by composite key. The preview is live source data, so deletion,
reactions and receipts do not require a shadow-preview rewrite.
Migration `0013_daily_gwen_stacy.sql` defines `idx_conversations_a` on
`(participant_a, last_created_at DESC, last_message_id DESC)` and
`idx_conversations_b` on
`(participant_b, last_created_at DESC, last_message_id DESC)`. Their
participant-leading descending sort keys support each participant access path;
the OR across those paths does not itself guarantee an ordered index scan or
eliminate a sort.
This is a bounded output/join shape, not a measured production latency or a
guarantee of a particular planner strategy.

**Write invariants:** `sortedParticipants` orders the pair the same way as
`deriveConversationId`; migration `0013_daily_gwen_stacy.sql` and retention
rebuilds use `LEAST`/`GREATEST` with `COLLATE "C"` rather than splitting ids.
Insertion and projection maintenance share one transaction. A replayed insert
does not increment unread; the latest pointer advances only by the
`(created_at, message_id)` order, while unread increments independently even
when an older message loses the pointer race. `markRead` updates receipts and
zeroes the correct participant counter transactionally. Retention and account
erasure also maintain/remove projection rows.

Historical evidence: [#390 measurement comment, 2026-09-14](https://github.com/konarsubhojit/studious-robot/issues/390#issuecomment-5660342816) reported the old query growing from ~2.5/~20/~95 ms at 1k/10k/100k hot messages, with disk spill at the largest size; #391 closed completed via merged #396, supporting the projection—not a current performance claim.

`server/test/message-store-pg.test.ts` checks the rendered bounded projection
query, transaction maintenance, replay behavior and search shape;
`conversations-projection.test.ts` checks migration/rebuild SQL and participant
ordering; `conversations-projection-db.test.ts` exercises database parity.
`DISTINCT ON` belongs to backfill/rebuild work, not the current list read.
These are inspected tests, not fresh pass counts.

Durable call history/timeline reads live in `server/src/domain/callHistory.ts`
and `callTimeline.ts`, with memory fallback when DB configuration/querying is
unavailable. `readCallsBetween` applies the cursor in SQL;
`readCallActivityByPeer` folds recent activity with unacknowledged missed calls;
`markMissedCallsRead` reaches evicted records. `call-timeline.test.ts` covers
durable-only history. `mergeTimeline` requires each input to contain its newest
requested page; the call bound follows the message-page bound. A combined
message/call query remains a design choice, not a correctness prerequisite.

### D5 — Android

#### Fixed: state management, local storage and error surfacing

- `messageHistory.mergeHistoryPage` preserves live entries outside the returned
  page window, older loaded pages and unsent entries.
- `withOutgoingMessage` in `messaging/conversations.ts` keeps optimistic sends
  and attachment previews aligned with their bubbles.
- `chat/ChatConversationPresentation.tsx` reads and clears the composer ref
  synchronously and suppresses the delayed sent-text echo.
- SQLite loads share a promise and fold earlier writes over disk state;
  outbox-only updates do not re-prune all histories.
- `useIdentity.ts` verifies the username with the server before committing it;
  identity rejection descriptions distinguish conflict codes.
- `StatusToast` on chat/call lists surfaces transient failures; persistent
  connectivity remains a condition banner.

#### Still to do

Production upload signing and release-device QA; native permission review;
i18n/copy extraction; and further presentation decomposition where cohesive.
Message `getItemLayout` is intentionally absent because text/media heights vary;
quote navigation retains its scroll-failure fallback, not a promised constant
row height.

### Working notes

- Use the package scripts/CI workflows for validation; install dependencies only
  if a chosen command reports missing tooling or manifests changed.
- Backend: typecheck, lint and tests are package scripts; a targeted suite uses
  `node --experimental-test-module-mocks --test test/<file>.test.ts` from
  `server/`. `backend-ci.yml` supplies Postgres; a local run without it does not
  establish DB integration coverage.
- Mobile: package typecheck/lint/test scripts define the current invocation.
  No clean lint, pass total, runtime or leaked-handle baseline is asserted here.
- Test doubles use the typed helpers in `server/test/helpers.ts`; narrowed
  hydration queries require chainable Drizzle doubles.
- Source-status inspection was separate from the parent's package validation
  reported above. No deployed fleet/device was inspected.

## Notes and deviations

### C6: picture state is not track count

A disabled camera may retain a video track, so track presence alone cannot
decide whether to draw a picture. `deriveCallStreams` combines track presence
with local/remote camera state, including the self-view tile. Each media-state
key is parsed independently: silence from a heartbeat is not a flag reset, and
an older peer defaults to camera enabled. `callStreamHelpers.test.ts` and
`call/pushRehydration.test.ts` cover these contracts. Native acquisition and
audio-only call paths also exist in `useLocalMedia` / `useCallFlow`; the old
blanket claim that every audio call negotiates video is obsolete. Actual
negotiated behavior requires device testing.

### B3: the unread divider cannot use read receipts

Opening the conversation quickly marks messages read. Freeze the unread count
at mount and count back incoming messages, skipping calls; clamp to the oldest
loaded incoming entry when the count exceeds the page. The divider must survive
the live badge falling to zero.

### P2.5: contrast and overlay invariants

Use `textOnAccent` on bright danger/success surfaces, not hardcoded white.
Fixed-dark video scrims use `onOverlay`, not palette-inverting `textPrimary`.
Overlay tokens belong outside light/dark palettes so a light theme cannot make
video-stage text dark. `theme.test.ts` checks token contrast; it does not certify
every composed screen.

### P2.3: accessibility state belongs in the accessible node

Unread badge text inside an already-labelled Pressable may be collapsed out of
the accessibility tree; include counts in the parent name. Toggle names state
the next action, while `accessibilityState.selected` communicates current state.
Fixed-size glyphs require an appropriate `fontScaleCaps` token.

### P2.4: an error is not an empty directory

`searchUsers` in `usePresenceSearch.ts` rejects actual failures with
`DirectorySearchError`; absent sessions and aborted superseded requests remain
non-errors. `SearchScreen` places retry UI above the list so a partial directory
failure cannot be hidden by local message/call results.

### P2.1: gesture / style boundaries

`resolveMediaGesture` in `MediaViewer.tsx` is both an exported pure helper and a
worklet; dependencies called from it must remain worklet-safe. RNGH handles
horizontal/vertical arbitration and composed pinch/pan/tap gestures.
`useThemedStyles` in `ThemeContext.ts` requires module-level factories: creating
one per render defeats its identity-keyed cache.

### P1.2: current decomposition boundary

Pure decisions live in `callUx.ts` and `mobile/src/call/` modules such as
`iceRestartLadder`, `callDecisions`, `sessionLifecycle`, `pushRehydration`,
`answerPath`, `audioRouteRules` and `recoveryEpisode`. Effectful concerns now
live in `useCallHeartbeat`, `useCallRecovery`, `useCallAudioRouting`,
`useConnectionQuality`, `usePeerConnection`, `useLocalMedia`,
`useSignalingSocket` and `useAnswerPath`. The older “negotiation/socket effects
cannot be extracted” phase narrative is superseded by those concern-hooks.

The composition root is **2,442 lines** (`wc -l`, audit revision).
`endActiveCall` remains there because its ordered teardown crosses history,
CallKeep/ringtone, heartbeat, recovery, screen share, peer connection, local
media, routing and UI reset. Moving that coordinator behind a large parameter
bag would relocate coupling rather than remove it.

**Retained rule invariants:**

- `sessionLifecycle`: an absent call-state report is not an empty active-call
  list. “No answer” from an older server must not tear down a healthy call.
- `iceRestartLadder` / `recoveryEpisode`: the lexicographic participant
  tie-break avoids simultaneous restart offers; recovered, paused, offline,
  negotiating and spent-budget states gate attempts. Waiting while recovery
  is impossible does not consume the attempt budget, but an absolute episode
  ceiling prevents indefinite extension.
- `callDecisions`: stale offers and transitions belonging to another call must
  not mutate the active call; duplicate accepts and replayed answers are bounded.
- `pushRehydration` / `answerPath`: waiting for identity is deferred work, not a
  vanished call. Queued answers must survive that deferral; HTTP answer fallback
  distinguishes unavailable transport/session from refusal and is never silent.
- `audioRouteRules`: speaker-on-join must not steal a headset route; incomplete
  device enumeration is not proof a detachable route was unplugged. Actual route
  loss is announced rather than silently handed over.
- `callEndpoints`: encode call ids at the URL boundary rather than duplicating
  interpolation rules across transport paths.

Focused hook/rule tests and `hooks/useCallFlow.test.tsx` exist; they are not
device-call E2E evidence, and no historical pass result or complexity score is
asserted.

**Device QA — outstanding; record actual results before declaring completion:**

- [ ] Outgoing call: connect, mute, routing, camera switch, end.
- [ ] Incoming ring, accept and decline.
- [ ] CallKeep answer, including cold-start push wake.
- [ ] Recoverable and unrecoverable network loss; budget/banner/endgame.
- [ ] Offline callee push wake.
- [ ] Screen share, PiP and detachable-headset hand-over.

### P1.7: SQLite is implemented; identity remains load-bearing

`localDatabase.ts` opens `wetalk-local.sqlite` through
`@op-engineering/op-sqlite`, enables WAL / FULL synchronous commits and serializes
complete operations. `chatDb.ts` maintains scope-isolated conversation/message/
outbox/draft state; `chatRecords.ts` serializes row payloads and diffs SQL changes
into an atomic batch. The legacy JSON document is an import path, not the
current write engine. Cold-start hydration still reads and parses the scope's
retained rows; SQLite does not make startup cost disappear.

Retention constants remain 200 recent timeline entries and 100 conversations.
They are **not a hard 20,000-row ceiling**: pending/failed entries and peers
pinned by drafts/outbox may exceed the nominal history bounds. Startup cleanup
diffs against actual disk rows, so retention deletes persisted expired rows,
not just their in-memory copies.

The two layers are distinct: `SNAPSHOT_PERSIST_DEBOUNCE_MS = 750` in
`useChatSnapshotMirror.ts` coalesces the rendered-state mirror;
`WRITE_DEBOUNCE_MS = 250` in `chatDb.ts` coalesces durable writes. The mirror's
timer reads the latest ref and is not restarted for every update. Non-active
AppState transitions and unmount call `persistNow` then `flushChatDb`; those
lifecycle flushes are asynchronous requests, not a guarantee against OS process
termination. Send paths explicitly await an outbox commit before network emit.

**Referential invariant:** unchanged peer arrays must retain their identities,
with immutable replacements for actual changes. `saveChatSnapshot` reuses the
previous pruned array when its input peer array is unchanged;
`snapshotRows` reuses held serialized rows and skips that peer's
`JSON.stringify` when
`snapshot.messagesByPeer[peer] === previous?.messagesByPeer[peer]`.
An equivalent-but-new array defeats that skip and re-serializes the peer's rows.
`rowChanges` separately avoids SQL for unchanged payload/
position. Avoiding SQL after serialization is not the same optimization.

**Verified regression scope and remaining gap:** `storage/chatDb.test.ts`
checks retention, migration/isolation, atomic rollback/retry, outbox-only array
preservation and no message SQL rewrites for an outbox-only change.
`hooks/useMessaging.test.tsx` checks the mirror window, background flush and
commit-before-send. Neither directly spies on serialization to prove a
changed-peer-only save leaves all other peer payloads unencoded, nor directly
tests pending mirror unmount force-flush.

Producer no-op guards are incomplete: `receivePipeline.applyIncomingMessage`
deduplicates by id, `applyReadReceipt` preserves state for repeated reads, and
`messageHistory` guards missing ids / absent removals. Their tests assert those
cases. But `applyDeliveryReceipt` and `upsertTimelineEntry` allocate for repeated
equivalent updates; `patchMessage` marks a found entry changed without checking
the updater result; `patchMessageEverywhere` maps every peer and uses one global
changed flag, so unrelated peer arrays are replaced too. Repeated reactions/
tombstones therefore lack complete no-op identity guards. The storage
optimization exists, but end-to-end changed-peer-only serialization is not
established. These are remaining work, not application changes in this audit.

The former whole-document size/stringify timing and extrapolated Hermes/device
costs are obsolete. Current startup/flush latency, memory, send jank and
production throughput require fresh measurements on the relevant workload.

### P3.3: timing is a protocol invariant

`shared/signaling/timing.ts` defines a 30,000 ms heartbeat interval and a
five-beat allowance, deriving the 150,000 ms timeout rather than duplicating
literals. It also relates recovery budget, disconnect allowance and server
grace; `heartbeat-timing.test.ts` guards the ordering.

### P1.5: compression is a separate trade-off

Body/frame limits and logging gates bound work without adding compression
middleware. The original decision avoided another runtime dependency for small
JSON payloads under the planning load assumption. Revisit with actual payload/
bandwidth measurements rather than treating that assumption as a benchmark.

### A1 / P1.1: subscribe to the data a surface actually reads

The stable call store and `useCallSelector` prevent unrelated stats updates
from waking chat/tab consumers. `endCall` / `handleExportLogs` read a ref rather
than depending on the whole fresh flow result. Duration displays own their
elapsed timer. The isolation tests exercise both unrelated updates and genuine
selected changes, so “nothing rerenders” cannot masquerade as correctness.
Leaf memoization is defense in depth, not the primary boundary.

### P1.3: retention bounds memory, not durable history

Only terminal calls are evicted; live calls remain timeout-managed state.
`server/src/config.ts` defaults to a 24-hour window and 500 retained terminal
calls, configurable through `CALL_RETENTION_MS` / `MAX_RETAINED_CALLS`.
`state.callEvents` is removed with each call. `/calls` reads durable,
participant-scoped, paged history and keeps memory as degraded fallback;
eviction is not the history horizon.

### P3.2: scoped declarations, not unrelated reformatting

Declaration-only `max-len` avoids imposing a new general line-length style.
Server ESLint also checks floating/misused promises and await misuse, which
statement-length scans cannot catch. The package workflows invoke lint; no
historical clean-run result is asserted.

### Retained review invariants

The obsolete per-branch review-response ledger is removed. Keep these design
constraints instead:

- `server/test/helpers.ts` centralizes ordered Socket.IO/HTTP teardown.
- Audio-route permission failures degrade through `audioRouting.ts` rather
  than escaping the routing contract.
- Native/JS ringer-mode vocabulary must stay aligned; it is not code-generated.
- Ringtone/audio-session teardown order needs revisiting if call waiting is
  introduced.
- `telemetry.ts` keeps `dbQueries` as a sorted operation table, not a keyed
  counter/histogram map; preserve that distinction for snapshot consumers.
- `persistence.ts` has deliberate write-error propagation differences; callers
  must not assume every persistence method throws.
