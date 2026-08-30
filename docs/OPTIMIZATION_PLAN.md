# Optimization Plan — UI, Architecture & Performance

Tracking document for the UI / architecture / performance pass. Each task is
sized to land independently behind the existing `backend-ci.yml` /
`mobile-ci.yml` typecheck + test gates. No task weakens or removes an existing
test.

## Operating assumptions

These were confirmed before work started and they materially shape the scope:

| Question | Answer | Consequence |
| -------- | ------ | ----------- |
| Instance count | **Single instance** today | P3.1 is a documentation + startup-assertion task, not a Redis state refactor |
| Concurrent users | **~10** | P1.4 (directory paging / lazy boot hydration) is premature; descoped to a documented note |

Everything else in the original plan stands.

## Status

Legend: ✅ done · 🚧 in progress · ⬜ not started · ⏸️ descoped (with reason)

### Phase 1 — Quick wins, low risk

| ID | Task | Status |
| -- | ---- | ------ |
| P3.4 | Heartbeat must be an explicit opt-in, not any `call.media-state` frame | ✅ already fixed on `master` — verified the `heartbeat === true` guard in `callHandlers.ts` and the regression test in `stale-calls.test.ts`; no change needed |
| P2.2 | Delete unreferenced `DraggableCallControls` | ✅ deleted, with its test |
| P1.5 | Server: `express.json` body limit, gate `verboseLog` allocation, Socket.IO buffer cap | ✅ see note on compression below |
| P3.3 | Move call timing constants into `shared/` so mobile and server cannot drift | ✅ `shared/signaling/timing.ts`, with an invariant test |

### Phase 2 — Render performance (P1.1)

| ID | Task | Status |
| -- | ---- | ------ |
| P1.1a | Memoize `ScreenRenderersContext` value; `useCallback` the `TabShell` renderers | ✅ |
| P1.1b | Move `elapsedCallSeconds` out of the shared hook into `useCallElapsedSeconds` | ✅ |
| P1.1c | `React.memo` the leaf screens | ✅ |
| P1.1d | Render-count regression test under fake timers | ✅ |

### Phase 3 — Startup / bundle

| ID | Task | Status |
| -- | ---- | ------ |
| P1.6a | Metro `inlineRequires` | ✅ |
| P1.6b | `useThemedStyles` module-level style cache | ✅ |

### Phase 4 — Server memory

| ID | Task | Status |
| -- | ---- | ------ |
| P1.3 | Evict terminal calls from the hot `state.calls` map after a retention window | ✅ |

### Phase 5 — Architecture & docs

| ID | Task | Status |
| -- | ---- | ------ |
| P3.1 | Document the single-instance requirement + surface it at startup and in `/health` | ✅ |
| P1.4 | Directory / boot-hydration scaling | ⏸️ descoped — premature at ~10 concurrent users |
| P3.2 | Reformat single-line wide type declarations + guard against regression | ✅ |

### Previously deferred, done in this pass

| ID | Task | Status |
| -- | ---- | ------ |
| P2.1 | Port `MediaViewer` / `SwipeableRow` to Reanimated worklets | ✅ |
| P2.3 | Accessibility sweep | ✅ |
| P2.4 | State completeness | ✅ |
| P2.5 | Design-system consolidation | ✅ |
| B4 | Attachment progress ring | ✅ optimistic attachment sends now create the bubble before upload, render progress/cancel on that bubble, and leave failed uploads retryable instead of removing them |
| P1.2 | Decompose `useCallFlow` | ◧ partial — two slices are out and directly tested (the WebRTC stats helpers in `callUx`, and the ICE-recovery ladder in `call/iceRestartLadder`); the structural split still wants its own PR |
| P1.7 | Swap `chatDb` JSON document for SQLite | ⏸️ still deferred, but the bound that justifies the deferral is now pinned by a test *and* priced: ≈ 7.9 MB and ≈ 24 ms of `JSON.stringify` per flush at the ceiling (see the note below) |

### Still deferred

| ID | Task | Reason |
| -- | ---- | ------ |
| P1.2 | Split `useCallFlow` into per-concern hooks | The remaining lines are ref-coupled call lifecycle, WebRTC negotiation and ICE recovery *side effects*; the recovery ladder's decisions have since been extracted (`call/iceRestartLadder`). Cutting the hooks themselves apart is still a behavioural risk that wants its own PR, its own review and device QA — not a rider on a UI pass |
| P1.6c | Enable R8 / `shrinkResources` for release builds | Real crash risk without device QA on the release APK, which this environment cannot do |
| P1.7 | Swap `chatDb` JSON document for SQLite | Needs a new native dependency. Bounded at 200 messages × 100 conversations, so defensible today |

