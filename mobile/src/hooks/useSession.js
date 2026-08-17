import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { logInfo, logWarn } from '../appLogger';
import { getIdToken } from '../authService';
import { loadDeviceId } from '../settingsStorage';

/**
 * Owns the server-side session lifecycle: creating/refreshing the
 * `sessionId` token and performing authenticated requests that transparently
 * recover from a `401` by refreshing (or re-creating) the session once and
 * retrying.
 *
 * Depends only on the identity value (`userId`) rather
 * than the `useIdentity` hook itself, so the two stay decoupled and either
 * could be tested or reused independently. Extracted out of `useCallFlow` so
 * this concern stays isolated from that hook's call-lifecycle/WebRTC
 * responsibilities.
 *
 * @param {{
 *   signalingUrl: string,
 *   userId: string,
 *   updateStatus: (message: string, severity?: string) => void,
 * }} params
 */
export default function useSession({ signalingUrl, userId, updateStatus }) {
  const sessionIdRef = useRef(null);
  // Stable per-install device id, lazily loaded from disk on first session.
  const deviceIdRef = useRef(null);
  // Holds the latest authedFetch implementation so callers that only have a
  // ref (e.g. helpers declared before authedFetch exists) can issue
  // 401-recovering requests without a circular dependency.
  const authedFetchRef = useRef(null);

  const createOrGetSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;

    const trimmedUrl = signalingUrl.trim();
    // Reuse this install's device id so the server keeps a single device record
    // (and a single push registration) instead of minting a new random one on
    // every session.
    if (!deviceIdRef.current) {
      deviceIdRef.current = await loadDeviceId();
    }
    const requestBody = {
      userId: userId.trim() || undefined,
      deviceId: deviceIdRef.current,
      platform: Platform.OS,
      idToken: await getIdToken(),
    };
    const response = await fetch(`${trimmedUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      if (response.status === 409) {
        updateStatus(
          errorPayload.userId
            ? `This account is already bound to ${errorPayload.userId}.`
            : 'This username is already bound to another account.',
          'error',
        );
      }
      throw new Error(`Session creation failed (HTTP ${response.status})`);
    }

    const data = await response.json();
    sessionIdRef.current = data.sessionId;
    logInfo('[Session] Session created', {
      sessionId: data.sessionId,
      userId: data.userId,
    });
    return data.sessionId;
  }, [updateStatus, signalingUrl, userId]);

  /**
   * Refresh the current session via `POST /session/refresh`, rotating the
   * sessionId. On success the new id is stored in `sessionIdRef`; on failure the
   * stale id is cleared so the next request mints a fresh session. Never throws.
   *
   * @returns {Promise<string | null>} the new sessionId, or `null` on failure
   */
  const refreshSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const trimmedUrl = (signalingUrl ?? '').trim();
    if (!sessionId || !trimmedUrl) return null;
    try {
      const response = await fetch(`${trimmedUrl}/session/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) {
        // The session is gone (e.g. server restart with in-memory store, or TTL
        // expiry): drop it so the next authed request creates a new session.
        sessionIdRef.current = null;
        logWarn('[Session] session refresh failed', {
          status: response.status,
        });
        return null;
      }
      const data = await response.json();
      sessionIdRef.current = data.sessionId;
      logInfo('[Session] Session refreshed', { sessionId: data.sessionId });
      return data.sessionId;
    } catch (error) {
      logWarn('[Session] session refresh threw', { message: error?.message });
      return null;
    }
  }, [signalingUrl]);

  /**
   * Perform an authenticated request with automatic 401 recovery. `buildRequest`
   * receives the current sessionId and returns `{ url, options? }`. On a 401 the
   * session is refreshed (or recreated) once and the request is retried with the
   * new id. Returns the `Response` (possibly still 401), or `null` when no
   * session could be established. Never throws on refresh; fetch errors
   * propagate to the caller's existing try/catch.
   *
   * @param {(sessionId: string) => { url: string, options?: object }} buildRequest
   * @returns {Promise<Response | null>}
   */
  const authedFetch = useCallback(
    async buildRequest => {
      let sessionId = sessionIdRef.current;
      if (!sessionId) {
        sessionId = await createOrGetSession().catch(() => null);
      }
      if (!sessionId) return null;

      let request = buildRequest(sessionId);
      let response = await fetch(request.url, request.options);

      if (response.status === 401) {
        // Session expired or was invalidated server-side: refresh once and retry.
        const refreshedId = await refreshSession();
        const nextId = refreshedId || (await createOrGetSession().catch(() => null));
        if (!nextId) return response;
        request = buildRequest(nextId);
        response = await fetch(request.url, request.options);
      }

      return response;
    },
    [createOrGetSession, refreshSession],
  );

  // Expose authedFetch through a ref for helpers that only have the ref.
  useEffect(() => {
    authedFetchRef.current = authedFetch;
  }, [authedFetch]);

  return {
    sessionIdRef,
    createOrGetSession,
    refreshSession,
    authedFetch,
    authedFetchRef,
  };
}
