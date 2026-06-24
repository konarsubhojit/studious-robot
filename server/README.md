# Signaling Server

Express + Socket.IO signaling service for the studious-robot project.

## Requirements
- Node.js (see repo root `.nvmrc`)

## Setup
```bash
cd server
npm install
```

## Run
```bash
npm start          # production
npm run dev        # watch mode
npm test           # node --test
```

The server listens on `PORT` (default `4173`) and exposes:
- `GET /health` — liveness/health probe returning JSON `{ status: "ok", ... }`
- Socket.IO endpoint for WebRTC signaling (see events below)

### Socket.IO signaling events

Authenticated call/RTC signaling uses versioned websocket events (`version: 1`) and Socket.IO acknowledgements.
Every `call.*`/`rtc.*` client event requires a socket authenticated with `auth.sessionId`.

#### Client → Server (call contract)

| Event            | Payload                                 | Ack success                        | Notes |
| ---------------- | --------------------------------------- | ---------------------------------- | ----- |
| `call.initiate`  | `{ version, calleeId }`                 | `{ ok, version, event, call }`     | Starts a call and notifies the callee in real time when ringing. |
| `call.accept`    | `{ version, callId }`                   | `{ ok, version, event, call }`     | Callee-only. |
| `call.decline`   | `{ version, callId }`                   | `{ ok, version, event, call }`     | Callee-only. |
| `call.cancel`    | `{ version, callId }`                   | `{ ok, version, event, call }`     | Caller-only. |
| `call.end`       | `{ version, callId }`                   | `{ ok, version, event, call }`     | Either participant may end an active call. |
| `rtc.offer`      | `{ version, callId, sdp }`              | `{ ok, version, event, callId }`   | Accepted call participants only. |
| `rtc.answer`     | `{ version, callId, sdp }`              | `{ ok, version, event, callId }`   | Accepted call participants only. |
| `rtc.candidate`  | `{ version, callId, candidate }`        | `{ ok, version, event, callId }`   | Accepted call participants only. |

Ack failures return `{ ok: false, version, event, error: { code, message } }` with clean rejection codes such as `unauthorized`, `unsupported_version`, `forbidden`, `call_not_found`, and `stale_call_state`.

#### Server → Client (call contract)

| Event                | Payload summary |
| -------------------- | --------------- |
| `call.incoming`      | `{ version, callId, call }` sent to the callee when a ringing call is created. |
| `call.ringing`       | `{ version, callId, call }` sent to the caller when the call is ringing. |
| `call.accept`        | `{ version, callId, actor, reason, call }` |
| `call.decline`       | `{ version, callId, actor, reason, call }` |
| `call.cancel`        | `{ version, callId, actor, reason, call }` |
| `call.end`           | `{ version, callId, actor, reason, call }` |
| `call.state_changed` | `{ version, callId, previousStatus, status, actor, reason, call }` emitted on every call-state transition. |
| `rtc.offer`          | `{ version, callId, fromUserId, sdp }` relayed only to the other participant. |
| `rtc.answer`         | `{ version, callId, fromUserId, sdp }` relayed only to the other participant. |
| `rtc.candidate`      | `{ version, callId, fromUserId, candidate }` relayed only to the other participant. |

#### Legacy room signaling

Rooms hold at most **2 participants**. These legacy relay events remain available for room-based flows.

#### Client → Server

| Event           | Payload                              | Description                                              |
| --------------- | ------------------------------------ | -------------------------------------------------------- |
| `join-room`     | `roomId: string`                     | Join a room. Rejected with `room-full` if already at 2. |
| `offer`         | `{ roomId, sdp }`                    | Relay an SDP offer to the other peer.                    |
| `answer`        | `{ roomId, sdp }`                    | Relay an SDP answer to the other peer.                   |
| `ice-candidate` | `{ roomId, candidate }`              | Relay an ICE candidate to the other peer.                |

#### Server → Client

| Event           | Payload                              | Description                                              |
| --------------- | ------------------------------------ | -------------------------------------------------------- |
| `peer-joined`   | `{ id: socketId }`                   | Emitted to the existing peer when a second user joins.   |
| `room-full`     | `{ roomId }`                         | Emitted to the joining client when the room is full.     |
| `offer`         | `{ from: socketId, sdp }`            | Forwarded offer from the other peer.                     |
| `answer`        | `{ from: socketId, sdp }`            | Forwarded answer from the other peer.                    |
| `ice-candidate` | `{ from: socketId, candidate }`      | Forwarded ICE candidate from the other peer.             |
| `peer-left`     | `{ id: socketId }`                   | Emitted to the remaining peer when the other disconnects.|
| `server.draining` | `{ reason, ts }`                   | Emitted to every connected client when the instance begins a graceful shutdown; clients should reconnect. |

