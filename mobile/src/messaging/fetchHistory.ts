import { API_ROUTES } from '../../../shared';
import { bearerAuthHeaders } from '../authHeaders';
import type { ChatMessage, TimelineCursor } from './types';

function historyParams(peerId: string, cursor: TimelineCursor | null): URLSearchParams {
  const params = new URLSearchParams({ peerId, include: 'calls', limit: '100' });
  if (cursor?.before) params.set('before', cursor.before);
  if (cursor?.beforeType) params.set('beforeType', cursor.beforeType);
  if (cursor?.beforeMessageId) params.set('beforeMessageId', cursor.beforeMessageId);
  if (cursor?.beforeCallId) params.set('beforeCallId', cursor.beforeCallId);
  return params;
}

/** Revalidate the bounded cached window, not just the first page's messages. */
export async function fetchHistory(
  authedFetch: Function | null, server: string, peerId: string,
  cursor: TimelineCursor | null, cachedCount: number,
): Promise<ChatMessage[] | null> {
  const pageCount = cursor ? 1 : Math.max(1, Math.ceil(Math.min(cachedCount, 200) / 100));
  const messages: ChatMessage[] = [];
  let next = cursor;
  for (let page = 0; page < pageCount; page += 1) {
    const params = historyParams(peerId, next);
    const response = await authedFetch?.((sid: string) => ({
      url: `${server}${API_ROUTES.MESSAGES}?${params.toString()}`,
      options: { headers: bearerAuthHeaders(sid) },
    }));
    if (!response?.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data.messages)) return null;
    messages.push(...data.messages);
    if (!data.nextCursor?.before || !data.messages.length) break;
    next = data.nextCursor;
  }
  return messages;
}
