# Performance code review — current source

**Audit date:** 2026-10-02. **Baseline:** `origin/master`,
`ab7591677e979d0a86b1137e99743fc5f3bdc5fd`. The audited source tree is identical
to that baseline; this is a requested whole-source audit, not a claim that these
risks were introduced by this documentation change.

## Scope and verdict

The code has meaningful bounds, indexed history reads and latency provenance.
That is not evidence that production meets its latency budget. **Production
metrics, load-test runs and physical-device performance were not validated.**
This source review made no application-code changes and ran no tests itself.
The coordinating task ran server/mobile lint and typecheck successfully;
server tests passed (685 passed, two database-gated skips out of 687), and
mobile tests passed (152 suites, 2564 tests). Mobile output retained pre-existing
React asynchronous-logging/open-handle warnings. These validations do not
establish production latency, live database query plans or physical-device
behavior. Existing test references below describe source coverage; database-gated
coverage was not exercised by the reported server run.

The actionable, open correctness finding is the load rig's phase/hold timing
(§6). The other sections distinguish remaining performance risks from paths
that are already mitigated or not reachable through normal production startup.

## Alert contract and interpretation

These are the actual strict comparisons in
`deploy/robot-metrics-check.sh:125-137`, not proposed targets:

| Signal | Checker condition |
| --- | --- |
| Postgres | `pg_query_duration_ms.max > 100` ms |
| Event loop, spike | `event_loop_lag_max_ms.max > 100` ms |
| Event loop, sustained | `event_loop_lag_ms.mean > 10` ms |
| Cache | `cache_hits + cache_misses >= 100` **and** `cache_hit_rate < .20` |
| Media connection | `call_connect_latency_ms.mean > 5000` ms |
| Redis | `redis_query_duration_ms.max > 50` ms |

The histograms and counters accumulate in the process; snapshots do not reset
them (`server/src/telemetry.ts:848-890`). In particular, one historical query
outlier can keep a maximum alert active until restart. Event-loop observations
are window means and maxima, sampled on a timer and reset at the native monitor
level (`server/src/telemetry.ts:398-421,829-839`); the reported sustained mean is
an accumulated mean of those window means, not a request-latency percentile.
Histogram means are rounded (`server/src/telemetry.ts:264-272`).
The checker tracks restart/reset markers
(`deploy/robot-metrics-check.sh:48-79`); compare deltas within a process epoch
and retain the sample count rather than presenting cumulative snapshots as a
fresh measurement window.

## 1. Event-loop lag: synchronous work remains, but distinguish backends

**Concrete path:** `GET /conversations` misses its cache and awaits
`messageStore.listConversations`
(`server/src/routes/messages.routes.ts:375-391`). In the memory backend,
`summariseConversations(messages, userId)` walks **all stored messages**,
builds summaries and sorts them; only afterwards does the caller slice to
`MAX_CONVERSATION_LIMIT`
(`server/src/messageStore/conversations.ts:26-55`;
`server/src/messageStore/memoryStore.ts:136-153`). This is synchronous
O(total messages + user conversations log user conversations) work. A result
cap does not bound its scan or intermediate allocation.

**Current mitigations/reachability:** PostgreSQL instead limits its
conversation projection before joining latest-message pointers
(`server/src/messageStore/pgStore.ts:394-446`). The factory selects PostgreSQL
when a database handle exists; otherwise it permits memory outside production,
or with an explicit production opt-in/injected store
(`server/src/messageStore/factory.ts:26-43`). More importantly, the standard
CLI bootstrap rejects absent `DATABASE_URL` under `NODE_ENV=production` even
with that message-store opt-in (`server/src/index.ts:70-73`). The deployed
service runs this entry point and sets production mode
(`deploy/robot-signal.service:24,94`). Thus the no-database scan is **not a
normal deployed production fallback**, nor does a PostgreSQL query failure
switch this store to memory.

