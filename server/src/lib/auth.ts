import { randomUUID, timingSafeEqual } from 'crypto';
import { normaliseId, normaliseOptionalString, isPlainObject } from './normalize.ts';

/** Upper bound for the client-supplied correlation id kept for logging. */
const MAX_CORRELATION_ID_LENGTH = 64;

/**
 * Width both tokens are padded to before comparison, so `timingSafeEqual`
 * (which throws on a length mismatch) can be reached without first branching
 * on length — branching on length is itself the timing leak.
 */
const TOKEN_COMPARE_BYTES = 256;

/**
 * Constant-time check of the operator debug token (`DEBUG_API_TOKEN`) that
 * guards `/metrics` and `/debug/active-calls`.
 *
 * Both buffers are padded to a fixed width before `timingSafeEqual`, so a
 * wrong-length guess costs exactly as much as a wrong-value one and the
 * configured token's length is not observable by timing. The length equality
 * is still asserted, but only *after* the constant-time compare has run.
 */
function hasOperatorToken(req: import('express').Request): boolean {
  const expected = process.env.DEBUG_API_TOKEN;
  if (!expected) return false;
  const presented = req.get('x-debug-token') ?? '';

  const expectedRaw = Buffer.from(expected);
  const presentedRaw = Buffer.from(presented);
  const expectedPadded = Buffer.alloc(TOKEN_COMPARE_BYTES);
  const presentedPadded = Buffer.alloc(TOKEN_COMPARE_BYTES);
  expectedRaw.subarray(0, TOKEN_COMPARE_BYTES).copy(expectedPadded);
  presentedRaw.subarray(0, TOKEN_COMPARE_BYTES).copy(presentedPadded);

  const equal = timingSafeEqual(expectedPadded, presentedPadded);
  return (
    equal &&
    expectedRaw.length === presentedRaw.length &&
    expectedRaw.length <= TOKEN_COMPARE_BYTES &&
    presentedRaw.length <= TOKEN_COMPARE_BYTES
  );
}

/**
 * Normalise the client-supplied per-session correlation id used to trace a
 * call across client and server logs.  Untrusted input: it is trimmed, capped
 * in length and restricted to log-safe characters.
 */
function normaliseCorrelationId(value: unknown): string | null {
  const id = normaliseId(value);
  if (!id) return null;
  const safe = id.replace(/[^A-Za-z0-9._:-]/g, '');
  return safe.length > 0 ? safe.slice(0, MAX_CORRELATION_ID_LENGTH) : null;
}

/**
 * Session/identity resolution for HTTP requests and Socket.IO handshakes.
 */

/**
 * Extract the bearer token from the HTTP Authorization header.
 */
function parseBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }

  const trimmed = header.trim();
  if (trimmed.length < 7 || trimmed.slice(0, 7).toLowerCase() !== 'bearer ') {
    return null;
  }

  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the authenticated session for an HTTP request.
 *
 * The session id is taken (in priority order) from the `Authorization` bearer
 * header, the request body, or the query string.  Returns `null` when there is
 * no matching, unexpired session.
 */
function getSessionFromRequest(req: import('express').Request, sessions: import('../stores/contracts.ts').SessionStore): import('../stores/contracts.ts').SessionRecord | null {
  const sessionId =
    normaliseId(parseBearerToken(req.headers.authorization)) ||
    normaliseId(req.body?.sessionId) ||
    normaliseId(req.query?.sessionId);

  if (!sessionId) return null;
  const session = sessions.get(sessionId) || null;
  if (!session) return null;
  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

/**
 * Resolve the identity for a connecting Socket.IO client.
 *
 * When the handshake carries a valid session id the identity is derived from
 * that session; otherwise a best-effort guest identity is minted from the
 * handshake `auth` fields (or random ids).
 *
 * When the handshake *did* present a `sessionId` but it no longer resolves to
 * a live session (e.g. the server restarted and dropped its in-memory session
 * table, or the TTL expired), the connection still succeeds but silently
 * downgrades to a guest identity. `presentedSessionId`/`sessionDowngraded`
 * let the caller detect that downgrade and tell the client, instead of the
 * client only finding out indirectly when an authenticated action (like
 * `call.initiate`) is later rejected.
 *
 *   Any Socket.IO socket; only the handshake `auth` payload is read, so tests
 *   may pass a minimal stand-in.
 */
function resolveSocketIdentity(socket: { handshake: { auth?: Record<string, any>; }; }, sessions: import('../stores/contracts.ts').SessionStore): {
    userId: string;
    deviceId: string;
    platform: string | null;
    sessionId: string | null;
    presentedSessionId: string | null;
    sessionDowngraded: boolean;
    correlationId: string | null;
} {
  const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth ?? {} : {};
  const sessionId = normaliseId(auth.sessionId);
  const session = sessionId ? sessions.get(sessionId) : null;
  const expiresAtMs = session?.expiresAt ? new Date(session.expiresAt).getTime() : null;
  const sessionValid = session && (!expiresAtMs || expiresAtMs > Date.now());
  const correlationId = normaliseCorrelationId(auth.correlationId);
  if (sessionValid) {
    return {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
      presentedSessionId: sessionId,
      sessionDowngraded: false,
      correlationId,
    };
  }

  return {
    userId: normaliseId(auth.userId) || `guest-${randomUUID()}`,
    deviceId: normaliseId(auth.deviceId) || `device-${randomUUID()}`,
    platform: normaliseOptionalString(auth.platform),
    sessionId: null,
    presentedSessionId: sessionId,
    // A sessionId was presented but didn't resolve to a live session: this is
    // a genuine downgrade (stale/expired/server-restart), distinct from a
    // fresh connection that never had a session id to begin with.
    sessionDowngraded: Boolean(sessionId),
    correlationId,
  };
}

export {
  hasOperatorToken,
  parseBearerToken,
  normaliseCorrelationId,
  getSessionFromRequest,
  resolveSocketIdentity,
};
