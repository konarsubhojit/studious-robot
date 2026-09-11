import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { logWarn } from '../appLogger';
import { API_ROUTES } from '../../../shared';
import { DEFAULT_CALL_MEDIA_TYPE } from '../callUx';
import { errorMessage } from '../errors';
import { bearerAuthHeaders } from '../authHeaders';
import { loadCallMediaTypes, saveCallMediaTypes } from '../settingsStorage';
import type { CallMediaType, CallMediaTypeMap } from '../settingsStorage';
import { dataScope } from '../storage/localDatabase';
import useCachedResource from '../storage/useCachedResource';
import { RequestCoalescer } from '../storage/requestCoalescer';

/** Maximum number of call history entries to retain in memory. */
const MAX_CALL_HISTORY = 50;

/**
 * Owns the call-history log: the in-memory list, missed-call badge count,
 * and fetching the authenticated user's history from the server.
 *
 * Extracted out of `useCallFlow` so this concern stays isolated from that
 * hook's call-lifecycle/session/WebRTC responsibilities; `useCallFlow` still
 * calls `addToHistory` from its own call-teardown logic.
 */

export type CallHistoryEntry = {
  callId: string;
  callerId: string;
  calleeId: string;
  direction: 'incoming' | 'outgoing';
  status?: string;
  endReason?: string | null;
  createdAt?: string;
  durationSeconds?: number | null;
  isRead?: boolean;
  /**
   * Whether this was placed as an audio or a video call.
   *
   * The server has no audio-only call type — `startAudioCallWith` places an
   * ordinary call and drops the camera once it connects — so the modality is
   * remembered on the device (see `loadCallMediaTypes`) and merged back in
   * here. `undefined` means "not recorded on this device", which the call log
   * renders as a video call, matching what redial will actually do.
   */
  mediaType?: CallMediaType;
};

/**
 * Modality assumed for a call this device has no record of.
 *
 * Re-exported from `callUx` so existing importers keep working; it lives there
 * because the call log's pure helpers need it without the WebRTC stack.
 */
export { DEFAULT_CALL_MEDIA_TYPE };

/** Merge the remembered modality into an entry that does not carry one. */
function withMediaType(entry: CallHistoryEntry, map: CallMediaTypeMap): CallHistoryEntry {
  const known = entry.mediaType ?? map[entry.callId];
  return known ? { ...entry, mediaType: known } : entry;
}

/**
 * @param params
 */
export default function useCallHistory({ authedFetchRef, sessionIdRef, signalingUrl, userId, storageUserId = userId }: {
        authedFetchRef: { current: Function | null; };
        sessionIdRef: { current: string | null; };
        signalingUrl: string;
        userId: string;
        storageUserId?: string;
    }) {
  const requests = useMemo(
    () => new RequestCoalescer(dataScope(signalingUrl, storageUserId)), [signalingUrl, storageUserId]);
  // Each entry: { callId, callerId, calleeId, direction, status, endReason,
  //               createdAt, durationSeconds, isRead }
  const [callHistory, setCallHistory] = useCachedResource<CallHistoryEntry[]>(
    dataScope(signalingUrl, storageUserId), 'calls', []);

  // `callId -> modality`, mirrored to disk. Held in a ref (not state) because
  // it is only ever read while building an entry, so a change to it must not
  // re-render every consumer of the log.
  const mediaTypesRef = useRef(({} as CallMediaTypeMap));

  useEffect(() => {
    let cancelled = false;
    loadCallMediaTypes().then(stored => {
      if (cancelled) return;
      // Anything recorded while the file was loading wins: it describes a call
      // from this session, which is necessarily newer than the file.
      mediaTypesRef.current = { ...stored, ...mediaTypesRef.current };
      // Backfill rows fetched before the file arrived.
      setCallHistory(prev =>
        prev.length ? prev.map(entry =>
          entry.mediaType ? entry : withMediaType(entry, mediaTypesRef.current),
        ) : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [setCallHistory]);

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

  /**
   * Append or update a call history entry (deduplicates by callId).
   *
   * An explicit `mediaType` is also remembered on disk, so the row still shows
   * the right type icon — and redial still starts the right kind of call —
   * after the log is re-fetched from the server on the next launch.
   */
  const addToHistory = useCallback((entry: CallHistoryEntry) => {
    if (entry.mediaType && entry.callId) {
      mediaTypesRef.current = { [entry.callId]: entry.mediaType, ...mediaTypesRef.current };
      saveCallMediaTypes(mediaTypesRef.current);
    }
    const resolved = withMediaType(entry, mediaTypesRef.current);
    setCallHistory(prev => {
      const without = prev.filter(e => e.callId !== resolved.callId);
      return [resolved, ...without].slice(0, MAX_CALL_HISTORY);
    });
  }, [setCallHistory]);

  /** Mark all missed-call entries as read (clears the badge counter). */
  const markMissedCallsRead = useCallback(() => {
    setCallHistory(prev => prev.map(e => ({ ...e, isRead: true })));
  }, [setCallHistory]);

  /**
   * Fetch the authenticated user's recent call history from the server and
   * populate `callHistory`.  Safe to call repeatedly; silently swallows
   * network errors so it never disrupts other call-flow operations.
   *
   * @param [limit=20]
   */
  const fetchCallHistory = useCallback(
    (limit = 20) => requests.run(String(limit), async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      try {
        const trimmedUrl = signalingUrl.trim();
        const trimmedUserId = userId.trim();
        const response = await authedFetchRef.current?.((sid: string) => ({
          url: `${trimmedUrl}${API_ROUTES.CALLS}?limit=${limit}`,
          options: { headers: bearerAuthHeaders(sid) },
        }));
        if (!response?.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.calls)) return;
        const entries = data.calls.map((call: any) => ({
          callId: call.callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          direction: call.callerId === trimmedUserId ? 'outgoing' : 'incoming',
          status: call.status,
          endReason: call.endReason,
          createdAt: call.createdAt,
          durationSeconds: call.durationSeconds ?? null,
          isRead: call.status !== 'missed' || Boolean(call.missedReadAt),
          mediaType: mediaTypesRef.current[call.callId],
        }));
        setCallHistory(previous => entries.slice(0, MAX_CALL_HISTORY).map((entry: CallHistoryEntry) => {
          const held = previous.find(row => row.callId === entry.callId);
          return { ...entry, isRead: Boolean(entry.isRead || held?.isRead), mediaType: entry.mediaType ?? held?.mediaType };
        }));
      } catch (error) {
        logWarn('[CallHistory] fetchCallHistory failed', {
          message: errorMessage(error),
        });
      }
    }),
    [authedFetchRef, sessionIdRef, signalingUrl, userId, setCallHistory, requests],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void fetchCallHistory();
    });
    return () => subscription.remove();
  }, [fetchCallHistory]);

  return {
    callHistory,
    missedCallCount,
    addToHistory,
    markMissedCallsRead,
    fetchCallHistory,
  };
}
