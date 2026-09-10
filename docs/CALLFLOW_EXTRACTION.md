# `useCallFlow` extraction — checkpoint-resumable timeline

Working document for the extraction of the **effectful** half of
`mobile/src/hooks/useCallFlow.ts` into focused hooks. It is the successor to the
Phase 5 architecture work tracked in #216, which took the _pure decision logic_
out and deliberately left every side effect behind.

This document exists because the work spans many sessions and many PRs, and
because any one of them can be interrupted. Each checkpoint below is written so
that a reader who has _only this file_ and a clean checkout can determine what
has already landed, what is safe to start, and how to verify the state they
found the tree in. Nothing here depends on a previous session's memory.

> **Naming.** `docs/OPTIMIZATION_PLAN.md` already uses "Phase 6" for the chat &
> calling UX pass and "Phase 7" for the target-architecture rebuild. The issue
> tree calls this work "Phase 6" because it succeeds #216's "Phase 5". To avoid
> two Phase 6s, this document refers to the work by name — _the `useCallFlow`
> extraction_ — and to its units as **checkpoints**, not phases.

---

## 1. Where the problem comes from

`useCallFlow` is the single hook behind every call: signaling, peer connection,
media, CallKeep, recovery, screen share, statistics and teardown. Phase 5 was
scoped by one rule — _rules come out; side effects stay_ — and delivered seven
pure modules under `mobile/src/call/`:

| Module                | What it decides                                                |
| --------------------- | -------------------------------------------------------------- |
| `callDecisions.ts`    | Whether a given signaling frame should act on the current call |
| `answerPath.ts`       | The ordering and preconditions of the answer sequence          |
| `sessionLifecycle.ts` | When a session must be created, refreshed or abandoned         |
| `pushRehydration.ts`  | What a cold-start push payload means for call state            |
| `audioRouteRules.ts`  | Which output to prefer, and when a manual pick is void         |
| `iceRestartLadder.ts` | The ICE-restart escalation schedule                            |
| `recoveryEpisode.ts`  | When a recovery episode opens, extends and closes              |

Two further modules, `callStateMachine.ts` and `callEndpoints.ts`, predate that
work but are crossed by several checkpoints below and are listed here so they
are not mistaken for new surface.

Since that baseline, the cohesive liveness and recovery side-effect clusters
also moved out into `useCallHeartbeat` and `useCallRecovery`, and screen-share
orchestration already lives in `useScreenShare`. What remains in this document
is the next, narrower extraction pass: moving the remaining effectful clusters
out of the composition root one checkpoint at a time.

Measured on `master` at `45c42ad`:

| Artefact                                      | Size            |
| --------------------------------------------- | --------------- |
| `mobile/src/hooks/useCallFlow.ts`             | **4,221 lines** |
| `mobile/__tests__/hooks/useCallFlow.test.tsx` | **5,800 lines** |

Current handoff, 2026-09-10: CP1 through CP5 have landed. `useCallFlow.ts`
is now **2,909 lines** in this checkout. The extracted effect hooks present now
are `useScreenShare`, `useCallHeartbeat`, `useCallRecovery`,
`useCallAudioRouting`, `useConnectionQuality`, `usePeerConnection`,
`useLocalMedia` and `useSignalingSocket`, with focused tests for the latter
seven. Per the scaffold-first follow-up request, the CP6 file also exists
(`useAnswerPath`) but is intentionally **not wired** yet. The next safe wiring
checkpoint is **CP6 — `useAnswerPath`**. A server-side call pickup blocker found
in the production logs on 2026-09-10 was fixed separately by refreshing stale
local call caches from shared call state before RTC/cancel handling; it does not
change this extraction order.

The pattern to follow already exists in the same directory: `useCallRecovery`,
`useScreenShare` and `useCallHeartbeat` are all effectful hooks that own their
refs, expose a narrow interface, and are composed by `useCallFlow`. The goal is
for `useCallFlow` to become a composition root rather than an implementation.

---

## 2. The one fact that governs sequencing

**Every checkpoint edits `mobile/src/hooks/useCallFlow.ts`.**

