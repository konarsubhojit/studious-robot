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
  ended:       'call_ended',
  declined:    'call_declined',
  cancelled:   'call_cancelled',
  timeout:     'call_missed',
  busy:        'callee_busy',
  unreachable: 'callee_unreachable',
  failed:      'call_failed',
};

/**
 * Valid next states for each non-terminal call state.
 *
 * @type {Map<string, Set<string>>}
 */
const CALL_TRANSITIONS = new Map([
  ['ringing',          new Set(['accepted', 'declined', 'missed', 'busy', 'unreachable', 'ended'])],
  ['accepted',         new Set(['connecting_media', 'ended'])],
  ['connecting_media', new Set(['in_call', 'ended'])],
  ['in_call',          new Set(['ended'])],
]);

/** How long a call may remain in `ringing` before it becomes `missed`. */
const DEFAULT_RINGING_TIMEOUT_MS = 30_000;

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
  RINGING_POLL_MS,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  SHUTDOWN_DRAIN_POLL_MS,
  USER_DIRECTORY_DEFAULT_LIMIT,
  USER_DIRECTORY_MAX_LIMIT,
};
