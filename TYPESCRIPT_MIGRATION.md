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
- `mobile/types/*.d.ts` holds hand-written ambient declarations for native
  dependencies that ship no types (currently `react-native-vector-icons`).

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
- [x] `src/callUx.js`
- [x] `src/haptics.js`
- [x] `src/crashReporter.js`
- [x] `src/settingsStorage.js`
- [x] `src/ErrorBoundary.js`
- [x] `src/SafeRTCView.js`
- [x] `src/authService.js`
- [x] `src/callService.js`
- [x] `src/cameraLighting.js`
- [x] `src/vectorIcons.js`
- [x] `src/voiceRecorder.js`
- [x] `src/webrtcConfig.js`
- [ ] `src/components/` (done: `AppButton`, `IconButton`, `SettingsCard`,
      `StatusBanner`, `InCallBanner`, `ReconnectBanner`)
- [x] `src/errorMessage.js`
- [ ] `src/call/` (done: `callStateMachine.js`)
- [ ] `src/chat/`
- [x] `src/navigation/` (except `AppNavigator.js`)
- [ ] `src/storage/` (done: `recentSearches.js`)
- [ ] `src/hooks/` (done: `useAppSettings`, `useBlocks`, `useCallHistory`,
      `useCallInitiation`, `useCallMinimize`, `useCameraLighting`,
      `useChatDeepLink`, `useCompactCallView`, `usePictureInPicturePip`,
      `useRecentSearches`, `useStartupPermissions`; `useSession` exports the
      shared `AuthedFetch` contract)
- [ ] remaining `src/*.js` modules (`appLogger`, `telemetry`, permissions,
      notifications, …)
- [ ] `App.js`
- [ ] `__tests__/`

### server/

- [x] `src/signaling/ack.js`
- [ ] `src/signaling/` (remaining handlers)
- [x] `src/lib/lifecycle.js`
- [x] `src/lib/auth.js`
- [x] `src/lib/normalize.js`
- [x] `src/lib/verbose.js`
- [x] `src/routes/auditLog.routes.js`
- [x] `src/routes/health.routes.js`
- [x] `src/routes/metrics.routes.js`
- [x] `src/routes/` (all routers except `calls.routes.js` / `messages.routes.js`;
      every router's `state` is typed by the shared `ServerState` contract in
      `src/stores/contracts.js`)
- [ ] `src/domain/`
- [x] `src/stores/`
- [ ] `src/lib/` (remaining modules)
- [x] `src/identity.js`
- [x] `src/firebaseAuth.js`
- [x] `src/messageBus.js`
- [x] `src/telemetry.js` — `@ts-check` on; `Telemetry` / `MetricsSnapshot` contracts defined
- [x] `src/security.js` — `@ts-check` on; `RateLimiter` / `AuditLog` contracts defined
- [ ] remaining `src/*.js` modules
- [ ] `test/`
