'use strict';

/**
 * Shared constants for the signaling server.
 *
 * These values were previously defined at the top of the monolithic
 * `index.js`.  They are collected here so every module (routes, signaling,
 * call domain) can import the same canonical definitions.
 */

const MAX_ROOM_SIZE = 2;
const PUSH_PROVIDERS = new Set(['apns', 'fcm']);
const SIGNALING_VERSION = 1;

/**
 * Message-bus channel on which call-state transitions are broadcast to other
 * instances / observers when a cross-instance bus is configured.
 */
const CALL_TRANSITION_CHANNEL = 'signaling:call.transitions';
const RTC_ACTIVE_CALL_STATES = new Set(['accepted', 'connecting_media', 'in_call']);

// ─── Call lifecycle ───────────────────────────────────────────────────────────

/** States from which calls can never leave. */
const TERMINAL_CALL_STATES = new Set(['ended', 'declined', 'missed', 'busy', 'unreachable']);

/**
 * Canonical end-reason codes with their stable i18n message keys.
 *
 * Each key is the value stored in `call.endReason`.  The value is a
 * localization-friendly message key that clients can map to translated text;
 * the key itself also serves as a readable default English hint.
 *
 * @type {Record<string, string>}
 */
const CALL_END_REASONS = {
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
  client_state_reconciled: 'call_state_reconciled',
};

/**
 * Valid next states for each non-terminal call state.
 *
 * @type {Map<string, Set<string>>}
 */
const CALL_TRANSITIONS = new Map([
  ['ringing', new Set(['accepted', 'declined', 'missed', 'busy', 'unreachable', 'ended'])],
  ['accepted', new Set(['connecting_media', 'ended'])],
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
 * surviving restarts through the `calls` table).  Sixty seconds is far longer
 * than a healthy ICE negotiation needs, but still finite.
 */
const DEFAULT_MEDIA_CONNECT_TIMEOUT_MS = 60_000;

/**
 * Upper bound on a fully connected (`in_call`) call.
 *
 * Deliberately generous — it exists only so that *no* call state can be
 * non-terminal indefinitely when both clients disappear without ever sending
 * `call.end`.
 */
const DEFAULT_MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * Grace period after a socket disconnect before an in-progress call whose
 * participants have no sockets left is ended with `participant_disconnected`.
 * Long enough to absorb an ordinary Socket.IO reconnect.
 */
const DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS = 15_000;

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

module.exports = {
  MAX_ROOM_SIZE,
  PUSH_PROVIDERS,
  SIGNALING_VERSION,
  CALL_TRANSITION_CHANNEL,
  RTC_ACTIVE_CALL_STATES,
  TERMINAL_CALL_STATES,
  CALL_END_REASONS,
  CALL_TRANSITIONS,
  DEFAULT_RINGING_TIMEOUT_MS,
  DEFAULT_MEDIA_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CALL_DURATION_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
  DEFAULT_SOCKET_PING_INTERVAL_MS,
  DEFAULT_SOCKET_PING_TIMEOUT_MS,
  RINGING_POLL_MS,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  SHUTDOWN_DRAIN_POLL_MS,
  USER_DIRECTORY_DEFAULT_LIMIT,
  USER_DIRECTORY_MAX_LIMIT,
};
