# Diagnosing `call_connect_latency_ms` (`accepted → in_call`)

Production `/metrics` on `micro2` (`INSTANCE_ID=1`) reported two `accepted → in_call`
samples, `min 1384` / `max 9468` / `mean 5426` ms, corroborated by a signaling log for
`callId=4cc2cdfa-df32-4a02-ad4f-bf998101660f` that spent ~6–7 s in `connecting_media`
across two VMs (`accepted` and `connecting_media` on `micro1`, `in_call` on `micro2`).

This is the written analysis for that investigation. No call state or transition logic is
changed here, and no fix is proposed for a cause that the current data cannot single out.
The headline is that **the metric cannot see the class of call the log shows**, so the two
numbers and the log are measuring different populations and must not be read together.

## 0. The metric excludes cross-instance calls by construction

`call_connect_latency_ms` is only observed when `acceptedMs` is already set for that call
**in the same process**:

- `telemetry.ts:262` — `callTimestamps` is a plain in-process `Map`.
- `telemetry.ts:269-277` — an entry is created *only* by `recordCallCreated`, whose sole
  caller is `notifyCallCreated` (`domain/notifications.ts:372-373`), i.e. the instance that
  handled `POST /calls` for the **caller**.
- `telemetry.ts:335-346` — `recordAcceptedCall` / `recordInCall` do nothing when
  `callTimestamps.get(callId)` misses, and `recordInCall` observes the histogram only when
  `ts.acceptedMs !== null` (`telemetry.ts:302-308`).
- `domain/notifications.ts:438-446` — `recordCallTransition` runs inside
  `notifyCallTransition`, which only the instance performing the transition calls.
- `domain/callSync.ts:1-14, 95-116` — a peer instance's transition deliberately re-emits
  and re-records nothing; it repairs local state only.

`call.accept` is handled on the **callee's** socket instance
(`signaling/connection/registerSocketHandlers.ts:290`). So for a cross-instance call the
caller's instance — the only one holding a `callTimestamps` entry — never sets
`acceptedMs`, and no `call_connect_latency_ms` sample is ever produced. (The one exception
is the HTTP answer fallback in `mobile/src/hooks/useAnswerPath.ts:238-244`, which can land
on either VM; it runs only after the socket accept has failed.)

Two consequences, both important:

1. The `9468` ms worst case is almost certainly a **same-instance** call. Candidate 3
   (cross-instance relay cost) therefore cannot be the explanation for it.
2. The 6–7 s cross-instance call in the log is **not** one of the two samples. The
   magnitudes agree only by coincidence; nothing here yet shows they share a cause.

With `n=2` from a biased sampler, no dominant contributor can be named from this data. The
rest of this document is the elimination pass, followed by the instrumentation that would
settle it.

## 1. TURN credential minting — off the steady-state path

Both ends of the fetch are cached, and the fetch is prefetched before a call exists:

- Server: the Cloudflare mint is process-wide cached and refreshed at 90 % of TTL
  (`routes/turnCredentials.routes.ts`, `cache.refreshAt = now + ttl * 0.9`), so at most one
  call in an hour pays the Cloudflare round trip, and it is paid by whichever request is
  unlucky — not by every call.
- Client: `getIceServersForCall` serves from a cache with a 55-minute default TTL and a
  60 s refresh margin, and concurrent callers share one in-flight promise
  (`mobile/src/webrtcConfig.ts:11-12, 284-296, 327-333`).
- The cache is warmed on every socket connect (`hooks/useSignalingSocket.ts:255`) and on
  push rehydration before the call lookup (`hooks/useCallFlow.ts:1330-1336`).

The only `await` on the call path is in `createPeerConnection`
(`hooks/usePeerConnection.ts:204-207`). It is a cache hit except on a cold process whose
prefetch has not landed — precisely the push cold-start case, where it races the accept.
**Not eliminated for cold starts, eliminated for warm ones**, and it is unmeasured either
way: the fetch logs a tier but no duration.

## 2. Early ICE candidates — the buffer exists, but the replay is instance-local

The 2026-09-10 fix (`docs/OPTIMIZATION_PLAN.md:180-188`) did two things: shared-store
hydration before rejecting a frame, and a hold-and-replay buffer. Hydration is now sound —
`handleRtcRelay` re-reads the shared record with `maxAgeMs: 0` before deciding a frame is
stale (`signaling/callHandlers.ts:307-313`), so a merely-behind local cache no longer
causes buffering at all. Buffering is now reached only when Redis itself still says
`ringing`, i.e. a genuine race with the accept commit.

