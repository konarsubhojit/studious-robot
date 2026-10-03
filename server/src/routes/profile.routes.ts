import express from 'express';
import { eq } from 'drizzle-orm';
import { API_ROUTES } from '../../../shared/index.ts';
import { users as usersTable } from '../../db/schema.ts';
import { conversationsCachePrefix, invalidateCache } from '../cache.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import {
  MAX_DISPLAY_NAME_LENGTH,
  impersonatesKnownUserId,
  normaliseDisplayName,
} from '../lib/displayName.ts';
import { describeError } from '../lib/errors.ts';
import { hasOwnProp, isPlainObject, sanitizeForLog } from '../lib/normalize.ts';
import { listKnownUsers } from '../lib/state.ts';
import type { Database } from '../../db/client.ts';

type ServerState = import('../stores/contracts.ts').ServerState;
type User = import('../identity.ts').User;

/** Public shape of a profile. The owner and the directory see the same fields. */
function describeProfile(userId: string, user: User | undefined) {
  return {
    userId,
    displayName: user?.displayName ?? null,
    avatarKey: user?.avatarKey ?? null,
    updatedAt: user?.updatedAt ?? null,
  };
}

/** Human-readable rejection, paired with the audited machine-readable reason. */
const REJECTION_MESSAGES: Record<string, string> = {
  invalid_type: 'displayName must be a string or null',
  empty: 'displayName must contain at least one visible character',
  too_long: `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
  impersonates_user: 'displayName must not match another user\'s username',
};

/**
 * Drop every cached projection that could carry this user's display name.
 *
 * Conversation lists are cached per participant and, with Redis, shared across
 * instances — `deploy/README.md` §5a warns that a stale entry written on one VM
 * "is not invisible to the other for a full TTL".  {@link invalidateCache}
 * evicts locally *and* publishes the prefixes on the message bus, so the peers
 * who see this name drop their copies instead of serving the old one until the
 * TTL expires.
 *
 * Best-effort: a message-store or bus fault must not fail the profile write.
 */
async function invalidateProfileProjections(state: ServerState, userId: string): Promise<void> {
  const prefixes = new Set<string>([conversationsCachePrefix(userId)]);
  try {
    const conversations = await state.messageStore.listConversations(userId);
    for (const conversation of conversations) {
      if (conversation?.peerId) prefixes.add(conversationsCachePrefix(conversation.peerId));
    }
  } catch (error) {
    console.error(`[profile] peer lookup for cache invalidation failed: ${describeError(error)}`);
  }
  await invalidateCache(state, ...prefixes);
}

/**
 * Profile read/write (`/profile`).
 *
 * Only the display name is writable here: the username is immutable (it is the
 * identifier every other user trusts) and the avatar key is owned by the
 * attachment-upload flow.
 *
 * @param ctx
 */
function createProfileRouter({ state, db }: { state: ServerState; db: Database | null; }): import('express').Router {
  const router = express.Router();

  /**
   * GET /profile
   *
   * The caller's own profile.
   *
   * Response 200: { userId, displayName, avatarKey, updatedAt }
   */
  router.get(API_ROUTES.PROFILE, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    res.status(200).json(describeProfile(session.userId, state.users.get(session.userId)));
  });

  /**
   * PATCH /profile
   *
   * Update the caller's display name.  `displayName: null` clears it, falling
   * the UI back to the username.
   *
   * Body: { displayName: string | null }
   * Response 200: { userId, displayName, avatarKey, updatedAt }
   * Response 400: rejected by validation (see `lib/displayName.ts`)
   * Response 429: rate-limited
   */
  // lgtm[js/missing-rate-limiting] Guarded by state.profileUpdateRateLimiter at the start of this handler.
  router.patch(API_ROUTES.PROFILE, async (req, res) => {
    const session = await getSessionFromRequestAsync(req, state);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const rateCheck = await state.profileUpdateRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'profile.rate_limited',
        actor: session.userId,
        target: session.userId,
        outcome: 'rejected',
      });
      res.status(429).json({
        error: 'too many profile updates',
        retryAfter: Math.max(1, Math.ceil((rateCheck.resetAt - Date.now()) / 1000)),
      });
      return;
    }

    const body = isPlainObject(req.body) ? (req.body as Record<string, unknown>) : {};
    if (!hasOwnProp(body, 'displayName')) {
      res.status(400).json({ error: 'displayName is required' });
      return;
    }

    const rejectChange = (reason: string) => {
      state.auditLog.record({
        event: 'profile.display_name_rejected',
        actor: session.userId,
        target: session.userId,
        outcome: 'rejected',
        details: { reason },
      });
      console.warn(
        `[security] profile.display_name_rejected userId=${sanitizeForLog(session.userId)} reason=${sanitizeForLog(reason)}`,
      );
      res.status(400).json({ error: REJECTION_MESSAGES[reason] ?? 'displayName is invalid', code: reason });
    };

    const result = normaliseDisplayName(body.displayName);
    if (!result.ok) {
      rejectChange(result.reason);
      return;
    }
    const displayName = result.displayName;

    // A name that folds onto another username turns the directory into a
    // spoofing surface, so it is refused however it was spelled.
    if (
      displayName &&
      impersonatesKnownUserId(displayName, session.userId, [
        ...state.users.keys(),
        ...listKnownUsers(state),
      ])
    ) {
      rejectChange('impersonates_user');
      return;
    }

    const user = state.users.get(session.userId);
    if (!user) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    if (user.displayName === displayName) {
      res.status(200).json(describeProfile(session.userId, user));
      return;
    }

    const previous = { displayName: user.displayName, updatedAt: user.updatedAt };
    user.displayName = displayName;
    user.updatedAt = new Date().toISOString();
    try {
      // Other instances may have changed the avatar; never persist the stale
      // profile or immutable identity columns as part of a display-name edit.
      if (db) {
        await db.update(usersTable)
          .set({ displayName, updatedAt: new Date(user.updatedAt) })
          .where(eq(usersTable.userId, session.userId));
      }
    } catch {
      user.displayName = previous.displayName;
      user.updatedAt = previous.updatedAt;
      res.status(503).json({ error: 'identity store unavailable' });
      return;
    }

    state.auditLog.record({
      event: 'profile.display_name_changed',
      actor: session.userId,
      target: session.userId,
      outcome: 'success',
      details: { cleared: displayName === null, length: displayName ? [...displayName].length : 0 },
    });

    await invalidateProfileProjections(state, session.userId);

    res.status(200).json(describeProfile(session.userId, user));
  });

  return router;
}

export { createProfileRouter };
