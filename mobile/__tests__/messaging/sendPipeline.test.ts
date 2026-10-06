import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_RETRY_MS,
  asFailed,
  asQueued,
  asSent,
  asUploadFailed,
  asUploaded,
  buildOptimisticMessage,
  buildOutboxItem,
  buildUploadingMessage,
  drainOrder,
  drainQueuedMessages,
  nextOutboxDeadline,
  isPermanentSendError,
  restoreOutboxMessages,
  isRetryable,
  nextDrainDelayMs,
  withAttemptRecorded,
  withAttemptsReset,
  withUploadProgress,
  withoutMessage,
} from '../../src/messaging/sendPipeline';
import { deriveDeliveryState } from '../../src/messaging/deliveryState';

/**
 * The send pipeline's pure half, exercised without mounting `useMessaging`:
 * these are the transforms the hook's optimistic send, upload and retry paths
 * are built out of.
 */

const draft = (overrides: any = {}): any => ({
  messageId: 'm1',
  conversationId: 'conv-1',
  senderId: 'alice',
  recipientId: 'bob',
  createdAt: '2026-08-25T10:30:00.000Z',
  body: 'hello',
  ...overrides,
});

const queued = (overrides: any = {}): any => ({
  messageId: 'm1',
  recipientId: 'bob',
  createdAt: '2026-08-25T10:30:00.000Z',
  attempts: 0,
  ...overrides,
});

describe('delivery state', () => {
  test('authoritative outbox determines waiting, in-flight and terminal states despite stale flags', () => {
    const message = draft({ failed: true, pending: true, readAt: '2026-08-25T10:31:00Z' });
    expect(deriveDeliveryState(message, queued())).toBe('queued');
    expect(deriveDeliveryState(message, queued(), true)).toBe('sending');
    expect(deriveDeliveryState(message, queued({ state: 'failed' }), true)).toBe('failed');
    expect(deriveDeliveryState(message, queued({ attempts: OUTBOX_MAX_ATTEMPTS }))).toBe('failed');
  });

  test('server receipts determine sent, delivered and read after reconciliation', () => {
    expect(deriveDeliveryState(draft())).toBe('sent');
    expect(deriveDeliveryState(draft({ deliveredTo: ['other'] }))).toBe('sent');
    expect(deriveDeliveryState(draft({ deliveredTo: ['bob'], pending: true }))).toBe('delivered');
    expect(deriveDeliveryState(draft({ readAt: '2026-08-25T10:31:00Z', failed: true }))).toBe('read');
    expect(deriveDeliveryState(draft({ recipientId: undefined, deliveredTo: ['bob'] }))).toBe('delivered');
  });

  test('legacy optimistic rows never imply an in-flight emit and failed uploads remain failed', () => {
    expect(deriveDeliveryState(draft({ pending: true }))).toBe('queued');
    expect(deriveDeliveryState(draft({ syncState: 'pending' }))).toBe('queued');
    expect(deriveDeliveryState(draft({ uploadState: 'failed' }), queued(), true)).toBe('failed');
  });

  test('persisted group readers exclude the sender and cannot override the outbox', () => {
    const message = draft({ recipientId: undefined, readBy: ['alice'] });
    expect(deriveDeliveryState(message)).toBe('sent');
    message.readBy.push('bob');
    expect(deriveDeliveryState(message)).toBe('read');
    expect(deriveDeliveryState(message, queued())).toBe('queued');
    expect(deriveDeliveryState(message, queued(), true)).toBe('sending');
    expect(deriveDeliveryState(message, queued({ state: 'failed' }))).toBe('failed');
  });
});

