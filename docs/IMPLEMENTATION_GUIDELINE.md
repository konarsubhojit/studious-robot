# Implementation Guideline — Remaining Gaps

This document captures the work that **could not be completed in a single agent
session** and is intended to be picked up directly in a follow-up session. It is
derived from the full gap analysis of the TCalling app (mobile React Native
client + Express/Socket.IO signaling server).

Each item lists **what is done**, **what remains**, and **concrete next steps**
so a new session can continue without re-deriving the analysis.

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
| 10 | **No text chat / no message persistence** | ✅ `server/src/messageStore.ts` (memory + Azure Cosmos DB for MongoDB, indexed on `{ conversationId, createdAt }`), `message.send` / `message.received` / `message.delivered` socket events, `GET /messages` history with cursor pagination, and a data-only push fallback for offline recipients. Env-gated via `MONGODB_URI`. Remaining: a mobile chat UI. |
| 11 | **Incoming calls never reached the callee** | ✅ Fixed. Offline-push gating was per **user** rather than per **device**, so a user online on one device got no push on any other; `resolveOfflinePushChannels()` now resolves push targets per device. Engine.IO's default 25s/20s heartbeat also let a suspended phone look connected for up to 45s — longer than the ringing timeout (30s at the time; now 120s) — so `SOCKET_PING_INTERVAL_MS` / `SOCKET_PING_TIMEOUT_MS` now default to 10s each. On mobile, a foreground `onMessage` handler was added (`setBackgroundMessageHandler` alone drops pushes that arrive while the app is open) and `displayIncomingCall()` deduplicates by `callId`. |

---

## 🟡 P2 — UX / reliability

- **TURN fallback** (`mobile/src/webrtcConfig.ts`): self-hosted TURN option +
  "TURN unavailable" diagnostics; document setup.
- **Lobby network-error recovery**: retry button + persistent offline banner.
- **iOS support**: CallKit, APNs token collection, an iOS CI workflow.
- **Session expiry**: default `SESSION_TTL_MS` to a finite value; call
  `POST /session/refresh` from the app.
- **Replace emoji icons** with `react-native-vector-icons` for consistent
  cross-device rendering (`IconButton`, Lobby gear, redial, presence dot).
- **Bitrate / codec control**: `RTCRtpSender.setParameters()` caps + `getStats()`
  packet-loss → quality warnings.

---

## 🔵 P3 — Mainstream features

Group calls (server `MAX_ROOM_SIZE = 2`), a **mobile chat UI** (the server-side
text-chat API and persistence now exist — see gap 10), screen sharing, profile
pictures/display names, blocked-callers UI (server `blocks` API exists, no UI),
account deletion/data export (GDPR), app icon & splash, i18n
(`CALL_END_REASON_LABELS` is i18n-ready), accessibility hints.

---

## 🔧 Infrastructure / ops

- Redis for sessions/presence + multi-instance rate limiting (per-process today).
- Keep `CORS_ORIGIN` locked down in production (no wildcard unless explicitly intended).
- Error tracking (Sentry/Bugsnag) — `crashReporter.ts` only writes local files.
- Automate Drizzle migrations in the Oracle VM deploy step (`db:migrate` — already done in `backend-ci.yml`).
- Prometheus scrape + alerting on the existing `/metrics` endpoint.

---

## Suggested order for the next session

All P0 items and the P1 functional gaps (#4, #5, #7, #8) are now implemented. The
remaining backlog is P2 / P3 / infra:

1. `cd mobile && npm install` to fetch the `react-native-callkeep` /
   `@react-native-firebase/*` native modules, then run real-device QA for
   background push + the system call UI (P0 #1/#2 operational follow-up).
2. Swap emoji glyphs for `react-native-vector-icons` (P2).
3. Persist the hot keyed state (sessions/presence Maps) behind Redis and call
   `POST /session/refresh` proactively on a TTL (P1 #8 follow-up).
4. TURN fallback + diagnostics and Lobby network-error recovery (P2).

**Conventions to follow** (see repo memories): Drizzle ORM for DB; run tests per
package (`cd mobile && npm test`, `cd server && npm test`); default branch is
`master`; mobile env vars have no `EXPO_PUBLIC_` prefix and are inlined at build.
