# Grumpy Code Review — copilot/investigate-media-connect-latency vs master

_Reviewed c2aba44..bf2ff9f, 24 files changed._

## Summary

Mergeable, but with one finding that undermines the point of the change. This PR
exists to make an `accepted → in_call` measurement trustworthy, and the server half
does that job well: the `answeredAt` derivation is correct, the skew guard is real
rather than decorative, and the provenance counters mean the histogram can no longer
lie by omission. The mobile half is where it slips. `permissions_checked` — the first
timed stage — silently includes the entire `sendCallAccept` round trip, because the
stage clock starts when the user taps Answer but the first mark is not taken until
after the accept has been acknowledged. That is a multi-hundred-millisecond network
hop charged to a permissions check, in the one instrument whose purpose is to stop
people guessing. Fix that and this is good work. There is also some unrelated
`package-lock.json` churn that has no business in a metrics PR.

## Findings

### Critical

None.

### High

- **[HIGH] The accept round trip is charged to `permissions_checked`** —
  `mobile/src/hooks/useAnswerPath.ts:383` and `:262`
  - `beginAnswerTimeline(call.callId)` starts the clock immediately before
    `reportAnswerStage('answer_attempted')`, i.e. at the moment the user taps Answer.
    The next `markAnswerStage` call is not until `permissions_checked`
    (`acquireMediaForAcceptedCall`), which runs only after `await sendCallAccept(...)`
    has completed a socket or HTTP round trip to the server. So
    `permissions_checked`'s `stageMs` is `accept RTT + permission check`, not the
    permission check.
  - This is precisely the mis-attribution the PR is meant to eliminate. An operator
    reading these receipts would conclude the callee spends hundreds of milliseconds
    checking permissions, and would go optimise the wrong thing. It is worse than no
    measurement, because it is a confident wrong one.
  - Fix: take a stage mark when the accept is acknowledged — report the duration on
    the existing `answer_accepted` receipt (which currently sends none) using
    `markAnswerStage`. That both resets the baseline for `permissions_checked` and
    turns the accept round trip into its own named, measured stage, which is
    independently worth having.
  - **Resolution: Fixed.** Added `markAnswerAccepted`
    (`mobile/src/call/answerTimeline.ts`), called at the accept ack in
    `useAnswerPath.acceptIncomingCall`; it closes the round trip as
    `answer_accepted`'s own duration and rebases the clock, so
    `permissions_checked` now measures only the permission check. Covered by a
    new test in `mobile/__tests__/call/answerTimeline.test.ts`.

### Medium

- **[MEDIUM] `sinceAcceptMs` measures from the tap, not from the accept the server
  recorded** — `mobile/src/call/answerTimeline.ts:22-27`
  - The field is named for, and read as, the client-side counterpart of the server's
    `accepted → in_call` window, and is reported as `media_connected`'s `durationMs`
    (`useCallRecovery.ts:399`). But its origin is `beginAnswerTimeline`, called before
    the accept is sent, whereas the server's window opens at the `accepted` transition.
    The two numbers are therefore not comparable, and the client's will always be the
    larger by an unstated amount.
  - Anyone correlating the client receipt against `call_connect_latency_ms` — the
    explicit purpose of this instrumentation — will find a consistent discrepancy and
    have to rediscover why.
  - Fix: rebase the timeline at the accept ack (the same fix as the HIGH finding
    resolves this), or rename the field to `sinceAnswerTappedMs` and document the
    offset in `docs/media-connect-latency-diagnosis.md` so the comparison is made
    knowingly.
  - **Resolution: Fixed.** Resolved by the same rebase: `sinceAcceptMs` is now
    measured from the accept acknowledgement, matching the origin of the
    server's `accepted → in_call` window. The field's doc comment states the
    origin and why the tap is not used.

