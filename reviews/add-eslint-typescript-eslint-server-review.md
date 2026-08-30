# Grumpy Code Review — copilot/add-eslint-typescript-eslint-server vs master

_Reviewed 2c88378..HEAD, 33 files changed (plus `server/package-lock.json`)._

## Summary

Mergeable. The diff does what the issue asked and nothing else: a 50-line flat
config, three type-aware promise rules, the mobile package's inverted `max-len`
rule, a `lint` script, a CI step, and the mechanical fallout of turning those
rules on. `npm run lint`, `npm run typecheck` and `npm test` (443 tests, 442
pass / 1 pre-existing skip) are all green. The worst thing in it is the
`cd .. && eslint …` lint script — ugly, but forced by ESLint refusing to lint
files outside the working directory, and the alternative is leaving `shared/`
with no linter at all now that the hand-rolled guard is gone.

## Findings

### Critical

None.

### High

None. The two behavioural edits (`void socket.join/leave`, wrapping the
`io.close` promise executors in a block) were checked against the socket.io
type declarations: `Socket#join` is `Promise<void> | void` and `Server#close`
is `Promise<void>`, so both sites really were returning promises that nothing
observed. Neither edit changes control flow — the `await` in each teardown is
still on the callback-backed promise.

### Medium

- **[MEDIUM] The deleted test's second assertion has no replacement** —
  `server/src/domain/calls.ts:313`
  - `declaration-formatting.test.ts` had a second case asserting that
    `pruneTerminalCalls` keeps its options in a *named* type rather than an
    inline object literal on the `function` line. `max-len` only sees lines
    that begin a `type`/`interface` declaration, so that specific regression
    (a 235-char inline signature) would no longer be caught.
  - Why it matters: the issue explicitly ordered the file deleted, so this is
    an accepted trade, but it should not be silently lost.
  - Mitigation applied: the doc comment above `PruneTerminalCallsOptions` now
    names the `max-len` rule as the reason the type exists, so the next person
    to inline it has the rationale in front of them.

### Low

- **[LOW] `npm run lint` changes directory** — `server/package.json:13`
  - `"lint": "cd .. && eslint --config server/eslint.config.js server shared"`
    is not the idiomatic `eslint .`.
  - Why it matters: it looks like a hack, and a reader will try to "fix" it.
  - Fix applied: the reason (ESLint reports `File ignored because outside of
    base path` for `../shared` regardless of `basePath`, in both v9 and v10) is
    documented in the `eslint.config.js` header, and the README script table
    records that the server lint covers `shared/` too.

### Nit

- **[NIT] `void` sprinkled across 24 test files** — `server/test/*.test.ts`
  - The `new Promise((resolve) => server.io.close(…))` teardown is copy-pasted
    into ~24 files; the fix had to be applied ~29 times.
  - A `closeTestServer()` helper in `test/helpers.ts` would collapse all of
    them, but that is a test refactor of its own and out of scope for a linter
    PR that must not weaken existing tests.

## Out of scope (pre-existing, not graded)

- `npm test` reports one skipped test on a machine without the CI Postgres
  service; unchanged by this diff.
- `npm audit` reports advisories in the existing `drizzle-kit` dependency tree;
  present on `master` before this change.
- The mobile package runs ESLint but `mobile-ci.yml` still does not invoke
  `npm run lint`. That asymmetry is real, but the issue scoped this change to
  `backend-ci.yml`.
