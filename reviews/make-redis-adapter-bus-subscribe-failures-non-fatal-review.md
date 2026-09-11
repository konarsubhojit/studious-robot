# Grumpy Code Review — copilot/make-redis-adapter-bus-subscribe-failures-non-fata vs master

_Reviewed 2b6fcc4..HEAD, 12 files changed (docs, server, mobile, tests)._

## Summary

Mergeable. The diff does what the issue asked and nothing more: permission
failures on the fire-and-forget Redis paths are absorbed and surfaced on
`/health`, the sweep's `NOPERM` stops being a five-second log loop, the push
receipt finally names the real reason a CallKeep UI never appeared, and the
docs stop pretending `redis://` and a local container are the whole story. The
worst thing in it was a mangled line in `createServer/index.ts` (an `IIFE`
jammed onto the `setInterval` line) — fixed before this report was written.
Everything else is Low/Nit.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

- **[LOW] The guarded bus `subscribe` resolves without a subscription** —
  `server/src/stores/redis.ts:132-186`
  - `guardPermissionFailures` turns a `NOPERM` rejection into a resolved
    promise, so `createRedisMessageBus.subscribe()` registers a local handler
    for a channel Redis never subscribed to.
  - It matters because the caller believes it is subscribed. The alternative is
    worse — the pre-existing behaviour was a single boot-time log line and then
    permanent silence — and the condition is now reported on `/health` under
    `redis.issues[]` for as long as it persists, which is the point of the
    change.
  - Accepted as designed; the trade-off is documented in the function's
    doc comment.

- **[LOW] `/health` reads a module-level singleton** —
  `server/src/routes/health.routes.ts:77`
  - `getRedisHealth()` is process-global rather than per-server state, so two
    `createServer()` instances in one process share it.
  - That is correct for what it describes (a per-process Redis connection
    bundle) and matches how the failure actually manifests, but it means tests
    must call `resetRedisHealth()`; they do.

### Nit

- **[NIT] `resetRedisHealth` exists only for tests** —
  `server/src/lib/redisHealth.ts:120`
  - Test-only exports are a smell; this one is three lines, documented as such,
    and the alternative (threading a registry through `createServer`) buys
    nothing for a process-scoped condition.

## Out of scope (pre-existing, not graded)

- The `Deploy to Oracle Cloud VM` job on `master` fails at `drizzle-kit
  migrate` against the production database. It predates this branch and is an
  infrastructure/credential problem, not a code one.
- The PR's own CI runs report `action_required` (workflow approval pending),
  so no branch CI result exists to grade.
