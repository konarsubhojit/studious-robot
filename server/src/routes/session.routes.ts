import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import type { Database } from '../../db/client.ts';
import { randomUUID } from 'node:crypto';
import { resolveIdentityClaim } from '../identity.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId, normaliseOptionalString, sanitizeForLog } from '../lib/normalize.ts';
import { addSessionToUser, upsertDevice, ensurePresenceRecord } from '../lib/state.ts';
import { persistUser, persistDevice } from '../lib/persistence.ts';

/**
 * Timestamps for a newly issued session, derived from a **single** clock read.
 *
 * `createdAt` and `expiresAt` used to call the clock independently, one
 * statement apart, so a session issued across a millisecond boundary advertised
 * a lifetime of `sessionTtlMs + 1` — the pair disagreed about when the session
 * began. On a loaded host the gap is not bounded at one millisecond; anything
 * that preempts the event loop between the two reads widens it.
 *
 * @param sessionTtlMs - Session lifetime; `0` means "never expires".
 */
function issueSessionTimestamps(sessionTtlMs: number): {
  createdAt: string;
  expiresAt: string | null;
} {
  const issuedAt = Date.now();
  return {
    createdAt: new Date(issuedAt).toISOString(),
    expiresAt: sessionTtlMs > 0 ? new Date(issuedAt + sessionTtlMs).toISOString() : null,
  };
}

/**
 * Session lifecycle: create, inspect, and rotate signaling sessions.
 *
 * @param ctx
 */
function createSessionRouter({ state, db, sessionTtlMs, verifyIdToken }: {
        state: import('../stores/contracts.ts').ServerState;
        db: Database | null;
        sessionTtlMs: number;
        verifyIdToken?: (idToken: string) => Promise<{
            authUid: string;
            email?: string | null;
            authProvider?: string | null;
        }>;
    }): import('express').Router {
  const router = express.Router();

  router.post(API_ROUTES.SESSION, async (req, res) => {
    let externalIdentity;
    try {
      externalIdentity = verifyIdToken
        ? await verifyIdToken(req.body?.idToken)
        : { authUid: `test-${normaliseId(req.body?.userId) || randomUUID()}` };
    } catch (error) {
      state.auditLog.record({
        event: 'session.authentication_failed',
        outcome: 'denied',
        details: {
          reason:
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : 'invalid_token',
        },
      });
      res.status(401).json({ error: 'invalid authentication token', code: 'invalid_token' });
      return;
    }

    const requestedUserId = normaliseId(req.body?.userId);
    const claim = resolveIdentityClaim(state.users, requestedUserId, externalIdentity);
    if (!claim.ok) {
      const userId = requestedUserId || claim.user?.userId || externalIdentity.authUid;
      state.auditLog.record({
        event: 'session.identity_conflict',
        actor: userId,
        target: userId,
        outcome: 'denied',
        details: { reason: claim.reason },
      });
      console.warn(
        `[security] session.identity_conflict userId=${sanitizeForLog(userId)} reason=${sanitizeForLog(claim.reason)}`,
      );
      res.status(409).json({
        error:
          claim.reason === 'username_required'
            ? 'username is required for a new account'
            : 'username is unavailable for this account',
        code: claim.reason,
        userId: claim.user?.userId,
      });
      return;
    }
    const userId = claim.user.userId;

    // Persist a newly claimed identity to DB so verification survives restarts.
    if (claim.claimed) {
      try {
        await persistUser(db, claim.user);
      } catch {
        state.users.delete(userId);
        res.status(503).json({ error: 'identity store unavailable' });
        return;
      }
    }

    const deviceId = normaliseId(req.body?.deviceId) || `device-${randomUUID()}`;
    const platform = normaliseOptionalString(req.body?.platform);
    const { createdAt, expiresAt } = issueSessionTimestamps(sessionTtlMs);
    const session = {
      sessionId: randomUUID(),
      userId,
      deviceId,
      platform,
      createdAt,
      expiresAt,
    };

    state.sessions.set(session.sessionId, session);
    await state.sessionState?.save(session);
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

  router.get(API_ROUTES.SESSION, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
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
  router.post(API_ROUTES.SESSION_REFRESH, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    // Invalidate the old session token.
    state.sessions.delete(session.sessionId);
    await state.sessionState?.remove(session.sessionId);
    state.userSessions.get(session.userId)?.delete(session.sessionId);

    // Issue a fresh session with a new token.
    const newSession = {
      sessionId: randomUUID(),
      userId: session.userId,
      deviceId: session.deviceId,
      platform: session.platform,
      ...issueSessionTimestamps(sessionTtlMs),
    };
    state.sessions.set(newSession.sessionId, newSession);
    await state.sessionState?.save(newSession);
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

export { createSessionRouter };
