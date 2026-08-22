# Grumpy Code Review — copilot/issue-121 vs master

_Reviewed c14d64d..HEAD (branch total: 245 files). This pass focuses on the
commits added in the current session (18acf04..HEAD, 30 files): the remaining
`mobile/__tests__` suites, `server/db/client.js`, both `tsconfig.json` files and
`TYPESCRIPT_MIGRATION.md`. Earlier commits on this branch were reviewed in their
own sessions; branch-wide patterns worth re-stating are grouped at the end._

## Summary

Mergeable. This finishes what issue #121 asked for: every `.js` file in
`mobile/`, `server/` and `shared/` is annotated, `checkJs` is now **on** in both
projects, and CI already runs `npm run typecheck` for both (`mobile-ci.yml:47`,
`backend-ci.yml:85`), so the "CI fails on type errors" acceptance criterion is
now enforced for *new* files too rather than only for opted-in ones. Verified
locally: mobile `typecheck` + `lint` clean, 934 jest tests pass; server
`typecheck` clean, 378 node tests pass. The worst thing in the diff is the
density of `/** @type {any} */` escape hatches in the test suites — they satisfy
the type checker without buying much safety, and in `screenShare.test.js` one of
them actively throws away a discriminated union the production code goes to the
trouble of returning.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] `any` cast discards the union `startScreenCapture` is designed to return** — `mobile/__tests__/screenShare.test.js:57,73,87,100,111`
  - `startScreenCapture()` returns `{ ok: true, videoTrack, audioTrack, audioShared } | { ok: false, reason, message }`. The tests now do
    `const result = /** @type {any} */ (await startScreenCapture());`, so a test
    asserting `result.videoTrack` on a failure path — or a future rename of
    `audioShared` — type-checks happily.
  - Why it matters: the point of migrating tests is that they fail to compile
    when a contract moves. An `any` at the top of the assertion block makes the
    whole test body unchecked.
  - Suggested fix: narrow instead of casting, e.g. assert the discriminant first
    (`expect(result.ok).toBe(true); if (!result.ok) throw new Error('expected success');`)
    or cast to the success/failure member type rather than `any`. Same applies to
    `verifyScreenShareFrames` at line 193.
  - **Resolution: Fixed.** Added generic `expectOk()` / `expectNotOk()` helpers
    to `screenShare.test.js` that narrow the `{ ok }` union (throwing on the
    wrong branch) and replaced every `/** @type {any} */` cast on a capture or
    frame-verification result with them; the unsupported-platform test now uses
    the raw result with `toEqual`. Typecheck + 15 tests green.

### Low

- **[LOW] `mobile/*.js` root config files stay unchecked** — `mobile/tsconfig.json:24-31`
  - `App.js` and `index.js` were added to `include`, but `jest.config.js`,
    `metro.config.js` and `babel.config.js` are still outside the program, so the
    doc's claim that "every `.js` file in this project is annotated" is slightly
    optimistic.
  - Why it matters: minor, but the next person adding a root-level module may
    assume it is covered by CI when it is not.
  - Suggested fix: either add `"*.config.js"` to `include` (they currently pass —
    worth confirming) or note the exclusion explicitly in `TYPESCRIPT_MIGRATION.md`.
  - **Resolution: Fixed.** Added `"*.config.js"` to `mobile/tsconfig.json`'s
    `include`; `npm run typecheck` stays clean, so `jest`/`metro`/`babel`
    configs are now checked in CI too.

- **[LOW] `LightingConstraints.frameRate` is still `object`** — `mobile/src/cameraLighting.js:158-163`
  - The new typedef pins down `advanced` but leaves `frameRate: object`, so
    `constraints.frameRate.ideal` is not checkable and the test can only assert
    it via `toEqual`.
  - Suggested fix: type it as `{ ideal: number, max: number }` to match
    `LIGHTING_PROFILES`.
  - **Resolution: Fixed.** Typed as `{ ideal: number, max?: number }` (the
    `normal`/`bright` profiles legitimately omit `max`) in both the typedef and
    the `LIGHTING_PROFILES` cast.

- **[LOW] `instanceof Error` narrowing drops messages from non-`Error` throwables** — `mobile/src/appLogger.js:65-67,133-135`, `mobile/src/attachmentPicker.js`, `mobile/src/audioRouting.js` (earlier commits on this branch)
  - `err?.message || 'unknown'` became `err instanceof Error ? err.message : ''`.
    Native modules and some JS libraries reject with plain objects that carry a
    `message`/`code`; those messages are now silently replaced by `'unknown'`.
  - Why it matters: it degrades diagnostics exactly in the cases (native
    bridge failures) where the log line is most useful.
  - Suggested fix: in the shared `errorMessage()` helpers, fall back to
    `typeof error === 'object' && error && 'message' in error` before giving up.
  - **Resolution: Deferred.** The pattern is duplicated in ~20 modules from
    earlier commits on this branch (`callKeep`, `ringtone`, `settingsStorage`,
    `useScreenShare`, …). Fixing it properly means introducing one shared
    `errorMessage` utility and rewiring every call site — a repo-wide refactor
    well outside this session's blast radius, and better tracked as its own
    change.

### Nit

- **[NIT] Mock aliasing style is inconsistent across the migrated suites** — e.g. `mobile/__tests__/settingsStorage.test.js:25-27` (module-level `const existsMock = …`) vs `mobile/__tests__/ThemeProvider.test.js:45` (inline `/** @type {jest.Mock} */ (…)` at each call site).
  - Both work; picking one and stating it in `TYPESCRIPT_MIGRATION.md` would
    save the next author a decision.

## Out of scope (pre-existing, not graded)

- `npx prettier --check "__tests__/**/*.js"` reports 52 files unformatted in
  `mobile/` on the base branch as well — Prettier is not wired into `npm run
  lint`, so formatting drift here predates this branch and was not "fixed" by it.
- One server test is skipped (`# skipped 1` in `npm test`) on both base and head.
- The `.ts`/`.tsx` question: this branch deliberately keeps `.js` + JSDoc because
  `tsc` runs with `noEmit` and neither project has a build step (`server` runs
  `node src/index.js`). The rationale is now documented in
  `TYPESCRIPT_MIGRATION.md`; an actual rename is a separate exercise that needs a
  server-runtime decision (build step vs. Node type stripping).


## Fix pass summary

Fixed: 1 Medium, 2 Low. Deferred: 1 Low (shared `errorMessage()` helper —
repo-wide refactor, rationale inline). No Critical or High findings were raised.
Post-fix validation: mobile `typecheck` + `lint` clean, 934 jest tests pass;
server `typecheck` clean, 378 node tests pass.
