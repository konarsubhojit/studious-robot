/**
 * Direct tests for the answer-path rules.
 *
 * None of this mounts `useCallFlow`: answering is the path that has to work
 * when the socket, the permissions and the app's own knowledge of the call are
 * all unreliable, and each of those cases is now a table entry.
 */

import {
  ANSWER_SOCKET_ATTEMPTS,
  ANSWER_SOCKET_WAIT_MS,
  classifyHttpAccept,
  decideQueuedAnswerReplay,
  describeAnswerFallback,
  describeDegradedMedia,
} from '../../src/call/answerPath';

describe('answer-path budgets', () => {
  it('waits a short, bounded time for a socket', () => {
    expect(ANSWER_SOCKET_WAIT_MS).toBe(5000);
  });

  it('retries the socket exactly once before falling back', () => {
    expect(ANSWER_SOCKET_ATTEMPTS).toBe(2);
  });
});

describe('describeAnswerFallback', () => {
  it('distinguishes a socket that failed from one that never connected', () => {
    expect(describeAnswerFallback(true)).toEqual({
      reason: 'socket_accept_failed',
      message: 'Answering — retrying over a different connection…',
    });
    expect(describeAnswerFallback(false)).toEqual({
      reason: 'socket_not_connected',
      message: 'Answering — connection still starting…',
    });
  });

  it('always says something, so the fallback is never silent', () => {
    for (const hasSocket of [true, false]) {
      expect(describeAnswerFallback(hasSocket).message).not.toBe('');
    }
  });
});

describe('classifyHttpAccept', () => {
  it('accepts an ok response and hands it back to be read', () => {
    const response = { ok: true, status: 200 };
    expect(classifyHttpAccept(response)).toEqual({ outcome: 'ok', response });
  });

  it.each([
    ['no response at all', undefined],
    ['a null response', null],
  ])('reports %s as a missing session', (_label, response) => {
    expect(classifyHttpAccept(response)).toEqual({
      outcome: 'failed',
      answerFailureReason: 'no_session',
      message: 'no session available to accept over HTTP',
    });
  });

  it.each([400, 403, 409, 500])('reports a %d as a refused answer', status => {
    expect(classifyHttpAccept({ ok: false, status })).toEqual({
      outcome: 'failed',
      answerFailureReason: 'http_accept_failed',
      message: `HTTP ${status}`,
    });
  });

  it('separates "nothing to answer with" from "the answer was refused"', () => {
    const missing = classifyHttpAccept(null);
    const refused = classifyHttpAccept({ ok: false, status: 409 });
    expect(missing).not.toEqual(refused);
  });
});

describe('describeDegradedMedia', () => {
  it('reports nothing when the call has a stream', () => {
    expect(describeDegradedMedia({ hasStream: true })).toBeNull();
    expect(
      describeDegradedMedia({ hasStream: true, missingPermissions: ['camera'] }),
    ).toBeNull();
  });

  it('blames the permission when one is missing, and repeats its wording', () => {
    expect(
      describeDegradedMedia({
        hasStream: false,
        missingPermissions: ['camera'],
        permissionMessage: 'Camera access is off',
      }),
    ).toEqual({
      reason: 'media_permission_denied',
      message: 'Camera access is off. Call connected without local media.',
    });
  });

  it('still names the permission failure when there is no message to quote', () => {
    expect(
      describeDegradedMedia({ hasStream: false, missingPermissions: ['microphone'] }),
    ).toEqual({
      reason: 'media_permission_denied',
      message: 'Call connected, but the camera/microphone is unavailable.',
    });
  });

  it.each([
    ['an empty missing list', []],
    ['no permission information', undefined],
    ['a failed permission check', null],
  ])('falls back to unavailable media for %s', (_label, missingPermissions) => {
    expect(
      describeDegradedMedia({
        hasStream: false,
        missingPermissions: missingPermissions as string[] | null | undefined,
      }),
    ).toEqual({
      reason: 'local_media_unavailable',
      message: 'Call connected, but the camera/microphone is unavailable.',
    });
  });
});

describe('decideQueuedAnswerReplay', () => {
  const base = { callUUID: 'c1', queuedCallId: 'c1', knownIncomingCallId: null };

  it('keeps the queue entry while rehydration is deferred', () => {
    expect(decideQueuedAnswerReplay({ ...base, outcome: 'deferred' })).toEqual({
      action: 'wait',
    });
  });

  it('keeps it even when the queue has moved on, so a deferred fetch still drains', () => {
    expect(
      decideQueuedAnswerReplay({
        ...base,
        outcome: 'deferred',
        queuedCallId: 'other',
      }),
    ).toEqual({ action: 'wait' });
  });

  it('leaves the entry alone when the queue is now about another call', () => {
    expect(
      decideQueuedAnswerReplay({ ...base, outcome: 'error', queuedCallId: 'other' }),
    ).toEqual({ action: 'ignore' });
  });

  it('leaves the entry alone when nothing is queued', () => {
    expect(
      decideQueuedAnswerReplay({ ...base, outcome: 'error', queuedCallId: null }),
    ).toEqual({ action: 'ignore' });
  });

  it('stands aside once the call record arrived by another route', () => {
    expect(
      decideQueuedAnswerReplay({
        ...base,
        outcome: 'ringing',
        knownIncomingCallId: 'c1',
      }),
    ).toEqual({ action: 'ignore' });
  });

  it.each(['terminal', 'not_found'])(
    'dismisses a notification that outlived the call (%s)',
    outcome => {
      expect(decideQueuedAnswerReplay({ ...base, outcome })).toEqual({
        action: 'dismiss',
        reason: 'call_already_ended',
      });
    },
  );

  it.each([
    ['a failed fetch', 'error'],
    ['an ignored callId', 'ignored'],
    ['no outcome at all', undefined],
    ['a null outcome', null],
  ])('drops the entry loudly for %s', (_label, outcome) => {
    expect(decideQueuedAnswerReplay({ ...base, outcome })).toEqual({
      action: 'unavailable',
      reason: 'call_unavailable',
    });
  });

  it('never leaves an entry stuck: every non-deferred outcome resolves it', () => {
    for (const outcome of ['ringing', 'terminal', 'not_found', 'error', 'ignored']) {
      expect(decideQueuedAnswerReplay({ ...base, outcome }).action).not.toBe('wait');
    }
  });
});
