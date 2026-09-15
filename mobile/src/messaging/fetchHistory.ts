import { API_ROUTES } from '../../../shared';
import { bearerAuthHeaders } from '../authHeaders';
import type { ChatMessage, TimelineCursor } from './types';

const FIRST_PAGE_MESSAGE_LIMIT = 20;
const BACKFILL_MESSAGE_LIMIT = 50;

function historyParams(peerId: string, cursor: TimelineCursor | null): URLSearchParams {
  const params = new URLSearchParams({
    peerId,
    include: 'calls',
    limit: String(cursor ? BACKFILL_MESSAGE_LIMIT : FIRST_PAGE_MESSAGE_LIMIT),
  });
  if (cursor?.before) params.set('before', cursor.before);
  if (cursor?.beforeType) params.set('beforeType', cursor.beforeType);
  if (cursor?.beforeMessageId) params.set('beforeMessageId', cursor.beforeMessageId);
  if (cursor?.beforeCallId) params.set('beforeCallId', cursor.beforeCallId);
  return params;
}

/** Fetch one screen-first page; wider revalidation must not block first paint. */
export async function fetchHistory(
  authedFetch: Function | null, server: string, peerId: string,
  cursor: TimelineCursor | null, cachedCount: number,
): Promise<ChatMessage[] | null> {
  void cachedCount;
  const params = historyParams(peerId, cursor);
  const response = await authedFetch?.((sid: string) => ({
    url: `${server}${API_ROUTES.MESSAGES}?${params.toString()}`,
    options: { headers: bearerAuthHeaders(sid) },
  }));
  if (!response?.ok) return null;
  const data = await response.json();
  if (!Array.isArray(data.messages)) return null;
  return data.messages;
}
