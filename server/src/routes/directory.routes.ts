import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { USER_DIRECTORY_DEFAULT_LIMIT, USER_DIRECTORY_MAX_LIMIT } from '../config.ts';
import { listBlocksAsync } from '../security.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId, normaliseOptionalString } from '../lib/normalize.ts';
import { getPresenceSnapshot, hasKnownUser, listKnownUsers } from '../lib/state.ts';

/**
 * Presence lookup and the contact directory / discovery endpoints.
 */
/**
 * Whether a directory candidate matches the `?search=` term, on either their
 * username or their display name.
 *
 * @param search - Already-lowercased search term.
 */
function matchesSearch(
  state: import('../stores/contracts.ts').ServerState,
  candidateId: string,
  search: string
): boolean {
  if (candidateId.toLowerCase().includes(search)) return true;
  const displayName = state.users.get(candidateId)?.displayName ?? '';
  return displayName.toLowerCase().includes(search);
}

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
   * Each entry also carries the user's profile fields (`displayName`,
   * `avatarKey`) so a client can render a row without a second round trip per
   * user — see `PATCH /profile` for how a display name is validated.
   *
   * Query params:
   *   - `search`: case-insensitive substring filter on `userId` or `displayName`.
   *   - `userId`: exact identifier filter for resolving a known peer's profile.
   *   - `limit`:  max number of results (default 50, capped at 100).
   *
   * The authenticated user is excluded from their own directory, as are users
   * in either direction of a block relationship with the requester.
   *
   * Response 200: { users: Array<{ userId, displayName, avatarKey, status,
   * online, lastSeen }>, total }
   */
  router.get(API_ROUTES.USERS, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const search = (normaliseOptionalString(req.query?.search) || '').toLowerCase();
    const targetUserId = normaliseId(req.query?.userId);
    if (req.query?.userId !== undefined && !targetUserId) {
      res.status(400).json({ error: 'userId must be a non-empty string' });
      return;
    }
    const requestedLimit = Number(req.query?.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), USER_DIRECTORY_MAX_LIMIT)
        : USER_DIRECTORY_DEFAULT_LIMIT;

    let blockedIds: Set<string>;
    try {
      blockedIds = new Set(await listBlocksAsync(state, session.userId, true));
    } catch {
      // Shared privacy is authoritative; a stale local map cannot grant access.
      res.status(200).json({ users: [], total: 0 });
      return;
    }

    const matches = [];
    const candidates = targetUserId
      ? [targetUserId].filter(id => hasKnownUser(state, id))
      : listKnownUsers(state);
    for (const candidateId of candidates) {
      if (candidateId === session.userId) continue;
      if (search && !matchesSearch(state, candidateId, search)) continue;
      // One bidirectional snapshot preserves avatar visibility semantics
      // without issuing shared-store reads for every directory candidate.
      if (blockedIds.has(candidateId)) continue;
      matches.push(candidateId);
    }

    matches.sort((a, b) => a.localeCompare(b));

    const users = matches.slice(0, limit).map((candidateId) => {
      const snapshot = getPresenceSnapshot(state, candidateId);
      // `avatarKey` is the stable identity of the picture, not a link to it:
      // bytes come from `GET /avatar/download`, which re-checks the predicate
      // above. Returning it lets a client cache the bytes it already holds for
      // that key instead of re-presigning a link on every render.
      const profile = state.users.get(candidateId);
      return {
        userId: snapshot.userId,
        displayName: profile?.displayName ?? null,
        avatarKey: profile?.avatarKey ?? null,
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
