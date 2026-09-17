import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId } from '../lib/normalize.ts';
import { deriveConversationId } from '../messageStore.ts';
import { isBlocked } from '../security.ts';
import {
  attachmentKeyFromUrl,
  attachmentScopeFromKey,
  createAttachmentKey,
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
 * (and, for backwards compatibility, a `publicUrl` built from it) the client
 * stores on the `message.send` that follows. The client uploads directly to
 * storage, so no binary ever travels through the signaling server.
 *
 * Object storage is **not** publicly readable: `publicUrl`/`key` is an
 * opaque reference, not a fetchable link. `GET /attachments/download`
 * exchanges it for a short-lived, participant-authorized `downloadUrl` —
 * see that route for the authorization rule. This also covers messages sent
 * before this endpoint existed: their stored `publicUrl` still resolves
 * (`attachmentKeyFromUrl`), so old history is not silently broken.
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

  /**
   * POST /attachments/presign
   *
   * Body: { peerId, type: 'image'|'file'|'voice', mimeType, sizeBytes }
   * Response 200: { conversationId, key, uploadUrl, publicUrl, expiresAt, headers }
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
   * /attachments/presign` (or, for messages sent before this endpoint
   * existed, the full legacy `publicUrl`; both resolve to the same object).
   * Response 200: { downloadUrl, expiresAt }
   *
   * Bucket reads are private: this is the only path that can turn a stored
   * attachment reference into bytes, and it never trusts a client-declared
   * conversation id — the expected key scope is recomputed from the caller's
   * own session and the `peerId` they claim, so a caller can only ever obtain
   * a grant for a conversation it is actually part of.
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

    const rawKey = req.query?.key;
    const key =
      typeof rawKey === 'string' && rawKey.trim()
        ? rawKey.trim()
        : attachmentKeyFromUrl(config, req.query?.url);
    if (!key) {
      res.status(400).json({ error: 'key must reference a managed attachment' });
      return;
    }

    const expectedScope = deriveConversationId(session.userId, peerId).replace(/:/g, '_');
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
