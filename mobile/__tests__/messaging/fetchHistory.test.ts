import { fetchHistory } from '../../src/messaging/fetchHistory';
import { mergeHistoryPage } from '../../src/messaging/messageHistory';
import type { ChatMessage } from '../../src/messaging/types';

const message = (messageId: string, extra: Partial<ChatMessage> = {}) => ({
  messageId, createdAt: '2026-01-01T00:00:00.000Z', body: 'cached', ...extra,
} as ChatMessage);

test('revalidates both pages of a cached window with the full call cursor', async () => {
  const cursor = { before: '2026-01-01T00:00:00.000Z', beforeType: 'call', beforeCallId: 'call-1' };
  const fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [message('first')], nextCursor: cursor }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [message('older', { deletedAt: 'now', body: '' })] }) });
  const page = await fetchHistory(fetch, 'https://example.test', 'bob', null, 200);
  expect(page?.map(row => row.messageId)).toEqual(['first', 'older']);
  const request = fetch.mock.calls[1][0]('token');
  expect(request.url).toContain('beforeType=call');
  expect(request.url).toContain('beforeCallId=call-1');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('partial refresh failure leaves the existing cache authoritative rather than deleting rows', async () => {
  const fetch = jest.fn()
    .mockResolvedValueOnce({
      ok: true, json: async () => ({ messages: [message('first')], nextCursor: { before: '2026-01-01' } }),
    })
    .mockResolvedValueOnce({ ok: false, status: 503 });
  expect(await fetchHistory(fetch, 'https://example.test', 'bob', null, 200)).toBeNull();
});

test('older server pages update cached tombstones and receipts instead of ignoring duplicate ids', () => {
  const held = message('old');
  const deleted = message('old', { deletedAt: '2026-01-02', body: '', attachment: null });
  const merged = mergeHistoryPage([held], [deleted], { before: '2026-01-03' });
  expect(merged).toEqual([deleted]);
});

test('a stale HTTP response cannot resurrect a socket tombstone', () => {
  const deleted = message('old', { deletedAt: '2026-01-02', body: '', attachment: null });
  expect(mergeHistoryPage([deleted], [message('old')])).toEqual([deleted]);
  expect(mergeHistoryPage([deleted], [message('old')], { before: '2026-01-03' })).toEqual([deleted]);
});