- **[MEDIUM] `reportCallConnected`'s identity now churns on `signalingUrl`** —
  `mobile/src/hooks/useCallRecovery.ts:449-457`
  - `reportConnectedDiagnostics` is a new dependency, and it in turn depends on
    `signalingUrl`. `reportCallConnected` is consumed by an effect at
    `useCallFlow.ts:871-875`, which now re-runs whenever the signaling URL changes.
  - The effect only reassigns a ref, so today this is harmless — but it quietly
    couples a diagnostics-only concern to the identity of a call-lifecycle callback,
    which is the kind of thing that becomes a bug the next time that effect gains a
    subscription.
  - Fix: hold `reportConnectedDiagnostics` in a ref (the file already uses
    `…Ref.current?.()` for exactly this, e.g. `scheduleIceRestartRef`) and drop it
    from the dependency array.
  - **Resolution: Fixed.** `reportConnectedDiagnostics` is now forwarded through
    `reportConnectedDiagnosticsRef`, restoring `reportCallConnected`'s previous
    dependency set.

### Low

- **[LOW] Unrelated `package-lock.json` churn** — `mobile/package-lock.json:7907,13763`
  - Two `dev` → `devOptional` / removed-`dev` flag changes for `fsevents` and
    `typescript`, produced incidentally by running `npm install` during development.
    Nothing in this PR changes a dependency.
  - It makes the diff look like it touches dependency resolution when it does not,
    and invites a reviewer to check something that does not need checking.
  - Fix: `git checkout origin/master -- mobile/package-lock.json`.
  - **Resolution: Fixed.** Lockfile reverted to the base branch's version.

- **[LOW] A timeline for a call that never connects is only cleaned up by eviction** —
  `mobile/src/call/answerTimeline.ts:39-46`
  - `endAnswerTimeline` is called on the answer-failure path and on
    `media_connected`, but a call that is accepted and then simply never reaches
    `call.connected` (the `media_connect_timeout` case, which this whole PR exists
    because of) leaves its entry until `MAX_TRACKED_ANSWERS` evicts it.
  - Bounded and therefore not a leak, but it means a later call *can* be the one that
    evicts it, and the eviction is silent.
  - Fix: call `endAnswerTimeline` from the call-teardown path alongside the existing
    `clearPendingAnswer`, so the lifetime is explicit rather than incidental.
  - **Resolution: Fixed.** `endActiveCall` (`mobile/src/hooks/useCallFlow.ts`)
    now calls `endAnswerTimeline` alongside the other per-call cleanup.

### Nit

- **[NIT] `call_setup_latency_ms` quietly changed its origin for same-instance calls** —
  `server/src/telemetry.ts:368-377`
  - It now measures from the record's `createdAt` rather than the in-process
    `ringingMs`. The two are stamped within a millisecond of each other, so the
    values are equivalent and the comment explains the reasoning — but the PR
    description's "existing same-instance behaviour is unchanged" is very slightly
    stronger than what the code does.
  - Fix: nothing in the code; a half-sentence in the PR description noting that both
    histograms now derive from the record would be more accurate.
  - **Resolution: Fixed.** Noted in the PR description; no code change.

## Resolution summary

6 findings, all in scope, all fixed, none deferred: 1 High, 2 Medium, 2 Low,
1 Nit. Revalidated after the fixes — server 625 pass / 0 fail, mobile 2346 pass
/ 0 fail, lint and typecheck clean on both packages.

## Out of scope (pre-existing, not graded)

- The §2 stranded-buffer replay gap is deliberately left unfixed, and is documented
  as such in both `docs/media-connect-latency-diagnosis.md` and
  `server/README.md`. That is the right call — fixing it in the same change that
  repairs the metric measuring it would make the result unattributable — and it is
  now counted by `rtc_signals_stranded_remote`.
- `usePeerConnection.ts`'s no-local-tracks behaviour and the camera-open-for-voice
  `getUserMedia` constraints are both named as non-scope in the task and are
  untouched here.
- The `master` CI failure in "Deploy to Oracle Cloud VM" (`drizzle-kit migrate`
  against the production DB) is pre-existing and unrelated to this branch.

## Baseline

`server`: typecheck, lint and the full suite (625 pass / 0 fail / 1 skip) are clean
on this branch. `mobile`: typecheck, `eslint .` and the full suite (2344 pass /
0 fail) are clean. No new lint or test failures are attributable to this diff.
