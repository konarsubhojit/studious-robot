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
   `registerForPushNotifications()` in `mobile/src/pushNotifications.js`, wired
   into the presence-connect effect in `mobile/src/hooks/useCallFlow.js` and
   unregistered on sign-out. Degrades to a graceful no-op when the native
   messaging library is absent (mirrors the server's env-gated push delivery).
2. **Settings screen** — `mobile/src/components/SettingsScreen.js` (change
   username, change signaling URL, sign out), routed from `App.js` and reachable
   via the ⚙️ gear in the Lobby title bar. The RegistrationScreen "change your
   username in Settings" hint is now truthful.
3. **Presence indicator** — `checkPresence()` + `calleePresence` in
   `useCallFlow`; the Lobby shows Online / Offline / Not-found for the callee
   before the call is placed (`GET /presence/:userId`).
4. **Tap-to-redial** — call-history rows in the Lobby are now pressable and
   re-place the call via `placeCall(peerId)`.

---

## 🔴 P0 — Hard blockers (still open)

### 1. Install the native FCM library (finish background push)
The JS plumbing is done but no library actually returns a device token.

**Next steps**
- `cd mobile && npm install @react-native-firebase/app @react-native-firebase/messaging`
  (run `runtime-tools-gh-advisory-database` for these npm packages first).
- Android: add `google-services.json` to `mobile/android/app/`, apply the
  `com.google.gms.google-services` Gradle plugin in
  `mobile/android/build.gradle` + `app/build.gradle`.
- Add the FCM background handler (`messaging().setBackgroundMessageHandler(...)`)
  in `mobile/index.js` and a `data`-only push payload contract with the server
  (`server/src/push.js` already sends FCM; confirm payload keys match the deep
  link `tcalling://call/{callId}`).
- No code change needed in `pushNotifications.js` — `loadMessaging()` will pick
  the library up automatically once installed.
- **Validation:** real-device only (FCM cannot be unit-tested); add a manual QA
  checklist entry.

### 2. System-level incoming-call UI (CallKit / ConnectionService)
A push banner is not enough — the ringing phase needs an OS-level full-screen
call UI so the call isn't missed during cold start.

**Next steps**
- Add `react-native-callkeep` (covers Android ConnectionService + iOS CallKit).
- On a background push, call `RNCallKeep.displayIncomingCall(uuid, handle, name)`
  and bridge "answer"/"end" events into `useCallFlow.acceptIncomingCall` /
  `declineIncomingCall`.
- Android: declare `ConnectionService` + `FOREGROUND_SERVICE_PHONE_CALL`
  permissions in `AndroidManifest.xml`; the existing `CallForegroundService.kt`
  handles the *accepted* phase — keep it for that.

### 3. userId uniqueness / identity verification
✅ **Implemented.** `POST /session` now enforces identity ownership via an
opt-in verification code:

- A `users` table (Drizzle, unique `user_id` primary key) was added in
  `server/db/schema.js` (migration `db/migrations/0001_*.sql`), plus a matching
  in-memory `users` store in the store contract.
- `server/src/identity.js` claims a `userId` the first time a session request
  supplies a `verificationCode`, storing only a salted scrypt hash.
- A later `POST /session` for a claimed `userId` must present the matching code,
  otherwise it returns **409** (`identity_conflict`) and writes a
  `session.identity_conflict` audit entry. Unclaimed `userId`s remain freely
  usable (backwards-compatible). Covered by `test/identity.test.js`.

**Remaining (optional follow-up)**
- Swap the in-memory `users` store for the Drizzle table at runtime so claims
  survive restarts, and add an external verification channel (email/phone OTP)
  to bootstrap the code instead of trust-on-first-use.

---

## 🟠 P1 — Major functional gaps

| # | Gap | Next step |
| - | --- | --------- |
| 4 | **Contact list / discovery** | Add a `users` directory endpoint + search; QR-pair; "recent contacts" (history redial is done). |
| 5 | **Lobby is a dev panel** | Hide the legacy Join-Room / Signaling-URL fields behind a developer-mode toggle (now that Settings exists). |
| 7 | **Presence before calling** | ✅ basic indicator added; optionally subscribe to live presence over the socket instead of one-shot fetch. |
| 8 | **In-memory sessions lost on restart** | Persist sessions/presence in Redis (`server/src/stores/redis.js` exists) and configure it in `render.yaml`; add retry-on-401 + session refresh (`POST /session/refresh` exists but is never called by the app). |

---

## 🟡 P2 — UX / reliability

- **TURN fallback** (`mobile/src/webrtcConfig.js`): self-hosted TURN option +
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

Group calls (server `MAX_ROOM_SIZE = 2`), in-call chat, screen sharing, profile
pictures/display names, blocked-callers UI (server `blocks` API exists, no UI),
account deletion/data export (GDPR), app icon & splash, i18n
(`CALL_END_REASON_LABELS` is i18n-ready), accessibility hints.

---

## 🔧 Infrastructure / ops

- Redis for sessions/presence + multi-instance rate limiting (per-process today).
- `CORS_ORIGIN` defaults to `*` in `deploy/robot-signal.service` — lock down.
- Error tracking (Sentry/Bugsnag) — `crashReporter.js` only writes local files.
- Automate Drizzle migrations in the Render build command (`db:migrate`).
- Prometheus scrape + alerting on the existing `/metrics` endpoint.

---

## Suggested order for the next session

1. Install `@react-native-firebase/messaging` and finish background push (P0 #1).
2. Add `react-native-callkeep` for the OS ringing UI (P0 #2).
3. Enforce `userId` uniqueness + basic verification (P0 #3).
4. Hide the legacy room-join flow behind developer mode (P1 #5).
5. Swap emoji glyphs for `react-native-vector-icons` (P2).

**Conventions to follow** (see repo memories): Drizzle ORM for DB; run tests per
package (`cd mobile && npm test`, `cd server && npm test`); default branch is
`master`; mobile env vars have no `EXPO_PUBLIC_` prefix and are inlined at build.
