import { mergeMessageSearchResults } from '../../src/messaging/messageSearch';

describe('mergeMessageSearchResults', () => {
  test('keeps local-only hits, prefers updated server rows, and sorts newest first', () => {
    const results = mergeMessageSearchResults(
      [
        { messageId: 'local', peerId: 'alice', body: 'cached', createdAt: '2024-01-01T00:00:00Z' },
        { messageId: 'shared', peerId: 'alice', body: 'stale', createdAt: '2024-01-02T00:00:00Z' },
      ],
      [
        { messageId: 'shared', peerId: 'alice', body: 'server', createdAt: '2024-01-03T00:00:00Z' },
        { messageId: 'remote', peerId: 'bob', body: 'older', createdAt: '2023-01-01T00:00:00Z' },
      ],
    );

    expect(results.map(result => result.messageId)).toEqual(['shared', 'local', 'remote']);
    expect(results[0].body).toBe('server');
  });

  test('caps results at a safe positive limit', () => {
    const results = mergeMessageSearchResults(
      Array.from({ length: 4 }, (_, index) => ({
        messageId: String(index), peerId: 'alice', createdAt: `2024-01-0${index + 1}T00:00:00Z`,
      })),
      [],
      2,
    );

    expect(results.map(result => result.messageId)).toEqual(['3', '2']);
  });
});
