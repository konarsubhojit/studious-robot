'use strict';

const { randomUUID } = require('crypto');
const { normaliseId, normaliseOptionalString, isPlainObject } = require('./normalize');

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
 * @param {Map<string, object>} sessions
 * @returns {object|null}
 */
function getSessionFromRequest(req, sessions) {
  const sessionId = normaliseId(parseBearerToken(req.headers.authorization))
    || normaliseId(req.body?.sessionId)
    || normaliseId(req.query?.sessionId);

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
 * @param {import('socket.io').Socket} socket
 * @param {Map<string, object>} sessions
 * @returns {{ userId: string, deviceId: string, platform: string|null, sessionId: string|null }}
 */
function resolveSocketIdentity(socket, sessions) {
  const auth = isPlainObject(socket.handshake.auth) ? socket.handshake.auth : {};
  const sessionId = normaliseId(auth.sessionId);
  const session = sessionId ? sessions.get(sessionId) : null;
  const expiresAtMs = session?.expiresAt ? new Date(session.expiresAt).getTime() : null;
  const sessionValid = session && (!expiresAtMs || expiresAtMs > Date.now());
  if (sessionValid) {
    return {
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      sessionId: session.sessionId,
    };
  }

  return {
    userId: normaliseId(auth.userId) || `guest-${randomUUID()}`,
    deviceId: normaliseId(auth.deviceId) || `device-${randomUUID()}`,
    platform: normaliseOptionalString(auth.platform),
    sessionId: null,
  };
}

module.exports = {
  parseBearerToken,
  getSessionFromRequest,
  resolveSocketIdentity,
};