### Phase 6 — Chat & calling UX pass

Workstream IDs below are those of the chat/calling UX plan (A performance
foundations, B chat UX, C calling UX, D new features, E enablers).

| ID | Task | Status |
| -- | ---- | ------ |
| — | Message bubbles could not be swiped | ✅ the bubble was a `Pressable` covering the pan surface, and `activeOffsetX` equalled `failOffsetY`; long press now races inside the RNGH gesture and activation (10dp) sits below the vertical fail threshold (24dp) |
| A2 | Debounce the chat snapshot mirror | ✅ trailing 750 ms debounce, force-flushed when the app leaves the foreground and on unmount |
| A3 | Gate WebRTC stats polling on foreground | ✅ polling pauses in `background`, resumes with an immediate sample |
| A4 | Call-history list cost | ✅ sections are shaped for `SectionList` inside the memo and the renderers are hoisted out of the JSX; server-side paging of `/calls` is not needed at the current log sizes |
| B1 | Per-conversation drafts | ✅ persisted in the chat snapshot, restored on open (including the reply target), previewed as "Draft: …" in the chat list; written with a trailing debounce and force-flushed on leave/background |
| B3 | Jump-to-latest / unread divider | ✅ the jump-to-latest pill (with a new-message count) and tap-a-quote-to-scroll already existed; this pass added the "N new messages" divider. It is anchored by counting back N *incoming* messages from the frozen mount-time unread count, **not** by `readAt` — see the note below |
| B6 | Unread badge cap / mute | ✅ the badge was already capped at 99+ by the `Badge` primitive (verified, no change); mute/unmute is now reachable from a chat-list swipe and muted rows carry a glyph |
| C1 | Quality-indicator hysteresis | ✅ `smoothConnectionQuality`: upgrade immediately, downgrade only after two consecutive worse samples |
| C2 | Make failures speak | ✅ `setTrackEnabled` reads the track state back so the UI can never claim "muted" while audio still flows, and a manually chosen headset that disconnects announces the hand-over. The plan's PiP-refusal toast has **no trigger**: PiP is only ever entered natively from `onUserLeaveHint`, never from a user-initiated request |
| C4 | Disable controls during renegotiation | ✅ the screen-share row reports `isTogglingScreenShare` as a busy, disabled "Starting…/Stopping…" state |
| D1 | Call from chat / chat from call | ✅ the conversation header already placed calls; call-history rows now swipe to "Message" |
| — | Screen share confirms success, not only failure | ✅ `verifyScreenShareFrames` already returned `verified`; `useScreenShare` now publishes it as `screenShareDelivery` (`idle`/`checking`/`confirmed`/`unverified`) and the in-call indicator settles on "Sharing — they can see your screen". An unreadable stats report stays `unverified` and keeps the old wording — the UI must not promise a view it could not measure |
| — | Haptics at the moments that substitute for looking | ✅ connect, end and incoming ring already fired; *message sent* was missing and now fires on the server ack, not on the optimistic bubble. Silent mode is respected through `triggerHapticUnlessSilent`, and only a single-message drain buzzes, so a reconnect replaying a backlog does not rattle once per queued message |
| — | First-run empty states point somewhere | ✅ the empty chat and call lists now offer a low-emphasis "Search for people" link. Deliberately *not* an `actionLabel`: a second filled button in the screen's accent, a couple of hundred pixels from the FAB, makes whichever the user reaches for the wrong one. The "no results" / "we could not check" distinction from P2.4 is untouched |

### Chat & calling UX pass — deferred

| ID | Task | Reason |
| -- | ---- | ------ |
| A1 | Split `CallProvider` into call-state / media-controls / recovery contexts | Real win, but it changes the consumer set of every call screen and is the natural first half of E1. Wants its own PR with render-count assertions, not a rider on this one |
| B2 | Message editing | Protocol change (`message.edit` / `message.edited`, `editedAt`, a server-enforced edit window). Should land together with D3 behind one schema-compatibility test |
| B5 | Presence freshness / last seen | Needs a server-side `lastSeenAt` and a socket presence subscription for the open conversation |
| C3 | Recovery endgame (escalation + "Call back" card) | Device QA required: the behaviour only manifests during a real ICE failure |
| C5 | Ringback tone for the caller | Device QA required; audio-session behaviour cannot be verified in this environment |
| C6 | Honest audio-only calls | The fix is at `getUserMedia` time and changes the negotiated media, so it needs device QA on both platforms. Until then `call-stage-ambient` stays unreachable |
| D2–D5 | Voice-message polish, link previews, group calls, group chat | Each is its own epic; D4/D5 in particular are explicitly out of scope for a UX pass |
| E1–E3 | `useCallFlow` decomposition, SQLite, i18n | Tracked above as P1.2 / P1.7; i18n should precede any further copy growth |

