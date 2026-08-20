# Grumpy Code Review — copilot/issue-121-work-autonomously vs main

_Reviewed 615edc9..fa5a08f, 22 files changed._

## Summary

This is a documentation-and-annotation diff that opts eleven more modules into
`// @ts-check` and fixes the type errors that surfaced. Both `npm run
typecheck` suites are clean, `eslint .` is clean, and 926 mobile + 374 server
tests pass. Nothing here is mergeable-blocking. The worst thing in it is a
missed opportunity: the new `Palette` typedef is derived from `darkColors`
only, so the light palette can silently drift out of shape without the type
checker noticing — exactly the class of bug this migration exists to prevent.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] `Palette` typedef does not enforce light/dark parity** — `mobile/src/theme.js`
  - `@typedef {typeof darkColors} Palette` describes the dark palette, and
    `palettes` is left untyped, so `lightColors` is never checked against it.
    Dropping or misspelling a token in `lightColors` compiles fine and blows
    up at runtime in light mode.
  - The file's own doc comment promises both palettes "expose exactly the same
    token names"; that promise is now checkable and isn't being checked.
  - Fix: annotate `palettes` as `@type {Record<'dark'|'light', Palette>}` so a
    missing light token is a type error. **(Fixed in this branch.)**

### Low

- **[LOW] Two near-identical `error → message` helpers** — `server/src/messageBus.js:44` (`toMessage`) and `mobile/src/settingsStorage.js:12` (`errorMessage`)
  - Same three-line body, different names, in two different packages.
  - Cross-package sharing is not warranted for three lines, but the naming
    divergence will make the eventual consolidation harder to spot.
  - Fix (optional): settle on one name when a third copy appears.

### Nit

- **[NIT] `info: null` added to the `severityTint` map** — `mobile/src/components/StatusBanner.js:14`
  - Runtime behaviour is unchanged (`null ?? null`), it exists to make the
    lookup total for the severity union. Harmless, but a reader may wonder why
    a key maps to `null` rather than being absent; the surrounding JSDoc
    already explains "or `null` for plain 'info'", so this is fine as-is.

## Out of scope (pre-existing, not graded)

- `console.error(...)` in `crashReporter.js` still interpolates the raw thrown
  value when it has no `message` field. Pre-existing behaviour, preserved
  deliberately.
- The large unmigrated modules (`useCallFlow.js`, `useMessaging.js`,
  `ChatConversationScreen.js`, `server/src/domain/`) remain opted out of
  `@ts-check`; that is the tracked, intentional remainder of the migration.
