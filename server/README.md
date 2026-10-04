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
- `GET /health` — liveness/health probe returning JSON `{ status: "ok", ... }`. Its `fanout` block is an *active* cross-instance check (`src/lib/fanoutProbe.ts`), deliberately separate from `stateAffinity`: the latter only says runtime state is Redis-backed, which does not prove an event emitted here reaches a socket held by another instance.
- `GET /messages` — paginated text-chat history (see [REST endpoints](#rest-endpoints))
- `GET /messages/search` — participant-scoped full-text search
- `GET /messages/sync` — cursor-paginated message deltas
- Socket.IO endpoint for WebRTC signaling (see events below)

### REST endpoints

Besides the call/session/contact routes, the chat surface adds:

| Method & path | Query | Response | Notes |
| ------------- | ----- | -------- | ----- |
| `GET /messages` | `peerId` (required), `limit` (1–100, default `50`), `before` (ISO `createdAt` cursor, exclusive), `include` (`calls` to merge in call records) | `200 { conversationId, messages }` | History of the conversation between the authenticated user and `peerId`, **newest-first**. Session resolved by `getSessionFromRequest` (`Authorization: Bearer <id>` header, or the request body for POSTs — **never the query string**, which would leak the token into access logs, proxies and `Referer`). `401` without a valid session, `400` when `peerId` is missing or equals your own id, `403` if a returned message does not involve you, `503` if the store is unavailable. |
| `GET /messages/search` | `q` (required), `conversationId` (optional), `limit` (1–100, default `50`), `cursor` (exclusive ISO `createdAt`), `cursorMessageId` (tie-breaker) | `200 { query, results, limit, nextCursor, hasMore }` | PostgreSQL full-text search across caller-participating conversations, newest-first; memory search requires every query token to occur. Tombstones and conversations blocked in either direction are excluded. Search terms are audit-logged; per-user rate limiting returns `429`. |
| `GET /messages/sync` | `since` (required exclusive ISO timestamp), `cursor` (opaque `nextCursor`), `limit` (1–100, default `50`) | `200 { changes, limit, nextCursor, hasMore }` | Ordered direct and group message changes (`new`, `edited`, `deleted`, `reactions`), after `since`; pass `nextCursor` to continue. Direct participants/block rules and active group membership/join watermarks are enforced. Both logs share the same change-ID sequence and cursor semantics. Change-log rows cascade with message retention. |
| `GET /calls` | `limit` (1–100, default `20`), `offset` (default `0`), `status` (optional filter) | `200 { calls, total, limit, offset, hasMore }` | Call history for the authenticated user, **most recently active first** (`updatedAt` descending). Read from the durable `calls` table, so it survives a restart and is not bounded by the in-memory retention window (`CALL_RETENTION_MS` / `MAX_RETAINED_CALLS`); when no `DATABASE_URL` is configured — or the query fails — it degrades to the calls still resident in memory. `401` without a valid session. |
| `GET /account/export` | `limit` (internal message page size, 1–100, default `50`), `callLimit` (internal call page size, 1–100, default `50`) | `200 { schemaVersion, exportedAt, userId, profile, messages, calls, callEvents, devices, blocks, auditLog, pagination }` | Complete streaming JSON export scoped only to the bearer session. Bounded internal reads include every message tombstone, attachment URL, participant call/event, outbound block, and audit entry involving the account. Excludes `authUid`, peer live-device ids, push tokens, session ids, and attachment bytes/metadata; attachment objects contain only `url`. Limited to one complete export per account per day by default. |

| `POST /account/delete` | body: none | `202 { status, requestedAt, scheduledFor, completedAt }` | Queues this account for erasure and returns when it becomes due (`ACCOUNT_DELETION_GRACE_MS`, 7 days by default). Idempotent: repeating the request does not extend the grace period. `GET /account/delete` reports the queued request (`{ status: 'none' }` when there is none) and `DELETE /account/delete` cancels one that has not run yet (`404` when nothing is pending). The erasure itself runs in a background sweep — see `src/domain/accountDeletion.ts` for what it cascades across. `401` without a valid session, `429` when the request limit is exhausted. |

| `GET /profile` | body: none | `200 { userId, displayName, avatarKey, updatedAt }` | The caller's own profile. `401` without a valid session. |
| `PATCH /profile` | body `{ displayName: string \| null }` | `200 { userId, displayName, avatarKey, updatedAt }` | Updates the caller's display name; `null` clears it so the UI falls back to the username. The value is NFC-normalised, stripped of control characters, bidi overrides and zero-width codepoints, capped at 48 codepoints, and **refused when it folds onto another user's username** (case, spacing and punctuation are ignored in that comparison) — otherwise the directory would be spoofable. Every accepted change is audited as `profile.display_name_changed` and every rejection as `profile.display_name_rejected`, and the conversation-list cache is invalidated for the user and every peer they have a conversation with, across instances, so a rename cannot linger on another VM for a TTL. `400` on a rejected name, `401` without a valid session, `429` when `PROFILE_UPDATE_RATE_LIMIT` is exhausted. |
| `POST /attachments/presign` | body `{ peerId, type, mimeType, sizeBytes }` | `200 { conversationId, key, uploadUrl, reference, expiresAt, headers }` | Mints a short-lived Cloudflare R2 upload URL for a chat attachment (see [Attachments](#attachments)). `401` without a valid session, `400` for a disallowed `type`/`mimeType` or an oversized `sizeBytes`, `429` when the message rate limit is exhausted, `503` when R2 is not configured. |

| `POST /avatar/presign` | body `{ mimeType, sizeBytes }` | `200 { key, uploadUrl, expiresAt, headers }` | Mints a short-lived R2 upload URL for the caller's own avatar (see [Avatars](#avatars)). `400` outside the image allowlist or over 2 MB, `429` on the message rate limit, `503` when R2 is not configured. |
| `PUT /avatar` | body `{ key }` | `200 { avatarKey }` | Publishes an uploaded key as the account's avatar and deletes the object it replaces. `400` unless the key is an avatar key minted for this account. |
| `DELETE /avatar` | body: none | `200 { avatarKey: null }` | Clears the avatar and deletes its object. |
| `GET /avatar/download` | `userId` (defaults to the caller) | `200 { userId, avatarKey, downloadUrl, expiresAt }` | Mints a presigned `GET` for that user's avatar. Authorised by **directory visibility** — the block-aware predicate `GET /users` filters on — not by conversation scope. `403` when the owner is not visible to the caller, `404` when they have no avatar, `429` on the attachment-download rate limit, `503` when R2 is not configured. |

With `include=calls` the page becomes a unified conversation timeline: calls between the same two users are merged in and every entry carries a `type` discriminator — a message contributes its own type (`text`, `image`, `file`, `voice`, `system`), or `call` for `{ type, callId, conversationId, direction, status, endReason, durationSeconds, createdAt }`. The `before` cursor stays exact across the merged stream (`messageStore.nextTimestamp()` guarantees strictly-increasing message timestamps, and ties are broken by entry id). The parameter is opt-in, so omitting it returns exactly the payload it always did, and a blocked (or blocking) peer's calls are filtered out just like their conversation is in `GET /conversations`.

`GET /conversations` correspondingly reports `lastActivity` — whichever of the last message and the last call is newer — alongside `lastMessage`, and counts a peer's unacknowledged missed calls in `unreadCount`. `POST /messages/read` clears both halves, returning `{ conversationId, updated, missedCallsRead }`.

### Socket.IO signaling events

Authenticated signaling uses versioned websocket events (`version: 3`) and Socket.IO acknowledgements. Version 2 remains accepted and is translated for deployed clients; server events are sent in the recipient's negotiated version.
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
| `rtc.offer`      | `{ version, callId, peerId, sdp }`      | `{ ok, version, event, callId }`   | V3 peer must be another call participant. V2 omits `peerId`. |
| `rtc.answer`     | `{ version, callId, peerId, sdp }`      | `{ ok, version, event, callId }`   | V3 peer must be another call participant. V2 omits `peerId`. |
| `rtc.ice`        | `{ version, callId, peerId, candidate }`| `{ ok, version, event, callId }`   | V3 ICE relay. V2 clients use `rtc.candidate` without `peerId`. |

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
| `call.participant.joined` | `{ version, callId, participantId, state: 'joined' }` |
| `call.participant.left` | `{ version, callId, participantId, state: 'left' | 'declined' }` |
| `rtc.offer`          | V3 `{ version, callId, peerId, fromUserId, sdp }`; v2 omits `peerId`. |
| `rtc.answer`         | V3 `{ version, callId, peerId, fromUserId, sdp }`; v2 omits `peerId`. |
| `rtc.ice`            | V3 `{ version, callId, peerId, fromUserId, candidate }`; v2 clients receive `rtc.candidate` without `peerId`. |

V3 call records include `participants: [{ userId, state }]`, where participant
states are `invited`, `ringing`, `joined`, `left`, or `declined`. The current
one-to-one call path is represented as two participants.

#### Text chat contract

Text chat reuses the same versioned envelope and ack conventions as the call
contract. Messages are persisted through `src/messageStore.ts` (Postgres when a
database handle is configured, in-memory otherwise). Group handlers use
`src/conversationStore.ts`; admission is explicit as described below.

##### Client → Server

| Event          | Payload                              | Ack success                            | Notes |
| -------------- | ------------------------------------ | -------------------------------------- | ----- |
| `message.send` | `{ version, recipientId XOR conversationId, body, type?, attachment?, replyTo?, clientMessageId?, messageId? }` | `{ ok, version, event, message }` | New sends use a stable UUID `clientMessageId`; `messageId` is only the legacy retry path. `recipientId` targets a direct chat; `conversationId` targets a group. `body` must be a string of at most **4000** characters, and non-empty unless the message carries an attachment. `type` defaults to `text` and may be `text`, `image`, `file` or `voice` (`system` is server-owned). The current direct-chat handler rejects missing/self `recipientId`, malformed content/attachments, and blocked peers. |
| `message.delete` | `{ version, peerId XOR conversationId, messageId }` | `{ ok, version, event, messageId, conversationId }` | "Delete for everyone" for one of your **own** messages. The row is tombstoned rather than removed, so a reply that quotes it still resolves. `not_found` for an unknown (or already deleted) message and for someone else's. |
| `message.react` | `{ version, peerId XOR conversationId, messageId, emoji, action }` | `{ ok, version, event, messageId, conversationId, reactions }` | `action` is `add` or `remove`; `emoji` must be an emoji of at most 16 code units. Idempotent, so a replayed add cannot toggle the reaction off. `not_found` for an unknown or tombstoned message, `forbidden` when either direct-chat party has blocked the other. |
| `message.typing` | `{ version, recipientId XOR conversationId, isTyping }` | _(fire-and-forget)_ | Announces typing in a direct chat or group. |

The client-side group lifecycle contract is:

| Event | Payload |
| ----- | ------- |
| `conversation.create` | `{ version, name, inviteeIds }` |
| `conversation.update` | `{ version, conversationId, name }` |
| `conversation.leave` | `{ version, conversationId }` |

The server broadcasts `conversation.updated` with
`{ version, conversation, updatedBy }`. The snapshot contains
`conversationId`, `name`, `creatorId`, active `memberIds`, and
`membershipVersion`. Invitees are not active members until they accept; client
provided IDs never establish authorization. Group calls remain out of scope.

##### Group admission and authorization (#536)

This implements server membership/admission and message fan-out, sync, and
receipts, not the broader mobile, unread/mute, encryption, or group-call
redesign MVP.

**Delivery and receipts (#538).** Direct and group sends share a
conversation-target delivery flow; legacy direct `recipientId` remains supported,
and a direct `conversationId` must identify the authenticated participant.
Group events cross instances through the Socket.IO Redis adapter's
server-to-server channel, with active membership and join-watermark checks on
each receiving instance. Without an adapter, the shared message bus remains the
event fallback, but presence lookup is local: this configuration is for
single-instance development, not multi-instance push delivery. The two-VM
deployment requires the Redis adapter (`deploy/README.md` §5a). Every member's
conversation-list cache is invalidated on the shared message bus.

One accepted group message makes at most **15** push attempts: one per offline
member, selecting their newest registered push device, with the group name as
the notification title. Adapter-wide presence includes members on another VM.
Idempotent retries do not resend notifications; push failure does not undo
message acceptance. Push delivery is best-effort.

Group messages expose `deliveredTo` and `readBy` member-ID lists, rather than a
single read flag. `POST /messages/read` accepts `{ conversationId }` for groups;
the direct `{ peerId }` contract is unchanged. Group reads are idempotent,
emit `message.read` with `readerId` and `readAt`, and produce `edited` sync
deltas. Clients can show a read count using `readBy.length` or a reader list.
Search and sync exclude departed members and pre-join history. Group search
reuses the current PostgreSQL full-text GIN approach (which superseded the
older trigram indexes in migration 0018).

Apply `0023_group_message_fanout.sql` before deploying this server. It adds
durable group receipts, the group change log and search index, and backfills
existing group messages into sync. Its matching Drizzle snapshot is included;
the migration uses transactional DDL, so plan for locks on populated tables.

**Storage compatibility.** The existing physical `group_conversations` and
`group_conversation_members` tables serve as semantic `groups` and
`group_members`. Reusing them avoids destructive renames or parallel state and
preserves UUIDs, existing message/call foreign keys, and the `conversationId`
wire field; direct conversations are unchanged. Migration
`0021_group_admission_intervals.sql` adds durable invitations/events and replaces
the member composite primary key with `member_id` plus a partial unique
active-member index. Existing legacy grants retain their admission timestamps.
Departure closes an interval; acceptance/rejoin appends one without resetting
old admission history. Apply migrations via `npm run db:migrate` using
`DATABASE_URL_DIRECT` (unpooled). These are ordinary transactional indexes,
**not** `CREATE INDEX CONCURRENTLY`; plan for DDL locks on populated tables.
Generation and `npm run db:check` need no live database.

**Admission/history decisions.** Only the creator initially joins. Invitations
name one account and issuer, record the membership version, expire after seven
days, and require explicit acceptance by the addressed account; possession of
an invitation ID grants nothing. Legacy `conversation.create` and
`conversation.member.add` return invitations, never implicit membership.
Acceptance checks the 16-active-member cap under the same PostgreSQL group-row
lock used for membership changes, sends, and content reads/mutations. Memory
performs final checks/writes without intervening awaits. The shared
`conversationStore/authorization.ts` predicate requires an active interval.
History, literal case-insensitive search, replies, retries, reactions, and
attachment lookup enforce the **current** interval's `joinedAt` watermark:
joining/rejoining never backfills older content. Serialized activity advances
by at least 1 ms to separate sends from subsequent admission even on clock ties;
clients cannot choose persisted group-message timestamps.

**REST contract.** All endpoints require the normal session bearer; the existing
POST session-body mechanism is also supported. Names are trimmed, 1–100
characters; removal reasons are at most 200 characters.

| Method/path | Body → result | Authority |
| --- | --- | --- |
| `POST /groups` | `{name, inviteeIds?: string[]}` → `201 {group, invitations}` | Creator |
| `GET /groups` | `{groups}` | Caller’s active groups |
| `GET /groups/invitations` | `{invitations}` | Caller’s pending, unexpired invitations |
| `GET /groups/:groupId` | `{group}` | Active member |
| `POST /groups/:groupId/invitations` | `{userId}` → `201 {invitation}` | Owner/admin |
| `POST /groups/:groupId/invitations/:invitationId/accept` | `{}` → `{group}` | Addressed account |
| `DELETE /groups/:groupId/invitations/:invitationId` | `204` | Owner/admin |
| `POST /groups/:groupId/leave` | `{}` → `{group}` | Active non-owner |
| `DELETE /groups/:groupId/members/:userId` | `{reason?}` → `{group}` | Owner/admin; not owner or self |
| `PATCH /groups/:groupId` | `{name}` → `{group}` | Owner/admin |
| `PATCH /groups/:groupId/members/:userId` | `{role: "admin" \| "member"}` → `{group}` | Owner; non-owner target |
| `POST /groups/:groupId/ownership` | `{userId}` → `{group}` | Owner; target is active admin |
| `DELETE /groups/:groupId` | `204` | Owner, with no other active members |
| `GET /groups/:groupId/events` | `{events}` since current join | Active member |
| `GET /groups/:groupId/messages` | `{messages, hasMore, nextCursor}` | Active member; current watermark |
| `GET /groups/:groupId/messages/search?q=…` | `{messages}` | Active member; current watermark |

History/search accept `limit` (up to 100), `before`, and `beforeMessageId`.
Search accepts a literal 1–200-character term and excludes tombstones; substring
matching may scan entitled history despite bounded results. Existing
`GET /conversations/:conversationId/messages` and socket send/delete/react/typing
enforce the same admission policy with server-derived identity.
Errors: `401` unauthenticated, `403` membership/role/block denial,
`400` malformed/unavailable invitation, `409` full group, `429` throttled,
`503` unavailable store. Deleted-group acceptance may yield `400` or `403`;
neither grants access.

**Blocks, media, and delivery.** Either-direction blocks reject invitation
creation (including invitation-bearing group creation), but later blocks do not
remove membership or filter shared group content. PostgreSQL rechecks durable
blocks in the invitation transaction; memory uses the injected privacy store.
`POST /attachments/presign` accepts `groupId` instead of `peerId`, issuing
`chatblobs/group_<groupId>/…` keys. Group sends reject foreign/direct scopes.
`GET /attachments/download` requires `groupId`, `messageId`, and `key` (or the
stored `url` reference), checking active membership, watermark, and the matching
message attachment. Guessed IDs/keys and client room subscriptions grant no
access. Content fan-out rechecks membership/visibility on the receiving instance
and fails closed on lookup failure, using existing private per-user rooms.
Departure lifecycle notifications do not confer content access. Previously
delivered bytes cannot be retracted; existing download URLs survive until their
15-minute TTL, while departure prevents new grants.

**Limits.** REST and legacy sockets share process-local creation/invitation
budgets: `GROUP_CREATE_RATE_LIMIT` defaults to 5/hour/account;
`GROUP_INVITE_RATE_LIMIT` to 30 addressed invitees/hour/account. Batches charge
each invitee; creation with invitees charges both budgets, and rejected attempts
can consume budget. Admission throttling returns `Retry-After` on REST. Restarts
reset these limits and multiple instances multiply them; fleet-wide guarantees
require a fail-closed shared limiter, not merely Redis configured elsewhere.

**Account policy.** Export retains active `groupConversations`, adds all own
`groupMemberships` (including closed intervals), and exports only the caller’s
own `groupMessages`, paged independently of current membership. Export is not
admission to other senders’ old content. Erasure closes/anonymizes intervals and
departure actors, cancels pending invitations involving the account, anonymizes
invitation/event identities, removes retained reactions, and revokes sessions
and sockets. Own messages become content-free tombstones; managed attachment
references enter the existing object-deletion workflow. Other entitled members
retain shared history. Owner erasure transfers authority to a remaining active
member as an erasure-only exception; ordinary departure requires explicit
transfer to an admin. Last-member erasure transactionally captures all live
attachment references (including former members and concurrent erasures) in
`group_attachment_cleanup` before collecting the group and cascaded rows.
Own message batches also enqueue unshared references in the same transaction.
This queue has no cascading foreign keys: restarts and completed account jobs
cannot lose pending cleanup. The account-deletion sweep reads at most 500 keys
per page and acknowledges only successful object deletions; storage failures
remain queued for later sweeps. Duplicate attempts are safe (object DELETE is
idempotent). Candidates and historical surviving references use the same
ECMAScript whitespace trimming; a copied live reference prevents enqueueing.
Only managed attachment references reach storage deletion (the existing key
validator still applies); invalid historical references remain queued for
operator review. Creator erasure alone never drops a populated group.

##### Server → Client

| Event               | Payload summary |
| ------------------- | --------------- |
| `message.received`  | `{ version, message }` emitted to the recipient's `user:<userId>` room, so every one of their devices receives it via the Socket.IO Redis adapter. |
| `message.delivered` | `{ version, messageId, conversationId, deliveredTo }` emitted back to the sender once the message has been persisted and fanned out. |
| `message.deleted`   | `{ version, conversationId, messageId, deletedBy, message }` emitted to **both** participants; `message` is the tombstone that replaced the content. |
| `message.reaction`  | `{ version, conversationId, messageId, reactions, actorId, emoji, action }` emitted to both participants' `user:<userId>` rooms, so every device of both users converges on the same reaction set. |

The persisted message shape is
`{ messageId, clientMessageId?, conversationId, senderId, recipientId, body, type, attachment, replyTo, reactions, deletedAt, createdAt, deliveredTo, readAt }`.

Explicit-key sends receive a server-generated `messageId`, distinct from
`clientMessageId`, and authoritative
`createdAt` in the ack's `message`. Retries return the persisted winner, preserving
those fields and any accumulated receipts/reactions. Unique sender/key indexes
in both message tables guarantee cross-instance deduplication; the same UUID
from two senders in one conversation does not collide. Mismatched key reuse is
`bad_request`, with no update or duplicate fanout. Membership/block validation
still runs on retries. Legacy sends without `clientMessageId` retain the
`(conversationId, messageId)` retry behavior.

An explicit-key retry after deletion returns the existing tombstone with its
original server ID/timestamp, without restoring content or creating another
change/unread increment. Sender, recipient, conversation, type and reply
reference still must match; erased body/attachment content cannot be compared.
Legacy `messageId` collision checks are unchanged. Mutable receipt or deletion
fields may legitimately differ between acks; their server identity stays stable.

Retry keys live with their message rows: explicitly configured retention that
removes a row also removes its deduplication guarantee. There is no separate
retention ledger, matching the legacy primary-key retry lifecycle.
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

#### Server lifecycle

| Event               | Payload                | Description |
| ------------------- | ----------------------- | ----------- |
| `server.draining`   | `{ reason, ts }`         | Emitted to every connected client when the instance begins a graceful shutdown; clients should reconnect. |

### Environment variables

| Name          | Default     | Description                                                       |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `PORT`        | `4173`      | TCP port to listen on                                             |
| `HOST`        | `0.0.0.0`   | Bind address                                                      |
| `CORS_ORIGIN` | `*` (dev)   | Comma-separated allow-list for Socket.IO CORS. Set to your app origin(s) in production. |
| `DEBUG_API_TOKEN` | _(unset)_ | Required operator token for `GET /metrics` and privileged debug endpoints. Send as `x-debug-token`. |
| `SHUTDOWN_DRAIN_MS` | `25000` | Max time (ms) to wait for in-flight socket connections to drain on `SIGTERM`/`SIGINT` before force-closing. Keep below the systemd `TimeoutStopSec`. |
| `SOCKET_PING_INTERVAL_MS` | `10000` | Engine.IO heartbeat interval. Together with `SOCKET_PING_TIMEOUT_MS` this bounds how long a dead client (e.g. a suspended phone) still looks connected. The defaults detect a drop in ~20s, comfortably inside the ringing timeout, so the callee falls back to push instead of ringing into a dead socket. |
| `SOCKET_PING_TIMEOUT_MS` | `10000` | Time (ms) to wait for a client's heartbeat response before considering the socket dead. |
| `RINGING_TIMEOUT_MS` | `120000` | How long a call may ring before it is marked `missed`. The incoming-call push TTL is derived from the time *remaining* in this window, so a late-delivered push expires exactly when the call does. |
| `STALE_DEVICE_MAX_AGE_MS` | `5184000000` (60d) | How long a device row may go without a push re-registration before the background sweep removes it. The app re-registers on every launch, so an older row belongs to an install that no longer exists (an app reinstall wipes the client-persisted `device_id` and registers a brand-new row). A row backing a live socket or an unexpired session is never swept. |
| `DB_CALL_RETENTION_MS` | `7776000000` (90d) | How long a **terminal** `calls` row is kept in Postgres before the retention sweep deletes it; its `call_events` cascade with it. Non-terminal calls are never swept, whatever their age. Much longer than the in-memory `CALL_RETENTION_MS` because the durable row is what `GET /calls` pages over after a restart. `0` disables the sweep. |
| `AUDIT_RETENTION_MS` | `15552000000` (180d) | How long an `audit_log` row is kept before the retention sweep deletes it. Longer than the call window: the audit trail exists to answer questions after the fact. `0` disables the sweep. |
| `MESSAGE_RETENTION_MS` | `0` (disabled) | How long a `messages` row is kept before the retention sweep deletes it. Off by default — unlike the other swept tables, `messages` holds the user's own content rather than a record the server made about them, so deleting it has to be an explicit operator decision. |
| `MAX_PUSH_DEVICES_PER_USER` | `3` | Maximum push-registered devices one user's notification fans out to, most recently registered first. Truncation is logged at `warn`, since it means stale rows are accumulating. |
| `DATABASE_URL` | _(unset)_ | Postgres connection string for **runtime** queries. On Neon, use the **pooled** endpoint (`...-pooler.neon.tech`). |
| `DATABASE_URL_DIRECT` | _(unset)_ | Postgres connection string for **migrations/DDL**. On Neon, use the **direct (unpooled)** endpoint. Falls back to `DATABASE_URL` when unset. |
| `DATABASE_POOL_MAX` | `10`     | Maximum app-side `pg` pool connections. |
| `FCM_SERVICE_ACCOUNT_JSON` | _(required)_ | Firebase service-account credentials used for ID-token verification and FCM HTTP v1 push delivery. Either the raw JSON string or a path to the JSON key file. |
| `TEST_AUTH_BYPASS_ENABLED` | `false` | When `true`, `POST /session` skips Firebase ID-token verification for any `idToken` starting with `TEST_AUTH_USER_PREFIX` (default `lt-`), so load-test traffic (see [`tools/loadrig`](../tools/loadrig/README.md)) can authenticate without real Firebase ID tokens. Tokens that don't match the prefix are still verified normally. Explicit opt-in only — leave unset outside of load testing, and never rely on it to skip provisioning `FCM_SERVICE_ACCOUNT_JSON` for real users. |
| `TEST_AUTH_USER_PREFIX` | `lt-` | Prefix an `idToken` must start with to be accepted by the `TEST_AUTH_BYPASS_ENABLED` bypass. Matches the load rig's generated `lt-<n>` user ids. |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` | _(unset)_ | APNs token-auth credentials. All four required to enable APNs pushes. |
| `APNS_PRODUCTION` | `false` | Use the APNs production gateway when `true`, sandbox otherwise. |
| `AZURE_NOTIFICATION_HUB_CONNECTION_STRING` | _(unset)_ | Azure Notification Hubs `DefaultFullSharedAccessSignature` connection string (`Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…`). Enables the **preferred** push transport. Absent or unparseable ⇒ `notification_hub_not_configured` and the direct FCM/APNs path is used. See [`AZURE_SETUP.md`](../docs/AZURE_SETUP.md). |
| `AZURE_NOTIFICATION_HUB_NAME` | _(unset)_ | Notification hub name (e.g. `storeman`). Required alongside the connection string. |
| `AZURE_NOTIFICATION_HUB_API_VERSION` | `2015-04` | Notification Hubs REST API version used in the `api-version` query parameter. |
| `ALLOW_IN_MEMORY_MESSAGE_STORE` | `false` | Set to `true` to explicitly allow non-durable messages in production. Chat history lives in the same Postgres database as everything else, so this is only needed when `DATABASE_URL` is deliberately absent. Development and tests still default to memory. |
| `R2_ACCOUNT_ID` | _(unset)_ | Cloudflare account id, used to derive the R2 S3 endpoint (`https://<id>.r2.cloudflarestorage.com`). Not needed when `R2_ENDPOINT` is set explicitly. |
| `R2_BUCKET` | _(unset)_ | R2 bucket holding chat media. Must **not** be publicly readable — no custom domain, no `r2.dev` URL (see [`deploy/README.md`](../deploy/README.md)). |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | _(unset)_ | R2 API token credentials used to sign upload URLs. |
| `R2_PUBLIC_BASE_URL` | _(removed)_ | Obsolete: attachments are not publicly addressable. Still being set is logged as a misconfiguration at startup, because it usually means the bucket is publicly served. |
| `R2_ENDPOINT` | derived from `R2_ACCOUNT_ID` | Override for the S3-compatible endpoint (custom domain, or a local S3 stand-in). |
| `R2_PRESIGN_TTL_SECONDS` | `300` | Lifetime of a presigned upload URL, capped at `3600`. |
| `MESSAGE_RATE_LIMIT` | `30` | Maximum `message.send` events per authenticated user per window. |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Message-send rate-limit window in milliseconds. |
| `PROFILE_UPDATE_RATE_LIMIT` | `5` | Maximum `PATCH /profile` display-name changes per authenticated account per window. |
| `PROFILE_UPDATE_RATE_WINDOW_MS` | `3600000` (1 hour) | Profile-update rate-limit window in milliseconds. |
| `ACCOUNT_EXPORT_RATE_LIMIT` | `1` | Maximum account-export requests per authenticated account per window. |
| `ACCOUNT_EXPORT_RATE_WINDOW_MS` | `86400000` (1 day) | Account-export rate-limit window in milliseconds. |
| `SESSION_TTL_MS` | `604800000` (7 days) | Session (bearer token) lifetime. Expired sessions are rejected on every read and swept from memory every 10 minutes; shared-store keys always carry an expiry. `0` restores non-expiring sessions — tests only. |
| `INSTANCE_ID` | _(unset)_ | This instance's ordinal, declared per VM (`SIGNAL_INSTANCE_ID` is an alias). Setting it on the second and subsequent instances arms the startup guard that faults a multi-instance fleet running without `REDIS_URL`. |
| `REDIS_URL` | _(unset)_ | Redis connection URL enabling shared runtime signaling state and multi-instance fanout (`stateAffinity: "shared"`), plus shared cache/message-bus wiring. **Required in production** — the fleet is two signaling VMs, so without it each VM has its own private sessions, presence, call state and cache. Optional for local single-process work, where the in-memory bus and cache are equivalent. |
| `FANOUT_PROBE_INTERVAL_MS` | `15000` | How often this instance announces itself to its peers over the Socket.IO adapter so `/health` can report whether cross-instance socket fan-out actually works (`fanout`). `0` disables the probe. |
| `DB_POOL_SIZE` | `4` | Per-instance Postgres pool size (fallback: `DATABASE_POOL_MAX`). For N instances, divide Neon pooler budget across instances. |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `300000` | Keep idle Postgres connections reusable to avoid a new TLS handshake on sporadic writes. |

## Attachments

Chat media never travels through the signaling server. `POST
/attachments/presign` returns a short-lived, S3 SigV4-signed `PUT` URL for
Cloudflare R2; the client uploads directly, then sends a `message.send`
referencing the returned `reference`.

- The bucket is **private**: nothing in it is fetchable without a signature, so `GET /attachments/download` — session-checked, block-checked, rate-limited, and scope-recomputed from the caller's own identity — is the only way to turn a stored reference into bytes. Exposing the bucket through a custom domain or its `r2.dev` URL makes every attachment readable by anyone who learns its key and bypasses all of that; R2 public access is bucket-level, so a private prefix inside a public bucket does not exist.
- A message stores the object **key** (`chatblobs/<conversationId>/<uuid>.<ext>`) as an opaque reference rather than a URL, and `message.send` rejects anything outside that prefix.
- The object key is **server-generated**, so a caller cannot overwrite another conversation's media.
- `cache-control`, `content-length`, and `content-type` are part of the signature: every object stores `public, max-age=31536000, immutable`, and an upload that exceeds the size cap or changes its MIME type is rejected by R2 itself, not only by the client. The same allowlist and caps (10 MB images, 16 MB voice notes, 25 MB files — see `shared/messages.ts`) are re-checked on `message.send`.
- When R2 is not configured the endpoint answers `503` and attachment messages are refused; the rest of chat is unaffected.

## Avatars

`GET /users?userId=<identifier>` resolves one exact peer's profile without
substring matches or page limits hiding that peer. It applies the same
self-exclusion and bidirectional block checks as directory search.

Avatars share the private R2 bucket with chat media and nothing else about it.
Chat downloads are authorised by recomputing the object's expected
*conversation* scope from the caller's identity; an avatar has no conversation
and is shown to everyone who can see its owner in the directory, so it gets its
own key namespace and its own rule (`src/avatars.ts`).

- Keys are `avatars/<owner>/<uuid>.<ext>`, **not** `chatblobs/`. Keeping the namespaces apart is what makes the two authorisation rules non-interchangeable: each resolves only keys under its own prefix, so an avatar key can never be authorised by a conversation scope, nor a chat key by directory visibility. The owner segment is percent-encoded, so a username containing `/` or `..` can neither forge extra segments nor collide with another user's.
- The bucket stays **private**. Avatars are not a reason to attach a custom domain or enable `r2.dev`: a key travels to every viewer in the directory listing, which makes "the UUID is not a security boundary" more true here, not less.
- `GET /avatar/download` never takes a key from the caller — it reads the owner's stored `avatarKey` — and authorises with `isDirectoryVisible`, the same block-aware predicate `GET /users` filters on, so a blocked user cannot fetch the avatar of somebody who has vanished from their directory.
- Uploads are presigned `PUT`s with `cache-control`, `content-length` and `content-type` signed in. The allowlist is narrower than the one for image attachments — `image/jpeg`, `image/png`, `image/webp`, 2 MB — because an avatar is stored in the clear and handed to every viewer's image decoder, so a server-side allowlist is a real control rather than a claim about opaque bytes.
- Replacing or removing an avatar deletes the previous object with a signed `DELETE`, and account erasure deletes the current one: the bucket has no lifecycle rule that would collect either.
- Download links live an hour (attachments get 15 minutes) because avatars are re-rendered constantly; clients cache the **bytes** under the stable `avatarKey`, never the URL, which expires. `GET /users` publishes `avatarKey` as a cache hint; the key returned by `GET /avatar/download` is the authoritative one, read from Postgres so an avatar changed on the other instance is never served as the key it replaced.
- When R2 is not configured every avatar endpoint answers `503` and clients fall back to initials; nothing else changes, and the server still starts.

## Push notifications

`src/push.ts` delivers data-only pushes to **devices** with no live WebSocket
connection — both incoming calls (`sendIncomingCallPush`) and text messages
(`sendMessagePush`). Gating is per **device**, not per user: a user who is online
on their phone still receives a push on their offline tablet.

Call previews and message titles resolve names from stored profiles using
`shared/identity.ts`, falling back to the raw user ID. Call data includes
`callerDisplayName` for cold-start system UI; `callerId` and `senderId` remain
unchanged for routing.

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
`FCM_SERVICE_ACCOUNT_JSON` is absent or invalid, unless `TEST_AUTH_BYPASS_ENABLED`
is set (see the env var table above) — that switch exists solely so the load-test
rig can authenticate without provisioning real Firebase ID tokens, and should not
be used as a substitute for configuring `FCM_SERVICE_ACCOUNT_JSON` for real users.

### APNs (Apple Push Notification service) — fallback

Set `APNS_KEY` (the `.p8` private key contents), `APNS_KEY_ID`, `APNS_TEAM_ID`,
and `APNS_BUNDLE_ID`; toggle `APNS_PRODUCTION=true` for the production gateway.

## Text-message persistence

Chat history lives in the **same Postgres database** as users, devices and
calls. `src/messageStore.ts` provides a transport-agnostic store with two
implementations:

- `createPgMessageStore({ db })` — the `messages` source table and `conversations`
  projection, via the Drizzle handle
  the rest of the server already shares. Selected whenever `createServer` is
  given a `db`.
- `createMemoryMessageStore()` — array-backed; used when there is no database
  handle, and throughout the test suite.

Both expose `saveMessage`, `listMessages({ conversationId, limit, before })`
(newest-first, `limit` clamped to 1–100, default 50), `searchMessages`,
`listConversations`, `markDelivered`, `markRead`, `deleteMessage`,
`reactToMessage` and `close()`. The store is created by the composition root
(`src/createServer.ts`) and hung off the shared `state` object next to
`messageBus`/`telemetry`.

The `messages` table carries five secondary indexes, alongside its composite
primary key `(conversation_id, message_id)`:

| Index | Serves |
| ----- | ------ |
| `idx_messages_conversation_created` | A conversation's newest-first page, including the `created_at` cursor. |
| `idx_messages_sender_created` / `idx_messages_recipient_created` | Participant-scoped search and account-history reads. |
| `idx_messages_unread` (partial, `read_at IS NULL`) | Unread-message reads and updates — it indexes only rows that can contribute to unread counts. |
| `idx_messages_body_fts` (partial GIN, `tsvector`) | PostgreSQL `simple`-dictionary full-text search for `GET /messages/search`, excluding tombstones. |

Migration `0018` adds the full-text index and the append-only `message_changes`
table, backfilling existing messages as their initial sync delta. Its composite
foreign key cascades with message retention. Participant columns and
`(changed_at, change_id)` indexes support ordered sync paging.

Migration `0013_daily_gwen_stacy.sql` added the one-row-per-thread
`conversations` projection. `idx_conversations_a` and `idx_conversations_b`
lead with their participant column, followed by
`(last_created_at DESC, last_message_id DESC)`. In
`src/messageStore/pgStore.ts`, `listConversations` selects a participant's
ordered projection page with `MAX_CONVERSATION_LIMIT` (100) **before** joining
its pointers back to `messages` by the composite primary key. This bounds the
preview join, not necessarily every row visited by the planner: the
either-participant predicate's actual scan/sort plan still needs `EXPLAIN`
on representative data.

Previews are joined rather than copied into the projection so later
tombstones, reactions and delivery receipts remain visible without rewriting
the projection row. Every writer must keep `participant_a` / `participant_b`
in the same sorted order as `deriveConversationId`; that is what makes the
reader's unread counter addressable by a string comparison. New-message
insertion and projection maintenance share a transaction: the pointer upsert
is ordering-guarded, while the unread increment is a separate unconditional
statement so an older arrival still counts. `markRead` clears the relevant
counter in its message-update transaction; retention rebuilds affected
projection rows in its delete transaction.

Historically, the [measurements posted for #391 on its parent #390](https://github.com/konarsubhojit/studious-robot/issues/390#issuecomment-5660342816)
showed the old query growing with hot-conversation history and spilling its
sort to disk, motivating the projection; these are not timings for today's query.

> This replaced a separate MongoDB deployment. A second datastore bought
> nothing the shared Postgres store does not, while costing a second connection
> pool, a second backup story, and a hand-maintained `conversation_index`
> collection that could silently disagree with the messages it summarised.

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
  `GET /messages` (`msg::<conversationId>::<limit>` — the message page only;
  an `include=calls` request shares the same entry and merges live call state
  on top, so the cache is reachable by the timeline the app actually asks for)
  and the first page
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

## Call latency metrics (`GET /metrics`)

Two histograms describe how long a call takes to become usable. They measure
different things and are dominated by different causes, so they are never
compared or added:

| Histogram | Interval | Dominated by |
| --- | --- | --- |
| `call_setup_latency_ms` | `ringing → accepted` | Human reaction time. Seconds are expected. |
| `call_connect_latency_ms` | `accepted → in_call` | WebRTC media establishment. This is the one users perceive as silence after answering. |

### Scrape each instance separately, and never sum them

Metrics are per-process and reset on restart, and there is no aggregation
across VMs. A histogram from `micro1` and one from `micro2` describe **disjoint
populations of calls**, not two samples of the same one: only the instance that
performed a transition records it. Summing the two hosts' buckets, or reading
either host's `mean` as a fleet figure, produces a number that corresponds to
nothing. Scrape and read them separately.

### Why the observation comes from the call record

Both intervals are now measured from timestamps on the shared call record —
`createdAt` for setup, `answeredAt` for connect — rather than from a
process-local map. On a cross-instance call the two ends of the interval are
handled by *different* instances, so the process that observes the end of the
interval never saw its start; before this, such calls produced no sample at all
and the histogram silently described only same-instance calls.

Each histogram therefore reports where its observations came from:

| Counter | Meaning |
| --- | --- |
| `…_shared` | Derived from the call record. The normal path. |
| `…_local` | Fallback to the in-process timestamp because the record's timestamp was absent. |
| `…_unmeasured` | Neither source was available; no sample was recorded. |
| `…_skew_rejected` | The record-derived value was negative or implausibly large and was discarded. |

`…_shared` + `…_local` equals the histogram's `count`. The other two counters
are observations the histogram is *missing*, and a non-trivial value in either
means the histogram is no longer a complete census of this instance's calls.

> **NTP is a precondition.** Deriving the interval from a record timestamp
> means one instance's clock is compared against another's. A host whose clock
> drifts will report inflated, deflated or rejected samples for every
> cross-instance call it handles. Keep time synchronised on every VM;
> `…_skew_rejected` climbing is the symptom.

Implausibility bounds live in `src/lib/callLatency.ts` and are derived from the
corresponding call timeouts: a call cannot legitimately take longer to connect
than the sweep that force-ends it allows.

### RTC signal buffering

`rtc.offer` / `rtc.answer` / `rtc.candidate` arriving before a call is ready to
relay them are held briefly and replayed. The outcome of every held signal is
counted:

| Counter | Meaning |
| --- | --- |
| `rtc_signals_buffered` | Signals held rather than relayed immediately. |
| `rtc_signals_replayed` | Held signals later delivered to the peer. |
| `rtc_signals_stranded_local` | Discarded because the call ended on this instance before the buffer could be replayed. |
| `rtc_signals_stranded_remote` | Discarded because *another* instance advanced the call, so this one never got the chance to replay them. |

`rtc_signals_stranded_remote` is the cross-instance loss specifically: those
candidates were received, held, and then dropped, forcing ICE down a slower
path. It is counted rather than fixed here deliberately, so the size of the
problem is known before the remedy changes it.

### Reading the transition log

`[signaling] call.transition` lines carry `instance=` and, for the
`connecting_media` and `in_call` transitions, `sinceAcceptedMs=` measured from
the shared `answeredAt`. The difference between the two lines' values is the
`connecting_media → in_call` leg, so one journal grep attributes the interval
without cross-referencing both hosts.

### RTC relay bucketing

`handleRtcRelay` relays four socket events, not three, and each is counted:

| Counter | Meaning |
| --- | --- |
| `rtc_relays_offer` / `rtc_relays_answer` / `rtc_relays_candidate` | SDP offer/answer and ICE candidates. |
| `rtc_relays_media_heartbeat` | The 30s liveness beat (`call.media-state` with `heartbeat: true`), sent by both participants of a connected call independently. Scales with connected-minutes, not call count — a large number here is expected load, not a loop. |
| `rtc_relays_media_state_change` | A real `call.media-state` toggle (screen-share/camera on or off), not a heartbeat. |
| `rtc_relays_other` | An event this relay path did not anticipate at all. Should read ~0 in normal operation; a non-zero value here is the signal actually worth alarming on. |

Before this split, heartbeats and state-change toggles both fell into
`rtc_relays_other`, which made routine heartbeat load (hundreds of beats per
handful of connected calls) indistinguishable from a genuine unexpected-event
bug. See `docs/call-setup-telemetry-findings.md` §1 for the investigation that
prompted this.

### Signaling error attribution

`signaling_errors_by_code` counts rejected socket acks by error code (e.g.
`stale_call_state`, `call_not_found`, `forbidden`), capped at
`MAX_TRACKED_SIGNALING_ERROR_CODES` distinct codes with overflow folded into
an `other` key.

`stale_call_state` additionally gets a per-triggering-event breakdown,
`signaling_errors_stale_call_state_by_event` (same capping pattern, capped at
`MAX_TRACKED_STALE_CALL_STATE_EVENTS`), because that one code is ambiguous
without knowing which event triggered it:

- a stale `rtc.candidate` is **expected** — `holdOrRejectRtcSignal` buffers
  candidates for a non-live call rather than rejecting them outright, but a
  candidate that arrives after the buffer's own limits still surfaces here
- a stale `rtc.offer` / `rtc.answer` indicates a **real race** in the accept path
- a stale `call.media-state` would indicate a **regression** of the
  previously-fixed `canRelayMediaState` gate (see
  `docs/signaling-error-diagnosis.md`)

Only `stale_call_state` gets this per-event breakdown, not every code: the
other tracked codes (`call_not_found`, `forbidden`, …) do not currently have
this same "which event changes the diagnosis" ambiguity, and adding a second
capped map per code multiplies cardinality for a question that, so far, only
`stale_call_state` actually poses. If that changes, extending the same
mechanism to other codes is a small follow-up.

### Which derived ratios are fleet-relative, and which are (not yet) local-safe

`derived.call_connect_rate` and `derived.call_completion_rate` divide
counters that can each be satisfied by a **different** instance than the one
reporting the ratio — `calls_in_call` is recorded by whichever instance's
socket first observes the `in_call` transition, independent of which
instance recorded `calls_accepted` or `calls_ended` for that same call. On a
fleet, a single call's accept, connect and end can each be observed by a
different host. **Both ratios are fleet-relative artefacts, not trustworthy
per-instance figures** — a value derived per-host can be arithmetically
impossible (e.g. `> 1`) or read as "this host connects 0% of what it
accepts" when every call in question did connect, just via a peer instance.

A same-instance-safe replacement was considered
(`call_connect_latency_shared / calls_accepted`, using the counter that
tracks connect-latency samples this instance actually recorded) but was
**not shipped**: `call_connect_latency_shared` can increment for a call this
instance never recorded as accepted (that is the entire purpose of the
shared-timestamp path in `src/lib/callLatency.ts`, which lets connect latency
be observed even when the accept happened on a peer instance), so that ratio
is not guaranteed to stay ≤ 1 either — it has the same structural problem by
a different route. No dedicated same-instance counter exists yet that would
fix this, so until one does, treat `call_connect_rate` and
`call_completion_rate` as coarse, whole-fleet-behavior signals to be read
after combining scrapes from every instance, never as a single host's
conversion rate. See `docs/call-setup-telemetry-findings.md` §5 for the full
analysis.

### DB query blocking/detached split

Each entry in the `dbQueries` per-operation breakdown carries a `detached`
count alongside `count`/`totalMs`/`meanMs`/`maxMs`/`slow`: the number of that
operation's queries that were fire-and-forget (`runDetached`, e.g.
`persistCallRecord`'s mirror-to-shared-store write) rather than blocking on a
user-facing request. This lets an outlier `maxMs` on a given operation be
attributed to background load versus a request that actually waited on it,
without cross-referencing raw timing records.
