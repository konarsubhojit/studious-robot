# TypeScript migration

The codebase is JavaScript with JSDoc. Rather than a big-bang rewrite, type
checking is enabled **file by file** and enforced in CI, so contracts that are
documented today become contracts that are checked.

## How it works

- `mobile/tsconfig.json` and `server/tsconfig.json` run TypeScript in `allowJs`
  mode with `strict: true` and `noEmit: true`. Nothing is compiled: `tsc` is a
  linter here, and Metro/Node keep running the `.js` files unchanged.
- `checkJs` is **off**, so unmigrated files never fail the build. A file opts in
  by starting with a `// @ts-check` comment.
- `npm run typecheck` (in `mobile/` and in `server/`) runs the check locally;
  both CI workflows run the same command and fail on any type error.
- `shared/` is checked from both projects, because both consume it.

## Migrating a file

1. Add `// @ts-check` as the first line (before `'use strict';` if present).
2. Run `npm run typecheck` in the owning project.
3. Fix the reported errors by adding JSDoc types (`@param`, `@returns`,
   `@typedef`). Prefer describing the real shape over `any`; use
   `/** @type {...} */ (value)` casts only where a third-party type is wrong.
4. Tick the file's directory below once every file in it is annotated.

Migration order (cheapest and most-depended-upon first): shared contracts →
design tokens and utilities → presentational components → hooks → screens and
`App.js` → server handlers.

## Progress

### shared/

- [x] `shared/` (schema, signaling contracts, API routes)

### mobile/

- [x] `src/theme.js`
- [x] `src/socketProtocol.js`
- [x] `src/signalingClient.js`
- [x] `src/ThemeContext.js`
- [x] `src/ThemeProvider.js`
- [x] `src/pipConstants.js`
- [x] `src/startupHealth.js`
- [x] `src/mediaControls.js`
- [x] `src/socketConfig.js`
- [x] `src/accessibilityAnnouncer.js`
- [x] `src/callStreamHelpers.js`
- [ ] `src/components/`
- [ ] `src/call/`
- [ ] `src/chat/`
- [ ] `src/navigation/`
- [ ] `src/hooks/`
- [ ] remaining `src/*.js` modules (logging, permissions, storage, …)
- [ ] `App.js`
- [ ] `__tests__/`

### server/

- [x] `src/signaling/ack.js`
- [ ] `src/signaling/` (remaining handlers)
- [x] `src/lib/lifecycle.js`
- [x] `src/routes/auditLog.routes.js`
- [x] `src/routes/health.routes.js`
- [x] `src/routes/metrics.routes.js`
- [ ] `src/routes/` (remaining routes)
- [ ] `src/domain/`
- [ ] `src/stores/`
- [ ] `src/lib/` (remaining modules)
- [x] `src/identity.js`
- [x] `src/firebaseAuth.js`
- [ ] remaining `src/*.js` modules
- [ ] `test/`
