# Implementation Guideline — Remaining Gaps

This document captures the work that **could not be completed in a single agent
session** and is intended to be picked up directly in a follow-up session. It is
derived from the full gap analysis of the TCalling app (mobile React Native
client + Express/Socket.IO signaling server).

Each item lists **what is done**, **what remains**, and **concrete next steps**
so a new session can continue without re-deriving the analysis.

> Last verified against commit `64fd1471e6f03f4218903449de3a97d0fd443717` on 2026-09-08.

---

## ✅ Already implemented in this PR

These gaps are complete and covered by tests (`cd mobile && npm test`):

1. **Push-token wiring (JS side)** — `getPushToken()` /
   `registerForPushNotifications()` in `mobile/src/pushNotifications.ts`, wired
   into the presence-connect effect in `mobile/src/hooks/useCallFlow.ts` and
   unregistered on sign-out. Degrades to a graceful no-op when the native
   messaging library is absent (mirrors the server's env-gated push delivery).
2. **Settings screen** — `mobile/src/components/SettingsScreen.tsx` (change
   username, change signaling URL, sign out), wired up in
   `mobile/src/components/TabShell.tsx` and reachable
   via the ⚙️ gear in the Lobby title bar. The RegistrationScreen "change your
   username in Settings" hint is now truthful.
3. **Presence indicator** — `checkPresence()` + `calleePresence` in
   `useCallFlow`; the Lobby shows Online / Offline / Not-found for the callee
   before the call is placed (`GET /presence/:userId`).
4. **Tap-to-redial** — call-history rows in the Lobby are now pressable and
   re-place the call via `placeCall(peerId)`.
5. **Mobile chat UI + message search + delivery/read status** — shipped in
   `mobile/src/components/chat/ChatConversationPresentation.tsx`
   (`MessageStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'read'`),
   `mobile/src/components/ChatListScreen.tsx`,
   `mobile/src/components/SearchScreen.tsx`, `mobile/src/hooks/useMessaging.ts`
   (`GET /messages/search`), and `server/src/routes/messages.routes.ts`
   (`GET /messages/search` + `POST /messages/read`).
6. **Blocked-people management UI** — `mobile/src/hooks/useBlocks.ts`, block /
   unblock actions in `mobile/src/components/PeerProfileScreen.tsx`, and the
   blocked-people list in `mobile/src/components/SettingsScreen.tsx`.
7. **Multi-device read sync** — `server/src/routes/messages.routes.ts` emits
   `SERVER_EVENTS.MESSAGE_READ` to a user's sockets; the mobile client subscribes
   in `mobile/src/hooks/useCallFlow.ts`.
8. **Screen sharing and call minimisation/PiP path** — shipped in
   `mobile/src/hooks/useScreenShare.ts`, `mobile/src/screenShare.ts`,
   `mobile/src/hooks/usePictureInPicturePip.ts`,
   `mobile/src/hooks/useCallMinimize.ts`, wired through
   `mobile/src/components/CallScreen.tsx`.
9. **TURN fallback + diagnostics** — `mobile/src/webrtcConfig.ts` now includes
   TURN credential fetch (`/turn-credentials`), tiered fallback (fetched/cache/
   stale-cache/build-time-config), and `getTurnDiagnostics()`.
10. **Lobby/search network-error recovery** — offline banner + retry actions are
    implemented in `mobile/src/components/CallsScreen.tsx` and
    `mobile/src/components/SearchScreen.tsx`, wired from
    `mobile/src/components/TabShell.tsx`.
11. **Vector icon migration** — icon rendering is centralised through
    `mobile/src/vectorIcons.tsx`, `mobile/src/components/primitives/Icon.tsx`
    and `mobile/src/components/IconButton.tsx` (emoji kept only as fallback when
    native fonts are absent).
12. **App icon and splash wiring** — launcher icons are present in
    `mobile/android/app/src/main/res/mipmap-*/ic_launcher*.png`; launch/splash
    surfaces are configured via
    `mobile/android/app/src/main/res/values/styles.xml` (`windowBackground`) and
    `mobile/ios/StudiousRobot/LaunchScreen.storyboard`; iOS app icons are in
    `mobile/ios/StudiousRobot/Images.xcassets/AppIcon.appiconset/`.

---

## 🔴 P0 — Hard blockers

### 1. Native FCM background push
✅ **Implemented.** The full background-push path is now wired:

- `@react-native-firebase/app` + `@react-native-firebase/messaging` are declared
  in `mobile/package.json`; `loadMessaging()` in `mobile/src/pushNotifications.ts`
  picks them up automatically and degrades to a no-op when absent.
- The Android Gradle `com.google.gms.google-services` plugin is applied in
  `mobile/android/build.gradle` + `app/build.gradle` (conditional on a
  `google-services.json` being present).
- `installBackgroundMessageHandler()` is registered at startup in
  `mobile/index.tsx`; the `data`-only payload keys (`callId`, `callerId`,
  `deepLink`) match what `server/src/push.ts` sends, and a `tcalling://call/{callId}`
  deep-link `<intent-filter>` is declared in `AndroidManifest.xml` so taps route
  into the app.

**Remaining (operational, not code):** drop a real `google-services.json` into
`mobile/android/app/` and complete real-device QA (FCM cannot be unit-tested).

### 2. System-level incoming-call UI (CallKit / ConnectionService)
✅ **Implemented.** `react-native-callkeep` is integrated as an *optional* native
module (mirrors the Firebase pattern — graceful no-op when absent):

- `mobile/src/callKeep.ts` wraps setup, `displayIncomingCall`, connected/end
  reporting, and answer/end event bridging; covered by
  `mobile/__tests__/callKeep.test.ts`.
- A background push now calls `displayIncomingCall(...)` from
  `handleBackgroundPushMessage`, so the OS rings full-screen even on cold start.
- `useCallFlow` configures CallKeep on mount, bridges the OS answer/end buttons
  into `acceptIncomingCall` / `declineIncomingCall` / `endActiveCall`, reports the
  call active on accept, and dismisses the system UI when a call ends.
- `AndroidManifest.xml` declares the `VoiceConnectionService` ConnectionService
  plus `FOREGROUND_SERVICE_PHONE_CALL` / `MANAGE_OWN_CALLS` permissions. The
  existing `CallForegroundService.kt` still handles the *accepted* phase.

**Remaining (operational, not code):** `cd mobile && npm install` to fetch the
native module, plus real-device QA (iOS additionally needs a CallKit entitlement).

### 3. userId uniqueness / identity verification
✅ **Implemented.** `POST /session` now enforces identity ownership via a
verified Firebase account:

- A `users` table (Drizzle, unique `user_id` primary key) was added in
  `server/db/schema.ts` (migration `db/migrations/0001_*.sql`), plus a matching
  in-memory `users` store in the store contract.
- `server/src/identity.ts` claims a `userId` the first time a session request
  supplies a valid Firebase ID token, storing the provider UID and metadata.
- A later `POST /session` for a claimed `userId` must present an ID token for
  the same provider UID. Another account receives **409** (`identity_claimed`)
  and a `session.identity_conflict` audit entry. Each provider UID can bind to
  only one public username. Covered by `test/identity.test.ts`.

**Remaining (optional follow-up)**
- Add an administrator-assisted migration flow for legacy usernames that
  predate provider account binding.

---

## 🟠 P1 — Major functional gaps

| # | Gap | Status |
| - | --- | ------ |
| 4 | **Contact list / discovery** | ✅ Server `GET /users` contact-directory endpoint (auth, `?search=` substring, `?limit=`, presence per user, block-aware) + `searchUsers()` in `useCallFlow` + a **Contacts** search section in the Lobby (debounced lookup, presence-aware rows, tap-to-select callee). Remaining: add QR-pair. |
| 5 | **Lobby is a dev panel** | ✅ The legacy Join-Room / Signaling-URL fields are now hidden behind a "Developer mode" toggle in Settings (persisted; off by default). |
| 7 | **Presence before calling** | ✅ basic indicator added; optionally subscribe to live presence over the socket instead of one-shot fetch. |
| 8 | **In-memory sessions lost on restart** | ✅ The server bootstrap (`require.main` block in `server/src/index.ts`) wires the Redis-backed store bundle via `createRedisPgStores()` whenever `REDIS_URL` is set (and closes it on shutdown). The mobile app gained `refreshSession()` + an `authedFetch()` helper that calls `POST /session/refresh` and retries once on a 401 (wired into call-history + contact lookups). Remaining: persist hot keyed state (currently per-instance Maps) and call refresh proactively on a TTL. |
| 9 | **Push provider lock-in / duplicated credentials** | ✅ Azure Notification Hubs is now the **preferred** transport in `server/src/push.ts` (SAS-signed REST direct-send, zero new dependencies), with automatic fallback to direct APNs/FCM when unconfigured or on send failure. Outcomes carry `transport: 'notification_hub' \| 'direct'`. Env-gated via `AZURE_NOTIFICATION_HUB_CONNECTION_STRING` / `AZURE_NOTIFICATION_HUB_NAME`; setup documented in [AZURE_SETUP.md](./AZURE_SETUP.md). |
| 10 | **No text chat / no message persistence** | ✅ `server/src/messageStore.ts` (memory + Postgres `messages` table, indexed on `(conversation_id, created_at desc)`), `message.send` / `message.received` / `message.delivered` socket events, `GET /messages` history with cursor pagination, and a data-only push fallback for offline recipients. Durable whenever `DATABASE_URL` is set. Mobile UI + search are now implemented (`ChatConversationPresentation.tsx`, `ChatListScreen.tsx`, `SearchScreen.tsx`). |
| 11 | **Incoming calls never reached the callee** | ✅ Fixed. Offline-push gating was per **user** rather than per **device**, so a user online on one device got no push on any other; `resolveOfflinePushChannels()` now resolves push targets per device. Engine.IO's default 25s/20s heartbeat also let a suspended phone look connected for up to 45s — longer than the ringing timeout (30s at the time; now 120s) — so `SOCKET_PING_INTERVAL_MS` / `SOCKET_PING_TIMEOUT_MS` now default to 10s each. On mobile, a foreground `onMessage` handler was added (`setBackgroundMessageHandler` alone drops pushes that arrive while the app is open) and `displayIncomingCall()` deduplicates by `callId`. |

---

## 🟡 P2 — UX / reliability

- ~~**TURN fallback**~~ ✅ Implemented in `mobile/src/webrtcConfig.ts`
  (credential fetch + tiered fallback + diagnostics).
- ~~**Lobby network-error recovery**~~ ✅ Implemented (offline banners + Retry)
  in `mobile/src/components/CallsScreen.tsx` and
  `mobile/src/components/SearchScreen.tsx`.
- **iOS support**: ✅ CallKit (`mobile/src/callKeep.ts`) + APNs/FCM token
  collection (`mobile/src/pushNotifications.ts`) are implemented. **Remaining:**
  add an iOS CI workflow (current `.github/workflows/mobile-ci.yml` runs tests on
  Ubuntu only; no iOS build job).
- ~~**Session expiry**~~: ✅ `SESSION_TTL_MS` defaults to 7 days, expired
  sessions are swept out of the in-memory map, every shared-store key is
  written with an expiry, and the app re-mints on `401` / `session.invalid`.
- ~~**Replace emoji icons**~~ ✅ Implemented via
  `mobile/src/vectorIcons.tsx` + shared icon primitives.
- **Bitrate / codec control**: ✅ bitrate caps are applied with
  `RTCRtpSender.setParameters()` (`applyBitrateConstraints` in
  `mobile/src/webrtcConfig.ts`) and `getStats()` packet-loss/quality warnings are
  surfaced in `mobile/src/hooks/useCallFlow.ts`. **Remaining:** codec-preference
  controls are still not implemented.

---

## 🔵 P3 — Mainstream features

- **Group calls** — still absent: server capacity is still capped to 1:1
  (`server/src/config.ts` `MAX_ROOM_SIZE = 2`).
- ~~**Mobile chat UI**~~ ✅ implemented (`mobile/src/components/chat/ChatConversationPresentation.tsx`,
  `mobile/src/components/ChatListScreen.tsx`, `mobile/src/components/SearchScreen.tsx`).
- ~~**Screen sharing**~~ ✅ implemented (`mobile/src/hooks/useScreenShare.ts`,
  `mobile/src/screenShare.ts`, `mobile/src/components/CallScreen.tsx`).
- **Profile pictures/display names** — still absent: avatars are initials from
  user ids (`mobile/src/components/primitives/Avatar.tsx`), and the persisted
  `users` table has no profile-picture/display-name fields (`server/db/schema.ts`).
- ~~**Blocked-callers UI**~~ ✅ implemented (`mobile/src/hooks/useBlocks.ts`,
  `mobile/src/components/PeerProfileScreen.tsx`,
  `mobile/src/components/SettingsScreen.tsx`).
- **Account deletion/data export (GDPR)** — still absent after scanning
  `server/src/routes/` (`attachments`, `auditLog`, `blocks`, `calls`, `devices`,
  `directory`, `health`, `messages`, `metrics`, `session`, `turnCredentials`):
  no account-delete or data-export endpoint found. Tracked in #293.
- ~~**App icon & splash**~~ ✅ implemented (`mobile/android/app/src/main/res/mipmap-*`,
  Android `windowBackground` styles, iOS `LaunchScreen.storyboard`, iOS
  `AppIcon.appiconset`).
- **i18n** (`CALL_END_REASON_LABELS` is i18n-ready) — still absent: no
  `i18n`/`i18next`/`translation`/`locale` matches under `mobile/src`. Tracked in #305.
- **Accessibility hints** — **could not determine full completion**: there are
  182 `accessibilityLabel` usages across `mobile/src`, but this document has not
  been through a full accessibility audit pass.

---

## 🔧 Infrastructure / ops

- Redis for sessions/presence + multi-instance rate limiting (per-process today).
- Keep `CORS_ORIGIN` locked down in production (no wildcard unless explicitly intended).
- Error tracking (Sentry/Bugsnag) — `crashReporter.ts` only writes local files.
- Automate Drizzle migrations in the Oracle VM deploy step (`db:migrate` — already done in `backend-ci.yml`).
- Prometheus scrape + alerting on the existing `/metrics` endpoint.

---

## Suggested order for the next session

All P0 items and core P1/P2 chat/call UX gaps are now implemented. The highest-
value remaining backlog is:

1. Add account deletion and data-export endpoints (GDPR; #293).
2. Add i18n plumbing and extract user-visible strings (#305).
3. Add an iOS CI workflow (current mobile CI is Linux-only tests/lint/typecheck).
4. Extend calling beyond 1:1 rooms (server still enforces `MAX_ROOM_SIZE = 2`).
5. Complete an explicit accessibility audit (current status is partially verified,
   not fully audited).
6. Optional call-quality follow-up: codec-preference controls (bitrate caps +
   quality warnings are already implemented).

**Conventions to follow** (see repo memories): Drizzle ORM for DB; run tests per
package (`cd mobile && npm test`, `cd server && npm test`); default branch is
`master`; mobile env vars have no `EXPO_PUBLIC_` prefix and are inlined at build.
