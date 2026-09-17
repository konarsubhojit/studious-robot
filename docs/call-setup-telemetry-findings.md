# Call-setup telemetry findings — 2026-09-17 three-instance scrape

## Scope and method

This report investigates the anomalies observed in a `GET /metrics` scrape of
`oci` (idle), `micro1` and `micro2`, taken within ~70s of each other on
2026-09-17 ~14:49Z. Per `server/README.md:414-419` ("Scrape each instance
separately, and never sum them"), the three hosts' counters are treated as
disjoint samples throughout — no cross-host arithmetic is performed anywhere
below except where explicitly framed as "if these numbers *were* combined,
here is why that would be wrong."

Every conclusion below is based on reading the referenced source, not on
inferring behaviour from a metric's name. No application code was changed;
this is a read-only investigation, per the task's instructions.

---

## 1. What populates `rtc_relays_other`? — **Confirmed: working as designed, but poorly named/observable**

### What falls into `other`

`recordRtcRelay()` buckets every relayed event that is not literally
`rtc.offer` / `rtc.answer` / `rtc.candidate`. Before this task's fix, this
was the implementation:

```ts
// server/src/telemetry.ts (pre-fix)
const RELAYED_RTC_EVENTS = ['rtc.offer', 'rtc.answer', 'rtc.candidate'] as const;

function recordRtcRelay(eventName: string, recipients: number | null = null) {
  const bucket = (RELAYED_RTC_EVENTS as readonly string[]).includes(eventName)
    ? (`rtc_relays_${eventName.slice('rtc.'.length)}` as keyof typeof counters)
    : 'rtc_relays_other';
  counters[bucket] += 1;
  ...
}
```

`recordRtcRelay` is called from exactly one call site, inside `logRtcRelay`
(`server/src/signaling/callHandlers.ts`), which is invoked from
`handleRtcRelay` in the same file. `handleRtcRelay` is wired to
**four** socket events, not three
(`server/src/signaling/connection/registerSocketHandlers.ts:416-458`):

| Socket event | `dataKey` | Counted as |
| --- | --- | --- |
| `rtc.offer` | `sdp` | `rtc_relays_offer` |
| `rtc.answer` | `sdp` | `rtc_relays_answer` |
| `rtc.candidate` | `candidate` | `rtc_relays_candidate` |
| **`call.media-state`** | `mediaState` | **`rtc_relays_other`** (pre-fix; see below) |

So `other` was exactly one event name: `call.media-state`
(`shared/signaling/events.ts:33,58`), relayed through the same generic path as
the SDP/ICE frames because it needs the same participant/auth/rate-limit
checks and the same "promote to `connecting_media` on first frame"
side effect (the `promoteToConnectingMedia` call inside `handleRtcRelay`).

### Who emits `call.media-state`, and on what trigger

Two independent client emitters share this one wire event:

1. **State-change relay** (`mobile/src/hooks/useCallFlow.ts:2053-2078`): an
   effect that debounces (`MEDIA_STATE_RELAY_DEBOUNCE_MS = 100ms`,
   `useCallFlow.ts:143`) and sends one frame whenever `isScreenSharing` or
   `isVideoEnabled` changes, gated by
   `canRelayMediaState = activeCallId !== null && isLiveCallStatus(activeCall?.status)`
   (`useCallFlow.ts:2054`). This fires at most a handful of times per call
   (once per real screen-share/camera toggle), **not** on a timer and **not**
   on every render — the dependency array is `[activeCallId, canRelayMediaState,
   isScreenSharing, isVideoEnabled]` (`useCallFlow.ts:2078`), all primitives.
2. **Liveness heartbeat** (`mobile/src/hooks/useCallHeartbeat.ts:107-131`): a
   `setInterval`-driven beat with `mediaState: { ..., heartbeat: true }`,
   started only from `useCallRecovery.ts:446`
   (`startCallHeartbeat('media-connected:...')`, i.e. only once the peer
   connection has actually reached `connected`/`completed`), at
   `CALL_HEARTBEAT_INTERVAL_MS = 30_000` (`shared/signaling/timing.ts:22`),
   from **both** call participants independently, and additionally "woken"
   (but not double-sent — `beatCallHeartbeatIfDue` is due-gated,
   `useCallHeartbeat.ts:104-105`) by socket pings, AppState changes and
   reconnects.

### Is the volume proportionate to call count, or a loop?

It is proportionate to **connected call time**, not call count, and this is
what the numbers show once the heartbeat is accounted for:

- micro1: 11 `in_call` samples (`call_connect_latency_ms.count`), 768 `other`.
  **This estimate assumes both peers of every call beat to micro1** — i.e.
  that neither participant's socket ever lived on micro2 for these 11 calls.
  Under that assumption, at 2 heartbeats/min per call (both peers × 1
  beat/30s), 768 beats implies roughly 35 cumulative connected-minutes across
  those 11 calls, a ~3 min average call. But the very next paragraph (micro2)
  shows heartbeats route by the *sender's* socket and can split across
  instances — so the same 768 could equally represent only micro1's *share*
  of the beats for those calls, with the rest landing on micro2. If beats
  split evenly, 768 implies roughly 70 cumulative connected-minutes, not 35.
  Notably, micro1's `call_duration_ms` mean is 539s (~9 min) over 5 samples,
  which sits awkwardly with a 3-minute estimate either way. **The only
  claim this data actually supports is the load-bearing one: 768 is
  proportional to connected time and consistent with heartbeat cadence, not
  an unbounded per-render emission.** The specific cumulative-minutes / average
  -call-length figures are not reliable from this sample and are dropped.
- micro2: 0 local `in_call` transitions, yet still 186 `other`. This is *not*
  a contradiction: a heartbeat is emitted per-**user**, and lands on whichever
  instance currently holds that user's socket (`emitToUserSockets`,
  `handleRtcRelay` receives it via `socket.on(CLIENT_EVENTS.CALL_MEDIA_STATE,
  ...)` on the instance the *sender's* socket is attached to,
  `registerSocketHandlers.ts:449-458`) — independent of which instance
  recorded the call's `in_call` transition in its own `state.calls` map. A
  call whose `connected` report and shared-store write happened to be handled
  by micro1 (`handleCallConnected`, `callHandlers.ts`, "the first peer
  to report wins") can still have its heartbeats observed by micro2, if that
  call's other participant's socket lives there. This is exactly the
  fleet-wide symptom described in item 5 below, now showing up a second time
  in a different counter.

**Verdict: confirmed working-as-designed data (heartbeat + occasional
media-state toggles), not a bug and not a client loop** — but the counter name
actively defeats diagnosis, which is the real problem: a reviewer cannot tell
"heartbeat load" from "a client stuck emitting on every render" without
reading this file, which is exactly what this section had to do.

### Proposed fix — split `other` into named sub-counters — **shipped**

```ts
// server/src/telemetry.ts — replace the single 'other' bucket
const RELAYED_RTC_EVENTS = ['rtc.offer', 'rtc.answer', 'rtc.candidate'] as const;
const MEDIA_STATE_RELAY_EVENT = 'call.media-state';

function recordRtcRelay(eventName: string, recipients: number | null = null, isHeartbeat = false) {
  const bucket =
    (RELAYED_RTC_EVENTS as readonly string[]).includes(eventName)
      ? (`rtc_relays_${eventName.slice('rtc.'.length)}` as keyof typeof counters)
      : eventName === MEDIA_STATE_RELAY_EVENT
        ? (isHeartbeat ? 'rtc_relays_media_heartbeat' : 'rtc_relays_media_state_change')
        : 'rtc_relays_other'; // kept as a true "unexpected event" bucket
  counters[bucket] += 1;
  if (recipients === 0) counters.rtc_relays_no_recipient += 1;
}
```

with two new declared counters:

- `rtc_relays_media_heartbeat` — the 30s liveness beat (`mediaState.heartbeat === true`).
- `rtc_relays_media_state_change` — real screen-share/camera toggles.

`handleRtcRelay` already computes `options.recordsHeartbeat === true &&
value?.heartbeat === true` (the `isHeartbeatFrame` local, reused for both the
`recordCallHeartbeat` gate and the telemetry call) for the `recordsHeartbeat`
branch, so the call site only needed to thread that same boolean into
`logRtcRelay`/`recordRtcRelay`. `rtc_relays_other` now reverts to its intended
meaning: *an event this analysis did not anticipate at all*, which is the
signal actually worth alarming on.

**Blast radius:** telemetry-only change (two new keys in the counters map, one
new parameter threaded through two internal functions). No wire format,
schema, or persisted-data change. Existing `rtc_relays_other` consumers (none
found outside `telemetry.ts` and its tests) would see their counter drop to
~0 after the split, which is a monitoring-dashboard update, not a behavioural
one. **Status: implemented, tested in `server/test/telemetry.test.ts`.**

---

## 2. Are the 5 `stale_call_state` acks the same bug as #1? — **Confirmed: prior fix present and complete; not reachable via long ring windows; residual count needs more data**

### Is the fix present and complete?

Yes. `reviews/fix-stale-call-state-error-review.md` describes gating the
media-state relay on `canRelayMediaState` rather than on the call having an
id. That gate is present verbatim today:

```ts
// mobile/src/hooks/useCallFlow.ts:2054
const canRelayMediaState = activeCallId !== null && isLiveCallStatus(activeCall?.status);
```

`isLiveCallStatus` (`mobile/src/call/callDecisions.ts:94-96`) checks
`LIVE_CALL_STATUSES = new Set(['accepted', 'connecting_media', 'in_call'])`
(`callDecisions.ts:58`) — an exact match for the server's
`RTC_ACTIVE_CALL_STATES` (`server/src/config.ts:27`,
`new Set(['accepted', 'connecting_media', 'in_call'])`). The review's own
"Medium" finding (depending on raw status re-relayed the snapshot three
times) is also fixed: the effect's dependency array is
`[activeCallId, canRelayMediaState, isScreenSharing, isVideoEnabled]`
(`useCallFlow.ts:2078`), the derived boolean, not the raw status string.

### Do long ring windows reopen this?

No. The gate is a **status check**, not a **time-based** check — nothing
about it depends on how long the call spent `ringing`. Widening the ring
window (up to 82s observed) only widens the interval during which
`canRelayMediaState` stays `false` and the effect's `useEffect` cleanup
(`useCallFlow.ts:2058-2061`, which clears any pending debounce timer) keeps
re-running; it cannot cause a frame to be sent early. Ruled out.

### Could any other client-side emitter fire before `RTC_ACTIVE_CALL_STATES`?

Checked every mobile call site of `CLIENT_EVENTS.RTC_OFFER` /
`RTC_ANSWER` / `RTC_CANDIDATE` / `CALL_MEDIA_STATE`:

- `useCallHeartbeat.ts:119` — only reachable after `startCallHeartbeat` is
  called, and the only caller is `useCallRecovery.ts:446`, itself only
  invoked from the peer connection's own `connected`/`completed` ICE-state
  handler — i.e., strictly after real media is up, which is after
  `accepted`. Cannot fire during `ringing`.
- `usePeerConnection.ts:156,243` and `useCallFlow.ts:1234` (offer/candidate
  emission) and `useSignalingSocket.ts:492` (answer) — all driven by
  `RTCPeerConnection` callbacks (`onnegotiationneeded`, `onicecandidate`),
  which only fire after a peer connection object exists, which is only
  created once the call is accepted. `rtc.candidate` is additionally
  server-side bufferable while `ringing` if it does race ahead
  (`BUFFERABLE_RTC_EVENTS = new Set([CLIENT_EVENTS.RTC_CANDIDATE])`,
  `server/src/signaling/rtcBuffer.ts:58`) rather than rejected outright.
- `useCallRecovery.ts:623` (re-offer on ICE restart) — only reachable from an
  already-live call's recovery path.

No other emitter was found that can address `rtc.offer`/`rtc.answer`/
`call.media-state` for a call that is still `ringing`.

### What, then, explains the remaining 5 `stale_call_state` (micro1) / the mechanism in general?

This was, at investigation time, where the evidence ran out — the honest
answer was **needs more data**. `acknowledgeError()` logs the rejected event
name (`server/src/signaling/ack.ts:120-121`, `event=${eventName}`) but
`recordSignalingError(code)` (`ack.ts:116`, `telemetry.ts`) only ever received
the **code**, never the **event name**, so `signaling_errors_by_code` could
not distinguish "a stale `rtc.candidate`" (expected — see
`holdOrRejectRtcSignal`, `callHandlers.ts:196-224`, which only *buffers*
candidates and rejects everything else outright for a non-live call) from "a
stale `call.media-state`" (would indicate the fix in §2 has a gap) from "a
stale `rtc.offer`" (would indicate a race in the accept path itself). All
three used to increment the identical `stale_call_state` counter with no way
to tell them apart from `/metrics` alone. **This gap is now closed** (see
below); the next scrape will settle which of the three this was.

### Proposed instrumentation fix — shipped

Track `stale_call_state` per triggering event, mirroring the existing
per-code breakdown:

```ts
// server/src/telemetry.ts — extend recordSignalingError
function recordSignalingError(code?: string, eventName?: string) {
  counters.signaling_errors += 1;
  const label = typeof code === 'string' && code.length > 0 ? code : 'unknown';
  ...
  if (label === 'stale_call_state') {
    const evLabel = typeof eventName === 'string' && eventName.length > 0 ? eventName : 'unknown';
    const evKey = staleCallStateByEvent.has(evLabel) || staleCallStateByEvent.size < MAX_TRACKED_STALE_CALL_STATE_EVENTS
      ? evLabel
      : 'other';
    staleCallStateByEvent.set(evKey, (staleCallStateByEvent.get(evKey) ?? 0) + 1);
  }
}
```

exposed as `signaling_errors_stale_call_state_by_event` (a small, capped map
like `signaling_errors_by_code`, capped at `MAX_TRACKED_STALE_CALL_STATE_EVENTS`
and overflowing to an `other` key), threaded from `acknowledgeError`
(`ack.ts:116`, which already has `eventName` in scope) down to
`recordSignalingError`. `eventName` stays optional on both functions, since
`acknowledgeError` is documented as callable before `state` exists at the
earliest guards.

**Decision on scope:** tracked the per-event breakdown only for
`stale_call_state`, not for every code. The generic version is barely more
code and would also answer this class of question for `call_not_found` and
`forbidden`, but every additional code doubles the cardinality of a capped
map that is already sized for the one code this investigation actually needed
answered. `stale_call_state` is the only code where "which event" changes the
verdict (buffered-candidate vs. accept-path race vs. regression); the other
codes do not have that ambiguity today. If that changes, the generic version
is a small follow-up, not a redesign.

**Blast radius:** additive counter, no behavioural change; touches
`acknowledgeError`'s one call to `recordSignalingError` and the telemetry
module. Low risk. **Status: implemented, tested in
`server/test/telemetry.test.ts`.**

---

## 3. Why are rings lasting 20–82 seconds with zero `calls_missed`? — **Confirmed: `missed` is reachable but not exercised by this data window (ring timeout > observed ring durations); working as designed for this sample, with a real design question about the timeout value**

### The configured timeout and what the sweep does

```ts
// server/src/config.ts:108-115
/**
 * How long a call may remain in `ringing` before it becomes `missed`.
 * Two minutes, so a callee whose handset is locked, silent or slow to wake has
 * a realistic chance to pick up; override with the `RINGING_TIMEOUT_MS` env var.
 */
const DEFAULT_RINGING_TIMEOUT_MS = 120_000;
```

The sweep (`tickRingingTimeouts`, `server/src/domain/calls.ts:437-451`) runs
every `RINGING_POLL_MS = 5_000` (`config.ts:281`), driven from
`createServer/index.ts:405-452`. For each non-terminal call it computes
`getCallExpiry` (`calls.ts:693-`); for `status === 'ringing'` this is:

```ts
// server/src/domain/calls.ts:706-713
case 'ringing':
  return {
    status: 'missed',
    reason: 'timeout',
    deadlineMs: call.ringTimeoutAt
      ? toTimestamp(call.ringTimeoutAt, enteredStateMs + ringingTimeoutMs)
      : enteredStateMs + ringingTimeoutMs,
  };
```

When the deadline passes, `finalizeCall` moves the call to `missed`
(the general stale path and the ringing-sweep path in `calls.ts` both call
it), which increments `calls_missed` via `recordRingEnd('calls_missed', ...)`
(`telemetry.ts`).

### Missed vs cancelled vs ended — is `missed` reachable at all?

Yes, and it is exercised elsewhere in the test suite
(`server/test/call-history.test.ts:137`, `call-timeline.test.ts:169` etc. seed
`status: 'missed'`), so it is not dead code. It is simply **not the path these
particular calls took**:

- `calls_cancelled` (micro1: 5, micro2: 3) comes from the caller explicitly
  hanging up while ringing — `CALL_CANCEL` →
  `nextStatus: 'ended', reason: 'cancelled'`
  (`registerSocketHandlers.ts:372-384`) — which is a **user action**, counted
  in `recordCallEnd` as `counters.calls_cancelled += 1` when
  `call.endReason === 'cancelled'` (`telemetry.ts`). This requires the
  call to reach `ended`, not `missed`.
- The observed ring durations (max 82126ms on micro2) are all **below** the
  120,000ms `DEFAULT_RINGING_TIMEOUT_MS`, so no call in this sample ever
  reached the sweep's deadline. Every ring in the sample ended by an explicit
  action (cancel, decline, or accept-elsewhere) before the timer could fire.

**Verdict: `missed` is reachable and not a metrics bug** — its absence in this
specific 70-second, 3-instance scrape is explained entirely by the fact that
every observed ring resolved (by user action) well inside the 120s window. It
would be a mistake to conclude anything is broken here from a single
`calls_missed: 0` reading; the correct read is "no ring in this window ran
out the clock."

### Is the sweep firing promptly, and is 120s the right number?

The sweep polls every 5s (`RINGING_POLL_MS`), so it cannot be the reason a
82s ring outlives its intent — 5s granularity against a 120s deadline is not
the bottleneck. The **product** question is separate and real: is 82s of
audible ringing (a full 82 seconds during which the callee's phone rings and
the caller is left waiting, before *either party* gives up) too long?
**This cannot be answered from four ring-duration samples across two hosts in
a 70-second window** — that is too small a sample to draw a calibration
conclusion from, and this report is deliberately conservative about sample
size everywhere else. The only claim the data supports is narrower: no ring
observed in this window reached the 120s deadline (max observed voluntary
cancel was 82126ms, still under the cutoff), so the sweep itself is not
firing late or misbehaving for these calls. Whether 120s is well-calibrated
for real user patience — or whether it is effectively unreachable in
practice because users always give up first — needs the same longer
observation window called out below, not a judgement from this sample.
**Needs more data**: a longer observation window (hours, not 70 seconds) is
needed to see whether `calls_missed` is ever non-zero in practice, which
would settle whether 120s is well-calibrated or effectively unreachable in
production too.

---

## 4. Is the 2009ms event-loop stall explained by detached DB work? — **Needs more data / partially ruled out: correlation is real, causation is not established, and the mechanism as commonly assumed (async I/O blocking the loop) does not hold**

### What `db_detached_queries_total` actually counts

```ts
// server/src/lib/queryTiming.ts:50-59
/**
 * Whether a user-facing operation actually waited for this query.
 * `false` for work started inside `runDetached` — the fire-and-forget
 * audit, call-persistence and read-receipt writes that are deliberately not
 * awaited. ... nobody's request paid it ...
 */
blocking: boolean;
```

`db_detached_queries_total` increments for **every** query issued while
`isDetached()` is true (`telemetry.ts`, checked from `queryTiming.ts`), and
`runDetached` wraps *at least three unrelated call sites*, not just call
persistence:

- `server/src/domain/calls.ts:33` — `mirrorCallToShared` (Redis save on every
  heartbeat and every transition, `recordCallHeartbeat`, `calls.ts:415-421`).
- `server/src/callPersistence.ts:32,52,100` — Postgres call-record
  persistence and cache-prefix invalidation.
- `server/src/security.ts:182` — audit-log persistence to Postgres, fired on
  *every* `auditLog.record()` call regardless of whether it relates to a call
  at all (rate-limit hits, session refreshes, blocks, etc. — see
  `security.ts:170-207`).
- `server/src/signaling/messageHandlers/send.ts:50` — cache invalidation on
  every chat message send.

**This means `db_detached_queries_total` is not a call-persistence-specific
counter.** micro1's 1212 vs oci's 25 is consistent with micro1 simply doing
far more of *everything* (calls, heartbeats, messages, audit events) than an
idle instance — it does not isolate `persistCallRecord` as the specific
contributor, and the task's framing ("bursts of detached persistence... is
the plausible source") cannot be confirmed or denied from this counter alone.

### Does detached (unawaited) I/O even block the event loop?

This is the load-bearing technical question, and the answer from the code is
**no, not by the mechanism implied** — `runDetached` wraps asynchronous
Postgres/Redis client calls (`callPersistence.ts:50-60`, `security.ts:182-189`,
`stores/redis.ts` saves), which yield to the event loop while awaiting the
network round trip exactly like their awaited counterparts do. Node's
`monitorEventLoopDelay` (from Node's `perf_hooks`, wired up in `telemetry.ts`) measures scheduling lag
between event-loop ticks — i.e. **synchronous** CPU work that never yields —
not time spent waiting on I/O. A detached `await pool.query(...)` cannot by
itself produce a 2009ms `event_loop_lag_max_ms` sample; only synchronous work
that runs to completion without an `await`/microtask boundary can. Firing
*more* detached operations concurrently increases scheduling pressure (more
promise-resolution microtasks and callback queue churn per tick), which is
a real but much smaller effect than "a query blocked the loop for 2 seconds."

### What synchronous work exists near this hot path

Candidates checked:

- `server/src/security.ts:206-207` — `entries.shift()` on a
  `MAX_AUDIT_LOG_SIZE = 1000` (`security.ts:15`) in-memory array on every
  audit record once the log is full. `Array.prototype.shift()` on a
  1000-element array is O(n) but sub-millisecond; not a plausible source of a
  2-second stall on its own, though it adds up under a sufficiently tight
  burst of many audit events in a single tick.
- `server/src/cache.ts:183` — `delByPrefix` uses `client.scanIterator({...,
  COUNT: 100 })`, explicitly chosen over `KEYS` "which blocks the Redis event
  loop" (`cache.ts:196`) — this is Redis-side blocking avoidance, and on the
  Node side `for await` over the iterator yields between batches. It cannot
  explain a Node event-loop stall; it can only make the *awaiting* request
  slower (which is what the 142.84ms `redis scan` maxMs already reflects, in
  `db_slow_queries_total`, not `event_loop_lag`).
- `server/src/push/tokens.ts:63-67,108-110` — synchronous `crypto.createSign`
  JWT signing for push tokens. Plausible microsecond-to-low-millisecond cost,
  and not obviously tied to call volume (push tokens are cached/regenerated
  infrequently, not per-call).

None of these individually explains 2009ms. No single synchronous hot path
proportional to call volume was found in the reachable code.

### Quantifying the risk to the connect-latency tail, if it is a real stall

If a 2s event-loop stall did occur mid-relay, its effect on `handleRtcRelay`
is real regardless of its cause: `handleRtcRelay` is on the hot path for
every offer/answer/candidate/media-state frame (`handleRtcRelay` in
`callHandlers.ts`), and a stalled event loop delays every queued
callback, including the one that would deliver an offer to the callee. A 2s
delay landing on the setup window (`call_setup_latency_ms` mean 5093/5620ms)
would be visible as a fat right tail, not the mean — and the reported means
here are unremarkable relative to their own maxima (max 20490ms / 11809ms),
which are large enough already to include ordinary human hesitation, so this
sample cannot distinguish "a rare stall added 2s to one call" from "that
particular human took longer to answer."

### Verdict

**Needs more data.** The correlation between `db_detached_queries_total` and
`event_loop_lag_max_ms` across the three hosts is real but is fully explained
by both being proportional to overall instance load (call + message + audit
traffic) — nothing here demonstrates that detached I/O *causes* the stall
mechanistically, and the mechanism most consistent with how V8/libuv actually
schedule work says it should not. **What would settle it**: a synchronous
CPU-time histogram (see below) sampled around the same tick as the
`event_loop_lag_max_ms` spike, or wrapping the audit-log `shift()` and any
other suspected synchronous hot path in a `performance.now()` span reported
as its own histogram, so the next occurrence can be attributed directly
instead of by elimination.

### Status: deferred, not shipped in this pass

Per this task's explicit instruction, this phase is deferred rather than
shipped alongside the cheaper Phases 0–3, so it does not hold back the
inexpensive fixes above. The design considered, for whoever picks this up:

- **What to build:** a small, capped span histogram (mirroring the existing
  `db_queries_total`/`pg_query_duration_ms` pattern) recording
  `performance.now()`-bounded durations around a short, explicit list of
  suspected synchronous hot paths (the audit-log `entries.shift()` compaction,
  the per-frame work inside `handleRtcRelay` before its first `await`, and
  JSON (de)serialization of large payloads), *or* capturing which handler
  (`options.eventName` in `handleRtcRelay`, or an equivalent label in other
  hot paths) was executing at the moment `monitorEventLoopDelay` samples a
  spike, so the next occurrence is attributed directly instead of by
  elimination.
- **The hard constraint:** the instrumentation must add no synchronous
  per-event cost to the relay hot path itself — `handleRtcRelay` runs once
  per offer/answer/candidate/heartbeat/state-change frame, so a `Date.now()`
  or `performance.now()` call around *every* invocation is probably fine, but
  anything heavier (allocating a histogram bucket key by string
  interpolation, for example) is not, and should be sampled (e.g. 1-in-N)
  rather than measured on every call if profiling shows it matters.
- **Why deferred rather than shipped now:** the design has two real
  alternatives (span histogram vs. spike-time handler capture) with
  different cost/precision tradeoffs, and picking one without a clear
  performance budget for the relay hot path risks exactly the kind of
  "instrumentation adds the load it's trying to measure" problem this whole
  investigation is about. A separate issue tracks this; Phases 0–3 do not
  depend on it and are not blocked by leaving it open.

---

## 5. Cross-instance observability gap — **Confirmed bug: the two derived ratios are unsafe to read per-instance and should be suppressed/reframed**

### Why the gap exists

`recordCallHeartbeat`/`handleCallConnected` (`callHandlers.ts`) show
the `in_call` transition is recorded by whichever instance's socket receives
the *first* `call.connected` report — which, on a fleet, need not be the same
instance that recorded the `accepted` transition (`calls_accepted`) for the
same call. `calls_accepted` and `calls_in_call` are therefore **not
guaranteed to describe the same population of calls on a given host** — this
is precisely the phenomenon the setup/connect-latency histograms already
guard against via their `_shared`/`_local`/`_unmeasured`/`_skew_rejected`
provenance split (`server/README.md:432-440`), but the two **derived**
ratios do not:

```ts
// server/src/telemetry.ts (in getSnapshot's derived block)
const { calls_initiated, calls_in_call, calls_ended } = snap.counters;
snap.derived.call_connect_rate =
  calls_initiated > 0 ? Number((calls_in_call / calls_initiated).toFixed(4)) : null;
snap.derived.call_completion_rate =
  calls_in_call > 0 ? Number((calls_ended / calls_in_call).toFixed(4)) : null;
```

micro2 shows this directly: `calls_accepted == 3`, 3 setup-latency samples
recorded, yet `calls_in_call == 0` and `call_connect_latency_ms.count == 0` —
the media phase for those exact three calls was handled entirely by micro1.
Reading `call_connect_rate = 0/… = 0` on micro2 as "this instance connects 0%
of the calls it accepts" is **false**; all three connected, just not
observably from micro2. Symmetrically, micro1's `call_completion_rate =
1.3636` (>1, `calls_ended / calls_in_call` with more ends than local
in-calls) is only possible because some `ended` calls it observes were
`in_call`-transitioned by a peer instance — the ratio silently assumes both
counters are drawn from the same call population, and on this data they are
demonstrably not.

### Are they safe to expose per-instance at all?

**No, not as currently defined.** Both ratios divide a numerator and
denominator that can each independently be satisfied by a different instance
than the one reporting the ratio, with no accompanying signal that this
happened. A ratio a reader cannot trust without independently re-deriving
provenance for both its terms should not be shipped as a trustworthy
per-instance figure.

### Proposed fix

Two complementary changes, additive-first:

1. **Ship a second, provably-single-instance variant as the primary fix.**
   Compute it from counters that already carry provenance:

   ```ts
   snap.derived.call_connect_rate_local_only =
     counters.calls_accepted > 0
       ? Number((counters.call_connect_latency_shared / counters.calls_accepted).toFixed(4))
       : null;
   ```

   using `call_connect_latency_shared` (a count of connect-latency samples
   this instance actually recorded) as the numerator instead of the
   fleet-relative `calls_in_call`, so the ratio's two terms are both
   guaranteed local to the reporting instance — additive, no existing field
   renamed or removed.

   **This was checked before shipping and does not hold.**
   `calls_accepted` increments only on the instance that itself handled the
   `accepted` transition (`recordAcceptedCall`), but
   `call_connect_latency_shared` can increment on an instance that never saw
   the accept at all — that is the entire purpose of the shared-timestamp
   path (`measureSinceAnswered` in `server/src/lib/callLatency.ts`), which
   exists precisely so connect latency can still be observed for a call this
   instance only saw the `in_call` side of. So the numerator is not
   guaranteed to be a subset of the denominator's calls, and this ratio can
   exceed 1 for the same structural reason `call_completion_rate` already
   does. **Per the "if it is not actually skew-free, do not ship it" rule:
   this derived field is not shipped.** `server/README.md` documents the
   reasoning instead (see below), and no dedicated same-instance counter
   currently exists that would fix it — building one (e.g. counting accepts
   this instance also later saw connect, keyed by call id) is a real option
   but is out of scope for this pass; it would need its own correctness
   argument before shipping, for the same reason this one didn't survive
   scrutiny.

   Separately, an **annotation-only** option remains available and is
   non-breaking as prose: adding a `_note` string field to `/metrics` was
   considered and dropped — a sentence of English does not survive
   Prometheus's text-exposition translation of a JSON payload into typed
   metric lines, so it would either be silently dropped or mis-typed as a
   metric itself. That explanation belongs in `server/README.md`, not in the
   scrape payload, and has been added there.

2. **A later, possible step: rename the existing fields** to make the
   fleet-relative nature explicit rather than implicit — e.g.
   `call_connect_rate` → `call_connect_rate_fleet_relative` — so a dashboard
   built against the old name breaks loudly instead of silently
   misinterpreting a per-instance read. **This is demoted from the primary
   recommendation.** Breaking a metrics contract is how observability
   disappears mid-incident: a dashboard that suddenly reads `null`/`NaN` for
   a renamed field during exactly the kind of multi-instance investigation
   this report describes is worse than a documented caveat. If a rename is
   pursued later, ship the new name alongside the old one for at least one
   release before removing the old one, and prefer documentation
   (`server/README.md`'s provenance table) as the primary mitigation until
   there is a trustworthy local-only replacement to point dashboards at.

**Blast radius:** documentation-only for this pass (updated `server/README.md`
provenance table); no new derived field shipped, no rename performed, no
wire-format change. The rename remains available as a possible, clearly
breaking, future step and is not implemented here.

---

## Instrumentation gaps (would have made 1, 3 and 5 diagnosable without reading source)

| Gap | Would have settled | Status |
| --- | --- | --- |
| `rtc_relays_other` collapses `call.media-state` heartbeats and real state-change toggles into one bucket (§1) | Whether "other" is heartbeat load (proportional to connected-minutes) or a genuine unexpected-event/loop bug, without opening `telemetry.ts` | **Closed** — `rtc_relays_media_heartbeat` / `rtc_relays_media_state_change` shipped; `rtc_relays_other` now a true unexpected-event bucket |
| `signaling_errors_by_code` has no per-triggering-event breakdown, even though `acknowledgeError` already logs the event name (§2) | Whether the 5 `stale_call_state` acks are stale candidates (expected), stale offers/answers (a real race), or stale media-state (a regression of the fixed bug) | **Closed** — `signaling_errors_stale_call_state_by_event` shipped |
| No metric distinguishes "a ring ended because the timeout fired" from "a ring ended because a user acted first, just before the timeout would have" (§3) | Whether `DEFAULT_RINGING_TIMEOUT_MS` is well-calibrated or effectively unreachable — currently only inferable by comparing `call_ring_duration_ms.max` against the (unexposed-in-metrics) configured timeout value | **Open** — not addressed this pass; `missed` vs `cancelled` is already distinguishable by end reason, but no metric surfaces "how close to timing out" a resolved ring was |
| `/metrics` does not expose the configured timeout values themselves (`DEFAULT_RINGING_TIMEOUT_MS`, `DEFAULT_MEDIA_CONNECT_TIMEOUT_MS`, etc.) | Same as above — a scrape currently cannot even state what the sweep's threshold *is* without reading `config.ts`, so "82s ring, is that close to timing out?" is unanswerable from `/metrics` alone | **Open** — not addressed this pass |
| `dbQueries` per-operation breakdown does not carry the `blocking` dimension already computed per-record | Whether the outlier `pg insert maxMs 176.61` / `redis scan maxMs 142.84` samples were detached (nobody's request paid for them) or blocking (a user-facing operation did) — currently ambiguous from the exposed breakdown even though the underlying `QueryTimingRecord.blocking` field already has the answer | **Closed** — each `dbQueries` entry now carries a `detached` count |
| No synchronous-CPU-time histogram exists at all (§4) | Whether `event_loop_lag_max_ms` spikes correlate with a specific synchronous code path (e.g. the audit-log array `shift()`, JSON stringify bursts) rather than with query *volume*, which this report could only rule out, not confirm a replacement cause for | **Deferred** — design considerations documented in §4 and the PR description; tracked as a separate follow-up so it does not hold back the cheaper fixes above |
| `calls_accepted`/`calls_in_call`/`calls_ended` used in derived ratios carry no same-instance guarantee (§5) | Whether `call_connect_rate` / `call_completion_rate` describe this instance's calls or a fleet-relative artefact — currently indistinguishable without independently checking the `_shared`/`_local` latency counters | **Open, documented** — the obvious same-instance replacement (`call_connect_latency_shared / calls_accepted`) was checked and found not to be skew-free either (see §5), so nothing was shipped; `server/README.md` now states which existing ratios are fleet-relative so readers are not misled in the meantime |

---

## Ruled out

- **Storage performance as the bottleneck for anything above — ruled out.**
  Zero `db_query_errors_total`-attributable failures, zero
  `db_blocking_slow_queries_total` on either active host (i.e. no user-facing
  request actually waited on a slow query), and only 4 (micro1) / 2 (micro2)
  slow queries total against `db_queries_total` volumes implied by 1212/388
  detached queries alone — a slow-query rate under 1%. The named outliers
  (`pg insert` maxMs 176.61/188.23, `redis scan` maxMs 142.84) are all
  comfortably below any of the call-state timeouts (media-connect timeout,
  ringing timeout) that would need to be threatened for storage to plausibly
  explain the setup/connect latency figures. `cache_hit_rate` (0.38/0.3704/
  0.4156) is low but is a cost/efficiency question, not a correctness or
  latency-tail one — nothing in the setup/connect/ring histograms shows a
  bimodal "cache miss tax" pattern that would implicate it. **Confirmed ruled
  out** as an explanation for the setup-latency, connect-latency, or
  event-loop anomalies in this scrape.
- **Long ring windows reopening the fixed `stale_call_state` media-relay bug
  (§2) — ruled out.** The gate is state-based, not time-based; see §2 for the
  code-level argument. A ring lasting 82s cannot, by this mechanism, cause a
  frame to be sent early.
- **The ring-timeout sweep firing too slowly to matter (§3) — ruled out** as
  an explanation for the 82s ring durations. The 5s poll interval is two
  orders of magnitude finer than the 120s deadline it enforces; sweep
  cadence is not the constraint on any ring observed here, since none reached
  the deadline in the first place.
- **`calls_missed` being dead/unreachable code (§3) — ruled out.** The
  transition exists, is exercised by the test suite, and is only absent from
  this specific sample because every observed ring resolved via explicit user
  action before its 120s deadline — a sample-window artefact, not a code
  defect. (Whether it is *effectively* unreachable at realistic ring lengths
  in production generally is a separate, open question — see §3's "needs more
  data.")
- **A client-side render-loop or timer bug driving `rtc_relays_other` (§1) —
  ruled out.** Both emitters (state-change relay, heartbeat) are
  state/interval-driven with concrete, bounded triggers, and the observed
  volume is consistent with heartbeat cadence over plausible call durations,
  not with an unbounded per-render emission.