The replay, however, did not follow the state into Redis. `state.pendingRtcSignals` is a
per-process `Map` (`stores/contracts.ts:195`), and every `flushBufferedRtcSignals` call
site is on the instance that performed the transition:

- `signaling/callHandlers.ts:164` — socket transition (`call.accept`, `call.connected`).
- `signaling/callHandlers.ts:235` — `promoteToConnectingMedia`.
- `routes/calls.routes.ts:306, 347, 388, 429` — the HTTP transition routes.

Nothing flushes on a **remote** transition: `applyRemoteTransition` adopts the shared
record and, for terminal states only, discards the buffer
(`domain/callSync.ts:50-91`). A remote move to `accepted` / `connecting_media` / `in_call`
leaves the buffer untouched.

Nor does the relay path recover it afterwards. Once the instance's view is media-ready,
frames are relayed directly with no flush (`signaling/callHandlers.ts:311-345`), and the
one path that would flush — `promoteToConnectingMedia` — returns early when its
`accepted → connecting_media` CAS loses, which is exactly what happens when the peer
instance has already made that transition (`signaling/callHandlers.ts:223-236`).

So on a cross-instance call, a candidate emitted by the caller between "callee tapped
accept" and "the accept is committed to Redis" is buffered on the caller's instance and
**never replayed** — it is silently dropped by `releaseCallResources` when the call ends.
The frames lost are the caller's earliest ones, which are its host and server-reflexive
candidates: the pairs that would have connected fastest. ICE still completes on later
trickle or a re-gather, which is the shape of a multi-second `connecting_media`.

This is a confirmed code-level gap and the strongest *mechanism* for the logged 6–7 s
call. It is **not** confirmed to have fired on that call: nothing counts buffering. The
buffer logs `rtc.buffer_flushed` / `rtc.buffer_dropped` (`signaling/rtcBuffer.ts`) but a
stranded buffer produces **neither** line, because `callSync` deletes it without logging
(`domain/callSync.ts:57-60`). Absence of evidence here is literally by design.

This also explains nothing at all about the same-instance `9468` ms sample: on a single
instance the accept and the flush are the same handler.

## 3. Cross-instance relay cost — eliminated

Relay is one `emitToUserSockets` through the Redis adapter per frame
(`signaling/callHandlers.ts:344`). The only awaited server work on the path is the
freshness re-read for a non-media-ready frame (`:307-313`) and one CAS for the first frame
(`:320-321`). Against `redis_query_duration_ms` mean 0.71 ms / max 6.70 ms over 397
operations, the arithmetic does not reach seconds even with tens of candidates. Nothing on
this path awaits a *round trip per candidate* for media-ready calls.

## 4. Relay vs host/srflx selection — unanswerable from server data

The server never learns the selected candidate pair; it relays opaque candidate blobs.
The client logs each **sent** candidate's summary (`summarizeIceCandidate`) but never the
pair that won. This hypothesis cannot be confirmed or eliminated without new client
telemetry (§6). It remains plausible, and it is *downstream of* §2: dropped host/srflx
candidates are one way a call ends up on a relay pair.

## 5. `call.connected` reporting lag — eliminated as a large contributor

`reportCallConnected` emits synchronously from the ICE state-change handler, with no
debounce, no timer and no awaited work
(`mobile/src/hooks/useCallRecovery.ts:378-397`); the server transitions on receipt
(`signaling/callHandlers.ts:349-388`). The reporting itself adds a socket hop.

What *is* inside the measured window, and is not media latency in the usual sense, is the
callee's media acquisition — see §6a.

## 6. Where the unmeasured seconds most plausibly are (mobile)

The caller pre-warms its stream **before** dialling (`hooks/useCallFlow.ts:1697`), so the
`startLocalPreview()` in `sendInitialOffer` returns the already-acquired stream without
touching the camera (`hooks/useLocalMedia.ts:47-48`); on `accepted` the caller only creates
the peer connection and offers (`hooks/useCallFlow.ts:1187-1205`).

The callee does the opposite. Everything below runs **after** `call.accept` is
acknowledged and therefore entirely inside `accepted → in_call`
(`hooks/useAnswerPath.ts:350-371`):

- `getMissingCallPermissions()`, and `bringAppToForeground()` when something is missing
  (`hooks/useAnswerPath.ts:249-261`);