**Remaining risks/action:** Custom `createServer` callers can inject memory;
an environment override that removes production mode can also allow the
no-database runtime. The service accepts optional environment files
(`deploy/robot-signal.service:103-107`); deploy scripts install/restart and
check service state, not a separate database-environment preflight
(`deploy/deploy.sh:30-48`; `deploy/redeploy.sh:10-22`). Preserve the startup
guard, confirm the effective deployed environment, and require indexed
summaries/retention if memory is deliberately used at scale. Do not diagnose
a production lag alert as this scan without first checking the selected store.
Production event-loop behavior and device JS-thread behavior remain unvalidated.

## 2. Cache-hit rate: bypass is not a recorded miss

**Concrete path:** First-page history reaches `readCached`; a `before` cursor
sets `cacheKey = null` and goes directly to `listMessages`, without a cache
read or fill (`server/src/routes/messages.routes.ts:102-138`). Consequently
deep pagination **does not directly increment cache misses or enter the hit-rate
denominator**. It can increase datastore load correlated with poor cache
effectiveness, but the aggregate ratio is only a correlation proxy for that
uncached traffic, not its measurement.

**Current mitigations:** First-page reads share a screen-sized key; larger
pages have size-specific keys. Cache TTL and memory LRU are bounded
(`server/src/cache.ts:30-36,124-155`), and invalidation fans out over the bus
(`server/src/cache.ts:372-394,404-417`). History fills check an invalidation
marker before writing (`server/src/cache.ts:342-356`).

**Remaining risks/accounting:** `readCached` counts a returned value as a hit,
undefined/errors as a miss, and no configured cache as neither
(`server/src/cache.ts:315-327`). The invalidation-marker read itself calls
this same recorder (`server/src/cache.ts:353`): a history fill can add a
marker hit/miss in addition to the payload lookup. A marker hit is not a
user response served from cache, and a marker miss is not another datastore
fallback. The ratio therefore mixes payload effectiveness and coherence checks.
High write churn invalidates recipient/message prefixes before delivery and
again after delivery marking
(`server/src/signaling/messageHandlers/send.ts:130-160`), so misses are not
automatically a cache defect. Future metrics should separate payload lookups,
coherence checks and bypasses using a bounded key-family taxonomy (§5), not
conversation/user IDs. Keep the checker's **100 recorded lookups** gate.
Production cache ratios and device refresh behavior remain unvalidated.

## 3. PostgreSQL: indexed receipts today; optional API still admits a scan

**Concrete path:** Online message sends persist transactionally, update the
conversation projection, invalidate caches and mark delivery before returning
(`server/src/messageStore/pgStore.ts:217-250`;
`server/src/signaling/messageHandlers/send.ts:100-160`). The current PostgreSQL
store does not implement `enqueueDeliveryReceipt`; the caller's fallback
therefore awaits `markDelivered(messageId, recipientId, conversationId)`.
Those statements reach the instrumented pool/client
(`server/db/client.ts:38-51,103-115`) and hence the Postgres histogram.

**Current mitigations:** `markDelivered` uses the composite primary key when
given the conversation, and performs an idempotent array append in the database
(`server/src/messageStore/pgStore.ts:359-391`;
`server/db/schema.ts:227-237`). History uses indexed conversation ordering,
bounded SQL pages and timestamp/message-ID tie-breaks
(`server/src/messageStore/pgStore.ts:265-287`). Conversation summaries now
read the bounded projection, not an application-side full history.
The limit bounds selected rows and subsequent message-pointer joins, **not
all work needed to select those rows**: the participant predicate is an `OR`
over two separately indexed columns before `ORDER BY ... LIMIT`
(`server/src/messageStore/pgStore.ts:408-420`;
`server/db/schema.ts:285-295`). These indexes do not prove a single ordered
scan without a sort or O(`MAX_CONVERSATION_LIMIT`) total execution cost.

