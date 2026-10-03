import { fetchGroupHistory, fetchHistory } from '../../src/messaging/fetchHistory';
import { bearerAuthHeaders } from '../../src/authHeaders';
import { mergeHistoryPage } from '../../src/messaging/messageHistory';
import type { ChatMessage } from '../../src/messaging/types';

const message = (messageId: string, extra: Partial<ChatMessage> = {}) => ({
  messageId, createdAt: '2026-01-01T00:00:00.000Z', body: 'cached', ...extra,
} as ChatMessage);

test('group history uses the implemented encoded route and message cursor, never the direct peer endpoint', async () => {
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [message('group-message')] }) });
  const page = await fetchGroupHistory(fetch, 'https://example.test', 'group/a:b', {
    before: '2026-01-01T00:00:00Z', beforeType: 'message', beforeMessageId: 'm1',
  });
  const request = fetch.mock.calls[0][0]('token');
  expect(request.url).toContain('/conversations/group%2Fa%3Ab/messages?limit=50');
  expect(request.url).toContain('beforeMessageId=m1');
  expect(request.url).not.toContain('peerId=');
  expect(request.url).not.toContain('include=calls');
  expect(request.options.headers).toEqual(bearerAuthHeaders('token'));
  expect(page?.[0].messageId).toBe('group-message');
});

test('fetches one screen-sized page before first paint regardless of cached window size', async () => {
  const cursor = { before: '2026-01-01T00:00:00.000Z', beforeType: 'call' as const, beforeCallId: 'call-1' };
  const fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [message('first')], nextCursor: cursor }) });
  const page = await fetchHistory(fetch, 'https://example.test', 'bob', null, 200);
  expect(page?.map(row => row.messageId)).toEqual(['first']);
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0][0]('token');
  expect(request.url).toContain('limit=20');
});

test('backfill fetches one larger page with the full call cursor', async () => {
  const cursor = { before: '2026-01-01T00:00:00.000Z', beforeType: 'call' as const, beforeCallId: 'call-1' };
  const fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [message('older')] }) });
  const page = await fetchHistory(fetch, 'https://example.test', 'bob', cursor, 200);
  expect(page?.map(row => row.messageId)).toEqual(['older']);
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0][0]('token');
  expect(request.url).toContain('limit=50');
  expect(request.url).toContain('beforeType=call');
  expect(request.url).toContain('beforeCallId=call-1');
});

test('refresh failure leaves the existing cache authoritative rather than deleting rows', async () => {
  const fetch = jest.fn()
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
