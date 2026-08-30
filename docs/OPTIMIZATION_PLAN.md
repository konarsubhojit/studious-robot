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
| P1.2 | Decompose `useCallFlow` | ✅ the structural hook split is now done. On top of the eleven pure-rule slices already out (the WebRTC stats helpers and stats-poll derivation in `callUx`, the ICE-recovery ladder rules in `call/iceRestartLadder`, the call-lifecycle decisions and `call.state_changed` dispatch and outgoing-call placement in `call/callDecisions`, the session/token rules in `call/sessionLifecycle`, push rehydration plus the media-state frame in `call/pushRehydration`, the answer path and queued-answer replay in `call/answerPath`, and the audio-route rules in `call/audioRouteRules`), the two remaining ref-coupled orchestration clusters are now their own concern-hooks: `useCallHeartbeat` (the in-call liveness beat + wake sources) and `useCallRecovery` (the recovery episode, the ICE-restart ladder and the proactive network-change restart, with its forward-refs). The public return contract is unchanged and `useCallFlow.test.tsx` passes unmodified; the new hooks have focused tests (`__tests__/hooks/useCallHeartbeat.test.tsx`, `__tests__/hooks/useCallRecovery.test.tsx`). **Device QA is still pending** (per instruction) — the recovery/audio-session behaviour only manifests on a device; see the checklist in the P1.2 note below |
| P1.7 | Swap `chatDb` JSON document for SQLite | ⏸️ still deferred, but the bound that justifies the deferral is now pinned by a test *and* priced: ≈ 7.9 MB and ≈ 24 ms of `JSON.stringify` per flush at the ceiling (see the note below) |

### Still deferred

| ID | Task | Reason |
| -- | ---- | ------ |
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
| C6 | Honest audio-only calls | ✅ camera state is now relayed over the existing `call.media-state` frame, so `mainHasVideo` asks whether there is a *picture* rather than whether there is a *track*, and `call-stage-ambient` is reachable. See the note below — this is deliberately not the `getUserMedia` change the original entry sketched |
| — | First-run empty states point somewhere | ✅ the empty chat and call lists now offer a low-emphasis "Search for people" link. Deliberately *not* an `actionLabel`: a second filled button in the screen's accent, a couple of hundred pixels from the FAB, makes whichever the user reaches for the wrong one. The "no results" / "we could not check" distinction from P2.4 is untouched |

### Chat & calling UX pass — deferred

| ID | Task | Reason |
| -- | ---- | ------ |
| A1 | Split `CallProvider` into call-state / media-controls / recovery contexts | Real win, but it changes the consumer set of every call screen and is the natural first half of E1. Wants its own PR with render-count assertions, not a rider on this one |
| B2 | Message editing | Protocol change (`message.edit` / `message.edited`, `editedAt`, a server-enforced edit window). Should land together with D3 behind one schema-compatibility test |
| B5 | Presence freshness / last seen | Needs a server-side `lastSeenAt` and a socket presence subscription for the open conversation |
| C3 | Recovery endgame (escalation + "Call back" card) | Device QA required: the behaviour only manifests during a real ICE failure |
| C5 | Ringback tone for the caller | Device QA required; audio-session behaviour cannot be verified in this environment |
| D2–D5 | Voice-message polish, link previews, group calls, group chat | Each is its own epic; D4/D5 in particular are explicitly out of scope for a UX pass |
| E1–E3 | `useCallFlow` decomposition, SQLite, i18n | E1 (`useCallFlow` decomposition) is now done — see P1.2 above, device QA pending; SQLite/i18n tracked as P1.7 / below; i18n should precede any further copy growth |

## Notes and deviations

### C6: the ambient canvas was gated on the wrong question
The canvas was built, tokenised and unit-tested for a state no call this app
could place would ever produce. `mainHasVideo` asked `getVideoTracks().length >
0`, and turning a camera off does not remove a track — `setTrackEnabled` sets
`track.enabled = false`, and a disabled sender keeps transmitting black frames.
So the receiver counted a track, claimed a picture, and drew a black rectangle.
The tests pinned the derivation and never the premise, which is why nothing went
red: every one of them supplied the stream directly.

The fix relays the camera flag rather than changing the negotiated media.
`enabled` is a purely local flag the peer cannot observe, so each side now sends
`isVideoEnabled` alongside `isScreenSharing` in the existing `call.media-state`
frame, and `deriveCallStreams` takes `localVideoEnabled` / `remoteVideoEnabled`
and answers "is there a picture" as *track ∧ camera on*.