**Caller audit:** The production direct call is
`server/src/signaling/messageHandlers/send.ts:147-151` and supplies the third
argument. Its enqueue branch also includes `conversationId` (lines 140-145).
Omissions in `server/test/message-store.test.ts:287-299,405` use the memory
store; `server/test/message-store-pg.test.ts:378-398` intentionally exercises
the PostgreSQL warning/fallback. The normal PostgreSQL tests supply the key
(lines 359-375). Route/search test doubles only implement the method; they are
not additional production callers. **No production caller omitting
`conversationId` was found; no missing-key production issue is warranted.**

**Remaining risks/action:** The shared signature still makes that argument
optional, although `DeliveryReceiptInput` requires it
(`server/src/messageStore/types.ts:72-80,97-110`). Omitting it warns and issues
`WHERE message_id = ...` without a matching leading index in the schema.
This admits table-/index-wide work and, because uniqueness is composite,
can update matching IDs in multiple conversations. It is a latent API hazard,
not an observed hot-path scan. Require the composite key for durable callers
or reject missing keys in a future hardening change. Projection selection/sort
cost, projection-write contention, multiple round trips and pool/remote-database
latency still need measurement; the configured pool is bounded
(`server/db/client.ts:81-98`),
but that alone is not a latency guarantee. Production query plans, the
`>100` ms maximum alert and device-visible send latency remain unvalidated.

## 4. Call connection and Redis: follow the critical path, not just names

**Concrete call path:** Acceptance stamps `answeredAt`
(`server/src/domain/calls.ts:197-198`); the participant's `call.connected`
report transitions media to connected
(`server/src/signaling/callHandlers.ts:519-565`). Telemetry measures accepted
to `in_call`, preferring the shared timestamp and tracking local/unmeasured/
skew-rejected provenance (`server/src/telemetry.ts:493-513`). This is not
ringing time or proof that both devices render usable media.

**Concrete Redis path:** A history/conversation cache lookup runs timed Redis
`get`; accepted sends run timed invalidation sweeps and deletes
(`server/src/cache.ts:209-258`;
`server/src/signaling/messageHandlers/send.ts:130-160`). Shared call-state
reads/transitions are also timed
(`server/src/stores/redis.ts:228-230,299-300`), so despite its cache-oriented
comment, `redis_query_duration_ms` is not exclusively cache latency.
`recordDbQuery` feeds the Redis histogram for Redis records
(`server/src/telemetry.ts:783-785,815-826`).

**Current mitigations:** RTC call-state reads use a freshness window instead
of one Redis round trip per frame
(`server/src/config.ts:26-38`;
`server/src/domain/sharedCalls.ts:55-83`). Early ICE candidates have a per-call
buffer cap; SDP offers/answers are not buffered
(`server/src/signaling/rtcBuffer.ts:34-84`). Implausible or negative
cross-host elapsed times are rejected
(`server/src/lib/callLatency.ts:83-106`). Cache invalidation uses `SCAN`, not
blocking `KEYS`, and deletes in batches.

**Remaining risks/action:** A full `SCAN` traversal is timed as one operation
and collects all matched keys before batched deletion; bounded batches do
not bound sweep duration or collected-key memory
(`server/src/cache.ts:235-258`). Blocking invalidation and shared-state reads
can delay signaling, while ICE/TURN/device work can dominate media connection
independently of Redis. The recorder's default slow-query threshold is 100 ms
for Redis too (`server/src/lib/queryTiming.ts:65-66,142-146`), so a `>50` ms
checker alert need not produce a slow-query warning. Attribute it using
`dbQueries` and detached counts, not just log presence. Existing call-flow
tests cover ICE prefetch, accepted-state presentation, answer-before-incoming
replay and stale OS hangup after accept
(`mobile/__tests__/hooks/useCallFlow.test.tsx:1530,1693,2033,2118`); they do
not establish real network/media latency. Production Redis/call thresholds
and physical-device media connection remain unvalidated.

## 5. Telemetry and mobile serialization: bounds are real, not unlimited labels

