/**
 * Answer-path decisions, as pure logic.
 *
 * Phase 5, slices 6 and 7 of the `useCallFlow` decomposition (#216). Answering
 * is the part of the call flow that has to work when nothing else does: the
 * socket may still be connecting on a cold start, the camera permission may
 * never have been granted, and the tap may have arrived from the OS call UI
 * before this app knew the call existed. Each of those is a rule about what to
 * do; emitting, fetching and ringing stay in the hook.
 *
 * No React, no refs, no socket, no peer connection.
 */

import type { RehydrationOutcome } from './pushRehydration';

/**
 * How long to wait for the signaling socket to connect before answering a call
 * over HTTP instead.
 *
 * Kept short: on a cold start the caller is already ringing, so a slow socket
 * must never be the reason a call cannot be picked up.
 */
export const ANSWER_SOCKET_WAIT_MS = 5000;

/**
 * How many times `call.accept` is emitted over a connected socket before
 * falling back to HTTP. One retry, because the common failure is a single
 * dropped ack rather than a dead socket — and the caller is still ringing.
 */
export const ANSWER_SOCKET_ATTEMPTS = 2;

/**
 * Why the answer is going over HTTP, and what to tell the user while it does.
 *
 * The fallback is never silent: the two cases read the same to the code that
 * follows but not to a person waiting on a call, so a socket that answered and
 * failed is reported differently from one that never connected.
 */
export function describeAnswerFallback(hasConnectedSocket: boolean): {
  reason: string;
  message: string;
} {
  return hasConnectedSocket
    ? {
      reason: 'socket_accept_failed',
      message: 'Answering — retrying over a different connection…',
    }
    : {
      reason: 'socket_not_connected',
      message: 'Answering — connection still starting…',
    };
}

/**
 * What an HTTP accept attempt amounted to.
 *
 * The `ok` variant carries the response back, so the caller reads the body off
 * this result rather than off a value it has to re-prove is there.
 */
export type HttpAcceptOutcome<TResponse> =
  | { outcome: 'ok'; response: TResponse; }
  | { outcome: 'failed'; answerFailureReason: string; message: string; };

/**
 * How to read the HTTP accept response.
 *
 * Both failures carry a canonical reason, because an answer that does not
 * happen is only diagnosable from the push receipt the hook sends next: "there
 * was no session to answer with" and "the server refused the answer" are
 * different bugs.
 */
export function classifyHttpAccept<TResponse extends { ok: boolean; status: number; }>(
  response: TResponse | null | undefined,
): HttpAcceptOutcome<TResponse> {
  if (!response) {
    return {
      outcome: 'failed',
      answerFailureReason: 'no_session',
      message: 'no session available to accept over HTTP',
    };
  }
  if (!response.ok) {
    return {
      outcome: 'failed',
      answerFailureReason: 'http_accept_failed',
      message: `HTTP ${response.status}`,
    };
  }
  return { outcome: 'ok', response };
}

/**
 * What a call answered without local media should report and say.
 *
 * Media is acquired *after* the call is accepted and its failure is never
 * fatal: a call that connects with no camera is far better than one that could
 * not be picked up. But it is not silent either — the user is told which of the
 * two happened, so a denied permission reads as something they can fix rather
 * than as a broken app.
 *
 * Returns `null` when there is a stream, i.e. when there is nothing to report.
 */
export function describeDegradedMedia({
  hasStream,
  missingPermissions,
  permissionMessage,
}: {
  hasStream: boolean;
  missingPermissions?: readonly string[] | null;
  permissionMessage?: string | null;
}): { reason: string; message: string; } | null {
  if (hasStream) return null;
  const denied = Boolean(missingPermissions?.length);
  return {
    reason: denied ? 'media_permission_denied' : 'local_media_unavailable',
    message:
      denied && permissionMessage
        ? `${permissionMessage}. Call connected without local media.`
        : 'Call connected, but the camera/microphone is unavailable.',
  };
}

/**
 * What to do with an answer that was queued before this hook knew the call.
 *
 * The queue lives in `callKeep.js` and there is deliberately exactly one of
 * them: a second queue in the call flow is where an answer gets lost in the
 * hand-off. This decides only whether the *queued* entry is still this
 * device's problem, and what became of it.
 *
 * - `wait` — rehydration deferred for want of an identity; the entry must
 *   survive, because the deferred fetch will run and drain it.
 * - `ignore` — the queue has moved on, or the call record arrived by another
 *   route and the normal accept path owns it now.
 * - `dismiss` — the call had already stopped ringing; the notification
 *   outlived the call, so it is taken down silently rather than failed.
 * - `unavailable` — the call could not be fetched at all; drop it loudly, so
 *   the entry is never left stuck.
 */
export function decideQueuedAnswerReplay({
  outcome,
  callUUID,
  queuedCallId,
  knownIncomingCallId,
}: {
  outcome: RehydrationOutcome | null | undefined;
  callUUID: string;
  queuedCallId: string | null | undefined;
  knownIncomingCallId?: string | null;
}): { action: 'wait'; } | { action: 'ignore'; } | { action: 'dismiss' | 'unavailable'; reason: string; } {
  if (outcome === 'deferred') return { action: 'wait' };
  if (queuedCallId !== callUUID || knownIncomingCallId === callUUID) {
    return { action: 'ignore' };
  }
  if (outcome === 'terminal' || outcome === 'not_found') {
    return { action: 'dismiss', reason: 'call_already_ended' };
  }
  return { action: 'unavailable', reason: 'call_unavailable' };
}
