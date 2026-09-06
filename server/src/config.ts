/**
 * Shared constants for the signaling server.
 *
 * These values were previously defined at the top of the monolithic
 * `index.js`.  They are collected here so every module (routes, signaling,
 * call domain) can import the same canonical definitions.
 */

import {
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_RECOVERY_BUDGET_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
  SIGNALING_VERSION,
} from '../../shared/index.ts';

const MAX_ROOM_SIZE = 2;
const PUSH_PROVIDERS = new Set(['apns', 'fcm']);

/**
 * Message-bus channel on which call-state transitions are broadcast to other
 * instances / observers when a cross-instance bus is configured.
 */
const CALL_TRANSITION_CHANNEL = 'signaling:call.transitions';
const RTC_ACTIVE_CALL_STATES = new Set(['accepted', 'connecting_media', 'in_call']);

/**
 * The status a call reaches once the peers report connected media.
 *
 * This is the call's *steady state*: it has no media-setup deadline, only a
 * heartbeat check and an absolute duration cap, so a healthy conversation is
 * never force-ended by the stale-call sweep.
 */
const CONNECTED_CALL_STATUS = 'in_call';

// ─── Call lifecycle ───────────────────────────────────────────────────────────

/** States from which calls can never leave. */
const TERMINAL_CALL_STATES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * Canonical end-reason codes with their stable i18n message keys.
 *
 * Each key is the value stored in `call.endReason`.  The value is a
 * localization-friendly message key that clients can map to translated text;
 * the key itself also serves as a readable default English hint.
 */
const CALL_END_REASONS: Record<string, string> = {
  ended: 'call_ended',
  declined: 'call_declined',
  cancelled: 'call_cancelled',
  timeout: 'call_missed',
  busy: 'callee_busy',
  unreachable: 'callee_unreachable',
  failed: 'call_failed',
  media_connect_timeout: 'call_media_connect_timeout',
  participant_disconnected: 'call_participant_disconnected',
  max_duration_exceeded: 'call_max_duration_exceeded',
  stale_cleanup: 'call_stale_cleanup',
  media_failed: 'call_media_failed',
  heartbeat_timeout: 'call_heartbeat_timeout',
  client_state_reconciled: 'call_state_reconciled',
};

/**
 * Valid next states for each non-terminal call state.
 */
const CALL_TRANSITIONS: Map<string, Set<string>> = new Map([
  ['ringing', new Set(['accepted', 'declined', 'missed', 'busy', 'unreachable', 'ended'])],
  // `in_call` is reachable directly from `accepted`: a client whose peer
  // connection reports `connected` before its first relayed RTC frame reaches
  // the server must still be able to advance the call.
  ['accepted', new Set(['connecting_media', 'in_call', 'ended'])],
  ['connecting_media', new Set(['in_call', 'ended'])],
  ['in_call', new Set(['ended'])],
]);

/**
 * How long a call may remain in `ringing` before it becomes `missed`.
 *
 * Two minutes, so a callee whose handset is locked, silent or slow to wake has
 * a realistic chance to pick up; override with the `RINGING_TIMEOUT_MS` env
 * var (read in `createServer`).
 */
const DEFAULT_RINGING_TIMEOUT_MS = 120_000;

/**
 * How long a call may sit in `accepted` / `connecting_media` before it is
 * force-ended with `media_connect_timeout`.
 *
 * Without this, a call whose peers vanish between "accepted" and "connected"
 * stays non-terminal forever, permanently marking both participants busy (and
 * surviving restarts through the `calls` table).  Ninety seconds leaves room
 * for the observed ~4s push latency plus a TURN relay allocation on a slow
 * network, while still bounding a genuine media-setup failure.
 *
 * It only ever applies to a call that has *not* reached `in_call`: a connected
 * call is excluded from this sweep entirely and ends via explicit hangup,
 * participant disconnect, a missed heartbeat, or the absolute duration cap.
 */
const DEFAULT_MEDIA_CONNECT_TIMEOUT_MS = 90_000;

/**
 * Upper bound on a fully connected (`in_call`) call.
 *
 * Deliberately generous — it exists only so that *no* call state can be
 * non-terminal indefinitely when both clients disappear without ever sending
 * `call.end`.
 */
const DEFAULT_MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * Call-liveness timing.
 *
 * Both values are re-exported from `shared/signaling/timing.ts` rather than
 * redeclared here: the client interval and this timeout are two halves of one
 * protocol contract, and they were previously two independent literals in two
 * packages that only a comment asked you to keep in step.
 */

