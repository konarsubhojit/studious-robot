// @ts-check
import { useCallback, useMemo, useState } from 'react';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errorMessage';
import { API_ROUTES } from '../../../shared';

/**
 * One row of the call log, as rendered by the Calls tab.
 *
 * `direction` is derived client-side by comparing the server's `callerId`
 * against the signed-in user, and `isRead` drives the missed-call badge.
 *
 * @typedef {object} CallHistoryEntry
 * @property {string} callId
 * @property {string} callerId
 * @property {string} calleeId
 * @property {'incoming'|'outgoing'} direction
 * @property {string} status
 * @property {string|null} endReason
 * @property {string} createdAt
 * @property {number|null} durationSeconds
 * @property {boolean} isRead
 */

/** Maximum number of call history entries to retain in memory. */
const MAX_CALL_HISTORY = 50;

/**
 * Owns the call-history log: the in-memory list, missed-call badge count,
 * and fetching the authenticated user's history from the server.
 *
 * Extracted out of `useCallFlow` so this concern stays isolated from that
 * hook's call-lifecycle/session/WebRTC responsibilities; `useCallFlow` still
 * calls `addToHistory` from its own call-teardown logic.
 *
 * @param {{
 *   authedFetchRef: { current: import('./useSession').AuthedFetch | null },
 *   sessionIdRef: { current: string | null },
 *   signalingUrl: string,
 *   userId: string,
 * }} params
 */
export default function useCallHistory({ authedFetchRef, sessionIdRef, signalingUrl, userId }) {
  const [callHistory, setCallHistory] = useState(
    /** @type {CallHistoryEntry[]} */ ([]),
  );

  /**
   * Number of incoming calls that ended as 'missed' and have not yet been
   * acknowledged by the user.
   */
  const missedCallCount = useMemo(
    () =>
      callHistory.filter(
        e =>
          e.direction === 'incoming' &&
          (e.status === 'missed' || e.endReason === 'timeout') &&
          !e.isRead,
      ).length,
    [callHistory],
  );

  /** Append or update a call history entry (deduplicates by callId). */
  const addToHistory = useCallback(/** @param {CallHistoryEntry} entry */ entry => {
    setCallHistory(prev => {
      const without = prev.filter(e => e.callId !== entry.callId);
      return [entry, ...without].slice(0, MAX_CALL_HISTORY);
    });
  }, []);

  /** Mark all missed-call entries as read (clears the badge counter). */
  const markMissedCallsRead = useCallback(() => {
    setCallHistory(prev => prev.map(e => ({ ...e, isRead: true })));
  }, []);

  /**
   * Fetch the authenticated user's recent call history from the server and
   * populate `callHistory`.  Safe to call repeatedly; silently swallows
   * network errors so it never disrupts other call-flow operations.
   *
   * @param {number} [limit=20]
   */
  const fetchCallHistory = useCallback(
    async (limit = 20) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const trimmedUserId = userId.trim();
        const response = await authedFetchRef.current?.(sid => ({
          url: `${trimmedUrl}${API_ROUTES.CALLS}?sessionId=${encodeURIComponent(sid)}&limit=${limit}`,
        }));
        if (!response?.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.calls)) return;
        const entries = data.calls.map(
          /** @param {any} call @returns {CallHistoryEntry} */
          call => ({
            callId: call.callId,
            callerId: call.callerId,
            calleeId: call.calleeId,
            direction: call.callerId === trimmedUserId ? 'outgoing' : 'incoming',
            status: call.status,
            endReason: call.endReason,
            createdAt: call.createdAt,
            durationSeconds: call.durationSeconds ?? null,
            isRead: call.status !== 'missed' || Boolean(call.missedReadAt),
          }),
        );
        setCallHistory(entries);
      } catch (error) {
        logWarn('[CallHistory] fetchCallHistory failed', {
          message: errorMessage(error),
        });
      }
    },
    [authedFetchRef, sessionIdRef, signalingUrl, userId],
  );

  return {
    callHistory,
    missedCallCount,
    addToHistory,
    markMissedCallsRead,
    fetchCallHistory,
  };
}
