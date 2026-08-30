/**
 * Session and token lifecycle, as pure logic.
 *
 * Phase 5, slice 2 of the `useCallFlow` decomposition (#216). The hook keeps
 * every side effect — minting sessions, arming the rotation timer, emitting
 * `call.state.report`, tearing a call down — but the rules those effects run
 * on are here: when a rotation timer is worth arming, how many times a session
 * is re-minted, how a `call.state.report` ack is read, and what the server's
 * answer proves about a call this device still thinks it holds.
 *
 * The last of those is the sharp one. `null` is not `[]`: an ack that says
 * nothing about the server's calls is "no answer", and reading it as "the
 * server holds nothing" tears down healthy calls against an older server.
 *
 * No React, no refs, no socket.
 */

/**
 * How often to proactively rotate the session token.  Set well below typical
 * server-side TTLs (e.g. 1 h) so the token never expires mid-call.
 */
export const SESSION_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * How many times a session is re-minted after the server rejects the presented
 * one, and how long between tries. More than one only mid-call, where losing
 * the session means losing the call.
 */
export const SESSION_REMINT_ATTEMPTS = 3;
export const SESSION_REMINT_RETRY_MS = 1000;

/** Shown when rotation failed but the current token has not expired yet. */
export const SESSION_REFRESH_FAILED_MESSAGE =
  'Session refresh failed — your token may expire soon. Reconnect if calls stop working.';

/** Shown once re-minting has given up and the socket is a guest for good. */
export const SESSION_EXPIRED_MESSAGE = 'Session expired — please reconnect.';

/**
 * Whether the proactive rotation timer is worth arming.
 *
 * There is nothing to rotate without both an identity and somewhere to rotate
 * against, and a whitespace-only value is neither.
 */
export function shouldScheduleSessionRefresh({
  userId,
  signalingUrl,
}: {
  userId: string;
  signalingUrl: string;
}): boolean {
  return Boolean(userId.trim()) && Boolean(signalingUrl.trim());
}

/**
 * How many times to try re-minting a session the server rejected.
 *
 * Mid-call this is not a cosmetic re-auth: the socket carrying the call's
 * signaling is a guest until a live session replaces it, so a single failed
 * mint (the handoff that caused the reconnect is often still settling) must
 * not be what ends the call.
 */
export function sessionRemintAttempts(isInCall: boolean): number {
  return isInCall ? SESSION_REMINT_ATTEMPTS : 1;
}

/** The server's answer to `call.state.report`, once read. */
export type CallStateReport = {
  /** Calls the server closed out on hearing this report. */
  clearedCallIds: string[];
  /**
   * The calls the server says it holds, or `null` when it did not describe
   * them at all — an absent field is "no answer", not "holds nothing".
   */
  activeCallIds: string[] | null;
};

/** A `call.state.report` ack as it arrives over the wire. */
export type CallStateReportAck = {
  ok?: boolean;
  error?: unknown;
  clearedCallIds?: string[];
  activeCalls?: unknown;
} | null | undefined;

/**
 * Read a `call.state.report` ack, or `null` if the server did not accept it.
 */
export function parseCallStateReportAck(ack: CallStateReportAck): CallStateReport | null {
  if (!ack?.ok) return null;
  return {
    clearedCallIds: ack.clearedCallIds ?? [],
    activeCallIds: Array.isArray(ack.activeCalls)
      ? ack.activeCalls
          .map((call: { callId?: string; }) => call?.callId)
          .filter((callId: string | undefined): callId is string => Boolean(callId))
      : null,
  };
}

/**
 * Whether the server's post-reconnect answer means this call is gone.
 *
 * Only positive evidence ends a call: the server explicitly cleared it, or it
 * described its calls and this one is not among them. Silence is never read as
 * "the call is gone".
 */
export function shouldTearDownAfterResync({
  currentCallId,
  clearedCallIds,
  activeCallIds,
}: {
  currentCallId: string | null;
} & CallStateReport): boolean {
  if (!currentCallId) return false;
  if (clearedCallIds.includes(currentCallId)) return true;
  return activeCallIds !== null && !activeCallIds.includes(currentCallId);
}