/**
 * Grace period after a socket disconnect before an in-progress call whose
 * participants have no sockets left is ended with `participant_disconnected`.
 *
 * Re-exported from `shared/signaling/timing.ts`, where it is derived from the
 * client's recovery budget plus the ping-timeout detection lag, rather than
 * redeclared here as a literal: it used to be 15s, which is *below* the window
 * in which a client is still actively recovering, so the server ended calls
 * the client would have saved.
 */

/**
 * Socket.IO heartbeat tuning.
 *
 * Engine.IO's defaults (25s ping interval + 20s ping timeout) mean a phone that
 * is killed or suspended by the OS can stay "connected" for up to 45 seconds.
 * For that whole window the server believes the callee is reachable over the
 * socket, so the incoming-call event is emitted into a dead connection and the
 * push fallback for that device never fires: the callee's phone simply never
 * rings.
 *
 * These values detect a dead client in ~18s, comfortably inside the
 * ring window, at the cost of one extra heartbeat every 10s.
 */
const DEFAULT_SOCKET_PING_INTERVAL_MS = 10_000;
const DEFAULT_SOCKET_PING_TIMEOUT_MS = 8_000;

/**
 * Largest accepted Socket.IO frame, in bytes.
 *
 * Engine.IO defaults to 1 MB. Nothing this server relays comes close: the
 * biggest frames are SDP offers/answers (a few KB) and chat messages, which the
 * shared schema already caps at {@link MAX_MESSAGE_BODY_LENGTH} characters.
 * Attachments never travel over the socket — they are uploaded straight to
 * object storage through a presigned URL — so a tighter cap costs nothing and
 * bounds what a single connection can force the process to buffer.
 * Override with `SOCKET_MAX_BUFFER_BYTES`.
 */
const DEFAULT_SOCKET_MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Largest accepted JSON request body, in bytes.
 *
 * Express defaults to 100 KB; this makes the limit explicit and slightly
 * tighter. The largest legitimate body is a chat message send, bounded by
 * `MAX_MESSAGE_BODY_LENGTH` (4000 characters) plus envelope. Attachment bytes
 * go direct to object storage, so no upload path depends on this.
 * Override with `JSON_BODY_LIMIT`.
 */
const DEFAULT_JSON_BODY_LIMIT = '64kb';

/**
 * How long a **terminal** call is kept in the in-memory `state.calls` map after
 * it ends.
 *
 * The map is the read path for `GET /calls`, so history has to survive in it for
 * a while — but nothing ever removed a call from it, so a long-lived process
 * grew without bound and every history request and every sweep tick iterated
 * more entries than the last. Terminal calls older than this are dropped;
 * non-terminal calls are never touched by the sweep, whatever their age.
 *
 * A day comfortably covers what a client asks for (`GET /calls` caps out at 100
 * rows) and, where Postgres is configured, the durable record in the `calls`
 * table outlives the in-memory copy regardless.
 * Override with `CALL_RETENTION_MS`.
 */
const DEFAULT_CALL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on retained terminal calls, applied after the age-based pass.
 *
 * Age alone bounds a *steady* workload; this bounds a burst, so the map cannot
 * balloon within a single retention window. The oldest are dropped first.
 * Override with `MAX_RETAINED_CALLS`.
 */
const DEFAULT_MAX_RETAINED_CALLS = 500;

/**
 * How long a terminal call row (and, by FK cascade, its `call_events`) is kept
 * in Postgres before the retention sweep deletes it.
 *
 * The in-memory window (`CALL_RETENTION_MS`, a day) bounds working set; this
 * bounds *storage*, and is deliberately much longer because the durable record
 * is what `GET /calls` pages over after a restart.  Without it the table only
 * ever grows, and boot hydration — which reads it — grows with it.
 * Override with `DB_CALL_RETENTION_MS`; `0` disables the sweep.
 */
const DEFAULT_DB_CALL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long an `audit_log` row is kept before the retention sweep deletes it.
 *
 * Longer than the call window: the audit trail's whole purpose is answering
 * questions after the fact.  Override with `AUDIT_RETENTION_MS`; `0` disables
 * the sweep.
 */
const DEFAULT_AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * How often the retention sweep runs.
 *
 * Deletion is by age, so the interval only decides how far past the window a
 * row may survive — hours are ample, and a long interval keeps the delete off
 * the hot path.  Override with `DB_RETENTION_SWEEP_INTERVAL_MS`.
 */
const DEFAULT_DB_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Rows deleted per retention-sweep statement, per table.
 *
 * The sweep deletes in bounded batches rather than one unbounded `DELETE`, so
 * a first run against a table that has never been pruned cannot hold a lock
 * over millions of rows or blow out the transaction.  Remaining rows are
 * collected by the next tick.
 */
const DB_RETENTION_DELETE_BATCH = 5_000;

/** How often the background worker polls for timed-out ringing calls. */
const RINGING_POLL_MS = 5_000;

