import {
  mergeHistoryPage,
  nextLocalCreatedAt,
  patchMessage,
  patchMessageEverywhere,
  prependMessage,
  removeMessage,
  upsertTimelineEntry,
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
    expect(next.bob.find((entry: any) => entry.messageId === 'm2')?.body).toBe('edited');
    expect(next.bob.find((entry: any) => entry.messageId === 'm1')).toBe(state.bob[0]);
  });

  test('re-sorts when an optimistic message is reconciled to the server timestamp', () => {
    const state = {
      bob: [
        message({ messageId: 'optimistic', createdAt: '2026-08-25T10:50:00.000Z', syncState: 'pending' }),
        message({ messageId: 'newer-server', createdAt: '2026-08-25T10:40:00.000Z' }),
      ],
    };
    const next = patchMessage(state, 'bob', 'optimistic', entry => ({
      ...entry,
      createdAt: '2026-08-25T10:30:00.000Z',
      syncState: 'synced',
    }));
    expect(next.bob.map((m: any) => m.messageId)).toEqual(['newer-server', 'optimistic']);
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

describe('nextLocalCreatedAt', () => {
  test('a new outgoing message is placed after newer call entries even if the device clock is behind', () => {
    const existing = [
      { callId: 'call-520', type: 'call', createdAt: '2026-08-25T17:20:00.000Z' } as any,
      message({ messageId: 'old-message', createdAt: '2026-08-25T17:00:00.000Z' }),
    ];
    const createdAt = nextLocalCreatedAt(
      existing,
      Date.parse('2026-08-25T17:10:00.000Z'),
    );
    const state = {
      bob: existing,
    };
    const next = prependMessage(
      state,
      'bob',
      message({ messageId: 'new-message', createdAt, clientCreatedAt: createdAt }),
    );

    expect(createdAt).toBe('2026-08-25T17:20:00.001Z');
    expect(next.bob.map((m: any) => m.messageId ?? m.callId)).toEqual([
      'new-message',
      'call-520',
      'old-message',
    ]);
    expect([...next.bob].reverse().map((m: any) => m.messageId ?? m.callId)).toEqual([
      'old-message',
      'call-520',
      'new-message',
    ]);
  });

  test('multiple local sends in the same tick keep composition order', () => {
    const first = nextLocalCreatedAt([], Date.parse('2026-08-25T17:21:00.000Z'), 0);
    const second = nextLocalCreatedAt([], Date.parse('2026-08-25T17:21:00.000Z'), Date.parse(first));
    expect([first, second]).toEqual([
      '2026-08-25T17:21:00.000Z',
      '2026-08-25T17:21:00.001Z',
    ]);
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

  test('an optimistic call entry is reconciled by callId, not duplicated', () => {
    const held = [
      { callId: 'call-1', type: 'call', status: 'ringing', syncState: 'pending', createdAt: '2026-08-25T10:35:00.000Z' } as any,
    ];
    const page = [
      { callId: 'call-1', type: 'call', status: 'ended', syncState: 'synced', durationSeconds: 12, createdAt: '2026-08-25T10:35:00.000Z' } as any,
    ];
    expect(mergeHistoryPage(held, page)).toEqual(page);
  });

  test('a server acknowledgement cannot move a newly sent message above newer call history', () => {
    const held = [
      message({
        messageId: 'new-message',
        createdAt: '2026-08-25T17:10:00.000Z',
        clientCreatedAt: '2026-08-25T17:21:00.000Z',
        syncState: 'synced',
      }),
      { callId: 'call-520', type: 'call', createdAt: '2026-08-25T17:20:00.000Z' } as any,
      message({ messageId: 'old-message', createdAt: '2026-08-25T17:00:00.000Z' }),
    ];
    const page = [
      { callId: 'call-520', type: 'call', createdAt: '2026-08-25T17:20:00.000Z' } as any,
      message({ messageId: 'new-message', createdAt: '2026-08-25T17:10:00.000Z' }),
      message({ messageId: 'old-message', createdAt: '2026-08-25T17:00:00.000Z' }),
    ];
    const merged = mergeHistoryPage(held, page);
    expect(merged.map((m: any) => m.messageId ?? m.callId)).toEqual([
      'new-message',
      'call-520',
      'old-message',
    ]);
    expect([...merged].reverse().map((m: any) => m.messageId ?? m.callId)).toEqual([
      'old-message',
      'call-520',
      'new-message',
    ]);
  });

  // The regression this guards: `fetchMessagesForPeer` awaits a network round
  // trip, and a message arriving over the socket during that window is newer
  // than anything the response can contain. Replacing the history with the page
  // dropped it from the conversation while the unread badge — fed from a
  // different piece of state — had already counted it.
  test('a message that arrived while the request was in flight is kept', () => {
    const held = [
      message({ messageId: 'live', syncState: 'synced', createdAt: '2026-08-25T10:40:00.000Z' }),
      message({ messageId: 'm1', syncState: 'synced' }),
    ];
    const page = [message({ messageId: 'm1', syncState: 'synced' })];
    expect(mergeHistoryPage(held, page).map((m: any) => m.messageId)).toEqual(['live', 'm1']);
  });

  test('history already paged in below the page window survives a refetch', () => {
    const held = [
      message({ messageId: 'm2', createdAt: '2026-08-25T10:30:00.000Z' }),
      message({ messageId: 'm1', createdAt: '2026-08-25T09:00:00.000Z' }),
    ];
    const page = [message({ messageId: 'm2', createdAt: '2026-08-25T10:30:00.000Z' })];
    expect(mergeHistoryPage(held, page).map((m: any) => m.messageId)).toEqual(['m2', 'm1']);
  });

  // The other half of the same rule: inside the window the server *is*
  // authoritative, so a message deleted on another device must not linger.
  test('a held entry inside the page window that the server dropped is discarded', () => {
    const held = [
      message({ messageId: 'newer', createdAt: '2026-08-25T10:40:00.000Z' }),
      message({ messageId: 'gone', createdAt: '2026-08-25T10:20:00.000Z' }),
      message({ messageId: 'older', createdAt: '2026-08-25T09:00:00.000Z' }),
    ];
    const page = [
      message({ messageId: 'newer', createdAt: '2026-08-25T10:40:00.000Z' }),
      message({ messageId: 'older', createdAt: '2026-08-25T09:00:00.000Z' }),
    ];
    expect(mergeHistoryPage(held, page).map((m: any) => m.messageId)).toEqual(['newer', 'older']);
  });

  test('an empty page reports on nothing, so it discards nothing', () => {
    const held = [message({ messageId: 'm1', syncState: 'synced' })];
    expect(mergeHistoryPage(held, []).map((m: any) => m.messageId)).toEqual(['m1']);
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

  test('an older page is re-sorted so entries stay newest-first', () => {
    const held = [
      message({ messageId: 'm3', createdAt: '2026-08-25T12:00:00.000Z' }),
      { callId: 'c1', type: 'call', createdAt: '2026-08-25T09:00:00.000Z' } as any,
    ];
    const page = [
      message({ messageId: 'm2', createdAt: '2026-08-25T11:00:00.000Z' }),
    ];
    const merged = mergeHistoryPage(held, page, { before: '2026-08-25T12:00:00.000Z' });
    expect(merged.map((m: any) => m.messageId ?? m.callId)).toEqual(['m3', 'm2', 'c1']);
  });
});

describe('upsertTimelineEntry', () => {
  test('inserts a live call chronologically among held messages', () => {
    const state = {
      bob: [
        message({ messageId: 'newer', createdAt: '2026-08-25T10:40:00.000Z' }),
        message({ messageId: 'older', createdAt: '2026-08-25T10:20:00.000Z' }),
      ],
    };
    const next = upsertTimelineEntry(state, 'bob', {
      callId: 'call-1',
      type: 'call',
      createdAt: '2026-08-25T10:30:00.000Z',
    } as any);
    expect(next.bob.map((m: any) => m.messageId ?? m.callId)).toEqual(['newer', 'call-1', 'older']);
  });

  test('replaces a previous live call entry by callId', () => {
    const state = {
      bob: [
        { callId: 'call-1', type: 'call', status: 'ringing', createdAt: '2026-08-25T10:30:00.000Z' } as any,
      ],
    };
    const next = upsertTimelineEntry(state, 'bob', {
      callId: 'call-1',
      type: 'call',
      status: 'ended',
      createdAt: '2026-08-25T10:30:00.000Z',
    } as any);
    expect(next.bob).toHaveLength(1);
    expect((next.bob[0] as any).status).toBe('ended');
  });
});