### Environment variables

| Name          | Default     | Description                                                       |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `PORT`        | `4173`      | TCP port to listen on                                             |
| `HOST`        | `0.0.0.0`   | Bind address                                                      |
| `CORS_ORIGIN` | `*` (dev)   | Comma-separated allow-list for Socket.IO CORS. Set to your app origin(s) in production. |
| `SHUTDOWN_DRAIN_MS` | `25000` | Max time (ms) to wait for in-flight socket connections to drain on `SIGTERM`/`SIGINT` before force-closing. Keep below the systemd `TimeoutStopSec`. |
| `DATABASE_URL` | _(unset)_ | Postgres connection string for **runtime** queries. On Neon, use the **pooled** endpoint (`...-pooler.neon.tech`). |
| `DATABASE_URL_DIRECT` | _(unset)_ | Postgres connection string for **migrations/DDL**. On Neon, use the **direct (unpooled)** endpoint. Falls back to `DATABASE_URL` when unset. |
| `DATABASE_POOL_MAX` | `10`     | Maximum app-side `pg` pool connections. |
| `FCM_SERVICE_ACCOUNT_JSON` | _(unset)_ | Firebase service-account credentials for FCM HTTP v1 push delivery. Either the raw JSON string or a path to the JSON key file. Absent ⇒ FCM pushes are skipped (`fcm_not_configured`). |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` | _(unset)_ | APNs token-auth credentials. All four required to enable APNs pushes. |
| `APNS_PRODUCTION` | `false` | Use the APNs production gateway when `true`, sandbox otherwise. |

## Push notifications

Incoming-call pushes are delivered by `src/push.js` to callees with no live
WebSocket connection. Two providers are supported and both fail gracefully when
unconfigured (logging and returning a `*_not_configured` reason).

### FCM (Firebase Cloud Messaging) — HTTP v1

The server uses the **FCM HTTP v1 API** (`/v1/projects/{projectId}/messages:send`)
with OAuth2 service-account authentication. The legacy server-key API is no
longer used.

1. In the Firebase console open **Project settings → Service accounts** and click
   **Generate new private key** to download the service-account JSON.
2. Provide it to the server via `FCM_SERVICE_ACCOUNT_JSON` — either the raw JSON
   (e.g. injected from a secret) or a path to the key file on disk.
3. In CI/CD, store the JSON as a GitHub Actions secret named
   `FCM_SERVICE_ACCOUNT_JSON` and expose it to the deploy environment. Never
   commit the key to the repository.

The server mints (and caches) a short-lived OAuth2 access token from the
service-account key and refreshes it automatically before expiry. If
`FCM_SERVICE_ACCOUNT_JSON` is absent or invalid, FCM delivery is skipped.

### APNs (Apple Push Notification service)

Set `APNS_KEY` (the `.p8` private key contents), `APNS_KEY_ID`, `APNS_TEAM_ID`,
and `APNS_BUNDLE_ID`; toggle `APNS_PRODUCTION=true` for the production gateway.

## Database (Drizzle ORM)

Durable persistence uses [Drizzle ORM](https://orm.drizzle.team/) over Postgres
(Neon). The schema is defined in code at `db/schema.js`; versioned SQL
migrations are generated from it into `db/migrations/` by `drizzle-kit` — do not
hand-edit the generated SQL.

```bash
# After editing db/schema.js, regenerate the migration (commit the result):
npm run db:generate

# Apply pending migrations (uses DATABASE_URL_DIRECT, falling back to DATABASE_URL):
npm run db:migrate
```

### Neon connection split

- **App/runtime** queries → the **pooled** endpoint via `DATABASE_URL`.
- **Migrations/DDL** → the **direct (unpooled)** endpoint via `DATABASE_URL_DIRECT`
  (Neon's PgBouncer transaction-mode pooler can't run migration advisory locks
  / some DDL).

The database-backed tests in `test/db-drizzle.test.js` are **skipped** unless
`DATABASE_URL` is set, so the rest of the suite runs offline. To run them
locally, point `DATABASE_URL` at a disposable Postgres and run `npm test`.
