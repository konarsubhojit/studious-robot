# Grumpy Code Review — copilot/fix-stale-call-state-error vs master

_Reviewed 49a500f..HEAD, 2 files changed._

## Summary

Mergeable. Two files, one behavioural line. The diff finds the actual source of
the `stale_call_state` acks — `useCallFlow`'s local media-presence relay fired
as soon as the outgoing call had an id, which is while the call is still
`ringing` — and gates it on the call having a live RTC status instead. The
heartbeat was cleared of suspicion by reading the code rather than by guessing:
`startCallHeartbeat` is only reached from `useCallRecovery`'s connected report,
and `beatCallHeartbeatIfDue` returns early unless the heartbeat is `active`, so
no beat was ever lost to this. The worst thing in here was caught and fixed
during the review pass (see below); mobile lint, `tsc --noEmit` and the full
Jest suite (2197 tests) are green on the branch.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] Depending on the raw status re-relayed the same snapshot three
  times per call** — `mobile/src/hooks/useCallFlow.ts:3394` *(fixed in this
  branch)*
  - The first cut added `activeCallStatus` to the effect's dependency array. A
    live call walks `accepted` → `connecting_media` → `in_call`, and each of
    those arrives as a `call.state_changed` that calls `setActiveCall`, so the
    unchanged `{ isScreenSharing, isVideoEnabled }` frame would have been sent
    on all three — turning a one-frame-per-call relay into three, on the same
    rate-limited RTC channel.
  - Why it matters: the comment directly above the effect promises "one
    explicit snapshot per call"; silently tripling it is exactly the kind of
    drift that makes the comment a lie and eats the `rtcRateLimiter` budget.
  - Fix applied: depend on the derived boolean `canRelayMediaState`, which
    flips `false → true` once and stays true across the remaining live
    transitions. Pinned by the test, which now asserts the emit list is exactly
    one frame and stays at one through `connecting_media` and `in_call`.

### Low

- **[LOW] The gate is silent about a call that never reports a live status** —
  `mobile/src/hooks/useCallFlow.ts:3405`
  - If a server ever answered an accept without a `status`, the snapshot would
    be withheld with no log line. In practice every call record on the wire
    carries `status` (`createCallEnvelope` sends the whole record, and the
    accept ack returns `result.call`), and the next `call.state_changed`
    re-arms the relay, so this self-heals within one transition.
  - Not worth a log line on a path that cannot occur against this server; noted
    so it is a decision rather than an oversight.

### Nit

None.

## Out of scope (pre-existing, not graded)

- The server's `RTC_ACTIVE_CALL_STATES` check in
  `server/src/signaling/callHandlers.ts:241` is left as-is. It is the contract
  — a media-state frame for a call that is not up is genuinely stale — and
  `server/test/telemetry.test.ts` pins the `stale_call_state` ack for a ringing
  call. This branch fixes the client that was violating the contract rather
  than loosening the contract to match it.
- The `act(...)` warning emitted by the "smoke: incoming answer stays alive…"
  test in `useCallFlow.test.tsx` predates this diff and is unrelated to it.
