# Grumpy Code Review — copilot/log-sql-mongo-db-query-times vs main

_Reviewed f323d5e..158f320, 13 files changed (11 source/doc, 2 lockfiles that had no business being here)._

## Resolution status

All Critical/High/Medium findings below were fixed in follow-up commits on this
branch, as were every Low finding; the single Nit was reviewed and knowingly
left as-is. Verified afterwards: `server npm test` (434 tests), `mobile npx
jest` (1087 tests), `npm run typecheck` in both packages, `npm run lint`
(mobile), and `npm ci --dry-run` in `server/` and `mobile/` to prove both
lockfiles still install cleanly. `mobile/android/**` (including
`app/gradle.lockfile` and `settings-gradle.lockfile`, which are strict —
`lockAllConfigurations()` in `mobile/android/build.gradle`) is untouched by
this branch, so the Gradle lock state cannot drift in the APK workflow.

## Summary

The feature itself is sound: one timing helper, instrumentation at the three
seams that actually issue I/O, aggregation in the existing telemetry, and an
export path on the client. Tests exist and pass (431 server, 1087 mobile).
But the diff ships two lockfiles nobody asked for, a global sink that the
*first* server to shut down happily rips out from under every other live
server, an "other" bucket that lies about whether it's a read or a write, and
a log line that shouts `SLOW` at queries that were not slow — they failed.
Fix those four and it's mergeable.

## Findings

### Critical

None. Nothing here fails to compile or crashes on the happy path.

### High

- **[HIGH] Unrelated lockfile churn shipped in a feature diff** — `server/package-lock.json`, `mobile/package-lock.json`
  - `git diff` shows 52 deleted lines in `server/package-lock.json` (the whole
    `gcp-metadata` optional/peer subtree) and two `dev` → `devOptional` /
    dropped-`dev` flips in `mobile/package-lock.json`. None of that is a
    consequence of this feature; it is the residue of running `npm install`
    while setting up the sandbox.
  - Why it matters: dependency resolution changes are how supply-chain
    surprises and "works on my machine" CI drift get merged unnoticed. A
    reviewer reading this PR cannot tell whether the removal of a transitive
    dependency is intentional.
  - Fix: `git checkout f323d5e -- server/package-lock.json mobile/package-lock.json`
    and keep the branch's dependency graph byte-identical to the base.

- **[HIGH] A single server shutdown silently disables query timing for every other live server** — `server/src/createServer.ts:149`, `server/src/createServer.ts:409`
  - `setQueryTimingSink(...)` installs a process-global sink on construction
    and `shutdown()` unconditionally calls `setQueryTimingSink(null)`. The
    server test suite (and any process that builds more than one server, e.g.
    a blue/green in-process handover) creates many instances: the last one
    constructed wins the sink, and the *first* one torn down clears it —
    after which every remaining server records nothing at all, forever, with
    no error.
  - Why it matters: metrics silently going to zero is worse than metrics
    being absent; `/metrics` keeps returning a well-formed, empty `dbQueries`
    and nobody notices the instrumentation died.
  - Fix: have `setQueryTimingSink` hand back a disposer (or compare identity
    on clear) so a server only uninstalls the sink it actually installed.

### Medium

- **[MEDIUM] The overflow bucket mislabels reads as writes (and vice versa)** — `server/src/telemetry.ts:340`
  - The per-operation map is keyed `backend:operation` and `entry.kind` is
    frozen from whichever record created the entry. Once the map hits
    `MAX_TRACKED_QUERY_OPERATIONS`, *every* subsequent operation — reads and
    writes alike — is folded into one `backend:other` row whose `kind` is
    whatever arrived first. The row then reports, say, `kind: "read"` over a
    total that is mostly writes.
  - Why it matters: read-vs-write attribution is the stated point of this
    feature. A bucket that quietly averages the two is worse than no bucket.
  - Fix: key the map by `backend:kind:operation` so `kind` is part of the
    identity and the overflow bucket splits into `other` per kind.

