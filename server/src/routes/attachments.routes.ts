import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { normaliseId } from '../lib/normalize.ts';
import { deriveConversationId } from '../messageStore.ts';
import { isBlocked } from '../security.ts';
import {
  attachmentKeyFromUrl,
  attachmentScopeFromKey,
  attachmentUrlHost,
  createAttachmentKey,
  loadR2Config,
  publiclyReadableAttachmentVariable,
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
 * `publicUrl`/`key` is meant to be an opaque reference rather than a
 * fetchable link: `GET /attachments/download` exchanges it for a short-lived,
 * participant-authorized `downloadUrl` — see that route for the authorization
 * rule. Whether the reference is *also* fetchable without that exchange is a
 * property of the bucket, not of this router (R2 public access is bucket-wide),
 * which is why a deployment without `R2_BUCKET_PRIVATE` is warned about at
 * startup. This also covers messages sent before this endpoint existed, and
 * those stored under a previous `R2_PUBLIC_BASE_URL`: their stored URL still
 * resolves (`attachmentKeyFromUrl`), so old history is not silently broken.
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
  } else {
    const publiclyReadable = publiclyReadableAttachmentVariable(config);
    if (publiclyReadable) {
      console.warn(
        `[attachments] ${publiclyReadable}=${config.publicBaseUrl} exposes the attachment bucket: ` +
          'anyone who learns an object URL can fetch it without a session, so the authorization ' +
          'performed by GET /attachments/download is advisory. R2 public access is bucket-level, ' +
          'so set R2_BUCKET_PRIVATE to a bucket with no public binding (see deploy/README.md).'
      );
    }
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
   * This is the only path this server offers for turning a stored attachment
   * reference into bytes, and it never trusts a client-declared conversation
   * id — the expected key scope is recomputed from the caller's own session
   * and the `peerId` they claim, so a caller can only ever obtain a grant for
   * a conversation it is actually part of. It is the *sole* path only when
   * the bucket has no public binding (`R2_BUCKET_PRIVATE`); otherwise the
   * startup warning applies.
   *
   * A stored `url` is resolved by its key path rather than an exact base-URL
   * match, so attachments sent under a previous `R2_PUBLIC_BASE_URL` still
   * resolve — the derived key is scope-checked exactly the same way.
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
    const key =
      typeof rawKeyParam === 'string' && rawKeyParam.trim()
        ? rawKeyParam.trim()
        : attachmentKeyFromUrl(config, req.query?.url);
    if (!key) {
      if (req.query?.url) {
        // Host only: enough to tell an unknown host from a stale base URL,
        // without putting a user's attachment URL in the logs.
        console.warn(
          '[attachments] could not resolve a stored attachment URL — ' +
            `host=${attachmentUrlHost(req.query.url) ?? 'unparseable'} ` +
            `configuredBaseUrl=${config.publicBaseUrl}`
        );
      }
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

    let presigned;
    try {
      presigned = await presignAttachmentDownload({ config, key });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[attachments] download presign failed: ${message}`);
      res.status(503).json({ error: 'could not presign download' });
      return;
    }

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
