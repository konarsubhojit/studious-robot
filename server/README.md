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
- `GET /messages` — paginated text-chat history (see [REST endpoints](#rest-endpoints))
- Socket.IO endpoint for WebRTC signaling (see events below)

### REST endpoints

Besides the call/session/contact routes, the chat surface adds:

| Method & path | Query | Response | Notes |
| ------------- | ----- | -------- | ----- |
| `GET /messages` | `peerId` (required), `limit` (1–100, default `50`), `before` (ISO `createdAt` cursor, exclusive), `include` (`calls` to merge in call records) | `200 { conversationId, messages }` | History of the conversation between the authenticated user and `peerId`, **newest-first**. Session resolved by `getSessionFromRequest` (bearer `Authorization` header, request body, or `?sessionId=`). `401` without a valid session, `400` when `peerId` is missing or equals your own id, `403` if a returned message does not involve you, `503` if the store is unavailable. |
| `GET /calls` | `limit` (1–100, default `20`), `offset` (default `0`), `status` (optional filter) | `200 { calls, total, limit, offset, hasMore }` | Call history for the authenticated user, **most recently active first** (`updatedAt` descending). Read from the durable `calls` table, so it survives a restart and is not bounded by the in-memory retention window (`CALL_RETENTION_MS` / `MAX_RETAINED_CALLS`); when no `DATABASE_URL` is configured — or the query fails — it degrades to the calls still resident in memory. `401` without a valid session. |

| `POST /attachments/presign` | body `{ peerId, type, mimeType, sizeBytes }` | `200 { conversationId, key, uploadUrl, publicUrl, expiresAt, headers }` | Mints a short-lived Cloudflare R2 upload URL for a chat attachment (see [Attachments](#attachments)). `401` without a valid session, `400` for a disallowed `type`/`mimeType` or an oversized `sizeBytes`, `429` when the message rate limit is exhausted, `503` when R2 is not configured. |

With `include=calls` the page becomes a unified conversation timeline: calls between the same two users are merged in and every entry carries a `type` discriminator — a message contributes its own type (`text`, `image`, `file`, `voice`, `system`), or `call` for `{ type, callId, conversationId, direction, status, endReason, durationSeconds, createdAt }`. The `before` cursor stays exact across the merged stream (`messageStore.nextTimestamp()` guarantees strictly-increasing message timestamps, and ties are broken by entry id). The parameter is opt-in, so omitting it returns exactly the payload it always did, and a blocked (or blocking) peer's calls are filtered out just like their conversation is in `GET /conversations`.

`GET /conversations` correspondingly reports `lastActivity` — whichever of the last message and the last call is newer — alongside `lastMessage`, and counts a peer's unacknowledged missed calls in `unreadCount`. `POST /messages/read` clears both halves, returning `{ conversationId, updated, missedCallsRead }`.

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
| `call.connected` | `{ version, callId, iceState? }`        | `{ ok, version, event, call }`     | Participants only. Reports the local `RTCPeerConnection` state: `connected`/`completed` advances the call to `in_call` (the first report wins, later ones are idempotent), while `disconnected`/`failed` ends it with `media_failed`. Without this event a call never leaves `connecting_media` and is force-ended by the stale-call sweep with `media_connect_timeout`. |
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

#### Text chat contract

Text chat reuses the same versioned envelope and ack conventions as the call
contract. Messages are persisted through `src/messageStore.ts` (in-memory by
default, Cosmos DB for MongoDB when `MONGODB_URI` is set).

##### Client → Server

| Event          | Payload                              | Ack success                            | Notes |
| -------------- | ------------------------------------ | -------------------------------------- | ----- |
| `message.send` | `{ version, recipientId, body, type?, attachment?, replyTo?, messageId? }` | `{ ok, version, event, message }`      | `body` must be a string of at most **4000** characters, and non-empty unless the message carries an attachment. `type` defaults to `text` and may be `text`, `image`, `file` or `voice` (`system` is server-owned). Rejected with `unauthorized` (no session), `unsupported_version`, `bad_request` (missing/self `recipientId`, empty/oversized/non-string `body`, unknown `type`, missing attachment, disallowed MIME type, oversized attachment, or an `attachment.url` this server did not presign), and `forbidden` when either party has blocked the other. |
| `message.delete` | `{ version, peerId, messageId }`   | `{ ok, version, event, messageId, conversationId }` | "Delete for everyone" for one of your **own** messages. The row is tombstoned rather than removed, so a reply that quotes it still resolves. `not_found` for an unknown (or already deleted) message and for someone else's. |
| `message.react` | `{ version, peerId, messageId, emoji, action }` | `{ ok, version, event, messageId, conversationId, reactions }` | `action` is `add` or `remove`; `emoji` must be an emoji of at most 16 code units. Idempotent, so a replayed add cannot toggle the reaction off. `not_found` for an unknown or tombstoned message, `forbidden` when either party has blocked the other. |

##### Server → Client

| Event               | Payload summary |
| ------------------- | --------------- |
| `message.received`  | `{ version, message }` emitted to the recipient's `user:<userId>` room, so every one of their devices receives it via the Socket.IO Redis adapter. |
| `message.delivered` | `{ version, messageId, conversationId, deliveredTo }` emitted back to the sender once the message has been persisted and fanned out. |
| `message.deleted`   | `{ version, conversationId, messageId, deletedBy, message }` emitted to **both** participants; `message` is the tombstone that replaced the content. |
| `message.reaction`  | `{ version, conversationId, messageId, reactions, actorId, emoji, action }` emitted to both participants' `user:<userId>` rooms, so every device of both users converges on the same reaction set. |

The persisted message shape is
`{ messageId, conversationId, senderId, recipientId, body, type, attachment, replyTo, reactions, deletedAt, createdAt, deliveredTo, readAt }`.
Rows written before rich messaging carry none of `type`, `attachment`,
`replyTo`, `reactions` or `deletedAt`: readers default the type to `text` and
treat the rest as absent. A `type` a client does not know about must render as
a neutral "Unsupported message" placeholder rather than crash it — that rule is
what makes the schema safe to extend, and it is covered by
`test/messages-rich.test.ts`.
`conversationId` is derived deterministically from the two user ids (sorted and
joined), so both participants resolve the same conversation. `createdAt` is a
monotonic ISO timestamp, which keeps the newest-first ordering and the `before`
cursor exact even for messages sent within the same millisecond.

Recipients with **no live socket** additionally get a data-only push via the
same provider chain as incoming calls (see [Push notifications](#push-notifications)).

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
| `SOCKET_PING_INTERVAL_MS` | `10000` | Engine.IO heartbeat interval. Together with `SOCKET_PING_TIMEOUT_MS` this bounds how long a dead client (e.g. a suspended phone) still looks connected. The defaults detect a drop in ~20s, comfortably inside the ringing timeout, so the callee falls back to push instead of ringing into a dead socket. |
| `SOCKET_PING_TIMEOUT_MS` | `10000` | Time (ms) to wait for a client's heartbeat response before considering the socket dead. |
| `RINGING_TIMEOUT_MS` | `120000` | How long a call may ring before it is marked `missed`. The incoming-call push TTL is derived from the time *remaining* in this window, so a late-delivered push expires exactly when the call does. |
| `STALE_DEVICE_MAX_AGE_MS` | `5184000000` (60d) | How long a device row may go without a push re-registration before the background sweep removes it. The app re-registers on every launch, so an older row belongs to an install that no longer exists (an app reinstall wipes the client-persisted `device_id` and registers a brand-new row). A row backing a live socket or an unexpired session is never swept. |
| `MAX_PUSH_DEVICES_PER_USER` | `3` | Maximum push-registered devices one user's notification fans out to, most recently registered first. Truncation is logged at `warn`, since it means stale rows are accumulating. |
| `DATABASE_URL` | _(unset)_ | Postgres connection string for **runtime** queries. On Neon, use the **pooled** endpoint (`...-pooler.neon.tech`). |
| `DATABASE_URL_DIRECT` | _(unset)_ | Postgres connection string for **migrations/DDL**. On Neon, use the **direct (unpooled)** endpoint. Falls back to `DATABASE_URL` when unset. |
| `DATABASE_POOL_MAX` | `10`     | Maximum app-side `pg` pool connections. |
| `FCM_SERVICE_ACCOUNT_JSON` | _(required)_ | Firebase service-account credentials used for ID-token verification and FCM HTTP v1 push delivery. Either the raw JSON string or a path to the JSON key file. |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` | _(unset)_ | APNs token-auth credentials. All four required to enable APNs pushes. |
| `APNS_PRODUCTION` | `false` | Use the APNs production gateway when `true`, sandbox otherwise. |
| `AZURE_NOTIFICATION_HUB_CONNECTION_STRING` | _(unset)_ | Azure Notification Hubs `DefaultFullSharedAccessSignature` connection string (`Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…`). Enables the **preferred** push transport. Absent or unparseable ⇒ `notification_hub_not_configured` and the direct FCM/APNs path is used. See [`AZURE_SETUP.md`](../docs/AZURE_SETUP.md). |
| `AZURE_NOTIFICATION_HUB_NAME` | _(unset)_ | Notification hub name (e.g. `storeman`). Required alongside the connection string. |
| `AZURE_NOTIFICATION_HUB_API_VERSION` | `2015-04` | Notification Hubs REST API version used in the `api-version` query parameter. |
| `MONGODB_URI` | _(unset)_ | Azure Cosmos DB for MongoDB connection string for text-message persistence. Must include `retrywrites=false` (see [`AZURE_SETUP.md`](../docs/AZURE_SETUP.md)). Required when `NODE_ENV=production` unless the memory store is explicitly enabled. |
| `ALLOW_IN_MEMORY_MESSAGE_STORE` | `false` | Set to `true` to explicitly allow non-durable messages in production. Development and tests still default to memory. |
| `MONGODB_DB_NAME` | `wetalk` | Database holding the chat collection. |
| `MONGODB_MESSAGES_COLLECTION` | `messages` | Collection holding chat messages. |
| `R2_ACCOUNT_ID` | _(unset)_ | Cloudflare account id, used to derive the R2 S3 endpoint (`https://<id>.r2.cloudflarestorage.com`). Not needed when `R2_ENDPOINT` is set explicitly. |
| `R2_BUCKET` | _(unset)_ | R2 bucket holding chat media. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | _(unset)_ | R2 API token credentials used to sign upload URLs. |
| `R2_PUBLIC_BASE_URL` | _(unset)_ | Public origin the bucket (or its CDN hostname) is served from. Chat media lives under `<base>/chatblobs/…`, and only URLs under that prefix are accepted on `message.send`. |
| `R2_ENDPOINT` | derived from `R2_ACCOUNT_ID` | Override for the S3-compatible endpoint (custom domain, or a local S3 stand-in). |
| `R2_PRESIGN_TTL_SECONDS` | `300` | Lifetime of a presigned upload URL, capped at `3600`. |
| `MESSAGE_RATE_LIMIT` | `30` | Maximum `message.send` events per authenticated user per window. |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Message-send rate-limit window in milliseconds. |
| `REDIS_URL` | _(unset)_ | Redis connection URL enabling multi-instance mode (cross-instance message bus + shared read cache + Socket.IO Redis adapter). Single-instance/in-memory when unset. |

## Attachments

Chat media never travels through the signaling server. `POST
/attachments/presign` returns a short-lived, S3 SigV4-signed `PUT` URL for
Cloudflare R2; the client uploads directly, then sends a `message.send`
referencing the returned `publicUrl`.

- Every object lives under one shared prefix — `<R2_PUBLIC_BASE_URL>/chatblobs/<conversationId>/<uuid>.<ext>` — so a deployment only points a single bucket/CDN hostname at chat media, and `message.send` can reject any URL outside it.
- The object key is **server-generated**, so a caller cannot overwrite another conversation's media.
- `content-length` and `content-type` are part of the signature: an upload that exceeds the size cap or changes its MIME type is rejected by R2 itself, not only by the client. The same allowlist and caps (10 MB images, 16 MB voice notes, 25 MB files — see `shared/messages.ts`) are re-checked on `message.send`.
- When R2 is not configured the endpoint answers `503` and attachment messages are refused; the rest of chat is unaffected.

## Push notifications

`src/push.ts` delivers data-only pushes to **devices** with no live WebSocket
connection — both incoming calls (`sendIncomingCallPush`) and text messages
(`sendMessagePush`). Gating is per **device**, not per user: a user who is online
on their phone still receives a push on their offline tablet.

### Provider chain

Every send walks the chain below and never throws; each step degrades to the
next and reports a `*_not_configured` reason when it is not set up.

1. **Azure Notification Hubs (preferred)** — one API for both platforms. Tried
   first whenever `AZURE_NOTIFICATION_HUB_CONNECTION_STRING` and
   `AZURE_NOTIFICATION_HUB_NAME` are set, regardless of the device's underlying
   provider.
2. **Direct FCM / APNs (fallback)** — used when Notification Hubs is
   unconfigured *or* a Notification Hubs send fails after retries. The fallback
   is logged explicitly:
   `[push] Notification Hub delivery failed (reason=…); falling back to direct fcm`.
3. **Skip** — if nothing is configured the send resolves to
   `{ ok: false, reason: '<provider>_not_configured' }` and the call/message
   still proceeds over the socket path.

The outcome returned to callers carries `transport: 'notification_hub' | 'direct'`
alongside the existing `provider`, `deviceId`, `ok`, `statusCode`, and `reason`
fields, so logs and metrics show which leg actually delivered.

Single attempts are wrapped in `withRetry()` (3 attempts, exponential backoff,
retrying on a missing status code, `429`, or `5xx`).

> **Data-only is deliberate.** Payloads never contain a `notification` block: on
> Android that would bypass the app's `setBackgroundMessageHandler` and break the
> CallKeep full-screen incoming-call UI.

### Azure Notification Hubs

Set `AZURE_NOTIFICATION_HUB_CONNECTION_STRING` (the
**DefaultFullSharedAccessSignature** from the hub's *Access Policies* blade) and
`AZURE_NOTIFICATION_HUB_NAME`. Optionally override
`AZURE_NOTIFICATION_HUB_API_VERSION` (default `2015-04`, the latest documented
data-plane version for the `/messages/?direct` operation).

The server signs each request with a short-lived SAS token minted from the
connection string (cached and refreshed before expiry) and uses **direct send**
(`/messages/?direct`, `ServiceBusNotification-DeviceHandle: <pushToken>`) so it
keeps targeting the exact device token already stored by `POST /devices/register` —
no migration to Notification Hubs registrations or tags is required. No Azure SDK
dependency is needed; the integration is plain `https` + `crypto`.

The hub translates the data-only body into a native provider payload according
to `ServiceBusNotification-Format`: `apple` for APNs devices, `FcmV1` for FCM
devices. Google retired the FCM legacy HTTP protocol (Notification Hubs' `gcm`
format) in June 2024 — a hub configured with a Google (FCM v1) service-account
credential rejects `gcm`-format sends with `400 ... no target applications ...
format is gcm`, so the server always sends the `FcmV1` native `message` envelope
for Android devices.

APNs and FCM credentials still have to be configured **inside the hub** (Apple
token auth + the Firebase service-account JSON). Step-by-step portal
instructions live in [`AZURE_SETUP.md`](../docs/AZURE_SETUP.md).

### FCM (Firebase Cloud Messaging) — HTTP v1 (fallback)

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

The server uses the service account for both Firebase ID-token verification and
short-lived FCM OAuth2 access tokens. Production startup fails when
`FCM_SERVICE_ACCOUNT_JSON` is absent or invalid.

### APNs (Apple Push Notification service) — fallback

Set `APNS_KEY` (the `.p8` private key contents), `APNS_KEY_ID`, `APNS_TEAM_ID`,
and `APNS_BUNDLE_ID`; toggle `APNS_PRODUCTION=true` for the production gateway.

## Text-message persistence

`src/messageStore.ts` provides a transport-agnostic store with two
implementations, selected by environment:

- `createMemoryMessageStore()` — array-backed, used when `MONGODB_URI` is unset
  and throughout the test suite.
- `createMongoMessageStore({ uri, dbName, collectionName })` — the official
  `mongodb` driver against **Azure Cosmos DB for MongoDB**.

Both expose `saveMessage`, `listMessages({ conversationId, limit, before })`
(newest-first, `limit` clamped to 1–100, default 50), `markDelivered`, and
`close()`. The store is created by the composition root (`src/createServer.ts`),
hung off the shared `state` object next to `messageBus`/`telemetry`, and closed
during the graceful-shutdown drain.

On first connect the Mongo store creates a compound
`{ conversationId: 1, createdAt: -1 }` index and a unique `{ messageId: 1 }`
index. Index creation failures are logged and ignored rather than taking the
server down.

See [`AZURE_SETUP.md`](../docs/AZURE_SETUP.md) for provisioning the Cosmos DB account.

## Database (Drizzle ORM)

Durable persistence uses [Drizzle ORM](https://orm.drizzle.team/) over Postgres
(Neon). The schema is defined in code at `db/schema.ts`; versioned SQL
migrations are generated from it into `db/migrations/` by `drizzle-kit` — do not
hand-edit the generated SQL.

```bash
# After editing db/schema.ts, regenerate the migration (commit the result):
npm run db:generate

# …or give the migration a meaningful name (commit the result):
npm run db:generate:named -- call_duration_and_missed_read

# Verify the generated migrations and their journal are consistent:
npm run db:check

# Apply pending migrations (uses DATABASE_URL_DIRECT, falling back to DATABASE_URL):
npm run db:migrate
```

### Neon connection split

- **App/runtime** queries → the **pooled** endpoint via `DATABASE_URL`.
- **Migrations/DDL** → the **direct (unpooled)** endpoint via `DATABASE_URL_DIRECT`
  (Neon's PgBouncer transaction-mode pooler can't run migration advisory locks
  / some DDL).

The database-backed tests in `test/db-drizzle.test.ts` are **skipped** unless
`DATABASE_URL` is set, so the rest of the suite runs offline. To run them
locally, point `DATABASE_URL` at a disposable Postgres and run `npm test`.

## Horizontal scaling (Redis)

Running more than one server instance behind a load balancer requires two pieces
of cross-instance coordination, both backed by Redis:

- **Message bus** (`src/messageBus.ts`) — Redis Pub/Sub used to broadcast
  call-state transitions (channel `signaling:call.transitions`) and cache
  invalidations (channel `signaling:cache.invalidate`) to other instances /
  observers.
- **Read cache** (`src/cache.ts`) — a shared cache in front of the hottest
  reads: `GET /conversations` (`conv::<userId>`), the first page of
  `GET /messages` (`msg::<conversationId>::<limit>`, excluding the
  `include=calls` timeline, which mixes in live call state) and the first page
  of `GET /calls` (`callhist::<userId>::<status>::<limit>`; paged requests,
  i.e. `offset > 0`, are not cached), each with a 30s TTL. Writes
  (`message.send`, delivery receipts, `POST /messages/read`, call transitions)
  evict the affected prefixes locally and publish them on the bus so every
  instance drops its copy. Backed by Redis when `REDIS_URL` is set (`SET … PX`
  / `GET`, `SCAN`-based prefix deletes) and by a bounded, TTL'd in-process map
  otherwise. Hits and misses are counted in `GET /metrics`
  (`cache_hits`, `cache_misses`, `derived.cache_hit_rate`).
- **Socket.IO Redis adapter** — so room and per-user emits reach a user's
  sockets no matter which instance they are connected to. Each socket joins a
  `user:<userId>` room on connect; user-targeted call/RTC events are addressed to
  that room.

Wire both by building a Redis-backed store bundle and passing it to
`createServer`:

```js
const { createServer, createRedisPgStores } = require('./src/index');

const stores = await createRedisPgStores();      // uses REDIS_URL
const server = createServer({ stores, messageBus: stores.messageBus });
```

`createRedisPgStores()` opens the Redis connections (one Pub/Sub pair for the
bus, one for the adapter), exposes `messageBus` and `attachAdapter(io)` (invoked
automatically by `createServer`), and a `close()` that `shutdown()` calls during
a graceful drain. Hot keyed state (rooms, sessions, presence, …) remains
in-process per instance; cross-instance delivery is handled by the adapter and
bus rather than by sharing those maps.

When `REDIS_URL` is unset the default in-memory stores and a no-op (single
instance) bus are used, so local development and the test suite run without
Redis. The message-bus / Redis-store tests in `test/message-bus.test.ts` use an
in-memory Redis fake and need no live server.