## Notes and deviations

### B3: the unread divider cannot be derived from read receipts
Opening a conversation marks it read within a round trip, so by the time the
list renders, the receipts that would identify the unread run are already
gone. The divider therefore reads the conversation's unread *count*, frozen at
mount, and counts back that many incoming messages from the end of the loaded
page. A count larger than the loaded page anchors at the oldest loaded message
rather than dropping the divider, and the divider survives `unreadCount`
dropping to 0 mid-session (there is a regression test for exactly that).

### P2.5: two real bugs, not just token hygiene
Replacing the colour literals was supposed to be cosmetic. It uncovered two
defects that the literals had been hiding.

`'#fff'` was hardcoded as the text colour on `colors.danger` and
`colors.success` badges. The dark palette's `danger: '#ff7b8a'` and
`success: '#5be2a2'` are bright, so white text on them failed WCAG AA. The
correct token, `textOnAccent`, is dark navy in the dark scheme, and
`theme.test.ts` had *already* been asserting
`contrast(textOnAccent, danger) >= 4.5` — the components simply were not using
it.

`colors.textPrimary` was used on the fixed-dark video scrims in
`DraggablePip` and `CallTopBar`. `textPrimary` inverts to near-black in the
light scheme, so that content was invisible over a 72%-black scrim for every
light-mode user. Those now use `colors.onOverlay`.

The `overlay` tokens deliberately live *outside* the two palettes: the video
stage is dark in both schemes, so putting scrims into `createStyles(colors)` is
what invites the second bug back. Two opacities were normalised on the way
(`0.55` and `0.65` both became `scrimMedium`, `0.6`); contrast against
`onOverlay` stays far above AA at either value.

### P2.3: the accessibility gaps were all "state conveyed by pixels"
Every finding had the same shape — something the sighted user reads off the
screen that was never in the accessibility tree.

The unread badges were the sharpest case. They render *inside* a `Pressable`
that already carries an `accessibilityLabel`, so React Native collapses the
subtree into one node and the badge text is simply never spoken. The count is
now part of the tab's and the row's accessible name.

The call-control toggles named only the *next* action ("Unmute microphone"),
which is a fine label but leaves no way to learn the *current* state, so
`IconButton` grew a `selected` prop. Its visual caption is now hidden from
assistive tech, since the button's own name already says the same words.

### P2.4: the missing state was error, not loading or empty
The screens already had loading skeletons and empty states. What they did not
have was any way to *reach* an error state, because `searchUsers` swallowed
both a non-OK response and a network error and returned `[]`. An unreachable
directory therefore rendered as a confident "No matching contacts" — a claim
the app had no basis for and the user could not act on.

`searchUsers` now rejects with a `DirectorySearchError`, keeping `[]` only for
the two cases that genuinely are not failures: no session yet, and a request
aborted by a newer keystroke. `SearchScreen` renders the retry banner *above*
the list rather than as `ListEmptyComponent`, because the contact lookup can
fail while local message and call results still arrive — an empty-component
banner would vanish exactly when the failure was partial.

### P2.1: what the port actually bought
Beyond moving the drag off the JS thread, both components lost hand-rolled
logic to the gesture system. `SwipeableRow`'s horizontal-vs-vertical
arbitration was a `Math.abs(dx) > Math.abs(dy)` comparison inside
`onMoveShouldSetPanResponder`; it is now `activeOffsetX`/`failOffsetY`, which
is the native gesture system's job and behaves correctly when the parent list
is also competing for the touch. `MediaViewer` deleted its two-touch distance
maths and its double-tap timestamp bookkeeping in favour of composed
`Pinch`/`Pan`/`Tap` gestures. `resolveMediaGesture` was left exactly as it was.

The jest mocks for both libraries moved into `mobile/__mocks__/`. They had been
copy-pasted into each test that touched an animated component, and every new
one needed them again.

