import express from 'express';
import { eq } from 'drizzle-orm';
import { API_ROUTES } from '../../../shared/index.ts';
import { users as usersTable } from '../../db/schema.ts';
import { loadR2Config } from '../attachments.ts';
import {
  avatarKeyOwner,
  createAvatarKey,
  deleteAvatarObject,
  isAvatarKeyOwnedBy,
  presignAvatarDownload,
  presignAvatarUpload,
  validateAvatarRequest,
} from '../avatars.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { describeError } from '../lib/errors.ts';
import { normaliseId } from '../lib/normalize.ts';
import { hasKnownUser } from '../lib/state.ts';
import { isDirectoryVisible } from '../security.ts';

/**
 * Avatar upload, publication and download.
 *
 * Three endpoints, because an avatar changes hands in three steps and each one
 * is a different authorisation question:
 *
 *   1. `POST /avatar/presign` — *may this caller upload an avatar?* Mints a
 *      key under the caller's own name (never one they supply) and a presigned
 *      `PUT` bound to the declared size and image MIME type.
 *   2. `PUT /avatar` — *is this key the caller's?* Publishes an uploaded key
 *      as the account's avatar and deletes the object it replaces; an upload
 *      that is never published leaves one orphan object rather than a
 *      half-changed profile.
 *   3. `GET /avatar/download` — *may this caller see that person?* The
 *      block-aware directory predicate from `GET /users`, not the
 *      conversation-scope rule chat media uses; see `src/avatars.ts`.
 *
 * `DELETE /avatar` is step 2 in reverse: clear the avatar, delete the object.
 *
 * Degradation matches attachments exactly: with R2 unconfigured every endpoint
 * answers `503` and nothing else about the deployment changes — clients fall
 * back to initials. An avatar is never a reason for the server to fail to
 * start, nor for the bucket to be made public.
 *
 * @param ctx
 */
