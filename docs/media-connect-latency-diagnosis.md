# Diagnosing `call_connect_latency_ms` (`accepted → in_call`)

Source audit: `ab7591677e979d0a86b1137e99743fc5f3bdc5fd`, 2026-10-02.

The original investigation compared a very small latency sample with a
cross-instance call trace. Its useful conclusion was methodological: the old
process-local timestamp sampler excluded cross-instance calls, so those
observations could not establish one dominant cause. Those samples are not a
baseline for the repaired metric.

## 1. Current metric and instrumentation

`server/src/lib/callLatency.ts` derives connect latency from the call record's
`answeredAt`, with bounds checks for negative/implausible elapsed times.
`server/src/telemetry.ts` prefers that shared timestamp and exposes
`call_connect_latency_shared`, `_local`, `_unmeasured` and `_skew_rejected`
provenance counters. Host clock agreement remains a prerequisite.

Implemented instrumentation is no longer a to-do list:

- `useAnswerPath.ts` reports permissions, media acquisition, peer readiness and
  answer stages through the answer timeline.
- `webrtcConfig.ts` measures the ICE-server fetch and reports its tier.
- `useCallRecovery.ts` and `call/iceStats.ts` report `media_connected`,
  candidate-pair information and the restart count.
- `server/src/signaling/rtcBuffer.ts` counts buffering, replay and local/remote
  stranded outcomes.

Source inspection does not supply new production latency measurements.

## 2. Remaining cross-instance replay limitation

Early RTC signals are held in the process-local `pendingRtcSignals` map.
Local transitions flush through `flushBufferedRtcSignals`; however,
`server/src/domain/callSync.ts`'s `applyRemoteTransition` adopts peer state
without flushing on a remote move to a media-ready state. A remote terminal
transition discards held frames via `releaseCallResources`, counting them as
`stranded_remote`.

That remains a code-level loss mechanism, not proof that it caused a particular
slow call. Compare `rtc_signals_buffered`, `_replayed`, `_stranded_local` and
`_stranded_remote` with call traces before assigning causal weight. Fixing replay
and changing the metric population together would make improvements difficult
to attribute; the instrumentation and replay behaviour are separate concerns.

## 3. Media acquisition and cold starts

The callee's answer path still includes permission checks, media acquisition and
peer readiness after accept. `useLocalMedia.ts` now requests `video: false`
for audio calls; the old premise that every voice answer opens the camera is
false.

`webrtcConfig.ts` caches/coalesces ICE-server requests. Socket-connect and
push-rehydration paths prefetch them. A cold process can still race that prefetch,
so the measured fetch tier/duration matters more than assuming every call pays
an external credential round trip.

## 4. Relay work

`handleRtcRelay` performs auth/state checks, may refresh shared call state, and
relays to the peer. Its diagnostics include a bounded room-recipient lookup for
selected event types. Do not treat older claims of negligible relay cost as a
measurement of the current path; separate datastore, diagnostic and network
costs with current traces.

## 5. Interpretation limits

The selected pair and answer stages make several old hypotheses observable;
they do not establish which contributor dominates without new data. A
same-instance trace and a cross-instance trace can have different bottlenecks.
No source-only review establishes the frequency or latency impact of stranded
candidates, cold-start permissions or relay selection.

## 6. Measurement method

Scrape each instance in the same observation window, retain process/restart
identity, and inspect histogram provenance before comparison. Do not infer
per-instance funnel conversion from transitions that can occur on different
hosts. Correlate per-call traces with answer-stage durations, candidate types,
ICE restarts and buffer outcomes; small histogram counts alone are insufficient.