### P1.2: a slice, not the split
The honest status is partial. What came out is the WebRTC stats handling —
`collectCallStats` and `summarizeCandidatePair`, now in `callUx` beside the
`getConnectionQuality` they feed. That was the largest remaining block of
genuinely pure logic in the hook, and it was previously reachable only by
mounting the hook and driving a fake peer connection, which is why its
relay-side matrix and protocol fallbacks had no direct tests.

Extracting it also surfaced that `useCallFlow.test.tsx` replaced the whole
`callUx` module with a single stub, so any new export from that module would
silently be `undefined` there. It now spreads the real module and stubs only
`getConnectionQuality`.

What is left in `useCallFlow` is call lifecycle, WebRTC negotiation and ICE
recovery, all coordinated through shared refs. Splitting that is a behavioural
change to the call path and belongs in its own PR with device QA, exactly as
the original deferral said.

**Second slice: the ICE-recovery ladder.** `call/iceRestartLadder.ts` now owns
the ladder's decisions — the capped exponential backoff, the lexicographic
`userId` glare tie-break, whether a scheduled rung may run (recovered, paused,
budget spent, socket offline, negotiation in flight), the TURN-less credential
re-fetch, what an observed `iceConnectionState` means, and what a spent
recovery budget should report. Trigger in, decision out: no React, no refs, no
peer connection. The hook still owns every side effect (fetching ICE servers,
creating the offer, arming timers, emitting signaling) and its return shape is
unchanged, so this is a pure refactor — the same rules, in a place where each
is a table-driven unit test (`__tests__/call/iceRestartLadder.test.ts`) rather
than something reachable only by mounting the hook and driving a fake peer
connection. `useCallFlow.test.tsx` passes unmodified.

The structural three-hook split remains deferred for the reason above.

### P1.7: the bound is now pinned, and priced
The JSON document is only defensible *because* the store is bounded — every
read and write serialises the whole file, so the cost is a direct function of
`MAX_MESSAGES_PER_CONVERSATION × MAX_CONVERSATIONS`. `chatDb.test.ts` now
asserts those two constants, so raising them is a deliberate act that fails a
test and forces the SQLite conversation, rather than a one-line drift.

The bound has since been priced, because the symptom of it arriving is **jank
on send**, not an error: a full document (100 conversations × 200 messages,
realistic message shape) serialises to **≈ 7.9 MB**, and `JSON.stringify` of
it costs **≈ 24 ms (p95 25 ms)** on x86 V8. That is the JS thread, blocked, on
a flush — and flushes are debounced at 250 ms, so a burst of sends costs it
once, not once per message. A second `chatDb.test.ts` case pins the document
size, so a schema change that inflates every message fails a test instead of
quietly doubling that number.

Two honest caveats. The figure is a **floor**: it is V8 on a CI x86 box, not
Hermes on a mid-range Android, where the same work runs several times slower —
a hundred-plus millisecond block, or several dropped frames, at the bound. And
it excludes the native `writeFile`, which is off the JS thread. Measuring the
real number needs a device, which this environment does not have; the
extrapolation is recorded here rather than presented as a measurement.

The conclusion is unchanged but no longer a guess: at *today's* volumes (a few
conversations, tens of messages) the document is kilobytes and the write is
sub-millisecond. The cost only becomes visible for a user who is at, or near,
the retention ceiling on every conversation. SQLite stays deferred, and this
is the number that would retire the question.


### P3.4 was already fixed
The finding in `reviews/copilot-master-review.md` is stale. `handleRtcRelay`
already requires `mediaState.heartbeat === true` before stamping liveness, and
`stale-calls.test.ts` already asserts that a plain screen-share frame does not
refresh the deadline. Verified rather than re-implemented.

### P1.5: no `compression` middleware
Deliberately skipped. It would add a runtime dependency to save bandwidth on
JSON payloads that are already small (a chat body is capped at 4000 characters)
for a deployment serving ~10 concurrent users. The other three items in P1.5 —
an explicit body limit, gating the verbose-logging allocation, and a Socket.IO
frame cap — cost nothing and were done. Revisit compression if payload sizes or
the user count change materially.

### P3.3: behaviour is unchanged
The server's heartbeat timeout was the literal `150_000`; it is now derived as
`CALL_HEARTBEAT_INTERVAL_MS * CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE`
(`30_000 * 5`), which is the same number. `heartbeat-timing.test.ts` pins the
values so the move cannot have changed behaviour and the two edges cannot drift
apart again.

### P1.1: what actually changed