describe('optimistic send', () => {
  test('discarded uploads hide reconciled server identities without hiding another sender', () => {
    const item = queued({ messageId: 'original', clientMessageId: 'client', discarded: true });
    const server = draft({ messageId: 'server', clientMessageId: 'client' });
    const peer = { ...server, messageId: 'peer-message', senderId: 'bob' };
    expect(restoreOutboxMessages({ bob: [server, peer] }, [item], 'alice').bob).toEqual([peer]);
  });
  test('cleanup tombstones stay retryable and do not block later sends during the final sweep delay', async () => {
    const discarded = queued({
      discarded: true, state: 'failed', attempts: 99, nextAttemptAt: Date.now() + 60_000,
    });
    const next = queued({ messageId: 'm2', createdAt: '2026-08-25T10:31:00.000Z' });
    expect(isRetryable(discarded)).toBe(true);
    const queue = drainOrder([next, discarded]);
    expect(queue[0]).toBe(discarded);
    expect(nextOutboxDeadline(queue)).toBeLessThanOrEqual(Date.now());
    const send = jest.fn(async () => true);
    await drainQueuedMessages(queue, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(next);
  });
  test('a completion checkpoint restores the opaque reference even if its UI mirror was interrupted', () => {
    const item = queued({
      body: '', type: 'file', attachment: { url: 'file:///docs/source', mimeType: 'application/pdf', sizeBytes: 10 },
      upload: { uri: 'file:///docs/source', parts: [], completed: true, progress: 1, key: 'chatblobs/alice_bob/file.pdf' },
    });
    const stale = buildUploadingMessage(draft({ body: '', type: 'file', attachment: item.attachment }));
    const restored = restoreOutboxMessages({ bob: [stale] }, [item], 'alice');
    expect(restored.bob[0]).toMatchObject({
      attachment: { url: 'chatblobs/alice_bob/file.pdf' }, uploadState: undefined, uploadProgress: undefined,
    });
  });
  test('an optimistic message is pending and carries the composed content', () => {
    const message = buildOptimisticMessage(draft({ replyTo: 'm0' }));
    expect(message).toMatchObject({
      messageId: 'm1',
      senderId: 'alice',
      recipientId: 'bob',
      body: 'hello',
      type: 'text',
      replyTo: 'm0',
      pending: true,
      syncState: 'pending',
      readAt: null,
      deletedAt: null,
    });
    expect(message.deliveredTo).toEqual([]);
  });

  test('an attachment placeholder starts at zero upload progress', () => {
    const message = buildUploadingMessage(
      draft({ body: '', type: 'image', attachment: { url: 'file:///a.jpg' } }),
    );
    expect(message).toMatchObject({
      pending: true,
      failed: false,
      uploadState: 'uploading',
      uploadProgress: 0,
      uploadError: null,
    });
  });

  test('the outbox row reuses the message identity the bubble was given', () => {
    const item = buildOutboxItem(draft());
    expect(item).toEqual({
      messageId: 'm1',
      conversationId: 'conv-1',
      recipientId: 'bob',
      body: 'hello',
      type: 'text',
      attachment: null,
      replyTo: null,
      createdAt: '2026-08-25T10:30:00.000Z',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      state: 'pending',
      nextAttemptAt: null,
    });
  });
});

describe('outbox bookkeeping', () => {
  test('a message stops being retryable once its attempts are exhausted', () => {
    expect(isRetryable(queued({ attempts: OUTBOX_MAX_ATTEMPTS - 1 }))).toBe(true);
    expect(isRetryable(queued({ attempts: OUTBOX_MAX_ATTEMPTS }))).toBe(false);
  });

  test('a drain works through retryable sends in composition order', () => {
    const outbox = [
      queued({ messageId: 'newer', createdAt: '2026-08-25T10:32:00.000Z' }),
      queued({ messageId: 'exhausted', attempts: OUTBOX_MAX_ATTEMPTS }),
      queued({ messageId: 'older', createdAt: '2026-08-25T10:31:00.000Z' }),
    ];
    expect(drainOrder(outbox).map(item => item.messageId)).toEqual(['older', 'newer']);
  });

  test('a failed attempt is recorded against only its own row', () => {
    const outbox = [queued(), queued({ messageId: 'm2' })];
    const next = withAttemptRecorded(outbox, 'm1', {
      attempts: 2,
      lastAttemptAt: '2026-08-25T10:33:00.000Z',
      lastError: 'boom',
    });
    expect(next[0]).toMatchObject({ attempts: 2, lastError: 'boom' });
    expect(next[1]).toBe(outbox[1]);
  });

  test('a retry resets the attempt budget under the original message id', () => {
    const outbox = [queued({ attempts: OUTBOX_MAX_ATTEMPTS, lastError: 'boom' })];
    const next = withAttemptsReset(outbox, 'm1');
    expect(next).toHaveLength(1);
    expect(next[0].messageId).toBe('m1');
    expect(next[0]).toMatchObject({ attempts: 0, lastError: null });
  });

  test('a delivered or discarded message leaves the outbox', () => {
    expect(withoutMessage([queued(), queued({ messageId: 'm2' })], 'm1')).toEqual([
      queued({ messageId: 'm2' }),
    ]);
  });

  test('the drain backoff grows to a jittered ceiling and stops there', () => {
    expect(nextDrainDelayMs(0, 0)).toBe(500);
    expect(nextDrainDelayMs(0, 1)).toBe(1000);
    expect(nextDrainDelayMs(1, 0)).toBe(1000);
    expect(nextDrainDelayMs(50, 1)).toBe(OUTBOX_MAX_RETRY_MS);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(1000 * 2 ** attempt, OUTBOX_MAX_RETRY_MS);
      for (const jitter of [0, 0.25, 0.5, 0.75, 1]) {
        expect(nextDrainDelayMs(attempt, jitter)).toBeGreaterThanOrEqual(ceiling / 2);
        expect(nextDrainDelayMs(attempt, jitter)).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  test('delayed heads gate later sends but independent conversations continue', async () => {
    const head = queued({ messageId: 'head', nextAttemptAt: Date.now() + 5000 });
    const later = queued({ messageId: 'later' });
    const other = queued({ messageId: 'other', recipientId: 'carol' });
    const send = jest.fn(async () => true);
    expect(await drainQueuedMessages([head, later, other], send)).toBe(false);
    expect(send.mock.calls.map(([item]: any[]) => item.messageId)).toEqual(['other']);
    expect(nextOutboxDeadline([head, later])).toBe(head.nextAttemptAt);
  });

  test('group-targeted rows use the same per-conversation drain ordering and failure isolation as direct rows', async () => {
    const drainBodies = async (targetKind?: 'group') => {
      const queue = [
        queued({ messageId: 'first', recipientId: targetKind ? 'group-1' : 'bob',
          ...(targetKind ? { targetKind, conversationId: 'group-1' } : {}), body: 'first' }),
        queued({ messageId: 'later', recipientId: targetKind ? 'group-1' : 'bob',
          ...(targetKind ? { targetKind, conversationId: 'group-1' } : {}), body: 'later' }),
        queued({ messageId: 'independent', recipientId: targetKind ? 'group-2' : 'carol',
          ...(targetKind ? { targetKind, conversationId: 'group-2' } : {}), body: 'independent' }),
      ];
      const attempted: string[] = [];
      const complete = await drainQueuedMessages(queue, async item => {
        attempted.push(item.body!);
        return item.messageId !== 'first';
      });
      return { attempted, complete };
    };

    expect(await drainBodies('group')).toEqual(await drainBodies());
    expect(await drainBodies('group')).toEqual({
      attempted: ['first', 'independent'],
      complete: false,
    });
  });

  test('a transient failure pauses only its conversation; a terminal failure releases later rows', async () => {
    const queue = [queued(), queued({ messageId: 'later' }), queued({ messageId: 'other', recipientId: 'carol' })];
    const transient = jest.fn(async (item: any) => item.messageId !== 'm1');
    await drainQueuedMessages(queue, transient);
    expect(transient.mock.calls.map(([item]) => item.messageId)).toEqual(['m1', 'other']);
    const terminal = jest.fn(async (item: any) => item.messageId === 'm1' ? 'unavailable' as const : true);
    await drainQueuedMessages(queue, terminal);
    expect(terminal.mock.calls.map(([item]) => item.messageId)).toEqual(['m1', 'later', 'other']);
  });

  test.each(['bad_request', 'blocked', 'forbidden', 'not_found', 'unauthorized', 'unsupported_version'])(
    'structured %s rejections are permanent', code => {
      expect(isPermanentSendError(Object.assign(new Error('rejected'), { code }))).toBe(true);
    },
  );

  test.each(['timeout', 'rate_limited', 'internal_error', undefined])(
    '%s errors and unstructured messages are transient', code => {
      expect(isPermanentSendError(Object.assign(new Error('forbidden'), { code }))).toBe(false);
    },
  );

  test('explicit retry clears a terminal state and deadline without changing either identity', () => {
    const item = queued({ clientMessageId: 'client-key', attempts: 1, state: 'failed',
      nextAttemptAt: Date.now() + 60_000, lastError: 'blocked' });
    expect(withAttemptsReset([item], item.messageId)[0]).toMatchObject({
      messageId: 'm1', clientMessageId: 'client-key', attempts: 0, state: 'pending',
      nextAttemptAt: null, lastAttemptAt: null, lastError: null,
    });
  });

  test('durable terminal rows repair an interrupted pending mirror or recreate a missing bubble', () => {
    const item = buildOutboxItem(draft());
    const outbox = [{ ...item, attempts: 1, state: 'failed' as const }];
    const pending = buildOptimisticMessage(draft());
    expect(restoreOutboxMessages({ bob: [pending] }, outbox, 'alice').bob[0])
      .toMatchObject({ messageId: item.messageId, pending: false, failed: true, syncState: 'failed' });
    expect(restoreOutboxMessages({}, outbox, 'alice').bob[0].syncState).toBe('failed');
  });
});

describe('send state transitions', () => {
  const pending = (): any => buildOptimisticMessage(draft());

  test('an acknowledged send takes the server copy and stops being pending', () => {
    const sent = asSent(pending(), { body: 'hello', deliveredTo: ['bob'] } as any);
    expect(sent).toMatchObject({
      pending: false,
      failed: false,
      syncState: 'synced',
      deliveredTo: ['bob'],
    });
  });

  test('an acknowledged send keeps the local composition timestamp for ordering', () => {
    const sent = asSent(
      pending(),
      {
        body: 'hello',
        createdAt: '2026-08-25T10:20:00.000Z',
      } as any,
    );
    expect(sent).toMatchObject({
      createdAt: '2026-08-25T10:20:00.000Z',
      clientCreatedAt: '2026-08-25T10:30:00.000Z',
      syncState: 'synced',
    });
  });

  test('an exhausted send is surfaced as failed', () => {
    expect(asFailed(pending())).toMatchObject({
      pending: false,
      failed: true,
      syncState: 'failed',
    });
  });

  test('a retried send goes back to pending under the same message id', () => {
    const requeued = asQueued(asFailed(pending()));
    expect(requeued.messageId).toBe('m1');
    expect(requeued).toMatchObject({ pending: true, failed: false, syncState: 'pending' });
  });
});

describe('attachment upload state', () => {
  const uploading = (): any =>
    buildUploadingMessage(draft({ body: '', type: 'image', attachment: { url: 'file:///a.jpg' } }));

  test('progress is clamped into 0..1', () => {
    expect(withUploadProgress(uploading(), 0.5).uploadProgress).toBe(0.5);
    expect(withUploadProgress(uploading(), -1).uploadProgress).toBe(0);
    expect(withUploadProgress(uploading(), 4).uploadProgress).toBe(1);
    expect(withUploadProgress(uploading(), Number.NaN).uploadProgress).toBe(0);
  });

  test('a stored blob turns the bubble into an ordinary queued send', () => {
    const uploaded = asUploaded(uploading(), { url: 'https://cdn/a.jpg' } as any);
    expect(uploaded).toMatchObject({
      attachment: { url: 'https://cdn/a.jpg' },
      pending: true,
      failed: false,
      syncState: 'pending',
      uploadState: undefined,
      uploadProgress: undefined,
      uploadError: null,
    });
  });

  test('a cancelled or failed upload leaves the bubble visible and failed', () => {
    const failed = asUploadFailed(uploading(), 'cancelled');
    expect(failed).toMatchObject({
      messageId: 'm1',
      pending: false,
      failed: true,
      syncState: 'failed',
      uploadState: 'failed',
      uploadError: 'cancelled',
    });
  });
});
