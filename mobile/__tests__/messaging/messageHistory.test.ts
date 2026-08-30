import {
  mergeHistoryPage,
  patchMessage,
  patchMessageEverywhere,
  prependMessage,
  removeMessage,
} from '../../src/messaging/messageHistory';

/**
 * The per-peer history transforms, exercised directly rather than through the
 * hook that feeds them to `setState`.
 */

const message = (overrides: any = {}): any => ({
  messageId: 'm1',
  senderId: 'bob',
  recipientId: 'alice',
  body: 'hi',
  createdAt: '2026-08-25T10:30:00.000Z',
  ...overrides,
});

describe('patchMessage', () => {
  test('updates one message by id', () => {
    const state = { bob: [message(), message({ messageId: 'm2' })] };
    const next = patchMessage(state, 'bob', 'm2', entry => ({ ...entry, body: 'edited' }));
    expect(next.bob[1].body).toBe('edited');
    expect(next.bob[0]).toBe(state.bob[0]);
  });

  test('is a no-op for an unloaded conversation or an unknown message', () => {
    const state = { bob: [message()] };
    expect(patchMessage(state, 'carol', 'm1', entry => entry)).toBe(state);
    expect(patchMessage(state, 'bob', 'nope', entry => entry)).toBe(state);
  });
});

describe('patchMessageEverywhere', () => {
  test('finds the message without being told which conversation holds it', () => {
    const state = { bob: [message()], carol: [message({ messageId: 'm2' })] };
    const next = patchMessageEverywhere(state, 'm2', entry => ({ ...entry, body: 'edited' }));
    expect(next.carol[0].body).toBe('edited');
    expect(next.bob[0]).toBe(state.bob[0]);
  });
});

describe('removeMessage and prependMessage', () => {
  test('a discarded message leaves its conversation', () => {
    const state = { bob: [message(), message({ messageId: 'm2' })] };
    expect(removeMessage(state, 'bob', 'm1').bob.map((m: any) => m.messageId)).toEqual(['m2']);
  });

  test('removing something that is not there changes nothing', () => {
    const state = { bob: [message()] };
    expect(removeMessage(state, 'bob', 'nope')).toBe(state);
    expect(removeMessage(state, 'carol', 'm1')).toBe(state);
  });

  test('a new message goes to the head of a newest-first history', () => {
    const next = prependMessage({ bob: [message()] }, 'bob', message({ messageId: 'm2' }));
    expect(next.bob.map((m: any) => m.messageId)).toEqual(['m2', 'm1']);
  });
});

describe('mergeHistoryPage', () => {
  test('the first page is authoritative but keeps entries the server has never seen', () => {
    const held = [
      message({ messageId: 'queued', syncState: 'pending', createdAt: '2026-08-25T10:35:00.000Z' }),
      message({ messageId: 'm1', syncState: 'synced' }),
    ];
    const page = [message({ messageId: 'm1', syncState: 'synced' })];
    const merged = mergeHistoryPage(held, page);
    expect(merged.map((m: any) => m.messageId)).toEqual(['queued', 'm1']);
  });

  test('an optimistic entry the server now knows about is replaced, not duplicated', () => {
    const held = [message({ messageId: 'm1', syncState: 'pending' })];
    const page = [message({ messageId: 'm1', syncState: 'synced' })];
    expect(mergeHistoryPage(held, page)).toEqual(page);
  });

  test('an older page is appended, deduped by message or call id', () => {
    const held = [message({ messageId: 'm2' })];
    const page = [
      message({ messageId: 'm2' }),
      message({ messageId: 'm1', createdAt: '2026-08-25T09:00:00.000Z' }),
      { callId: 'c1', type: 'call', createdAt: '2026-08-25T08:00:00.000Z' } as any,
    ];
    const merged = mergeHistoryPage(held, page, { before: '2026-08-25T10:30:00.000Z' });
    expect(merged.map((m: any) => m.messageId ?? m.callId)).toEqual(['m2', 'm1', 'c1']);
  });
});
