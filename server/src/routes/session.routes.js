'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');
const { resolveIdentityClaim } = require('../identity');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normaliseOptionalString } = require('../lib/normalize');
const { addSessionToUser, upsertDevice, ensurePresenceRecord } = require('../lib/state');
const { persistUser, persistDevice } = require('../lib/persistence');

/**
 * Session lifecycle: create, inspect, and rotate signaling sessions.
 *
 * @param {{ state: object, db: object|null, sessionTtlMs: number }} ctx
 * @returns {import('express').Router}
 */
function createSessionRouter({ state, db, sessionTtlMs }) {
  const router = express.Router();

  router.post('/session', async (req, res) => {
    const userId = normaliseId(req.body?.userId) || `user-${randomUUID()}`;

    // Enforce identity ownership: a userId that has been claimed with a
    // verification code can only be re-used by presenting that same code.
    const claim = await resolveIdentityClaim(state.users, userId, req.body?.verificationCode);
    if (!claim.ok) {
      state.auditLog.record({
        event: 'session.identity_conflict',
        actor: userId,
        target: userId,
        outcome: 'denied',
        details: { reason: claim.reason },
      });
      console.warn(`[security] session.identity_conflict userId=${userId} reason=${claim.reason}`);
      res.status(409).json({
        error: 'userId is claimed by a verified identity',
        code: 'identity_conflict',
      });
      return;
    }

    // Persist a newly claimed identity to DB so verification survives restarts.
    if (claim.claimed && claim.user) {
      await persistUser(db, claim.user);
    }

    const deviceId = normaliseId(req.body?.deviceId) || `device-${randomUUID()}`;
    const platform = normaliseOptionalString(req.body?.platform);
    const createdAt = new Date().toISOString();
    const session = {
      sessionId: randomUUID(),
      userId,
      deviceId,
      platform,
      createdAt,
      expiresAt: sessionTtlMs > 0 ? new Date(Date.now() + sessionTtlMs).toISOString() : null,
    };

    state.sessions.set(session.sessionId, session);
    addSessionToUser(state, session);
    const device = upsertDevice(state, {
      userId,
      deviceId,
      platform,
      sessionId: session.sessionId,
    });
    ensurePresenceRecord(state, userId);

    // Persist the device as soon as it has a session, rather than waiting for
    // POST /devices/register.  Push-token acquisition can fail or be delayed
    // (no FCM/APNs credentials on the build, permission denied, …) and without
    // this the `devices` table would stay empty, leaving no record of which
    // devices belong to a user.  Push columns are left untouched here.
    await persistDevice(db, device, 'session');

    res.status(201).json(session);
  });

  router.get('/session', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    res.status(200).json(session);
  });

  /**
   * POST /session/refresh
   *
   * Rotate the session token: the old token is immediately invalidated and a
   * fresh one (same userId / deviceId) is returned.  Useful for security-
   * conscious clients that periodically rotate their credentials.
   */
  router.post('/session/refresh', (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    // Invalidate the old session token.
    state.sessions.delete(session.sessionId);
    state.userSessions.get(session.userId)?.delete(session.sessionId);

    // Issue a fresh session with a new token.
    const newSession = {
      sessionId: randomUUID(),
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      createdAt: new Date().toISOString(),
      expiresAt: sessionTtlMs > 0 ? new Date(Date.now() + sessionTtlMs).toISOString() : null,
    };
    state.sessions.set(newSession.sessionId, newSession);
    addSessionToUser(state, newSession);
    upsertDevice(state, {
      userId: newSession.userId,
      deviceId: newSession.deviceId,
      platform: newSession.platform,
      sessionId: newSession.sessionId,
    });

    state.auditLog.record({
      event: 'session.refreshed',
      actor: session.userId,
      outcome: 'success',
      details: { deviceId: session.deviceId },
    });

    res.status(200).json(newSession);
  });

  return router;
}

module.exports = { createSessionRouter };
