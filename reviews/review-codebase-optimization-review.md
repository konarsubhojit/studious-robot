# Grumpy Code Review — copilot/review-codebase-optimization vs master

_Reviewed `cd142c4..257913d` (the Postgres-consolidation slice of the branch), 39 files changed: +2122 / −3202._

Scope note: the earlier commits on this branch (`6f8ed22`..`cd142c4` — deployment
surface, Redis, session lifetime, retention, cache reachability) were reviewed in
previous passes. This review covers the D1 slice: the move of chat history from
MongoDB into Postgres.

## Summary

Mergeable. The shape of the change is right — the `MessageStore` interface was
already the correct seam, so a whole datastore came out without a single caller
changing, and the diff deletes 1080 more lines than it adds. The SQL is correct
and every query matches an index that was added for it, which the new test file
actually asserts rather than assuming.

The worst thing in it is that `/health` can no longer tell you the message store
is broken: `messageStoreStatus` is now a hardcoded `'ready'`, so a Postgres
outage produces an endpoint that cheerfully reports a healthy store while every
message read returns 503. That is a field which no longer carries information
but still looks like it does, which is worse than not having it. Second worst is
the message retention sweep, which issues one `DELETE` round trip *per row* —
up to 5000 sequential statements per tick — while the two tables next to it in
the same file each use a single bounded statement.

## Resolution

All findings below were fixed in a follow-up commit on the same branch; each
entry is annotated with what was done. Server typecheck, lint and the full test
suite (529 passing / 1 skipped) are green afterwards.

## Findings

### Critical

None.

### High

