import { timelineEntryId } from './messageIdentity';

export type MessageSearchResult = {
  messageId: string;
  clientMessageId?: string;
  senderId?: string;
  peerId: string;
  body?: string;
  createdAt?: string;
};

/**
 * Merge device-cache and server search hits, preferring the authoritative server
 * copy while retaining local-only matches.
 */
export function mergeMessageSearchResults<T extends MessageSearchResult>(
  local: T[],
  remote: T[],
  limit = 100,
): T[] {
  const byId = new Map<string, T>();
  for (const message of local) {
    if (message.messageId) byId.set(timelineEntryId(message)!, message);
  }
  for (const message of remote) {
    if (!message.messageId) continue;
    const id = timelineEntryId(message)!;
    byId.set(id, { ...byId.get(id), ...message });
  }
  return [...byId.values()]
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt ?? '');
      const bTime = Date.parse(b.createdAt ?? '');
      const aHasTime = Number.isFinite(aTime);
      const bHasTime = Number.isFinite(bTime);
      if (aHasTime && bHasTime && aTime !== bTime) return bTime - aTime;
      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
      return b.messageId.localeCompare(a.messageId);
    })
    .slice(0, Math.max(1, Math.min(limit, 100)));
}
