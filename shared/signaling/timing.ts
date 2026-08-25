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

/**
 * How long a client keeps trying to recover a call whose media path broke
 * before it gives up and reports the failure.
 *
 * This is the *client's* budget, and it is the number that decides when a call
 * that hit a Wi-Fi⇄cellular handoff ends. It lives here for the same reason
 * the heartbeat pair does: the server's own disconnect grace has to stay
 * outside it, and two independent literals in two packages is exactly how that
 * ordering silently drifts.
 *
 * The budget is spent on *attempts*, not on waiting — a client pauses it while
 * recovery is impossible (no connectivity, no socket) — so 30s here means 30s
 * of actually trying.
 */
const CALL_RECOVERY_BUDGET_MS = 30_000;

/**
 * Absolute ceiling on one recovery episode, however many times a flapping
 * interface extends it.
 *
 * A genuine new network transition extends the budget rather than being
 * swallowed, which without a ceiling would let an interface that flaps forever
 * keep a dead call alive forever.
 */
const CALL_RECOVERY_MAX_EPISODE_MS = CALL_RECOVERY_BUDGET_MS * 3;

/**
 * Allowance for how long the server takes to *notice* a socket is gone.
 *
 * With `pingInterval` 10s and `pingTimeout` 8s the server can take ~18s to
 * declare a socket dead, and only then does the disconnect grace start. Without
 * this allowance a grace period equal to the client budget would still expire
 * first, and the server — not the client's own decision — would be what ends
 * the call.
 */
const PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS = 20_000;

/**
 * Grace period after a socket disconnect before an in-progress call whose
 * participants have no sockets left is ended with `participant_disconnected`.
 *
 * Derived so the server is always the *outer* bound: client budget < server
 * grace < heartbeat timeout. `server/test/heartbeat-timing.test.ts` asserts
 * that ordering so it cannot regress.
 */
const DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS =
  CALL_RECOVERY_BUDGET_MS + PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS;

export {
  CALL_HEARTBEAT_INTERVAL_MS,
  CALL_RECOVERY_BUDGET_MS,
  CALL_RECOVERY_MAX_EPISODE_MS,
  PARTICIPANT_DISCONNECT_DETECTION_ALLOWANCE_MS,
  DEFAULT_PARTICIPANT_DISCONNECT_GRACE_MS,
  CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE,
  CALL_HEARTBEAT_DUE_MS,
  DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS,
};
