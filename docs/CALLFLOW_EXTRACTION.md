# `useCallFlow` extraction — completed boundaries

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.
The checkpointed effect-hook extraction is implemented; this is a boundary
decision record, not a queue of checkpoints to start.

`mobile/src/hooks/useCallFlow.ts` contains **2,442 lines** and
`mobile/__tests__/hooks/useCallFlow.test.tsx` contains **6,212 lines**
(`wc -l`, 2026-10-02). These are current sizes, not a claim that later feature
work must keep the hook at its immediate post-extraction size.

## Extracted responsibilities

Each hook below is imported and composed by `useCallFlow`, with a matching
`mobile/__tests__/hooks/<hook>.test.tsx` suite.

| Hook | Responsibility |
| --- | --- |
| `useCallAudioRouting` | Audio-session lifecycle, device snapshots, automatic/manual routes and microphone mute routing. |
| `useConnectionQuality` | Foreground-gated stats polling, selected candidate pairs and quality smoothing. |
| `usePeerConnection` | Peer construction, candidate/track handlers, additional remote audio merging, renegotiation and peer teardown. |
| `useLocalMedia` | Local stream acquisition/release, video enablement and camera switching. |
| `useSignalingSocket` | Authenticated socket lifecycle, ref-forwarded handlers, transport listeners and reconnect handling. |
| `useAnswerPath` | Accept/decline effects, answer replay and notification/CallKeep action bridging. |

Related concern hooks include `useCallHeartbeat`, `useCallRecovery` and
`useScreenShare`. Pure decisions remain in `mobile/src/call/`, including
`callDecisions.ts`, `answerPath.ts`, `sessionLifecycle.ts`,
`pushRehydration.ts`, `audioRouteRules.ts`, `iceRestartLadder.ts` and
`recoveryEpisode.ts`.

## Teardown decision: retain `endActiveCall`

`endActiveCall` remains in `useCallFlow`. It coordinates history/timeline
reconciliation, CallKeep, ringtone cleanup, heartbeat, recovery, screen share,
peer connection, local media and UI reset.

Moving this sequence behind a `useCallTeardown` wrapper would require passing
the participating hooks, refs and setters back into it. That would relocate
cross-hook coupling without removing it, and hide the ordered lifecycle
boundary. Keep concern-specific cleanup in the concern hooks and the
whole-call teardown order in the composition root.

## Behavioural boundaries to preserve

- Keep answer replay on the existing helpers in `mobile/src/callKeep.ts`;
  extraction is not a reason to create another pending-answer queue.
- Preserve the memoized `callFlowState` / `callFlowActions` split.
- Reuse `call/iceRestartLadder.ts`; do not duplicate its escalation policy.
- Reset remote-stream and merged-audio tracking together in
  `usePeerConnection`.
- Keep microphone mute independent from shared system audio; the native ADM
  path is described in [android-system-audio-decision.md](./android-system-audio-decision.md).

## Verification still requiring hardware

The repository records implementation and focused tests, not completed
physical-device QA for every extraction checkpoint. Do not infer those results
from source inspection:

- Outgoing call: connect, mute, speaker/earpiece, camera switch, end.
- Incoming call: accept and decline.
- Answer through system call UI, including a push cold start.
- Mid-call network loss with successful and unsuccessful recovery.
- Screen-share start/stop and PiP enter/exit.

For later call-path changes, run the owning hook suite together with
`useCallFlow.test.tsx`, plus the package's existing typecheck and lint commands.
Install dependencies only when absent, not as a mandatory precondition for
every validation run.