- **[MEDIUM] Failed queries are logged as "SLOW"** — `server/src/lib/queryTiming.ts:130`
  - `report()` branches on `record.slow || !record.ok` and prints
    `[db-timing] SLOW …` for both. A 2 ms query that threw `23505` is logged
    as slow, which is simply false.
  - Why it matters: whoever greps `SLOW` during an incident gets a pile of
    fast failures mixed into the latency evidence, and the actual slow
    queries are diluted.
  - Fix: emit `SLOW` only when `record.slow`, and `FAILED` when `!record.ok`
    (both when both are true).

- **[MEDIUM] `getSnapshot()` mutates nothing, but the live map is typed as a snapshot and carries a permanently-zero `meanMs`** — `server/src/telemetry.ts:174`
  - `queryOperations` is a `Map<string, QueryOperationSnapshot>`, but the
    live entries never maintain `meanMs` — it is computed in `getSnapshot()`
    and the stored value stays `0` forever. The accumulator is being made to
    wear the wire type, so a future reader of the map gets a field that is
    always a lie.
  - Fix: give the accumulator its own internal type without `meanMs`, and
    derive the snapshot shape in `getSnapshot()`.

- **[MEDIUM] The mobile export blocks for up to 5 s on a network call before writing anything** — `mobile/src/diagnostics.ts:369`
  - `exportDiagnosticLogs` now awaits `fetchServerQueryTimings` before
    `writeLogsFile`. On a dead/mis-typed signaling URL the user taps "Export
    Logs" and stares at an unchanged screen for the full timeout, with no
    indication that anything is happening.
  - Why it matters: the export exists precisely for the "something is broken"
    case, which is exactly when the server is most likely unreachable.
  - Fix: drop the timeout to something a human tolerates (~2.5 s) and say in
    the JSDoc that the export deliberately waits for it, so the next reader
    doesn't "optimise" the await away.

### Low

- **[LOW] A doc comment was orphaned from the function it documents** — `server/db/client.ts:22`
  - The `instrumentQuery` JSDoc block now sits above
    `const INSTRUMENTED = Symbol(...)`, so tooling attributes the
    documentation to the symbol.
  - Fix: move the `const` above the comment.

- **[LOW] `describeSqlStatement` classifies an unparseable statement as a write without saying why** — `server/src/lib/queryTiming.ts:196`
  - Defaulting to `write` is the right (conservative) call — a write counted
    as a read understates mutation cost — but nothing in the code says so.
  - Fix: one comment line stating the bias and its reason.

- **[LOW] Stray double blank line** — `server/src/messageStore.ts:500`
  - Two blank lines between `createIndexOrWarn` and the new
    `MONGO_OPERATION_KINDS`; the rest of the file uses one.

- **[LOW] Env vars are re-parsed on every single query** — `server/src/lib/queryTiming.ts:79`, `server/src/lib/queryTiming.ts:88`
  - `isQueryTimingEnabled()` and `slowQueryThresholdMs()` do
    `process.env` reads plus `trim`/`toLowerCase`/`Number` per query. It is
    cheap, and it keeps the tests able to flip the env at runtime — but it is
    per-query work on the hottest path in the process.
  - Fix (accepted trade-off if declined): note the deliberate choice in the
    JSDoc so it reads as a decision rather than an oversight.

### Nit

- **[NIT] `dbQueries` sits outside `counters`/`histograms`/`derived`** — `server/src/telemetry.ts:48`
  - The snapshot's other three keys are objects; this one is an array at the
    top level. Defensible (it is a sorted table, not a keyed map) but worth a
    sentence in the type doc so nobody "normalises" it later. Already
    documented — leaving as-is.

## Out of scope (pre-existing, not graded)

- `server/src/lib/persistence.ts` swallows DB errors on most write paths but
  rethrows on `persistUser`. Inconsistent, pre-existing, untouched here.
- `MessageStore`'s `DrizzleDb = any` / `messages: any` typing means none of
  the Mongo call sites are type-checked against the driver. Pre-existing.
- The Jest run reports "A worker process has failed to exit gracefully" on
  `main` as well — not introduced by this diff.
