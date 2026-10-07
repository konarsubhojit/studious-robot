# Call-setup telemetry — interpretation and retained findings

Source audit: `ab7591677e979d0a86b1137e99743fc5f3bdc5fd`, 2026-10-02.

The 2026-09-17 three-instance investigation established observability limits,
not a current performance baseline. Its completed instrumentation changes are
described below without reopening the old implementation phases.

## Relay counters and stale-state attribution

`server/src/telemetry.ts` now separates:

- `rtc_relays_media_heartbeat`: frames marked as liveness heartbeats.
- `rtc_relays_media_state_change`: other `call.media-state` frames.
- `rtc_relays_other`: unexpected event names rather than the old combined
  media-state bucket.

`useCallHeartbeat.ts` is due-gated using the shared 30-second interval in
`shared/signaling/timing.ts`. The separate state-change effect in
`useCallFlow.ts` debounces camera/screen-share updates and gates them on a live
call. Relay volume therefore needs connected-time and sender-socket context,
not just a count of transitions recorded by the receiving instance.

`signaling_errors_stale_call_state_by_event` attributes stale-state rejections
to the triggering event. A long ringing window does not by itself reopen the
old early media-state emission problem: the client gate is state-based.
Residual rejections need event/call traces, not an assumption that all
`stale_call_state` errors have the same cause.

## Ring timeout interpretation

`server/src/config.ts` defaults ringing to **120,000 ms**.
`getCallExpiry` and timeout sweeping in `server/src/domain/calls.ts` can move a
ringing call to `missed`; explicit cancel/decline/accept paths can resolve it
before that deadline.

An observation window containing no `calls_missed` does not show that the
timeout path is unreachable. Calibrating the timeout to user patience requires
a longer production observation, not the earlier small sample.

## Detached work and event-loop lag

`server/src/lib/queryTiming.ts` records the `blocking` dimension, and telemetry
exposes a per-operation `detached` count. Detached query volume is not a
call-persistence-only metric: audit, cache and other background work also
contribute.

Asynchronous datastore wait time is not itself synchronous JavaScript CPU
time. A correlation between detached-query volume and event-loop lag does not
identify a cause. The source still has no dedicated synchronous-span histogram
that attributes lag to a particular hot path. Choosing sampled spans or
spike-time attribution remains a separate profiling decision with an overhead
budget; there is no expired phase sequence to resume.

The earlier scrape did not establish detached persistence as the cause of its
lag spike. Nor does a low count of blocking slow queries rule out every
storage/queueing contributor to a latency tail.

## Cross-instance ratios: retain the caveat

### Restart scope decision (2026-10-07)

Keep counters **process-scoped**, as the telemetry recorder's contract already
specifies. Hydration restores a bounded, newest-first call cache and its events,
not the entire database; rebuilding "lifetime" totals from that page would be
incorrect. Hydration itself must not replay historical transitions into telemetry.
Transitions of restored or remotely initiated calls during this process still
count as observed events, but are not part of its locally initiated cohort.

The supplied production evidence showed 331 restored calls and 1,338 events,
with `calls_ended` exceeding process-local `calls_initiated` after restart.
That comparison is **not an invariant**. `/metrics.metricScopes` labels each
counter and derived rate; `historical` separately reports hydration counts
(loaded rows, not lifetime totals). Device counts are labelled as the current
instance's cache, while call-quality aggregates are retained database history
(or disabled/empty without a database). The checker compares
`calls_ended_for_initiated` with `calls_initiated`: both refer only to calls
created by this recorder. Legacy payloads without that cohort counter are not
compared. This also avoids false alarms from cross-instance endings.

The actual completion denominator is `calls_in_call`, not `calls_accepted`;
the supplied samples happened to have matching accepted/connected counts.
Cancelled and busy calls can end without connecting, so completion above one
is valid. Delivery marks count idempotent marking operations, including reads
of older messages, not unique persisted messages or recipient devices. The
supplied 24 persisted / 32 marks sample is healthy; only a positive gap warrants
the existing warning, not an equality assertion.

`telemetry.ts` still derives:

```text
call_connect_rate = calls_in_call / calls_initiated
call_completion_rate = calls_ended / calls_in_call
```

Those transitions can be handled by different instances. A per-host ratio can
therefore exceed one or look like a failed funnel while the call progressed
elsewhere. It is not a same-call-cohort conversion rate.

The rejected replacement, `call_connect_latency_shared / calls_accepted`,
would not fix this: shared-timestamp connect samples can be recorded by a host
that never handled the accept. Keep provenance explicit rather than shipping
that misleading replacement or renaming metrics without compatibility planning.

Group-call participant metrics use like-for-like units: `call_participant_join_rate`
is `call_participants_joined_total / call_participants_total`, while the existing
connect and completion rates remain call-to-call ratios. The participant
histograms and peer-failure counters are still process-local, so their fleet
totals require aggregating counters across instances rather than averaging
per-instance rates.

## What remains unmeasured here

No fresh production scrape, host-clock verification, device run or profiling
session accompanied this documentation audit. Ring-timeout calibration,
synchronous CPU attribution and the frequency/impact of cross-instance
buffer loss require those measurements. See
[media-connect-latency-diagnosis.md](./media-connect-latency-diagnosis.md) for
the current latency instrumentation and replay limitation.
