import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId } from '../lib/normalize.ts';
import { deriveConversationId } from '../messageStore.ts';
import { isBlocked } from '../security.ts';
import {
  attachmentKeyFromReference,
  attachmentScopeFromKey,
  createAttachmentKey,
  describeR2Misconfiguration,
  loadR2Config,
  presignAttachmentDownload,
  presignAttachmentUpload,
  validateAttachmentRequest,
} from '../attachments.ts';

/**
 * Attachment upload and download-authorization endpoints.
 *
 * `POST /attachments/presign` hands an authenticated client a short-lived,
 * size- and MIME-bound upload URL for Cloudflare R2, plus the object `key`
 * and the `reference` the client stores on the `message.send` that follows.
 * The client uploads directly to storage, so no binary ever travels through
 * the signaling server.
 *
 * The stored `reference` is the object key — an opaque handle, not a
 * fetchable link. `GET /attachments/download` exchanges it for a short-lived,
 * participant-authorized `downloadUrl`; see that route for the authorization
 * rule. That rule is only a boundary while the bucket has no public binding,
 * which is why a leftover `R2_PUBLIC_BASE_URL` is reported at startup.
 *
 * @param ctx
 */
function createAttachmentsRouter({ state, env = process.env }: {
        state: import('../stores/contracts.ts').ServerState;
        env?: Record<string, string | undefined>;
    }): import('express').Router {
  const router = express.Router();
  const config = loadR2Config(env);

  if (!config) {
    console.log('[attachments] R2 is not configured — attachment uploads are disabled');
  }
  // Loud at startup, naming the variable at fault: a half-configured or
  // publicly-served bucket otherwise shows up as a per-upload 503, or not at
  // all until someone notices the bytes are world-readable.
  for (const problem of describeR2Misconfiguration(env)) {
    console.error(`[attachments] ${problem}`);
  }

  /**
   * POST /attachments/presign
   *
   * Body: { peerId, type: 'image'|'file'|'voice', mimeType, sizeBytes }
   * Response 200: { conversationId, key, uploadUrl, reference, expiresAt, headers }
   */
  router.post(API_ROUTES.ATTACHMENTS_PRESIGN, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    if (!config) {
      res.status(503).json({ error: 'attachment uploads are not configured' });
      return;
    }

    // Presigning is a write-shaped operation (it mints a credential), so it is
    // throttled with the same budget as sending a message.
    const rateCheck = state.messageSendRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'attachment_presign.rate_limited',
        actor: session.userId,
        outcome: 'rejected',
      });
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      });
      return;
    }

    const peerId = normaliseId(req.body?.peerId);
    if (!peerId || peerId === session.userId) {
      res.status(400).json({ error: 'peerId must be another user' });
      return;
    }

    // Mirror `message.send`: a blocked pair cannot exchange media either, so
    // refuse before minting an upload credential rather than after the upload.
    if (
      isBlocked(state.blocks, peerId, session.userId) ||
      isBlocked(state.blocks, session.userId, peerId)
    ) {
      res.status(403).json({ error: 'blocked' });
      return;
    }

    const validated = validateAttachmentRequest(req.body ?? {});
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }

    const conversationId = deriveConversationId(session.userId, peerId);
    let presigned;
    try {
      presigned = presignAttachmentUpload({
        config,
        key: createAttachmentKey({ conversationId, mimeType: validated.mimeType }),
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[attachments] presign failed: ${message}`);
      res.status(503).json({ error: 'could not presign upload' });
      return;
    }

    state.auditLog.record({
      event: 'attachment.presigned',
      actor: session.userId,
      target: peerId,
      outcome: 'allowed',
      details: { type: validated.type, sizeBytes: validated.sizeBytes },
    });

    res.status(200).json({ conversationId, ...presigned });
  });

  /**
   * GET /attachments/download
   *
   * Query: { peerId, key } — `key` is the object key from `POST
   * /attachments/presign`; `url` carries the same value for clients that
   * still send the stored reference under that name.
   * Response 200: { downloadUrl, expiresAt }
   *
   * This is the only path that turns a stored attachment reference into
   * bytes, and it never trusts a client-declared conversation id — the
   * expected key scope is recomputed from the caller's own session and the
   * `peerId` they claim, so a caller can only ever obtain a grant for a
   * conversation it is actually part of. It is the *only* path as long as the
   * bucket has no public binding (see `server/src/attachments.ts`).
   */
  router.get(API_ROUTES.ATTACHMENTS_DOWNLOAD, async (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = await getSessionFromRequestAsync(req, state).catch(() => null);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    if (!config) {
      res.status(503).json({ error: 'attachments are not configured' });
      return;
    }

    const rateCheck = state.attachmentDownloadRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'attachment_download.rate_limited',
        actor: session.userId,
        outcome: 'rejected',
      });
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      });
      return;
    }

    const peerId = normaliseId(req.query?.peerId);
    if (!peerId || peerId === session.userId) {
      res.status(400).json({ error: 'peerId must be another user' });
      return;
    }

    // Mirror `POST /attachments/presign` and `message.send`: a blocked pair
    // cannot exchange media, so it cannot fetch it back either.
    if (
      isBlocked(state.blocks, peerId, session.userId) ||
      isBlocked(state.blocks, session.userId, peerId)
    ) {
      res.status(403).json({ error: 'blocked' });
      return;
    }

    const rawKeyParam = req.query?.key;
    // A `key` is checked by the scope comparison below rather than here, so a
    // key outside the prefix stays the same "not your object" 403 it has
    // always been. A `url` carries the stored reference and is derived —
    // there is nothing to compare until it resolves to a key.
    const key =
      typeof rawKeyParam === 'string' && rawKeyParam.trim()
        ? rawKeyParam.trim()
        : attachmentKeyFromReference(config, req.query?.url, {
          // Host only, never the reference itself: enough to tell a leftover
          // public URL from a malformed key without logging user content.
          onUnresolved: ({ reason, host }) => {
            console.warn(
              `[attachments] could not resolve an attachment reference: ${reason} ` +
                  `(host=${host ?? 'none'})`
            );
          },
        });
    if (!key) {
      res.status(400).json({ error: 'key must reference a managed attachment' });
      return;
    }

    const expectedScope = deriveConversationId(session.userId, peerId).replace(/:/g, '_');
    // `attachmentScopeFromKey` returns `null` for a malformed/foreign key,
    // which can never equal `expectedScope` (always a non-empty string) —
    // so a bad key is rejected by the same comparison as a mismatched scope.
    if (attachmentScopeFromKey(key) !== expectedScope) {
      // Either a foreign key (a guess, or one lifted from another
      // conversation) or a `peerId` the caller is not actually talking to —
      // both are the same "not your object" outcome from the caller's side.
      state.auditLog.record({
        event: 'attachment_download.forbidden',
        actor: session.userId,
        target: peerId,
        outcome: 'rejected',
      });
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const presigned = presignAttachmentDownload({ config, key });

    state.auditLog.record({
      event: 'attachment.download_granted',
      actor: session.userId,
      target: peerId,
      outcome: 'allowed',
    });

    res.status(200).json(presigned);
  });

  return router;
}

export { createAttachmentsRouter };
