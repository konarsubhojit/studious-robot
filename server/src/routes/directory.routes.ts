import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { USER_DIRECTORY_DEFAULT_LIMIT, USER_DIRECTORY_MAX_LIMIT } from '../config.ts';
import { isBlocked } from '../security.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId, normaliseOptionalString } from '../lib/normalize.ts';
import { getPresenceSnapshot, hasKnownUser, listKnownUsers } from '../lib/state.ts';

/**
 * Presence lookup and the contact directory / discovery endpoints.
 */
function createDirectoryRouter({ state }: { state: import('../stores/contracts.ts').ServerState; }): import('express').Router {
  const router = express.Router();

  router.get('/presence/:userId', async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    const userId = normaliseId(req.params.userId);
    if (!userId || !hasKnownUser(state, userId)) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    res.status(200).json(getPresenceSnapshot(state, userId));
  });

  /**
   * GET /users
   *
   * Contact directory / discovery.  Returns the list of known users (anyone who
   * has ever created a session, registered a device, or appeared in presence),
   * each annotated with a lightweight presence snapshot so the client can show
   * who is reachable before placing a call.
   *
   * Query params:
   *   - `search`: case-insensitive substring filter on `userId`.
   *   - `limit`:  max number of results (default 50, capped at 100).
   *
   * The authenticated user is excluded from their own directory, as are users
   * in either direction of a block relationship with the requester.
   *
   * Response 200: { users: Array<{ userId, status, online, lastSeen }>, total }
   */
  router.get(API_ROUTES.USERS, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const search = (normaliseOptionalString(req.query?.search) || '').toLowerCase();
    const requestedLimit = Number(req.query?.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), USER_DIRECTORY_MAX_LIMIT)
        : USER_DIRECTORY_DEFAULT_LIMIT;

    const matches = [];
    for (const candidateId of listKnownUsers(state)) {
      if (candidateId === session.userId) continue;
      if (search && !candidateId.toLowerCase().includes(search)) continue;
      // Hide users in either direction of a block relationship.
      if (isBlocked(state.blocks, session.userId, candidateId)) continue;
      if (isBlocked(state.blocks, candidateId, session.userId)) continue;
      matches.push(candidateId);
    }

    matches.sort((a, b) => a.localeCompare(b));

    const users = matches.slice(0, limit).map((candidateId) => {
      const snapshot = getPresenceSnapshot(state, candidateId);
      return {
        userId: snapshot.userId,
        status: snapshot.status,
        online: snapshot.online,
        lastSeen: snapshot.lastSeen,
      };
    });

    res.status(200).json({ users, total: matches.length });
  });

  return router;
}

export { createDirectoryRouter };