/**
 * Default maximum time `shutdown()` waits for in-flight socket connections to
 * drain before force-closing them.  Kept below the systemd `TimeoutStopSec`
 * (30s) so the process exits cleanly before being hard-killed.
 */
const DEFAULT_SHUTDOWN_DRAIN_MS = 25_000;

/** Poll interval while waiting for sockets to drain during shutdown. */
const SHUTDOWN_DRAIN_POLL_MS = 50;

/** Default / maximum page size for the GET /users contact directory. */
const USER_DIRECTORY_DEFAULT_LIMIT = 50;
const USER_DIRECTORY_MAX_LIMIT = 100;

/**
 * How long a device row may go without a push re-registration before it is
 * considered abandoned and swept.
 *
 * Dead-token pruning (`pruneDeadDevice`) only fires when the provider reports
 * `UNREGISTERED` / `INVALID_ARGUMENT` for a specific token.  Delivering through
 * Azure Notification Hubs, a `201` means the hub *queued* the notification —
 * the per-token verdict never comes back on that path, so the documented
 * fallback never runs and rows orphaned by an app reinstall (which wipes the
 * client-persisted `device_id`) accumulate forever.
 *
 * The app re-registers its push token on every launch, so a row untouched for
 * two months belongs to an install that no longer exists.  Override with
 * `STALE_DEVICE_MAX_AGE_MS`.
 */
const DEFAULT_STALE_DEVICE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** How often the background worker sweeps abandoned device rows. */
const DEFAULT_STALE_DEVICE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Default session lifetime.
 *
 * A session id is a bearer token: anyone holding it can act as the user until
 * it is revoked. The previous default of `0` meant "never expires", so a
 * leaked token stayed valid forever and `state.sessions` only ever grew — the
 * wrong default at any scale.
 *
 * Seven days is long enough that a normal user is never interrupted (and, when
 * they are, `POST /session/refresh` and the `session.invalid` socket event both
 * re-mint transparently), and short enough that a stolen token has a horizon.
 * Set `SESSION_TTL_MS=0` to restore non-expiring sessions; nothing but a test
 * should want that.
 */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Upper bound applied to a shared-store session key that carries no explicit
 * expiry (`SESSION_TTL_MS=0`).
 *
 * Redis has no "expire eventually" mode, so a key written without `PX` is
 * immortal even after the process that created it is gone. Writing every key
 * with *some* expiry keeps the keyspace bounded by construction rather than by
 * a sweep that a crash can skip.
 */
const SHARED_SESSION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often expired sessions are swept out of the in-memory map. */
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Maximum number of push-registered devices a single user's notification fans
 * out to, most recently registered first.  A backstop for the accumulation
 * above: even before a sweep runs, one message must not push to an unbounded
 * number of rows.  Override with `MAX_PUSH_DEVICES_PER_USER`.
 */
const DEFAULT_MAX_PUSH_DEVICES_PER_USER = 3;

/**
 * Device count above which a user is reported in the `/metrics` device
 * summary, so accumulating stale rows are noticeable before users complain.
 */
const DEVICE_FANOUT_ALERT_THRESHOLD = 3;

export {
  MAX_ROOM_SIZE,
  PUSH_PROVIDERS,
  SIGNALING_VERSION,
  CALL_TRANSITION_CHANNEL,
  RTC_ACTIVE_CALL_STATES,
  CONNECTED_CALL_STATUS,
  TERMINAL_CALL_STATES,
  CALL_END_REASONS,
  CALL_TRANSITIONS,
  DEFAULT_RINGING_TIMEOUT_MS,
  DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CALL_DURATION_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_RECOVERY_BUDGET_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
  DEFAULT_SOCKET_PING_INTERVAL_MS,
  DEFAULT_SOCKET_PING_TIMEOUT_MS,
  DEFAULT_SOCKET_MAX_BUFFER_BYTES,
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_CALL_RETENTION_MS,
  DEFAULT_MAX_RETAINED_CALLS,
  DEFAULT_DB_CALL_RETENTION_MS,
  DEFAULT_AUDIT_RETENTION_MS,
  DEFAULT_DB_RETENTION_SWEEP_INTERVAL_MS,
  DB_RETENTION_DELETE_BATCH,
  RINGING_POLL_MS,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  SHUTDOWN_DRAIN_POLL_MS,
  USER_DIRECTORY_DEFAULT_LIMIT,
  USER_DIRECTORY_MAX_LIMIT,
  DEFAULT_STALE_DEVICE_MAX_AGE_MS,
  DEFAULT_STALE_DEVICE_SWEEP_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  SHARED_SESSION_MAX_TTL_MS,
  DEFAULT_MAX_PUSH_DEVICES_PER_USER,
  DEVICE_FANOUT_ALERT_THRESHOLD,
};