- `startLocalPreview()` → `ensureCallPermissions()` then `getUserMedia`, which always
  requests `video: { facingMode: 'user' }` even for a voice call
  (`hooks/useLocalMedia.ts:47-79`) — a camera open, not a microphone open;
- `ensurePeerConnection()`, which awaits the ICE-server fetch (§1) and constructs the
  `RTCPeerConnection` (`hooks/useAnswerPath.ts:283-289`, `hooks/usePeerConnection.ts:204`).

On a push-woken cold start that is a permission round trip, a camera initialisation and
possibly an uncached TURN fetch, serialised, before the callee can answer the offer. This
is the largest block of serialised work on the path and it is **mobile-side**. It fits a
same-instance 9.5 s sample far better than anything in `server/src/`.

A secondary observation, recorded but not claimed as latency: because the peer connection
is created from whatever `localStreamRef` holds at that moment
(`hooks/usePeerConnection.ts:218-231`), an offer that arrives before `getUserMedia`
resolves yields a peer connection with no local tracks. That is a media-content question,
not a timing one, and is out of scope here.

## Conclusion

The current data is **insufficient** to name a dominant contributor, and the two available
samples are drawn from a population that excludes the case the log shows. Ranked by
strength of evidence:

1. **Callee-side serialised media acquisition** (§6) — entirely inside the window,
   unmeasured, and the only candidate whose cost is plausibly seconds on a same-instance
   call. Mobile.
2. **Stranded cross-instance candidate buffer** (§2) — a confirmed code gap that fits the
   cross-instance log exactly, but cannot be shown to have fired because nothing counts
   it. Server.
3. **Cold-start TURN fetch** (§1) — on the path only for an unwarmed cache; unmeasured.
   Mobile, with a server-side cache that is already correct.
4. **Relay-vs-direct selection** (§4) — plausible, unobservable today. Mobile.
5. **Cross-instance relay cost** (§3) and **reporting lag** (§5) — eliminated.

## Instrumentation that would settle it

None of the following changes call state or transition logic.

**Server (`server/src/`)**

- Make the metric cross-instance-safe. `answeredAt` is already on the shared record and is
  stamped on the accepted transition (`domain/calls.ts:196-198`), so the `in_call`
  observation can be derived from the record (`now − Date.parse(call.answeredAt)`) instead
  of from a process-local `acceptedMs`. Until then, note in any report that the histogram
  covers same-instance calls only. Cross-VM clock skew becomes a factor; NTP discipline on
  both hosts is a precondition.
- Count the buffer. `rtc_signals_buffered`, `rtc_signals_replayed`,
  `rtc_signals_stranded` (buffer non-empty when the call ends) turns §2 from a mechanism
  into a measurement. Today the only trace is two `console.log` lines, and the stranded
  case emits neither.
- Log the elapsed `accepted → connecting_media → in_call` split per instance on the
  existing `[signaling] call.transition` line, so a single journal grep attributes the
  interval without cross-referencing two hosts.

**Mobile (`mobile/src/call/`, `mobile/src/hooks/`)**

- Extend the existing `reportAnswerStage` receipts with stage durations for
  `permissions_checked`, `media_acquired`, `peer_connection_ready`, `answer_sent`. The
  transport already exists and already carries `latencyMs`; §6 is unfalsifiable without
  it.
- Time the ICE-server fetch and report the tier it landed on (`cache` / `fetched` /
  `stale-cache` / `build-time-config`) with a duration, so §1 is separable from §6 rather
  than hidden inside it.
- Report the selected candidate pair's types (`host` / `srflx` / `relay`) from
  `getStats()` at the moment `call.connected` is emitted. That answers §4 outright, and
  distinguishes "ICE was slow" from "ICE gave up on direct paths".
- Record whether `iceRestartLadder` fired during the window. The first rung is immediate
  and the second is 1500 ms (`mobile/src/call/iceRestartLadder.ts:33-34, 57-64`), so a
  restart inside `connecting_media` would inflate the interval by seconds; nothing today
  correlates a restart with the connect metric.

**Measurement methodology**

Metrics are per-process and reset on restart, with no cross-VM aggregation. Any read must
scrape `micro1` and `micro2` separately, in the same window, and must not sum histograms
whose populations differ (§0). With per-host counts in the low single digits, the useful
unit of evidence for now is the per-call journal trace, not the histogram.