function createAvatarRouter({ state, db = null, env = process.env }: {
  state: import('../stores/contracts.ts').ServerState;
  db?: import('../../db/client.ts').Database | null;
  env?: Record<string, string | undefined>;
}): import('express').Router {
  const router = express.Router();
  const config = loadR2Config(env);

  if (!config) {
    console.log('[avatar] R2 is not configured — avatars are disabled (initials only)');
  }
  // The startup diagnostics for a half-configured or publicly-served bucket
  // are logged once by the attachments router, which reads the same variables.

  /**
   * Answer `429` when `userId` has exhausted the budget for this kind of
   * request, recording why.
   *
   * Every avatar endpoint mints or spends a signed credential, so each one is
   * throttled: writes share the message-send budget (a replacement also issues
   * a signed `DELETE` to object storage), reads the attachment-download one.
   *
   * @returns `true` when the response has been sent and the handler must stop.
   */
  function rejectWhenRateLimited(
    userId: string,
    res: import('express').Response,
    event: string,
    limiter: import('../stores/contracts.ts').RateLimiter = state.messageSendRateLimiter
  ): boolean {
    const rateCheck = limiter.check(userId);
    if (rateCheck.allowed) return false;
    state.auditLog.record({ event: `${event}.rate_limited`, actor: userId, outcome: 'rejected' });
    res.status(429).json({
      error: 'too many requests',
      retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
    });
    return true;
  }

  /**
   * Publish `key` as `userId`'s avatar.
   *
   * The durable write happens first, and only the avatar columns are touched:
   * if it fails, the caller returns an error and the previous object is left
   * alone, so an account keeps a picture that still exists rather than a
   * reference to bytes that were deleted on its behalf.
   *
   * @returns the key that was replaced, or `null` when there was none.
   */
  async function setAvatarKey(userId: string, key: string | null): Promise<string | null> {
    const user = state.users.get(userId);
    if (!db && !user) throw new Error('avatar owner is not a claimed identity');

    const previousKey = await currentAvatarKey(userId);
    if (previousKey === key) return null;

    if (db) {
      await db
        .update(usersTable)
        .set({ avatarKey: key, updatedAt: new Date() })
        .where(eq(usersTable.userId, userId));
    }
    if (user) state.users.set(userId, { ...user, avatarKey: key, updatedAt: new Date().toISOString() });
    return previousKey;
  }

  /**
   * The avatar key currently published for `userId`.
   *
   * Read from Postgres when there is one, because `state.users` is per
   * instance: an avatar changed on the other signaling VM would otherwise be
   * served here as the key it replaced — a key whose object has already been
   * deleted. Falls back to the local copy when there is no database (or it is
   * unreachable), which is also the single-instance case where the two agree
   * by construction.
   */
  async function currentAvatarKey(userId: string): Promise<string | null> {
    if (db) {
      try {
        const rows = await db
          .select({ avatarKey: usersTable.avatarKey })
          .from(usersTable)
          .where(eq(usersTable.userId, userId))
          .limit(1);
        if (rows.length > 0) return rows[0].avatarKey ?? null;
      } catch (error) {
        console.error(`[avatar] failed to read an avatar key: ${describeError(error)}`);
      }
    }
    return state.users.get(userId)?.avatarKey ?? null;
  }

  /**
   * Remove a replaced avatar object, best effort.
   *
   * The profile is already correct by the time this runs, so a storage failure
   * must not fail the request — it leaves one unreferenced object, which is
   * logged because no bucket lifecycle rule will collect it.
   */
  async function deleteReplacedAvatar(key: string | null): Promise<void> {
    if (!key) return;
    if (!config) {
      // Reached only by `DELETE /avatar`, which clears the reference whether
      // or not storage is reachable. Nothing will collect the object later.
      console.warn('[avatar] storage is unconfigured — a replaced avatar object was left behind');
      return;
    }
    try {
      const deleted = await deleteAvatarObject({ config, key });
      if (!deleted) console.warn('[avatar] a replaced avatar object was not deleted');
    } catch (error) {
      console.error(`[avatar] failed to delete a replaced avatar: ${describeError(error)}`);
    }
  }

  /**
   * POST /avatar/presign
   *
   * Body: { mimeType, sizeBytes }
   * Response 200: { key, uploadUrl, expiresAt, headers }
   */
  router.post(API_ROUTES.AVATAR_PRESIGN, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    if (!config) {
      res.status(503).json({ error: 'avatars are not configured' });
      return;
    }

    // Presigning mints a credential, so it is throttled on the same budget as
    // the other write-shaped endpoints.
    if (rejectWhenRateLimited(session.userId, res, 'avatar_presign')) return;

    const validated = validateAvatarRequest(req.body ?? {});
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }

    let presigned;
    try {
      presigned = presignAvatarUpload({
        config,
        key: createAvatarKey({ userId: session.userId, mimeType: validated.mimeType }),
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
      });
    } catch (error) {
      console.error(`[avatar] presign failed: ${describeError(error)}`);
      res.status(503).json({ error: 'could not presign upload' });
      return;
    }

    state.auditLog.record({
      event: 'avatar.presigned',
      actor: session.userId,
      target: session.userId,
      outcome: 'allowed',
      details: { sizeBytes: validated.sizeBytes },
    });

    res.status(200).json(presigned);
  });

  /**
   * PUT /avatar
   *
   * Body: { key } — a key from `POST /avatar/presign` whose upload completed.
   * Response 200: { avatarKey }
   */
  router.put(API_ROUTES.AVATAR, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    if (!config) {
      res.status(503).json({ error: 'avatars are not configured' });
      return;
    }

    if (rejectWhenRateLimited(session.userId, res, 'avatar_update')) return;

    const key = normaliseId(req.body?.key);
    // The owner segment is recovered from the key and compared with the
    // session, so a caller can only publish an object minted under their own
    // name — a key belonging to somebody else (or a chat-media key, which has
    // no avatar owner at all) is refused before anything is written.
    if (!key || !isAvatarKeyOwnedBy(key, session.userId)) {
      res.status(400).json({ error: 'key must be an avatar key minted for this account' });
      return;
    }

    let replaced: string | null;
    try {
      replaced = await setAvatarKey(session.userId, key);
    } catch (error) {
      console.error(`[avatar] failed to publish an avatar: ${describeError(error)}`);
      res.status(503).json({ error: 'could not update the avatar' });
      return;
    }

    await deleteReplacedAvatar(replaced);

    state.auditLog.record({
      event: 'avatar.updated',
      actor: session.userId,
      target: session.userId,
      outcome: 'success',
    });

    res.status(200).json({ avatarKey: key });
  });

  /**
   * DELETE /avatar
   *
   * Clear the account's avatar and delete its object.
   * Response 200: { avatarKey: null }
   */
  router.delete(API_ROUTES.AVATAR, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    if (rejectWhenRateLimited(session.userId, res, 'avatar_update')) return;

    let removed: string | null;
    try {
      removed = await setAvatarKey(session.userId, null);
    } catch (error) {
      console.error(`[avatar] failed to remove an avatar: ${describeError(error)}`);
      res.status(503).json({ error: 'could not update the avatar' });
      return;
    }

    // With storage unconfigured the reference is still cleared: the profile is
    // this server's to fix even when the bytes are out of reach.
    await deleteReplacedAvatar(removed);

    state.auditLog.record({
      event: 'avatar.removed',
      actor: session.userId,
      target: session.userId,
      outcome: 'success',
    });

    res.status(200).json({ avatarKey: null });
  });

  /**
   * GET /avatar/download
   *
   * Query: { userId } — whose avatar to fetch; defaults to the caller's own.
   * Response 200: { userId, avatarKey, downloadUrl, expiresAt }
   *
   * The key is never taken from the caller: it is read from the owner's
   * profile, so there is no key to guess, enumerate or replay from another
   * account. What the caller supplies is only *who* they want to see, and that
   * is answered with directory visibility — the block-aware predicate
   * `GET /users` filters on — so a blocked user cannot fetch the avatar of
   * someone they can no longer see.
   */
  router.get(API_ROUTES.AVATAR_DOWNLOAD, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    if (!config) {
      res.status(503).json({ error: 'avatars are not configured' });
      return;
    }

    if (
      rejectWhenRateLimited(session.userId, res, 'avatar_download', state.attachmentDownloadRateLimiter)
    ) {
      return;
    }

    const ownerId = normaliseId(req.query?.userId) || session.userId;
    // Own avatar excepted — a block cannot hide you from yourself — every
    // other owner must be someone this caller can see in the directory.
    const visible =
      ownerId === session.userId ||
      (hasKnownUser(state, ownerId) && isDirectoryVisible(state.blocks, session.userId, ownerId));
    if (!visible) {
      state.auditLog.record({
        event: 'avatar_download.forbidden',
        actor: session.userId,
        target: ownerId,
        outcome: 'rejected',
      });
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const avatarKey = await currentAvatarKey(ownerId);
    // A stored key whose owner segment no longer matches its row is not
    // fetchable: the profile column is authoritative for *which* object, the
    // key's own shape for *whose* it is, and both must agree.
    if (!avatarKey || avatarKeyOwner(avatarKey) !== ownerId) {
      res.status(404).json({ error: 'no avatar' });
      return;
    }

    const presigned = presignAvatarDownload({ config, key: avatarKey });
    res.status(200).json({ userId: ownerId, avatarKey, ...presigned });
  });

  return router;
}

export { createAvatarRouter };