Three things about the shape of it:

- **Both flags travel in one frame**, not two relays, so a peer can never apply
  half an update. The receiving handler tests for each key independently
  (`'isVideoEnabled' in mediaState`) for the same reason the screen-share flag
  always did: a liveness heartbeat carries neither, and silence about a flag is
  not a claim about it.
- **The default is `true` on both ends.** A peer running an older build never
  sends the flag, and is therefore treated exactly as it was before — this is a
  strictly additive protocol change, and there is a regression test for the
  silent peer.
- **The self-view tile follows the same rule.** `pipHasVideo` gates the PiP, so
  turning your own camera off removes the tile instead of leaving a black square
  that follows you around the screen.

This is deliberately *not* the `getUserMedia` change the original deferral
sketched. Negotiating a genuinely audio-only call is a larger, device-QA-shaped
piece of work; making the UI stop lying about what is on the wire is not, and it
is the half that was actually broken. An "audio call" is still a video call with
the camera off — but it now says so, and both ends render the ambient canvas.
`§3.1` of the UX plan is updated accordingly: it was a script for confirming a
gap, and is now a script for confirming a fix.

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

### P1.2: the slices, then the split
The honest status at the time of that pass was partial. What came out is the
WebRTC stats handling —
`collectCallStats` and `summarizeCandidatePair`, now in `callUx` beside the
`getConnectionQuality` they feed. That was the largest remaining block of
genuinely pure logic in the hook, and it was previously reachable only by
mounting the hook and driving a fake peer connection, which is why its
relay-side matrix and protocol fallbacks had no direct tests.

Extracting it also surfaced that `useCallFlow.test.tsx` replaced the whole
`callUx` module with a single stub, so any new export from that module would
silently be `undefined` there. It now spreads the real module and stubs only
`getConnectionQuality`.

What was left in `useCallFlow` after this slice was call lifecycle, WebRTC
negotiation and ICE recovery, all coordinated through shared refs. The recovery
and liveness parts of that have since been lifted into their own hooks
(`useCallRecovery`, `useCallHeartbeat`) — see the completion note at the end of
this section; device QA of the call path remains the outstanding gate.

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

