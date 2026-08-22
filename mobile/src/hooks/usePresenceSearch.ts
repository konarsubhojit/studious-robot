import { useCallback, useEffect, useRef, useState } from 'react';
import { logWarn } from '../appLogger';
import { API_ROUTES } from '../../../shared';

/**
 * How many consecutive socket `connect_error` events before the lobby is
 * considered offline and an offline banner is shown.
 */
const OFFLINE_ERROR_THRESHOLD = 3;

/**
 * Owns presence lookups (`GET /presence/:userId`), the contact directory
 * search (`GET /users`), and the "is the signaling server reachable" offline
 * indicator derived from consecutive socket `connect_error` events.
 *
 * The socket lifecycle itself lives in `useCallFlow`; it reports connection
 * outcomes here via `recordConnectSuccess` / `recordConnectError` instead of
 * reaching into this hook's state directly, keeping the offline-detection
 * policy (the error threshold) encapsulated in one place.
 *
 * Extracted out of `useCallFlow` so this concern stays isolated from that
 * hook's call-lifecycle/session/WebRTC responsibilities.
 *
 * @param {{
 *   signalingUrl: string,
 *   authedFetchRef: { current: Function | null },
 *   sessionIdRef: { current: string | null },
 *   calleeId: string,
 * }} params
 */
export default function usePresenceSearch({
  signalingUrl,
  authedFetchRef,
  sessionIdRef,
  calleeId,
}: {
        signalingUrl: string;
        authedFetchRef: { current: Function | null; };
        sessionIdRef: { current: string | null; };
        calleeId: string;
    }) {
  // Presence of the user currently entered in `calleeId`, or `null` while
  // unknown / not yet checked.  Shape: { status: 'online'|'offline', online }.
  const [calleePresence, setCalleePresence] = useState(
    (null as { status: string, online: boolean, unknown?: boolean } | null),
  );

  /**
   * `true` when repeated socket connect errors suggest the signaling server is
   * unreachable.  Cleared automatically on a successful connection.  Drives the
   * persistent offline banner + retry button in the Lobby.
   */
  const [isServerUnreachable, setIsServerUnreachable] = useState(false);

  const calleePresenceRequestIdRef = useRef(0);
  // Counts consecutive socket connect_error events; resets on a successful
  // connect.  Used to flip isServerUnreachable after OFFLINE_ERROR_THRESHOLD.
  const connectErrorCountRef = useRef(0);

  /**
   * Query the signaling server for the online/offline presence of a userId.
   * Returns the presence snapshot, or `null` when the user is unknown (404) or
   * the request fails.  Never throws.
   *
   * @param {string} targetUserId
   * @returns {Promise<{ status: string, online: boolean, unknown?: boolean } | null>}
   */
  const checkPresence = useCallback(
    async (/** @type {string} */ targetUserId: string) => {
      const trimmedId = (targetUserId ?? '').trim();
      const trimmedUrl = (signalingUrl ?? '').trim();
      if (!trimmedId || !trimmedUrl) return null;
      try {
        const response = await authedFetchRef.current?.((/** @type {string} */ sessionId: string) => ({
          url: `${trimmedUrl}/presence/${encodeURIComponent(
            trimmedId,
          )}?sessionId=${encodeURIComponent(sessionId)}`,
        }));
        if (!response) return null;
        if (response.status === 404) return { status: 'offline', online: false, unknown: true };
        if (!response.ok) return null;
        const data = await response.json();
        return { status: data.status, online: Boolean(data.online) };
      } catch (error) {
        logWarn('[PresenceSearch] checkPresence failed', {
          message: error instanceof Error ? error.message : undefined,
        });
        return null;
      }
    },
    [authedFetchRef, signalingUrl],
  );

  /**
   * Search the server's contact directory (`GET /users`) for known users whose
   * userId matches `query` (case-insensitive substring).  Returns an array of
   * `{ userId, status, online, lastSeen }` entries, or an empty array when the
   * request fails or no session exists.  Never throws.
   *
   * Pass a `signal` to cancel an in-flight request — the unified search screen
   * aborts the previous lookup on every keystroke.
   *
   * @param {string} [query] optional substring filter
   * @param {{ limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Array<{ userId: string, status: string, online: boolean, lastSeen?: string | null }>>}
   */
  const searchUsers = useCallback(
    /**
     * @param {string} [query]
     * @param {{ limit?: number, signal?: AbortSignal }} [options]
     */
    async (query: string = '', { limit = 20, signal }: { limit?: number; signal?: AbortSignal; } = {}) => {
      const sessionId = sessionIdRef.current;
      const trimmedUrl = (signalingUrl ?? '').trim();
      if (!sessionId || !trimmedUrl) return [];
      try {
        const trimmedQuery = (query ?? '').trim();
        const response = await authedFetchRef.current?.((/** @type {string} */ sid: string) => {
          const params = new URLSearchParams({
            sessionId: sid,
            limit: String(limit),
          });
          if (trimmedQuery) params.set('search', trimmedQuery);
          return {
            url: `${trimmedUrl}${API_ROUTES.USERS}?${params.toString()}`,
            options: signal ? { signal } : undefined,
          };
        });
        if (!response?.ok) return [];
        const data = await response.json();
        return Array.isArray(data.users) ? data.users : [];
      } catch (error) {
        // An aborted request is the expected outcome of a newer keystroke.
        if (!(error instanceof Error) || error.name !== 'AbortError') {
          logWarn('[PresenceSearch] searchUsers failed', {
            message: error instanceof Error ? error.message : undefined,
          });
        }
        return [];
      }
    },
    [authedFetchRef, sessionIdRef, signalingUrl],
  );

  // Debounced presence lookup for the currently entered calleeId, so the UI
  // can show whether the callee is online before the user presses Call.
  useEffect(() => {
    const trimmedId = calleeId.trim();
    if (!trimmedId) {
      calleePresenceRequestIdRef.current += 1;
      setCalleePresence(null);
      return undefined;
    }
    let cancelled = false;
    const requestId = calleePresenceRequestIdRef.current + 1;
    calleePresenceRequestIdRef.current = requestId;
    const timer = setTimeout(async () => {
      const presence = await checkPresence(trimmedId);
      if (!cancelled && calleePresenceRequestIdRef.current === requestId) {
        setCalleePresence(presence);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [calleeId, checkPresence]);

  /** Report a successful socket connection: clears the offline indicator. */
  const recordConnectSuccess = useCallback(() => {
    connectErrorCountRef.current = 0;
    setIsServerUnreachable(false);
  }, []);

  /** Report a socket `connect_error`; flips the offline indicator once the
   * consecutive-error threshold is reached. */
  const recordConnectError = useCallback(() => {
    connectErrorCountRef.current += 1;
    if (connectErrorCountRef.current >= OFFLINE_ERROR_THRESHOLD) {
      setIsServerUnreachable(true);
    }
  }, []);

  /** Reset offline tracking before a manual reconnect attempt. */
  const resetOfflineTracking = useCallback(() => {
    setIsServerUnreachable(false);
    connectErrorCountRef.current = 0;
  }, []);

  /** Immediately flag the server as unreachable (e.g. a manual retry failed
   * outright), bypassing the consecutive-error threshold. */
  const markServerUnreachable = useCallback(() => {
    setIsServerUnreachable(true);
  }, []);

  return {
    calleePresence,
    checkPresence,
    searchUsers,
    isServerUnreachable,
    recordConnectSuccess,
    recordConnectError,
    resetOfflineTracking,
    markServerUnreachable,
  };
}
