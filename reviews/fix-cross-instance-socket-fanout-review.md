# Grumpy Code Review — copilot/fix-cross-instance-socket-fanout vs master

_Reviewed 49a500fb3a31827706ff92cbcff4e945f9a41a6f..HEAD, 10 files changed (3 docs, 5 server source, 1 new module, 1 new test suite)._

## Summary

Mergeable. The diff adds an active cross-instance fan-out probe
(`server/src/lib/fanoutProbe.ts`), wires it into the composition root, and
reports it on `/health` under a field that is deliberately separate from
`stateAffinity` — which is exactly what the issue asked for, and it was
verified end-to-end against a real Redis adapter with two instances, not just
against a test double. The worst things in it were found and fixed during this
pass: a peer-supplied string reaching `console.warn` unsanitised (log
injection, contrary to this repo's own convention), and two maps that were
only ever pruned when somebody scraped `/health`. Nothing Critical or High
remains.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] Peer state was only pruned by `/health`** — `server/src/lib/fanoutProbe.ts`
  - `getStatus()` was the sole place stale peers were evicted, and
    `mismatchesLogged` was never evicted at all. A Redis-backed instance with
    no `INSTANCE_ID` identifies itself with a fresh `randomUUID()` on every
    restart (`server/src/stores/redis.ts:100`), so on an instance whose
    `/health` nothing scrapes, both collections grew once per peer restart.
  - Why it matters: an unbounded map in a long-lived process is a slow leak,
    and it lives in code whose entire purpose is to be trustworthy about
    health.
  - Fixed: extracted `prunePeers(now)`, called from the probe timer as well as
    `getStatus()`, and it now drops the peer's `mismatchesLogged` entry too so
    a peer that returns on a mismatched transport warns again.

### Low

- **[LOW] Peer-supplied strings reached `console.warn` unsanitised** — `server/src/lib/fanoutProbe.ts`
  - The mixed-transport warning interpolated `probe.instanceId` and
    `probe.transport` straight into a log line. Those fields arrive over the
    adapter's Redis channels — not from a client, so this is defence in depth
    rather than a live hole — but every other externally-sourced log field in
    this server goes through `sanitizeForLog` (`src/signaling/ack.ts:120`,
    `src/domain/calls.ts:327`).
  - Why it matters: a compromised or shared Redis could forge log lines in
    journald output that operators read during exactly the incident this
    feature exists to surface.
  - Fixed: both fields are truncated to `MAX_PROBE_FIELD_CHARS` (64) in
    `parseProbe` and passed through `sanitizeForLog` in the warning, with a
    regression test asserting a newline cannot survive into the log.

- **[LOW] `/health` now advertises peer instance ids and the transport name publicly** — `server/src/routes/health.routes.ts:69`
  - `/health` is unauthenticated and, per `deploy/README.md`, curled through
    the public hostname. The new block adds `peersSeen` (`["0"]`, `["1"]`) and
    `transport` (`redis-adapter`).
  - Why it matters: it is a small amount of topology disclosure.
  - Judged acceptable and left as-is: the endpoint already publishes
    `instanceId`, `stateAffinity` and the message-store backend, this is the
    same class of operator-facing metadata, and a value only operators can act
    on is worthless if operators cannot read it. Noted so the decision is
    deliberate rather than accidental.

### Nit

- **[NIT] `getStatus()` mutates while reading** — `server/src/lib/fanoutProbe.ts`
  - A getter that evicts entries is mildly surprising. It is documented on
    `prunePeers`, and lazy eviction keeps the status honest without a second
    timer, so it stays.

## Out of scope (pre-existing, not graded)

- The `Backend CI & Deploy` workflow's **Deploy to Oracle Cloud VM** job fails
  on `master` as well (run `34186664257`); it is an SSH/deploy-environment
  failure, not a test failure, and predates this branch. The `test` job passes.
- `deploy/deploy.sh` performs no `/health` request at all, so the issue's
  "Option B" (deploy-time cross-instance comparison) has no natural hook here
  and was deliberately not attempted: it needs a step that can see *both*
  VMs, while `deploy.sh` runs on one. Option A, the runtime probe, is
  implemented.
