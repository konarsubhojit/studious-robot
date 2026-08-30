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
  isRetryable,
  nextDrainDelayMs,
  withAttemptRecorded,
  withAttemptsReset,
  withUploadProgress,
  withoutMessage,
} from '../../src/messaging/sendPipeline';

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

describe('optimistic send', () => {
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