Two sessions working concurrently will conflict, and the conflicts land in a
4,000-line file whose call path has no E2E coverage (#114 is open). Therefore:

> **Rule: one checkpoint in flight at a time. Wait for _merge_, not PR-open,
> before starting the next.**

Genuinely parallel work is anything that does _not_ touch that file:

- splitting `useCallFlow.test.tsx` into per-hook test files, after a checkpoint lands;
- updating this document or `docs/OPTIMIZATION_PLAN.md`;
- device QA for the _previously merged_ checkpoint.

A workable rhythm is to run checkpoint _N_'s device QA in parallel with
checkpoint _N+1_'s implementation.

CP3, CP5 and CP6 must **never** be batched together. They touch overlapping refs
— `peerConnectionRef`, `socketRef`, `signalingRef`, `activeCallIdRef` — and each
is individually large.

---

## 3. Invariants — must hold after every checkpoint

Violating any of these is a regression even when the suite is green.

**Carried forward from #216**

- One checkpoint per PR, each with its own review and device QA pass.
- `useCallFlow.test.tsx` passes **unmodified** after each checkpoint.
- The hook's public return shape is unchanged.
- Exactly **one** pending-answer queue exists, in `callKeep.js`. Do not add a second.
- `callConnectedAtMs` changes exactly twice per call; `callTimerRenderIsolation.test.tsx` guards this.
- The `call.media-state` contract stays additive: each key is read independently and both flags default to `true` for older peers.
- No checkpoint may duplicate or bypass `call/iceRestartLadder.ts`.

**Added by the six PRs merged against #345**

| Invariant                                                                                                        | Source |
| ---------------------------------------------------------------------------------------------------------------- | ------ |
| The memoized `callFlowState` / `callFlowActions` split — never reintroduce an unmemoized return                  | #353   |
| `areConnectionQualitiesEqual` preserves object identity on `setConnectionQuality`                                | #353   |
| `prefetchIceServersForCall` warms at socket connect _and_ at push rehydration                                    | #354   |
| `remoteStreamRef`, `mergedScreenAudioTrackIdsRef` and `mergedScreenAudioTrackRefsRef` are always reset together  | #355   |
| `connectSocketHandlersRef` ref-forwarding keeps `connectSocket` dependent only on `signalingUrl`                 | #356   |
| `publishAudioDevices` identity preservation, the media-state relay debounce, and the bounded answered-call `Set` | #358   |

---

## 4. Standard verification

Run from `mobile/`. `node_modules` in a fresh checkout is incomplete, so install
first.

```bash
cd mobile
npm install                    # required; @types are otherwise missing
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint . — must run from mobile/, legacy .eslintrc.js
npx jest --ci --forceExit      # the suite leaks handles and hangs without --forceExit
```

For a single suite while iterating:

```bash
npx jest --ci --forceExit --runInBand __tests__/hooks/useCallFlow.test.tsx
```

A checkpoint is **verified** when typecheck, lint and the full suite pass with
`useCallFlow.test.tsx` unmodified, and the device QA list in §6 is recorded.

---

## 5. Checkpoint timeline

Line numbers are as of `45c42ad` and will drift as checkpoints land. Each
checkpoint therefore also names the section banner it lives under
(`// ─── … ───`), which survives renumbering; navigate by banner, then confirm.

Status legend: ⬜ not started · 🚧 in flight · ✅ merged · ⏸️ documented "no".

### CP0 — Baseline (recorded, no code change) ✅

Establishes the numbers every later checkpoint is measured against. Already
captured in §1 of this document: 4,221 lines of hook, 5,800 lines of test, at
`45c42ad`.

**Resume check:** none. This checkpoint is this document.

---

### CP1 — `useCallAudioRouting` ✅ · size S · risk Low

**Extracts.** The `// ─── Audio session & device routing ───` block
(≈3821–3920): the `startAudioSession` / `stopAudioSession` lifecycle effect,
`applyAutomaticAudioRoute`, the `subscribeAudioDevices` effect including the
`describeDetachedManualRoute` hand-over, and the speaker-route effect. Plus
`chooseAudioOutput` (≈3559–3586) from `// ─── Media controls ───`.

**Owns.** `manualAudioRouteRef`, `isSpeakerEnabled`, and the `publishAudioDevices`
call sites.

**Interface.** Takes `isInCall`, `speakerEnabledByDefault`, `publishAudioDevices`
and `updateStatus`; returns `isSpeakerEnabled` and `chooseAudioOutput`.

**Recommended scope change.** `handleMuteToggle` (≈3440–3470) reaches into this
checkpoint's territory via `restoreInCallAudioSession(selectedAudioRouteRef.current)`
— it restores the in-call audio session because unmuting can drop the device out
of in-call mode and lose the echo canceller. Move `handleMuteToggle` into **CP1**
rather than leaving it for CP4. It is audio-session code wearing a media-control
label, and moving it removes one of the two known cross-checkpoint couplings
outright instead of documenting it. If it is left behind instead, `selectedAudioRouteRef`
must be part of the returned interface, and that must be stated in the PR.

**Why first.** Small, self-contained, and it proves the seam.

**Entry precondition.** `master` at or after `45c42ad`.
**Exit state.** `mobile/src/hooks/useCallAudioRouting.ts` exists with direct tests
that do not mount `useCallFlow`; `useCallFlow.ts` shrinks by ≈130 lines.
**Resume check.** `ls mobile/src/hooks/useCallAudioRouting.ts` — if present and the
suite is green, CP1 is done; start CP2.
**Rollback.** Revert the single PR; nothing else depends on it.

**Landed in this session.** `useCallAudioRouting` owns the audio session
start/stop effect, automatic route selection, native device subscription,
speaker-route reassertion, manual `chooseAudioOutput`, the audio-device snapshot
and `handleMuteToggle`'s unmute session restore. Focused coverage:
`mobile/__tests__/hooks/useCallAudioRouting.test.tsx`. Verified with mobile
typecheck, lint, the CP1 hook test and `useCallFlow.test.tsx`.

---

### CP2 — `useConnectionQuality` ✅ · size S · risk Low

**Extracts.** The whole `// ─── Connection quality polling ───` block
(≈3655–3817): `noteSelectedCandidatePair` and the `getStats` polling effect,
including its `AppState` foreground gating, the interval start/stop pair and the
cancellation flag.

**Owns.** `selectedCandidatePairRef`, `qualitySmootherRef`, `connectionStatsRef`,
`connectionQuality` and `selectedCandidatePair`.

**Interface.** Takes `isInCall`, `peerConnectionRef`, `remoteStreamRef`,
`activeIceTransportPolicy` and `updateStatus`; returns `connectionQuality` and
`selectedCandidatePair`.

**Care.** #353's identity preservation lives here: `setConnectionQuality` must keep
returning `current` when `areConnectionQualitiesEqual` is true, both in the
polling path and in the `!isInCall` reset. This is the checkpoint most likely to
regress a render-count test while the suite still passes functionally — check
`callTimerRenderIsolation.test.tsx` and the render-count assertions in
`callContextIsolation.test.tsx` explicitly.

**Entry precondition.** CP1 merged.
**Exit state.** `mobile/src/hooks/useConnectionQuality.ts` with direct tests.
**Resume check.** `ls mobile/src/hooks/useConnectionQuality.ts`.
**Rollback.** Revert the single PR.

**Landed in this session.** `useConnectionQuality` owns the foreground-gated
stats polling effect, the selected-candidate-pair dedupe key, quality smoothing,
bitrate differencing state and the no-link reset. It preserves the
`areConnectionQualitiesEqual` identity rule for unchanged samples and resets.
Focused coverage: `mobile/__tests__/hooks/useConnectionQuality.test.tsx`.
Verified with mobile typecheck, lint, the CP2 hook test and `useCallFlow.test.tsx`.

---

### CP3 — `usePeerConnection` ✅ · size L · risk High

**Extracts.** `closePeerConnection` and `createPeerConnection` (≈1122–1312) plus
`renegotiate` (≈895–925).

**Owns.** `peerConnectionRef`, the ICE-candidate and track handlers
(`PeerIceCandidateEvent` / `PeerTrackEvent`), and the three merge-tracking refs
`remoteStreamRef` / `mergedScreenAudioTrackIdsRef` / `mergedScreenAudioTrackRefsRef`.

**Care.**

- The three merge-tracking refs are reset _together_ (#355). Keeping them in one
  hook is the point of taking this checkpoint before CP4.
- `prefetchIceServersForCall` warming (#354) must survive.
- The hook must call into `call/iceRestartLadder.ts`, never reimplement it.

**Ordering.** Must precede CP4 so that `handleCameraSwitch` has a peer-connection
boundary — `replaceTrack` on the video sender — to call into rather than reaching
through `peerConnectionRef` directly.

**Entry precondition.** CP2 merged.
**Resume check.** `ls mobile/src/hooks/usePeerConnection.ts`.
**Rollback.** Revert; CP4 must not be wired until this is stable.

**Landed in this session.** `usePeerConnection` now owns `peerConnectionRef`,
`pendingPeerConnectionRef`, `remoteStreamRef`, `iceCandidateBufferRef`,
`isNegotiatingRef`, peer construction with TURN-aware ICE servers, candidate
emission, remote track handling, screen-audio-only stream merging,
renegotiation and close/teardown. `useCallFlow` keeps the recovery/screen-share
composition by passing ref-backed callbacks into the hook. Focused coverage:
`mobile/__tests__/hooks/usePeerConnection.test.tsx`. Verified with mobile
typecheck and the CP3 hook plus `useCallFlow.test.tsx` targeted Jest run.

---

### CP4 — `useLocalMedia` ✅ · size M · risk Medium

**Extracts.** `startLocalPreview` and `releaseLocalMedia` from
`// ─── Local media ───` (≈1316–1349, with `releaseLocalMedia` at ≈1107), and
from `// ─── Media controls ───` the `handleVideoToggle` and `handleCameraSwitch`
handlers (≈3492–3545). If CP1 took `handleMuteToggle` as recommended, this
checkpoint starts at `handleVideoToggle`.

**Owns.** `localStreamRef`, `localStream`, `isVideoEnabled`, `isFrontCamera`.

**Care.** `handleCameraSwitch` has two paths: the in-place `_switchCamera()` fast
path, and the fallback that acquires a new stream and calls `replaceTrack` on the
peer connection's video sender. The fallback is the coupling to CP3 — route it
through the CP3 interface, not through `peerConnectionRef`.

`handleMuteToggleRef` and `handleEndCallRef` exist because the Picture-in-Picture
hook wires its controls before these handlers are defined. Whatever moves must
keep those refs current.

**Entry precondition.** CP3 merged.
**Resume check.** `ls mobile/src/hooks/useLocalMedia.ts` and confirm
`useCallFlow` imports and composes it.

**Landed in this session.** `useLocalMedia` now owns `localStreamRef`,
`localStream`, `isVideoEnabled`, `isFrontCamera`, `startLocalPreview`,
`releaseLocalMedia`, `handleVideoToggle` and `handleCameraSwitch`. Camera-switch
fallback calls through the CP3 `replaceOutgoingVideoTrack` boundary rather than
reading `peerConnectionRef` directly. Focused coverage:
`mobile/__tests__/hooks/useLocalMedia.test.tsx`.

---

### CP5 — `useSignalingSocket` ✅ · size XL · risk High

**Extracts.** The `// ─── Socket connection ───` block (≈1624–2284).

**This is smaller than it looks.** #356 did more than stabilize `connectSocket`'s
dependencies: it introduced `connectSocketHandlersRef` (≈1739), a ref bag holding
**twenty** handlers — `consumeForeignDeviceCallEvent`, `createOrGetSession`,
`disconnectSocket`, `sendInitialOffer`, `updateStatus`, `showIncomingCallUi`, the
six message/typing handlers, `handleSocketConnected`, `handleSocketDisconnected`,
`recordConnectSuccess`, `recordConnectError`, `fetchConversations`, `fetchBlocks`
and `wakeCallHeartbeat` — with a dependency array of literally `[signalingUrl]`
behind an eslint-disable.

That ref bag _is_ the extracted hook's interface, already designed. The work is
closer to moving a block than to untangling one: the twenty handlers become the
hook's parameter object, and the ref-forwarding pattern moves with it. Do not
collapse the ref bag into direct dependencies — that reintroduces the reconnect
storm #356 fixed.

**Entry precondition.** CP4 merged.
**Resume check.** `ls mobile/src/hooks/useSignalingSocket.ts` and confirm
`connectSocket`'s dependency array is still `[signalingUrl]`.

**Landed in this session.** `useSignalingSocket` now owns socket disconnect,
authenticated socket creation, manager ping/reconnect-failed listeners, the
ref-forwarded socket handler bag, call/RTC/message/media-state transport
listeners, reconnect queue flushing and session-invalid re-mint handling.
Focused coverage: `mobile/__tests__/hooks/useSignalingSocket.test.tsx`.

---

### CP6 — `useAnswerPath` 🚧 scaffolded · size L · risk High

**Extracts.** `// ─── Accept incoming call ───` (≈2834–3183) and the adjacent
`// ─── Decline incoming call ───` and `// ─── CallKeep: bridge OS answer/end
buttons ───` blocks as far as ≈3425.

**Care.** The pending-answer queue stays in `callKeep.js` — exactly one, still. The
cold-start push path and the system-UI answer path must both continue to funnel
through `call/answerPath.ts`; this checkpoint moves the effects around those
decisions, it does not re-decide them.

**Entry precondition.** CP5 merged.
**Resume check.** `ls mobile/src/hooks/useAnswerPath.ts`; if the hook only
returns `{}`, CP6 still needs wiring.

**Scaffold status.** `mobile/src/hooks/useAnswerPath.ts` exists only as an
unwired placeholder.

---

### CP7 — Teardown (investigation, not a commitment) ⬜

**Subject.** `endActiveCall` (≈1420–1543) under `// ─── Call teardown ───`.

**The case against extracting it is strong, and a documented "no" is a valid
outcome.** Measured on `45c42ad`, `endActiveCall` touches:

- **13 refs** — `activeCallRef`, `incomingCallRef`, `activeCallIdRef`, `isCallerRef`,
  `callConnectedAtRef`, `isConnectionLostRef`, `connectionQualityRef`,
  `displayedIncomingCallIdsRef`, `outgoingCallMediaTypeRef`, `connectedReportedCallIdRef`,
  `cancelIceRestartsRef`, `recordTimelineCallRef`, `refreshCallTimelineRef`;
- **12 setters** — `setCallSummary`, `setCallConnectedAtMs`, `setIsConnectionLost`,
  `setCallDelivery`, `setActiveCall`, `setIncomingCall`, `setIsReconnecting`,
  `setIsCompactView`, `setIsLocalPrimary`, `setAudioDevices`,
  `setIsRemoteScreenSharing`, `setIsRemoteVideoEnabled`;
- **every other checkpoint's hook** — recovery (`closeRecoveryEpisode`), heartbeat
  (`stopCallHeartbeat`), screen share (`resetScreenShare`), peer connection
  (`closePeerConnection`), local media (`releaseLocalMedia`), plus `endCallKeepCall`,
  `stopIncomingRingtone`, `stopCallService`, `addToHistory`, `Telemetry.trackCallEnd`
  and `dispatchCallEvent`.

It is the composition root's own function: the one place that knows the whole
call's shape. Extracting it would mean passing most of the hook back in as
parameters, which relocates the coupling without reducing it.

If the conclusion is not to extract, **record that in `docs/OPTIMIZATION_PLAN.md`
with the reasoning**, exactly as #216 recorded its two deferrals — both of which
were correct.

**Entry precondition.** CP6 merged, so the collaborator list is final.
**Resume check.** Search `docs/OPTIMIZATION_PLAN.md` for a teardown decision; its
presence _is_ the completion signal, whichever way it went.

---

## 6. Device QA — required for every checkpoint

The call path has no E2E coverage, so this list is the real gate. Record the
result in the checkpoint's PR.

- [ ] Outgoing call: connect, mute, speaker/earpiece, camera switch, end.
- [ ] Incoming call: ring, accept; and separately, ring and decline.
- [ ] Answer from the CallKeep system UI, including from a cold start via push.
- [ ] A mid-call network drop that recovers, and one that does not.
- [ ] Screen share start/stop, and PiP enter/exit.

---

## 7. Resuming after an interruption

1. `git log --oneline -1` — note the commit the tree is on.
2. `ls mobile/src/hooks/` — `useCallAudioRouting.ts`,
   `useConnectionQuality.ts` and `usePeerConnection.ts` are wired checkpoints.
   `useLocalMedia.ts`, `useSignalingSocket.ts` and `useAnswerPath.ts` may be
   scaffold-only; open each file and confirm it does more than return `{}` before
   treating that checkpoint as wired.
3. `wc -l mobile/src/hooks/useCallFlow.ts` — compare against 4,221 baseline,
   the 4,024-line post-CP1 handoff and the 3,799-line post-CP2 handoff to gauge
   progress.
4. Check for an open PR touching `useCallFlow.ts`. If one exists, **that is the
   in-flight checkpoint**; do not start another.
5. Run the §4 verification to confirm the tree you found is actually green before
   building on it.
6. Update the §5 status marks as part of the merging PR, so this document does not
   drift from the code it describes.

---

## 8. Definition of done

- [x] CP1 extracted.
- [x] CP2 extracted.
- [x] CP3 extracted.
- [x] CP4 extracted.
- [x] CP5 extracted.
- [ ] CP6 scaffold file is wired.
- [ ] `useCallFlow.ts` is materially smaller and reads as a composition root.
- [ ] Each extracted hook has direct tests that do not mount `useCallFlow`.
- [ ] `useCallFlow.test.tsx` still passes unmodified.
- [ ] Device QA recorded per checkpoint.
- [ ] `docs/OPTIMIZATION_PLAN.md` updated with what came out, what remains, and why
      anything was abandoned — including CP7's verdict.
