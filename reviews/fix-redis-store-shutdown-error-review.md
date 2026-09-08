# Grumpy Code Review — copilot/fix-redis-store-shutdown-error vs master

_Reviewed b87b23a..b7f69f9, 4 files changed._

## Summary

Mergeable. The diff is four files, 64 added lines, and it actually fixes the
reported bug at its source instead of muffling it: `createServer().shutdown()`
already closed the store bundle, and the SIGTERM handler in
`server/src/index.ts` closed it a *second* time, which is exactly why
node-redis answered with "The client is closed" on every stop. The duplicate
call is gone, the bundle's `close()` is now idempotent as a belt-and-braces
guard, and both behaviours have regression tests that were verified to fail
without the fix. `npm run lint`, `npm run typecheck` and the full `npm test`
(553 passing, 1 pre-existing skip) are green on the branch. The worst thing in
here is a theoretical retry-semantics change on a failed first close, and
that's Low.

## Findings

### Critical

None.

### High

None.

### Medium

None. The removal of the `stores` handle from `bootstrap()`'s return
(`server/src/index.ts:63`, `:88`) is the right call rather than leaving a
dead field: the only consumer was the double-close that this change deletes,
and `createServer()` already owns the bundle it was given
(`server/src/createServer/index.ts:457-459`).

### Low

- **[LOW] A failed first close is never retried** — `server/src/stores/redis.ts:242-250`
  - `closePromise ??= (…)()` caches the promise on first call, so if
    `releaseSweepLease()` or `messageBus.close()` rejects, every later
    `close()` re-throws the same rejection instead of re-attempting the
    teardown.
  - Why it matters: only in theory. Nothing in the shutdown path retries a
    failed close — `shutdown()` is itself single-shot
    (`server/src/createServer/index.ts:412`) and the process exits straight
    after — and a rejected-close-then-retry loop against a half-quit Redis
    connection would be the same "client is closed" noise this change exists
    to remove. Deliberate, and the safer of the two behaviours.
  - Suggested fix: none; leave as is. Revisit only if a caller ever needs a
    retryable teardown, in which case clear `closePromise` in a `catch`.

### Nit

None worth the electrons. The new comments match the surrounding files'
density and explain *why* (the double close) rather than restating the code.

## Out of scope (pre-existing, not graded)

- The `Backend CI & Deploy` failure on `master`
  (run 34052549394) is in the "Deploy to Oracle Cloud VM" job, not in lint,
  typecheck or tests, and predates this branch. This PR's own Backend CI run
  is `action_required` (awaiting maintainer approval), not failed.
- `bundle` is still typed as `Record<string, any>` and returned via
  `return bundle as any` (`server/src/stores/redis.ts`), so `close()` gets no
  compile-time contract check. Pre-existing; this diff neither widens nor
  worsens it.
