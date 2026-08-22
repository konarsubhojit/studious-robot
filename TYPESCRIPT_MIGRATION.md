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
- Test suites (`mobile/__tests__/`, `server/test/`) are part of the same
  projects, so they opt in the same way.

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
- [x] `src/callService.js`
- [x] `src/authService.js`
- [x] `src/settingsStorage.js`
- [x] `src/SafeRTCView.js`
- [x] `src/ErrorBoundary.js`
- [x] `src/appLogger.js`
- [x] `src/observability.js`
- [x] `src/telemetry.js`
- [x] `src/components/`
  - [x] `AppButton.js`
  - [x] `AppTabBar.js`
  - [x] `AttachSheet.js`
  - [x] `AudioOutputMenu.js`
  - [x] `CallControls.js`
  - [x] `CallScreen.js`
  - [x] `CallStage.js`
  - [x] `CallTimelineRow.js`
  - [x] `CallTopBar.js`
  - [x] `ChatConversationScreen.js`
  - [x] `ChatListScreen.js`
  - [x] `DraggableCallControls.js`
  - [x] `DraggablePip.js`
  - [x] `ErrorState.js`
  - [x] `FloatingCallBubble.js`
  - [x] `IconButton.js`
  - [x] `InCallBanner.js`
  - [x] `IncomingCallScreen.js`
  - [x] `Lobby.js`
  - [x] `OutgoingCallScreen.js`
  - [x] `PeerProfileScreen.js`
  - [x] `ReconnectBanner.js`
  - [x] `RegistrationScreen.js`
  - [x] `SearchScreen.js`
  - [x] `SettingsCard.js`
  - [x] `SettingsScreen.js`
  - [x] `StatusBanner.js`
  - [x] `SwipeableRow.js`
  - [x] `TabShell.js`
- [x] `src/call/`
  - [x] `callStateMachine.js`
  - [x] `CallProvider.js`
- [x] `src/chat/`
  - [x] `ChatProvider.js`
- [x] `src/navigation/`
  - [x] `routes.js`
  - [x] `linking.js`
  - [x] `navigationRef.js`
  - [x] `navigationState.js`
  - [x] `AppNavigator.js`
- [x] `src/hooks/`
  - [x] `useRecentSearches.js`
  - [x] `useStartupPermissions.js`
  - [x] `useCameraLighting.js`
  - [x] `useCallMinimize.js`
  - [x] `useCallInitiation.js`
  - [x] `useAppSettings.js`
  - [x] `useCompactCallView.js`
  - [x] `useChatDeepLink.js`
  - [x] `useCallHistory.js`
  - [x] `useBlocks.js`
  - [x] `usePictureInPicturePip.js`
  - [x] `useChatSync.js`
  - [x] `useAttachments.js`
  - [x] `useSession.js`
  - [x] `usePresenceSearch.js`
  - [x] `useIdentity.js`
  - [x] `useScreenShare.js`
  - [x] `useMessaging.js`
  - [x] `useCallFlow.js`
- [x] `src/storage/` (chatDb, recentSearches)
- [x] `src/diagnostics.js`
- [x] `src/audioRouting.js`
- [x] `src/cameraLighting.js`
- [x] `src/messageNotification.js`
- [x] `src/ringtone.js`
- [x] `src/incomingCallNotification.js`
- [x] `src/screenShare.js`
- [x] `src/voiceRecorder.js`
- [x] `src/attachmentDownload.js`
- [x] `src/attachmentUpload.js`
- [x] `src/attachmentPicker.js`
- [x] `src/pushNotifications.js`
- [x] `src/callKeep.js`
- [x] `src/permissions.js`
- [x] `src/vectorIcons.js`
- [x] `src/webrtcConfig.js`
- [x] `src/AppShell.js`
- [x] remaining `src/*.js` modules (logging, permissions, …)
- [x] `App.js`
- [ ] `__tests__/`

### server/

- [x] `src/signaling/ack.js`
- [x] `src/signaling/index.js`
- [x] `src/signaling/callHandlers.js`
- [x] `src/signaling/messageHandlers.js`
- [x] `src/config.js`
- [x] `src/security.js`
- [x] `src/telemetry.js`
- [x] `src/callPersistence.js`
- [x] `src/attachments.js`
- [x] `src/messageBus.js`
- [x] `src/index.js`
- [x] `src/cache.js`
- [x] `src/createServer.js`
- [x] `src/messageStore.js`
- [x] `src/lib/lifecycle.js`
- [x] `src/lib/normalize.js`
- [x] `src/lib/verbose.js`
- [x] `src/lib/auth.js`
- [x] `src/lib/state.js`
- [x] `src/lib/persistence.js`
- [x] `src/stores/` (contracts, memory, redis)
- [x] `src/routes/auditLog.routes.js`
- [x] `src/routes/blocks.routes.js`
- [x] `src/routes/health.routes.js`
- [x] `src/routes/metrics.routes.js`
- [x] `src/routes/directory.routes.js`
- [x] `src/routes/turnCredentials.routes.js`
- [x] `src/routes/session.routes.js`
- [x] `src/routes/devices.routes.js`
- [x] `src/routes/attachments.routes.js`
- [x] `src/routes/index.js`
- [x] `src/routes/calls.routes.js`
- [x] `src/routes/messages.routes.js`
- [x] `src/routes/` (all routes)
- [x] `src/domain/` (callTimeline, calls, notifications)
- [x] `src/identity.js`
- [x] `src/firebaseAuth.js`
- [x] `src/push.js`
- [x] remaining `src/*.js` modules
- [ ] `test/` (in progress)
  - [x] `helpers.js`
  - [x] `correlation.test.js`
  - [x] `db-drizzle.test.js`
  - [x] `health.test.js`
  - [x] `stores.test.js`
  - [x] `verbose-logger.test.js`
  - [x] `cache.test.js`
  - [x] `directory.test.js`
  - [x] `message-bus.test.js`
  - [x] `shared-contract.test.js`
  - [x] `shutdown.test.js`
  - [x] `security.test.js`
  - [x] `signaling.test.js`
  - [x] `telemetry.test.js`
  - [x] `turn-credentials.test.js`
  - [x] `calls.test.js`
  - [x] `identity.test.js`
  - [x] `reconnect.test.js`
  - [x] `signaling-contract.test.js`
  - [x] `stale-calls.test.js`
  - [x] `cache-integration.test.js`
  - [x] `messages.test.js`
  - [x] `messages-rich.test.js`
  - [x] `messages-search.test.js`
  - [x] `messages-timeline.test.js`