- **[HIGH] `/health` reports a healthy message store even when Postgres is down** — `server/src/createServer/index.ts:206`, surfaced at `server/src/routes/health.routes.ts:50-53`
  - `messageStoreStatus` is assigned the literal `'ready'` and is never written
    again. The Mongo path that used to flip it to `'unavailable'` was deleted
    along with the driver, and nothing replaced it. `GET /health` still
    publishes the field, so an operator (or a load balancer health check, or the
    mobile diagnostics screen) reading `messageStore.status` gets `"ready"`
    while `GET /messages` is returning `503 message store unavailable`.
  - Why it matters: this is the one field on `/health` whose entire purpose was
    to distinguish "the process is up" from "the process can serve chat". A
    constant that always says yes is not a degraded signal, it is a wrong one —
    it will actively delay diagnosis during exactly the incident it exists for.
    The justifying comment ("the Postgres store borrows the pool `db/client.ts`
    has already established, so there is no separate connection to wait on") is
    true about *startup* and irrelevant to *steady state*: the pool being
    constructed says nothing about whether it can currently reach the database.
  - Suggested fix: either (a) make it real — have the retention/sweep tick, or a
    small dedicated probe, run `select 1` against the pool and record
    `'ready' | 'unavailable'` on `state`, so the field means what it claims; or
    (b) delete `messageStoreStatus` from `ServerState` and from the `/health`
    payload entirely and report only `messageStore.type`, so nothing publishes a
    health signal it does not actually compute.
  - **Fixed** by (b): `messageStoreStatus` is gone from `ServerState`
    (`src/stores/contracts.ts`), from `createServer` and from the `/health`
    payload, which now reports `messageStore: { type }` only. The route's doc
    comment records *why* there is no readiness flag, so nobody re-adds a
    constant one. Nothing outside the server consumed it — the mobile client
    reads only `status` and `stateAffinity` — and `test/health.test.ts` was
    updated to assert the narrowed payload.

### Medium

- **[MEDIUM] The message retention sweep issues one `DELETE` per row** — `server/src/lib/retention.ts:118-136`
  - `pruneExpiredMessages` selects up to `batchSize` (`DB_RETENTION_DELETE_BATCH`
    = 5000) doomed rows, then loops:
    ```ts
    for (const row of doomedRows) {
      const removed = await db.delete(messagesTable).where(and(eq(...), eq(...))).returning(...);
    }
    ```
    That is up to 5000 sequential round trips, each its own implicit
    transaction, per sweep tick. `pruneExpiredCalls` and `pruneExpiredAuditLog`,
    twenty lines above in the same file, each do the equivalent work in one
    statement.
  - Why it matters: on the two-VM fleet the database is on a separate host, so
    each of those iterations pays network latency. At 2 ms RTT a full batch is
    ~10 s of serialised waiting on a shared pool connection, competing with live
    traffic. It also makes the sweep non-atomic in a way the others are not: a
    mid-loop failure leaves a partially-pruned batch, and the `catch` in
    `runRetentionSweep` reports `messages: 0` even though rows were deleted.
  - Suggested fix: issue a single statement. Postgres supports row-value `IN`,
    so the composite key is not actually an obstacle:
    `DELETE FROM messages WHERE (conversation_id, message_id) IN ((…),(…))`,
    expressible via `sql` with the doomed rows as parameters — or, simpler,
    `DELETE FROM messages WHERE ctid IN (SELECT ctid FROM messages WHERE created_at < $1 LIMIT $2)`,
    which needs no key handling at all and matches the bounded-subselect pattern
    the other two prunes already use. Then `deleted.length` is the count and the
    batch is atomic.
  - **Fixed**: `pruneExpiredMessages` is now a single
    `delete … where ctid in (select ctid … limit $n)` returning the deleted ids,
    so the sweep is one statement and one transaction like its siblings. The
    two retention tests were rewritten to assert exactly one statement is
    issued.

- **[MEDIUM] The module doc now contradicts what the module does** — `server/src/lib/retention.ts:50-55`
  - The file's own explanation of `pruneExpiredCalls` says the delete is bounded
    by a sub-select "so the first run against a table that has never been pruned
    cannot lock millions of rows in a single statement". `pruneExpiredMessages`
    is bounded too, but by a mechanism the doc does not describe and that has the
    opposite failure mode (many tiny transactions rather than one large one). A
    maintainer reading the header will assume all three prunes behave alike.
  - Why it matters: the comments in this repository are load-bearing — they are
    how the design intent survives. One that is quietly wrong about a sibling
    function is worse than none.
  - Suggested fix: fold into the fix above; once `pruneExpiredMessages` uses one
    bounded statement the existing doc is accurate again and needs no special
    case.
  - **Fixed**: resolved by the change above; the function's own doc now explains
    only the one thing that genuinely differs (why `ctid` rather than an
    `IN (...)` over a single key column).

### Low

- **[LOW] `deriveConversationId` lost its doc comment** — `server/src/messageStore/queries.ts:19`
  - The comment explaining *why* the ids are sorted before joining ("so both
    participants — and both directions of a send — always resolve to the same
    conversation") was removed along with the adjacent Mongo sort constants. The
    function is exported, is depended on by `callTimeline.ts` to map a call onto
    a conversation, and its one-line body does not explain itself.
  - Suggested fix: restore the three-line doc comment verbatim.
  - **Fixed**: comment restored.

- **[LOW] Stray blank line where the Mongo type import was** — `server/src/messageStore/queries.ts:10-11`
  - Two consecutive blank lines between the module doc and the first
    declaration; every other file in `src/messageStore/` has one.
  - Suggested fix: delete the extra newline.
  - **Fixed**.

- **[LOW] Over-long line introduced in a wrapped comment block** — `server/src/lib/retention.ts:16`
  - `* from, so they grew without bound.  That is a storage problem, but on this deployment it is first a`
    runs well past the ~80-column wrap every other line in the block observes,
    because the sentence was extended in place without re-wrapping.
  - Suggested fix: re-wrap the paragraph.
  - **Fixed**.

### Nit

- **[NIT] `escapeLikePattern` is exported from `pgStore.ts` purely for its test** — `server/src/messageStore/pgStore.ts:49`
  - Every other pure helper of this kind (`clampLimit`, `normaliseSearchTerm`,
    `bodyMatches`) lives in `queries.ts`, which exists precisely to hold
    "assertable without a database" logic. `escapeLikePattern` qualifies and is
    imported by `message-store-internals.test.ts` alongside those three.
  - Suggested fix: move it to `queries.ts` next to `bodyMatches`, so the search
    term's entire journey — normalise, escape, match — is described in one file.
  - **Not fixed** (Nit, deliberately left): the escaping is coupled to the
    `ESCAPE '\\'` clause in `pgStore.searchMessages`, so keeping the two
    adjacent is defensible. Noted rather than churned.

## Out of scope (pre-existing, not graded)

- `src/domain/callTimeline.ts` still reads the in-memory `state.calls` (lines
  51, 78, 163), so a missed call disappears from the timeline once the in-memory
  retention window prunes it, and `mergeTimeline` (line 99) slices *after*
  merging two independently-limited lists. This diff does not make either worse;
  it makes both *fixable*, since `messages` and `calls` are finally in the same
  database and joinable. `docs/OPTIMIZATION_PLAN.md` records it as the
  outstanding item. Not graded here.
- `README.md` §2 says Node 24 via `.nvmrc` while `server/package.json` engines
  says `>=22`. Pre-existing, untouched.
- The mobile Jest run prints "A worker process has failed to exit gracefully";
  previously established to be an RN `Animated` mock artifact from the
  `Skeleton` / `RingingAvatar` loops, not a product leak. Pre-existing.
