/**
 * Push-rehydration and relayed media-state decisions, as pure logic.
 *
 * Phase 5, slice 5 of the `useCallFlow` decomposition (#216). When the app is
 * opened from a push notification it has a callId and nothing else, and has to
 * work out whether it can act on it at all and what the server's answer means.
 * Those are rules; fetching, navigating and ringing are the effects the hook
 * keeps, and the URL it fetches is built by `callEndpoints`.
 *
 * The `call.media-state` reader is here for the same reason: whether a frame
 * claims anything about a flag is a question about the protocol's additive
 * contract, not about React state.
 *
 * No React, no refs, no network.
 */

/**
 * What a rehydration attempt did, so a caller replaying a queued answer can
 * tell "still waiting on an identity" apart from "this call is gone".
 */
export type RehydrationOutcome =
  | 'deferred'
  | 'ringing'
  | 'terminal'
  | 'not_found'
  | 'error'
  | 'ignored';

/** Whether there is anything to rehydrate at all. */
export function isRehydratableCallId(callId: string | null | undefined): boolean {
  return Boolean(callId);
}

/**
 * Whether rehydration must wait for an identity.
 *
 * A push can land before the stored userId has loaded or a signaling URL is
 * known. That is not a failure — the callId is held and retried once identity
 * arrives — so it is reported separately from a call that is genuinely gone.
 */
export function shouldDeferRehydration({
  userId,
  signalingUrl,
}: {
  userId?: string | null;
  signalingUrl?: string | null;
}): boolean {
  return !(userId ?? '').trim() || !(signalingUrl ?? '').trim();
}

/** What a non-OK lookup response means. */
export type LookupFailure = { outcome: 'not_found'; message: string; } | { outcome: 'throw'; };

/**
 * How to treat a failed call lookup.
 *
 * A 404 is an answer, not an error: the server is saying the call is gone, and
 * the user should be told that rather than shown a failure they might retry.
 * Anything else is a fault worth raising.
 */
export function classifyLookupFailure(status: number): LookupFailure {
  if (status === 404) {
    return { outcome: 'not_found', message: 'Call no longer available' };
  }
  return { outcome: 'throw' };
}

/**
 * How a call that a push named has already finished.
 *
 * Phrased the way the timeline phrases the same call, with a fallback for a
 * status this build does not know: a newer server must never leave the user
 * looking at a blank status line.
 */
const TERMINAL_PUSH_MESSAGES: Record<string, string> = {
  missed: 'Missed call',
  declined: 'Call was declined',
  ended: 'Call ended',
  busy: 'Line was busy',
  unreachable: 'Call unreachable',
};

/** What to do with a call the server just described. */
export type RehydratedCall =
  | { outcome: 'ringing'; }
  | { outcome: 'terminal'; message: string; };

/**
 * Whether a rehydrated call can still be answered, and what to say if not.
 *
 * Only `ringing` is answerable. Every other status — including one this build
 * has never heard of — is over, and is reported rather than presented as an
 * incoming call the user would tap into nothing.
 */
export function describeRehydratedCall(status: unknown): RehydratedCall {
  if (status === 'ringing') return { outcome: 'ringing' };
  return {
    outcome: 'terminal',
    message:
      (typeof status === 'string' &&
      Object.hasOwn(TERMINAL_PUSH_MESSAGES, status)
        ? TERMINAL_PUSH_MESSAGES[status]
        : undefined) ?? 'Call no longer active',
  };
}

/**
 * What a relayed `call.media-state` frame actually claims.
 *
 * The frame is additive and each key is read independently: a liveness
 * heartbeat carries neither flag, and silence about a flag is not a claim
 * about it — a frame that omits `isVideoEnabled` is not saying the camera is
 * off, and must not clear the banner or the peer's picture. A key that is
 * present is coerced to a boolean, so an older or sloppier peer cannot put
 * `undefined` into the UI's state.
 */
export function readMediaStateFrame(mediaState: unknown): {
  isScreenSharing?: boolean;
  isVideoEnabled?: boolean;
} {
  if (!mediaState || typeof mediaState !== 'object') return {};
  const frame = mediaState as Record<string, unknown>;
  return {
    ...('isScreenSharing' in frame
      ? { isScreenSharing: Boolean(frame.isScreenSharing) }
      : {}),
    ...('isVideoEnabled' in frame
      ? { isVideoEnabled: Boolean(frame.isVideoEnabled) }
      : {}),
  };
}
