import { useCallback, useMemo, useState } from 'react';
import { logWarn } from '../appLogger';
import { API_ROUTES } from '../../../shared';

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
 * @param {{
 *   authedFetchRef: { current: Function | null },
 *   sessionIdRef: { current: string | null },
 *   signalingUrl: string,
 * }} params
 */
export default function useBlocks({ authedFetchRef, sessionIdRef, signalingUrl }) {
  /** @type {[string[], Function]} ids the authenticated user has blocked. */
  const [blockedUsers, setBlockedUsers] = useState([]);

  const blockedSet = useMemo(() => new Set(blockedUsers), [blockedUsers]);

  /** Whether `peerId` is currently blocked by the authenticated user. */
  const isUserBlocked = useCallback(peerId => blockedSet.has((peerId ?? '').trim()), [blockedSet]);

  /**
   * Load the blocklist from the server (`GET /blocks`).  Safe to call
   * repeatedly; network errors are swallowed so it never disrupts the caller.
   */
  const fetchBlocks = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const trimmedUrl = signalingUrl.trim();
      const response = await authedFetchRef.current?.(sid => ({
        url: `${trimmedUrl}${API_ROUTES.BLOCKS}?sessionId=${encodeURIComponent(sid)}`,
      }));
      if (!response?.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.blockedUsers)) return;
      setBlockedUsers(data.blockedUsers);
    } catch (error) {
      logWarn('[Blocks] fetchBlocks failed', { message: error?.message });
    }
  }, [authedFetchRef, sessionIdRef, signalingUrl]);

  /**
   * Block `peerId` (`POST /blocks`).
   *
   * @param {string} peerId
   * @returns {Promise<boolean>} whether the block was applied.
   */
  const blockUser = useCallback(
    async peerId => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return false;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}${API_ROUTES.BLOCKS}`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, blockeeId: trimmedPeerId }),
          },
        }));
        if (!response?.ok) return false;
        setBlockedUsers(prev => (prev.includes(trimmedPeerId) ? prev : [...prev, trimmedPeerId]));
        return true;
      } catch (error) {
        logWarn('[Blocks] blockUser failed', { message: error?.message });
        return false;
      }
    },
    [authedFetchRef, signalingUrl],
  );

  /**
   * Remove a block (`DELETE /blocks/:peerId`).  A block the server no longer
   * holds (404) still clears locally, so the two can never disagree.
   *
   * @param {string} peerId
   * @returns {Promise<boolean>} whether the peer ended up unblocked.
   */
  const unblockUser = useCallback(
    async peerId => {
      const trimmedPeerId = (peerId ?? '').trim();
      if (!trimmedPeerId) return false;
      try {
        const trimmedUrl = signalingUrl.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}${API_ROUTES.BLOCKS}/${encodeURIComponent(trimmedPeerId)}?sessionId=${encodeURIComponent(sid)}`,
          options: { method: 'DELETE' },
        }));
        if (!response || (!response.ok && response.status !== 404)) return false;
        setBlockedUsers(prev => prev.filter(id => id !== trimmedPeerId));
        return true;
      } catch (error) {
        logWarn('[Blocks] unblockUser failed', { message: error?.message });
        return false;
      }
    },
    [authedFetchRef, signalingUrl],
  );

  return {
    blockedUsers,
    isUserBlocked,
    fetchBlocks,
    blockUser,
    unblockUser,
  };
}
