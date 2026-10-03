import { API_ROUTES } from '../../../shared';
import { bearerAuthHeaders } from '../authHeaders';
import type { PeerProfile } from '../types/directory';

/** Exact, block-aware profile lookup; never accepts a signed avatar URL from a row. */
export async function fetchPeerProfile({
  signalingUrl, userId, currentUserId, authedFetch, signal,
}: {
  signalingUrl: string;
  userId: string;
  currentUserId?: string;
  authedFetch: Function | null;
  signal?: AbortSignal;
}): Promise<PeerProfile | null> {
  const server = signalingUrl.trim().replace(/\/+$/, '');
  if (!userId || !server || !authedFetch || signal?.aborted) return null;
  const isSelf = userId === currentUserId;
  const path = isSelf ? API_ROUTES.PROFILE : `${API_ROUTES.USERS}?userId=${encodeURIComponent(userId)}`;
  try {
    const response = await authedFetch((sessionId: string) => ({
      url: `${server}${path}`,
      options: { headers: bearerAuthHeaders(sessionId), ...(signal ? { signal } : {}) },
    }));
    if (!response?.ok || signal?.aborted) return null;
    const data = await response.json();
    const row = isSelf ? data : Array.isArray(data.users)
      ? data.users.find((user: { userId?: unknown }) => user?.userId === userId) : null;
    if (!row || signal?.aborted) return null;
    return {
      displayName: typeof row.displayName === 'string' ? row.displayName : null,
      avatarKey: typeof row.avatarKey === 'string' ? row.avatarKey : null,
    };
  } catch {
    return null;
  }
}
