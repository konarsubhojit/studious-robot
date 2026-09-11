import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { logWarn } from '../appLogger';
import { API_ROUTES } from '../../../shared';
import { errorMessage } from '../errors';
import { bearerAuthHeaders } from '../authHeaders';
import { dataScope } from '../storage/localDatabase';
import useCachedResource from '../storage/useCachedResource';
import { invalidateDirectory } from '../storage/resourceCache';

/**
 * Owns the authenticated user's blocklist: the ids they have blocked, and the
 * block/unblock round trip against `POST /blocks` / `DELETE /blocks/:id`.
 *
 * The server already filters a blocked peer out of the contact directory, the
 * conversation list and message search, and refuses calls and messages in both
 * directions — this hook is what finally makes that reachable from the UI (the
 * peer profile screen). The local `blockedUsers` set is updated optimistically
 * so the profile screen flips to "Unblock" immediately, and reconciled from
 * the server's response.
 *
 * Extracted as its own hook, like `useCallHistory` / `usePresenceSearch`, so
 * `useCallFlow` stays free of this concern.
 *
 * @param params
 */
export default function useBlocks({ authedFetchRef, sessionIdRef, signalingUrl, userId = '' }: {
        authedFetchRef: { current: Function | null; };
        sessionIdRef: { current: string | null; };
        signalingUrl: string;
        userId?: string;
    }) {
  /** @type ids the authenticated user has blocked. */
  const scope = dataScope(signalingUrl, userId);
  const [blockedUsers, setBlockedUsers] = useCachedResource<string[]>(scope, 'blocks', []);
  const blockedUsersRef = useRef(blockedUsers);
  blockedUsersRef.current = blockedUsers;

  const blockedSet = useMemo(() => new Set(blockedUsers), [blockedUsers]);

  /** Whether `peerId` is currently blocked by the authenticated user. */
  const isUserBlocked = useCallback(
    (peerId: string) => blockedSet.has((peerId ?? '').trim()),
    [blockedSet],
  );

  /**
   * Load the blocklist from the server (`GET /blocks`).  Safe to call
   * repeatedly; network errors are swallowed so it never disrupts the caller.
   */
  const fetchBlocks = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const trimmedUrl = signalingUrl.trim();
      const response = await authedFetchRef.current?.((sid: string) => ({
        url: `${trimmedUrl}${API_ROUTES.BLOCKS}`,
        options: { headers: bearerAuthHeaders(sid) },
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.blockedUsers)) return;
      const previous = blockedUsersRef.current;
      const changed = previous.length !== data.blockedUsers.length ||
        previous.some(id => !data.blockedUsers.includes(id));
      setBlockedUsers(data.blockedUsers);
      if (changed) {
        await invalidateDirectory(scope).catch(() => logWarn('[Blocks] Failed to invalidate cached directory'));
      }
    } catch (error) {
      logWarn('[Blocks] fetchBlocks failed', { message: errorMessage(error) });
    }
  }, [authedFetchRef, sessionIdRef, signalingUrl, scope, setBlockedUsers]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void fetchBlocks();
    });
    return () => subscription.remove();
  }, [fetchBlocks]);

  /**
   * Block `peerId` (`POST /blocks`).
   *
   * @returns whether the block was applied.
   */
  const blockUser = useCallback(
    async (peerId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return false;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.BLOCKS}`,
          options: {
            method: 'POST',
            headers: bearerAuthHeaders(sid, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ blockeeId: trimmedPeerId }),
          },
        }));
        if (!response?.ok) return false;
        setBlockedUsers((prev: string[]) =>
          prev.includes(trimmedPeerId) ? prev : [...prev, trimmedPeerId],
        );
        await invalidateDirectory(scope).catch(() => logWarn('[Blocks] Failed to invalidate cached directory'));
        return true;
      } catch (error) {
        logWarn('[Blocks] blockUser failed', { message: errorMessage(error) });
        return false;
      }
    },
    [authedFetchRef, signalingUrl, scope, setBlockedUsers],
  );

  /**
   * Remove a block (`DELETE /blocks/:peerId`).  A block the server no longer
   * holds (404) still clears locally, so the two can never disagree.
   *
   * @returns whether the peer ended up unblocked.
   */
  const unblockUser = useCallback(
    async (peerId: string) => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return false;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.((sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.BLOCKS}/${encodeURIComponent(trimmedPeerId)}`,
          options: { method: 'DELETE', headers: bearerAuthHeaders(sid) },
        }));
        if (!response || (!response.ok && response.status !== 404)) return false;
        setBlockedUsers((prev: string[]) =>
          prev.filter((id: string) => id !== trimmedPeerId),
        );
        await invalidateDirectory(scope).catch(() => logWarn('[Blocks] Failed to invalidate cached directory'));
        return true;
      } catch (error) {
        logWarn('[Blocks] unblockUser failed', { message: errorMessage(error) });
        return false;
      }
    },
    [authedFetchRef, signalingUrl, scope, setBlockedUsers],
  );

  return {
    blockedUsers,
    isUserBlocked,
    fetchBlocks,
    blockUser,
    unblockUser,
  };
}