**Third slice: the call-lifecycle decisions** (Phase 5, #216).
`call/callDecisions.ts` now owns the rules that were inline in the hook and
therefore only reachable by mounting it: which statuses mean a call is live (so
a failed accept never tears down the call the user just picked up) or terminal
(so a call that stops ringing takes its OS notification with it), whether an
inbound `rtc.offer` is stale or glare, duplicate-accept suppression and the
bounded answered-call history, the replayed-answer guard's bound, delivery
classification (`ringing` vs `push`, defaulting to `ringing` for a server that
does not say), terminal ICE-state classification for the queued-report drop,
and the end-of-call derivation — duration, the `media_failed` override, which
calls are worth summarising, the summary itself and what counts as missed.

**Fourth slice: the session and token lifecycle.** `call/sessionLifecycle.ts`
owns the rotation interval and when the timer is worth arming, the re-mint
budget (three attempts mid-call, one when idle), and the post-reconnect
reconciliation of `call.state.report`: how the ack is read and what it proves.
The sharp rule is that `null` is not `[]` — an ack that says nothing about the
server's calls is "no answer", and reading it as "the server holds nothing"
tears down healthy calls against an older server. That distinction now has a
test of its own rather than living in a comment beside a socket callback.

**Fifth slice: the `call.state_changed` dispatch.** This is the takeable half
of the issue's "signaling event handling": the handler was a decision table
written as a `switch` with an act of negotiation embedded in one of its arms.
`call/callDecisions.ts` now also owns which callId this device considers its
own, whether a transition belongs to some other call (a stale ring that ends
while a call is up must not touch the call in progress), the terminal-status →
message/severity/`endReason` table — including that an `ended` whose reason is
`cancelled` is a cancellation, not a call that happened — and the `busy`
self-heal condition, where the call the rejection is *about* does not count as
one this device holds. The negotiation the `accepted` transition triggers moved
to a named `sendInitialOffer` beside the handler rather than into the pure
module: it is `createOffer` / `setLocalDescription` against a live peer
connection, which is exactly what does not belong there.

**Sixth slice: the stats-poll derivation.** `pollStats` was the file's worst
complexity entry (#4, 35) and computed everything inline: kbps from a pair of
`bytesReceived` samples, the packet-loss ratio, the identity of the selected
candidate pair, whether a relay-only policy was actually being honoured, and
when a poor-connection warning is worth showing. Those five are now in
`callUx.ts` beside `collectCallStats` and `getConnectionQuality`, which is
where the first slice went and the one place stats vocabulary can live without
pulling in a native module. The effectful half — remembering which pair was
last reported, so the same pair is not logged twice — became a named
`noteSelectedCandidatePair` in the hook.

**Seventh slice: push rehydration and the relayed media-state frame.**
`call/pushRehydration.ts` owns what an app opened from a notification decides
before it can act: whether it must wait for an identity (deferring is not a
failure — the callId is held and retried, and is reported apart from a call
that is genuinely gone), where to ask about the call, that a `404` is an answer
and not a fault, and whether the returned status is still answerable — with the
terminal-message table phrased as the timeline phrases it and a fallback so a
status from a newer server never leaves a blank line. It also owns
`readMediaStateFrame`, which keeps the C6 additive contract explicit: each key
is read independently with `in`, silence about a flag is not a claim about it,
and a liveness heartbeat therefore never clears the "they are presenting"
banner or the peer's picture. One hardening detail came with the move: the
message table is now looked up with `Object.hasOwn`, so a status of
`constructor` returns the generic message instead of a function off
`Object.prototype`. The callId escaping was preserved, not introduced — the
hook already encoded it at all three call sites, and those builders have since
been collected into `call/callEndpoints.ts` so that rule is written once.

**Eighth, ninth, tenth and eleventh slices: the answer path, the queued
answer, outgoing placement, and audio routing.** `call/answerPath.ts` owns what
answering decides when nothing else is reliable — how long a cold start waits
for a socket and how many times it retries over one, why the answer is going
over HTTP and what to say while it does (a socket that answered and failed
reads differently from one that never connected, and the fallback is never
silent), which HTTP failure is "nothing to answer with" versus "the answer was
refused" — the two are different bugs and the push receipt is the only place
either is visible — and what a call that connected without local media should
report and say. It also owns `decideQueuedAnswerReplay`: whether an answer
queued before this hook knew the call must survive (a deferred rehydration will
drain it), has been overtaken, was for a notification that outlived its call, or
must be dropped loudly. The queue itself stays in `callKeep.js`, where there is
deliberately exactly one of them.

`call/callDecisions.ts` gained `resolveOutgoingCallee`: a tapped contact beats
whatever is stale in the dial field, a blank or non-string explicit id is no
signal and falls back to the field, and both refusals are ordinary user
mistakes with their own messages rather than faults.

`call/audioRouteRules.ts` owns the four rules that were inline in the hook's
audio effects and reachable only by replaying a native device-change event:
that "speaker on join" upgrades the earpiece but never steals a call away from
a headset, that only a *detachable* route can be lost — an incomplete device
list is not an unplug — and that the loss is announced rather than silently
handed over, how a chosen route is named, and that a selection which reports no
devices has discovered nothing rather than an empty world, so the output picker
never empties itself between two successful switches. It imports the route
vocabulary from `audioRouting` rather than redeclaring it, and decides only:
every `chooseAudioRoute` stayed where it was.

Every slice is pure — no React, no refs, no peer connection, no socket — the
hook's return shape is unchanged, and `useCallFlow.test.tsx` passes unmodified,
as it did for the ladder. All three of the file's complexity-baseline entries
are now cleared — `endActiveCall` (#21, 19), the `call.state_changed` handler
(#22, 19) and `pollStats` (#4, 35) — and `useCallFlow.ts` lints with zero
warnings.

**What was deliberately left in the hook, and why.** #216 listed four target
areas. The first three came out. The fourth — WebRTC negotiation — did not, and
this is the documented "this cannot be separated because X" the issue asks for
in preference to pushing through.

The negotiation path is `setRemoteDescription` / `createAnswer` /
`setLocalDescription` / `addTrack` against a live `RTCPeerConnection`, sequenced
by refs that exist precisely to serialise it: `peerConnectionRef`,
`isNegotiatingRef` and `iceCandidateBufferRef`. There is no *decision* left in
it to extract. Every rule those effects consult has already come out — whether
an inbound offer is stale or glare (`decideIncomingOffer`), what an observed
`iceConnectionState` means and which rung of the ladder may run
(`call/iceRestartLadder`), what a terminal ICE state implies
(`isTerminalIceState`) — and what remains is the ordering of native calls.
Moving that into a module would relocate side effects, not separate decisions
from them: the module would need the peer connection, which is exactly the
thing these modules are defined by not having, and `useCallFlow.test.tsx` would
have to change to follow it. The same applies to the residual socket handlers,
which close over the refs they mutate.

That is the boundary the extraction pattern has held at for eleven slices, and
it is the reason `useCallFlow.test.tsx` has never needed to change. Where a
decision *was* separable from the effect it sits beside — the offer's
stale-vs-glare guard, the state-change dispatch, the answer's transport
fallback — it came out.

The structural split is now done. What the eleven pure-rule slices left behind
was coordinated side effects sequenced through shared refs — but two of those
clusters were cohesive enough to lift out whole, carrying their refs with them
rather than leaving a decision behind:

- **`useCallHeartbeat`** owns the in-call liveness beat: the `heartbeatRef`
  interval, the `wakeCallHeartbeatRef` catch-up used by every wake source
  (socket ping, peer relay, `AppState`, socket reconnect), and the `AppState`
  listener. `useCallFlow` calls `startCallHeartbeat`/`stopCallHeartbeat` from the
  call lifecycle and nudges it through the stable `wakeCallHeartbeat` wrapper.
- **`useCallRecovery`** owns the recovery machinery: the pausable
  `recoveryEpisode` budget and its deadline timer, the backed-off ICE-restart
  ladder (schedule/run/cancel plus the `scheduleIceRestartRef` /
  `beginIceRecoveryRef` / `cancelIceRestartsRef` forward-refs the socket and ICE
  handlers reach it through), the TURN-less credential re-fetch, and the
  proactive network-change restart. The pure decisions it runs on stay in
  `call/recoveryEpisode` and `call/iceRestartLadder`; the hook is only the side
  effects and the refs that serialise them.

Both keep `react-native-webrtc` at arm's length exactly as the rule modules do —
they touch the peer connection only through the refs `useCallFlow` passes in, so
the pure slices remain independent of the native WebRTC surface. The hook's
public return contract is unchanged, `useCallFlow.test.tsx` passes unmodified,
and each new hook has a focused test
(`__tests__/hooks/useCallHeartbeat.test.tsx`,
`__tests__/hooks/useCallRecovery.test.tsx`).

What deliberately stayed in `useCallFlow` is the orchestrator layer itself — the
`connectSocket` handlers and the WebRTC negotiation sequence — because, as the
paragraphs above set out, there is no *decision* left in them to separate: they
are the ordering of native calls against `peerConnectionRef` /
`isNegotiatingRef` / `iceCandidateBufferRef`, and a module for them would have to
carry the peer connection, which is the one thing these modules are defined by
not having.

**Device QA — outstanding.** CI cannot verify any of this: there is no E2E
coverage of the call path (#114), so a regression here is caught by a person on
a device or not at all. The following has to be run against this branch before
it merges, and its result recorded on the PR:

- [ ] Outgoing call: connect, mute, speaker/earpiece, camera switch, end.
- [ ] Incoming call: ring, accept, and separately decline.
- [ ] Answer from the CallKeep system UI, including from a cold start via push.
- [ ] A mid-call network drop that recovers, and one that does not — verifying
      the reconnect banner's attempt progression and the "Connection lost"
      endgame.
- [ ] Call from an offline callee's perspective — the push wake path.
- [ ] Screen share start/stop, and PiP enter/exit.

The last two items on that list exercise `call/audioRouteRules` and
`call/answerPath` most directly: the audio hand-over when a headset is pulled
mid-call, and an answer tapped in the system UI before the app knows the call.

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
The finding that raised it (in a review report since deleted — see the review
ledger below) was stale. `handleRtcRelay` already requires
`mediaState.heartbeat === true` before stamping liveness, and
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

## Review ledger

The `reviews/` directory held six "grumpy code review" reports, one per branch.
Each carried its own resolution status, and every Critical, High, Medium and Low
finding across all six was already marked fixed in the report that raised it.
What was left was the residue: findings graded Nit, findings explicitly deferred,
and observations filed under "out of scope (pre-existing, not graded)" — the
category that outlives the branch that noticed it and therefore has nowhere to
live once the report is deleted.

That residue is closed or recorded below, and the directory is deleted. A review
report is a per-branch artefact; keeping six of them in the tree turns a merged
branch's transient state into permanent documentation that slowly diverges from
the code. Anything from them that is still true belongs in this plan or in
`mobile/docs/UX_REDESIGN_PLAN.md`, which is where it now is.

| Report | What was still open | Disposition |
| ------ | ------------------- | ----------- |
| `add-eslint-typescript-eslint-server` | **Nit**: the Socket.IO teardown was copy-pasted into ~25 suites; a `closeTestServer()` helper would collapse them | **Fixed.** `server/test/helpers.ts` exports `closeTestServer`, and all 25 suites call it. Its docstring states why the order (drop keep-alives → close Socket.IO → close HTTP) is not arbitrary: get it wrong and a suite hangs rather than fails |
| `add-eslint-typescript-eslint-server` | **Out of scope**: `mobile-ci.yml` never ran `npm run lint`, so only the server's linter gated CI | **Fixed.** `mobile-ci.yml` runs `npm run lint` between typecheck and tests. The mobile package was already clean, so this only closes the gap between "we have a linter" and "the linter can fail a build" |
| `better-ux-theming-options` | **Nit**: `confirm` in `SettingsScreen` was not a `useCallback` while `dismissToast` was | **Already fixed** on the branch; verified rather than re-done |
| `copilot-fix-reconnect-banner-state` | **Nit, deferred**: `RingingAvatar`'s 36 dp initials sit in a fixed 100 dp disc with no `maxFontSizeMultiplier`, so they clip at large accessibility text sizes | **Fixed.** Capped at `fontScaleCaps.badge`, which is the token for exactly this shape — a glyph inside fixed geometry. Pinned in `accessibility.test.tsx` alongside the other 17 caps |
| `fix-ringing-issue-on-caller-side` | **Out of scope**: `chooseAudioRoute` performs its Bluetooth permission check *outside* its `try`, which is why a Medium finding on that branch had to be closed with a `.catch()` at the call site rather than at the cause | **Fixed at the cause.** The permission check is now inside a `try` and a throw degrades exactly as a denial does, so the module keeps its "never throw, log and degrade" contract. The call-site `.catch()` stays as defence in depth. Two tests cover it, including one asserting `restoreInCallAudioSession` resolves |
| `fix-ringing-issue-on-caller-side` | **Nit**: the three ringer-mode strings are declared on both sides of the native bridge | **Recorded, not changed.** Both sides carry a comment pointing at the other, which is the best available without a codegen step |
| `fix-ringing-issue-on-caller-side` | **Out of scope**: `stopIncomingRingtone()` tears down the whole audio session rather than just the ringtone | **Recorded here.** Harmless in today's flows — it always runs before the in-call session starts — but it would bite a call-waiting feature, and that is the change that should fix it |
| `log-sql-mongo-db-query-times` | **Nit**: `dbQueries` sits outside `counters`/`histograms`/`derived` in the telemetry snapshot | **Recorded, not changed.** It is a sorted table rather than a keyed map; already documented in the type |
| `log-sql-mongo-db-query-times` | **Out of scope**: `persistence.ts` swallows DB errors on most write paths but rethrows on `persistUser`; `MessageStore`'s `any` typing leaves the Mongo call sites unchecked | **Half fixed.** The Mongo call sites are now typed: `messageStore/types.ts` describes the collection/cursor/client surface the store actually uses, so a misspelled operator or an unpopulated result field is a compile error. The injected client is asserted once, at the connector, because neither the driver's generic `Collection` nor a test double can be checked at that boundary. `persistence.ts`'s deliberate asymmetry is unchanged and still recorded here |
| `copilot-implementation-plan-ui-architecture-performance` | **Two Nits**, both reviewed and knowingly left: `resolveMediaGesture` is dual-natured (exported pure helper *and* worklet), and `useThemedStyles`' cache requires module-level factories | **Recorded here**, because both are invariants rather than defects: adding a non-worklet-safe call to the first reintroduces a device-only crash, and defining a style factory inside a component silently defeats the second |
| All six | Mobile Jest reports leaked handles and needs `--forceExit`; the server suite reports one skipped test without a CI Postgres service | **Recorded in the UX plan's §0 command table**, which now names `--forceExit` rather than describing the warning as benign |
