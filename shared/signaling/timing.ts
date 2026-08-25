/**
 * Call-liveness timing, shared by `mobile/` and `server/`.
 *
 * These two numbers are a *protocol* contract, not an implementation detail of
 * either side. A connected client reports liveness every
 * {@link CALL_HEARTBEAT_INTERVAL_MS} over the `call.media-state` relay, and the
 * server ends a call that has gone {@link DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS}
 * without one. They therefore have to stay in a fixed ratio: if the client
 * interval ever creeps above the server timeout, healthy calls get hung up on
 * mid-conversation.
 *
 * They used to be declared twice — `mobile/src/hooks/useCallFlow.ts` and
 * `server/src/config.ts` — as two independent literals that a comment on each
 * side asked you to keep in sync. Nothing enforced it. Declaring them once here,
 * where both packages already import their wire contracts from, makes drift
 * impossible rather than merely discouraged, and
 * {@link CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE} makes the relationship between
 * them explicit instead of implied by two unrelated-looking constants.
 */

/** How often a connected client reports call liveness to the server. */
const CALL_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How many consecutive beats a call may miss before the server considers it
 * abandoned. Deliberately forgiving: a phone that briefly loses its network
 * must not lose the call.
 */
const CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE = 5;

/**
 * How long a connected (`in_call`) call may go without a heartbeat before it is
 * ended with `heartbeat_timeout`.
 *
 * Derived from the interval so the two can never drift apart.
 *
 * A call that has *never* sent a heartbeat is never aged out by it: an older
 * client that does not implement heartbeats stays bounded by the absolute call
 * duration cap instead.
 */
const DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS =
  CALL_HEARTBEAT_INTERVAL_MS * CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE;

/**
 * How long since the last beat before another one is due.
 *
 * The client heartbeat is *time*-driven rather than tick-driven: any wake-up
 * source (the interval, an inbound socket packet, an AppState change) asks
 * whether a beat is due instead of emitting one unconditionally, so extra
 * wake-ups are free and a missed tick is caught up by whichever source fires
 * next.
 *
 * Slightly under the interval so a timer that fires a few milliseconds early
 * still counts as due, rather than slipping a whole period.
 */
const CALL_HEARTBEAT_DUE_MS = CALL_HEARTBEAT_INTERVAL_MS - 1_000;

export {
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE,
  CALL_HEARTBEAT_DUE_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
};