**Concrete path/current mitigations:** Every recorded query updates totals;
an authenticated `/metrics` request materializes and sorts them
(`server/src/telemetry.ts:815-826,848-878`;
`server/src/routes/metrics.routes.ts:62-71`). Query keys fold into
`backend:kind:other` once the map reaches the tracking threshold
(`server/src/telemetry.ts:788-812`), with backend/kind constrained to two
values each by `server/src/lib/queryTiming.ts:34-43`. For those supported
inputs, this bounds the map by the 100-key admission threshold plus at most
four overflow rows, **not an exact 100-row ceiling**. Signaling error/event
maps similarly admit 50 labels plus at most one `other` each
(`server/src/telemetry.ts:711-729`). Existing overflow coverage is in
`server/test/query-timing.test.ts:435-459` and
`server/test/telemetry.test.ts:563-620`.

On mobile, `flushToDisk` builds changed rows and executes only their SQL batch
(`mobile/src/storage/chatDb.ts:322-333`). `snapshotRows` reuses held rows for
unchanged table/peer-array identities and skips those arrays' serialization;
`rowChanges` skips equal payload/position pairs
(`mobile/src/storage/chatRecords.ts:19-67`). Outbox-only saves preserve
message-array identity (`mobile/src/storage/chatDb.ts:347-373`), with regression
coverage at `mobile/__tests__/storage/chatDb.test.ts:458-469`. This is not the
old whole-snapshot JSON-file write.

**Remaining risks/action:** The existing identity test proves save-level
reuse, not a direct no-serialization assertion for `snapshotRows`; add focused
held-row identity/serialization regression coverage before extending this
optimization. Row maps are still walked, and replacing a peer array serializes
that peer's rows. Retention intentionally preserves pending/failed entries and
pinned peers (`mobile/src/storage/chatDb.ts:120-137`); advertised recent-history
limits are not absolute memory bounds on offline backlog.

Any future per-key cache breakdown must use a fixed allowlist such as
`conversations`, `message-first-page`, `message-sized-page`, `call-history`,
`invalidation-marker`, with unknown labels folded into one reserved `other`
bucket. Never expose raw user/conversation IDs as labels, and test both
cardinality and overflow accounting. Preserve the backend/kind allowlist
(or validate it at runtime if record sources become untyped); unrestricted
backend values would create new overflow rows. Production snapshot overhead
and physical-device serialization/SQLite timing remain unvalidated.

## 6. Open measurement-validity bug — Medium

**Serial awaited batches can contaminate "steady" results and erase the hold.**
`tools/loadrig/rig.mjs:631-640` opens users concurrently *within* a batch,
awaits that batch's sessions/socket connects, then sleeps a fixed second
before starting the next batch. Batch connection duration is additive; the
minimum batch-size calculation (`tools/loadrig/rig.mjs:79-88`) does not
guarantee completion by `RAMP_SECS`.

Meanwhile `phaseFor` switches on elapsed wall time alone (lines 183-185).
Each connected user immediately starts its sender (lines 294-310), and
messages retain their send-time phase for acknowledgment/delivery buckets
(lines 299-302,334-354). Slow connection batches can therefore still be
running when messages and reports are labeled **steady**, at less than the
intended connected-user load. The hold deadline is also anchored to initial
startup, not actual ramp completion (lines 713-719): ramp overrun shortens,
or completely consumes, the post-ramp hold. The call scheduler starts only
after ramp completion (line 714), so its available test window shrinks too.

**Current mitigations:** Batch-size validation prevents an obviously
undersized nominal schedule, and reports include connected/failure counts
(lines 590-606). Neither fixes this timing defect.

**Required follow-up:** Schedule batches against absolute ramp deadlines,
record actual ramp completion, begin steady classification only after the
intended connection attempt phase finishes, and hold for the full configured
duration from that point. Add slow-session/socket tests that assert phase
purity and hold length. This is an open documentation follow-up for a
source-level harness defect, not an application latency regression or a code
fix in this audit; no issue was filed as part of this task.
No new load run or production/device measurement validates the reported phases.