The root cause was that `useCallFlow` returns a fresh object on every render and
ticked `elapsedCallSeconds` once a second. That made the `CallProvider` context
identity change every second, which changed the `ChatProvider` context derived
from it, which re-rendered every mounted screen — including an open conversation
and all of its message bubbles — for the entire duration of every call.

The fix inverts the direction of the data: `useCallFlow` now publishes
`callConnectedAtMs`, a value that changes exactly twice per call, and the two or
three components that display a duration derive the seconds locally through
`useCallElapsedSeconds`. The timer no longer crosses a provider boundary at all.

`callTimerRenderIsolation.test.tsx` locks this in. It asserts both halves of the
property — that five seconds of call time advance the banner while leaving the
tab shell's render count untouched, *and* that a genuine state change still
re-renders the shell, so the first assertion cannot silently degrade into
"nothing is being counted".

Note on P1.1c: `React.memo` on the leaf screens is defence in depth rather than
the main win. Because the screens are reached through the `render*` indirection,
the effective guard is that those renderers are now stable, so the route
components do not re-render and the elements are never recreated. The `memo`
wrappers matter for the paths where a parent re-renders for an unrelated reason.

### P1.3: retention is a memory bound, not the history horizon

`GET /calls` used to read history straight out of the in-memory `state.calls`
map rather than out of Postgres, which made the retention window double as the
history horizon: a restart wiped the log, and nothing older than the window was
visible even though every call was already persisted. **That deferral is
resolved.** The endpoint now reads the durable `calls` table (see
`server/src/domain/callHistory.ts`), scoped to the requesting user, ordered by
`updatedAt` descending and paged via `limit`/`offset`; only the first page is
cached, matching how `GET /messages` treats deep pagination. `state.calls`
backs live-call state only, and the in-memory read is kept as a degraded
fallback for deployments without `DATABASE_URL` and for a failed query.

Eviction from the hot map remains deliberately conservative:

- Only calls in a terminal state are ever evicted. A live call is state, not
  history, and stays until the existing timeout sweep closes it.
- The age pass uses `updatedAt`, which is stamped at the moment the call reached
  its terminal state, and defaults to a 24h window.
- A count ceiling (500, oldest-first) catches a burst that lands entirely inside
  one window, so the map is bounded on both axes.
- `state.callEvents` is evicted in step with `state.calls`; otherwise the leak
  just moves from one map to the other.

Both bounds are configurable (`CALL_RETENTION_MS`, `MAX_RETAINED_CALLS`). At the
target of ~10 concurrent users neither will realistically be reached, so this is
a leak fix rather than a behaviour change — and now purely a memory bound, since
evicting a call no longer hides it from its participants.

### P3.1: documented, not re-architected

Given a single instance today, this is a documentation and observability task
rather than the Redis state refactor the original plan sketched as option (b).
Three things now state the constraint instead of leaving it to be rediscovered
from intermittent 401s:

- `README.md` has a "Deployment topology" section explaining that `REDIS_URL`
  shares the Socket.IO adapter and message bus but *not* sessions, calls,
  presence, or connections.
- `/health` reports `stateAffinity: "sticky"`, so a deployment can assert on it.
- The server logs a warning at startup when `REDIS_URL` is set, since that is
  the configuration that implies multi-instance intent.

Moving session and active-call lookups into Redis remains the way to lift the
constraint. It is a contained refactor — all access already goes through
`lib/state.ts` — but it requires making those reads async, which is not worth
doing before a second instance actually exists.

### P3.2: scoped to declarations only

Reformatting used `prettier` on the individual declaration lines rather than on
whole files, so the diff contains no unrelated reformatting. Regression guards
differ by package because their tooling does:

- **Mobile** uses an `eslint` `max-len` rule whose `ignorePattern` inverts the
  usual sense of the rule — every line that is *not* a type or interface
  declaration is exempt. This deliberately avoids imposing a general
  line-length style on the codebase.
- **Server** now runs `eslint` too (`server/eslint.config.js`, wired to
  `npm run lint` and to `backend-ci.yml`). It carries the same `max-len` rule,
  which replaced the `declaration-formatting.test.ts` guard that stood in for a
  linter while the server had none; the rule was verified to fail on a
  deliberately over-wide declaration in both `server/` and `shared/`, so it
  cannot silently pass. The linter earns its dependency with the type-aware
  rules a hand-rolled scan cannot replicate — `no-floating-promises`,
  `no-misused-promises` and `await-thenable`, which is where an un-awaited
  Socket.IO handler otherwise becomes a process-killing unhandled rejection.
