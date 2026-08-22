// @ts-check
'use strict';

const { randomUUID } = require('crypto');
const { normaliseId, normaliseOptionalString, isPlainObject } = require('./normalize');

/** Upper bound for the client-supplied correlation id kept for logging. */
const MAX_CORRELATION_ID_LENGTH = 64;

/**
 * Normalise the client-supplied per-session correlation id used to trace a
 * call across client and server logs.  Untrusted input: it is trimmed, capped
 * in length and restricted to log-safe characters.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseCorrelationId(value) {
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
 *
 * @param {unknown} header
 * @returns {string|null}
 */
function parseBearerToken(header) {
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
 *
 * @param {import('express').Request} req
 * @param {import('../stores/contracts').SessionStore} sessions
 * @returns {import('../stores/contracts').SessionRecord|null}
 */
function getSessionFromRequest(req, sessions) {
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
 * @param {{ handshake: { auth?: Record<string, any> } }} socket
 *   Any Socket.IO socket; only the handshake `auth` payload is read, so tests
 *   may pass a minimal stand-in.
 * @param {import('../stores/contracts').SessionStore} sessions
 * @returns {{
 *   userId: string,
 *   deviceId: string,
 *   platform: string|null,
 *   sessionId: string|null,
 *   presentedSessionId: string|null,
 *   sessionDowngraded: boolean,
 *   correlationId: string|null,
 * }}
 */
function resolveSocketIdentity(socket, sessions) {
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

module.exports = {
  parseBearerToken,
  normaliseCorrelationId,
  getSessionFromRequest,
  resolveSocketIdentity,
};
