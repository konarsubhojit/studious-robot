# Diagnosing silent `signaling_errors` during socket reconnect churn

A `/metrics` snapshot covering a single voice call (`callId=d801e70a-…`, caller `zen`,
callee `nez`) plus a synthetic message burst reported `signaling_errors: 60`,
`calls_in_call: 1` / `calls_ended: 0`, a 9486 ms `call_setup_latency_ms` sample and a 5 %
cache hit rate — while the journal contained **zero** error lines for the same window.

This document records the investigation and the one narrow instrumentation change that
came out of it.  Nothing here fixes the transport drops or the cache: the goal of this
pass is to make the next occurrence self-diagnosing.

## Why the errors were invisible

`acknowledgeError()` (`server/src/signaling/ack.ts`) recorded the error in telemetry and
returned the envelope to the client, but never logged.  The aggregate counter is a single
number with no code, event, socket or user attached, so a burst of 60 errors was
indistinguishable from 60 different failures.

## 1. Does `socket.data.identity` survive a reconnect?

No — and it does not have to.  Every reconnect produces a brand new socket with an empty
`socket.data`; identity is re-resolved from the handshake `auth` payload on the
`connection` event, and only *after* it resolves are the event handlers registered:

- `server/src/signaling/connection/registerSocketHandlers.ts:34-36` — `const identity =
  await resolveSocketIdentityAsync(socket, state); socket.data.identity = identity;`, run
  before any `socket.on(...)` registration in the same handler.

Because the handlers themselves are only attached after that `await` resolves, there is
**no window** in which an RTC event reaches `requireSocketSession` (`ack.ts:15-28`) with
identity unset — an event that arrives during the gap has no listener yet and is dropped
rather than mis-handled.  What *can* happen is that the client reconnects without a valid `sessionId` (expired or omitted), in which case
`resolveSocketIdentityAsync` downgrades it to a guest with `sessionId: null` and every
subsequent `rtc.*` event fails the guard with `unauthorized`.

That path, however, does **not** explain the observed 60: guard failures are not counted
(see §3).  The counted errors must come from a code path that passes `state`.

## 2. Error codes `handleRtcRelay` can emit

`server/src/signaling/callHandlers.ts:162-278`:

| Code | Site | Counted? | Likelihood under reconnect churn |
| --- | --- | --- | --- |
| `stale_call_state` | `:232` — status outside `RTC_ACTIVE_CALL_STATES` | yes (`state` passed) | **Highest.** After a `transport close` both sides restart ICE while the record is being swept or is still `ringing`/already `ended`. |
| `call_not_found` | `:209` — `hydrateCallFromShared` returned nothing | yes | High. The record is gone from the local map and the shared store lookup misses. |
| `forbidden` | `:221` — requester is neither participant | yes | Low; requires an identity mismatch, e.g. a guest-downgraded reconnect getting a fresh anonymous `userId`. |
| `rate_limited` | `:187` | yes | Low, but plausible: ICE candidates from two peers re-offering repeatedly. |
| `unauthorized` | `:169` guard | **no** | Common in fact, invisible in metrics. |
| `unsupported_version` | `:172` guard | **no** | Negligible. |

Given ~60 errors in a 9.5 s setup, per-code attribution is exactly the missing datum — the
patch below supplies it, so the next snapshot answers this question directly instead of by
ranking.

## 3. `signaling_errors` is undercounted

`requireSocketSession` and `validateSignalingVersion` do not accept a `state` argument at
all, so the `acknowledgeError` they issue is never recorded.  All 16 call sites are
affected:

- `server/src/signaling/connection/registerSocketHandlers.ts:149,152` (`call.initiate`),
  `:232,235` (`call.incoming_ack`), `:365,368` (`call.state_report`)
- `server/src/signaling/callHandlers.ts:81,84` (call transitions), `:169,172` (RTC relay)
- `server/src/signaling/messageHandlers/index.ts:19,22` (`message.send`), `:42,45`
  (`message.delete`), `:135,138` (`message.react`)

`parseInboundPayload` does take `state`, but the room handlers pass none
(`registerSocketHandlers.ts:119,127,135`), so malformed room payloads are also uncounted.

Consequence: every `unauthorized` and `unsupported_version` rejection — precisely the
failure mode a reconnect storm produces — is missing from `signaling_errors`.  The
`console.warn` added in this pass closes the observability gap without changing the
counter semantics; threading `state` through the guards is a follow-up.

## 4. Why the call never reached `ended`

Terminal transitions come from three places: an explicit `call.end`, the expiry sweep
(`getCallExpiry` → media-connect / heartbeat / max-duration timeouts), and disconnect
cleanup.  The disconnect path is `scheduleParticipantDisconnectCleanup`
(`server/src/signaling/connection/lifecycle.ts:23-36`) → `endCallsForDisconnectedParticipant`
(`server/src/domain/calls.ts:316-336`), which bails out early:

```ts
if (call.status === 'ringing') continue;
if (hasLiveSockets(state, call.callerId) || hasLiveSockets(state, call.calleeId)) continue;
```

With the observed churn — 5–60 s sessions, `remainingUserSockets=0` on every disconnect,
reconnects within seconds — each grace timer fires *after* at least one participant has
reconnected, so `hasLiveSockets` is true and the call is skipped.  Both participants were
at zero sockets simultaneously at 08:10:33 and 08:10:40, but only transiently: the timers
are scheduled per disconnect and evaluated later, never at the moment of the shared gap.

The record therefore stays `in_call` until the max-duration sweep, which is why
`calls_ended` stayed at 0 and `call_duration_ms.count` never incremented.  That is a real
bug, but fixing it means changing cleanup semantics (evaluate liveness at schedule time, or
re-arm the heartbeat deadline on reconnect) and is deliberately out of scope here.

## 5. Cache invalidation expansion

`invalidateCache(state, ...prefixes)` issues exactly one `delByPrefix` per non-empty
prefix.  Per user-visible action:

- `messageHandlers/send.ts:232-237` — 3 prefixes (both participants' conversation lists +
  the message list) per send, plus `:256` — 1 more when the recipient is online and the
  message is marked delivered.
- `messageHandlers/index.ts:109-113` — 3 per delete; `:221` — 1 per reaction.
- `routes/messages.routes.ts:335-339` — 3 per read receipt.

A single delivered-and-read message therefore costs 4 + 3 = 7 `delByPrefix` calls, and a
conversation of two participants both reading trends toward the ~11 observed.  Against
`cache_hits: 3` / `cache_misses: 57` (5 %), each write pays several prefix scans to save
one read in twenty.  At these rates the cache is a net loss; the options are a longer TTL,
coarser keys, or removing the layer.  Not changed in this pass.

## The patch

- `recordSignalingError(code)` now keeps a per-code tally alongside the aggregate counter,
  exposed as `signaling_errors_by_code` on `/metrics` (e.g.
  `{ "stale_call_state": 42, "call_not_found": 18 }`).  Distinct codes are capped at 50,
  with the overflow folded into `other`, mirroring the query-operation cap.
- The aggregate `signaling_errors` counter is unchanged, so existing scrapers keep working.
- `acknowledgeError()` logs every rejection with its code, event name, socket id, user id
  and message — including the guard failures that telemetry still does not count.
