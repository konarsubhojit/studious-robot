'use strict';

const express = require('express');
const { API_ROUTES } = require('../../../shared');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId } = require('../lib/normalize');
const { deriveConversationId } = require('../messageStore');
const {
  createAttachmentKey,
  loadR2Config,
  presignAttachmentUpload,
  validateAttachmentRequest,
} = require('../attachments');

/**
 * Attachment upload endpoint.
 *
 * `POST /attachments/presign` hands an authenticated client a short-lived,
 * size- and MIME-bound upload URL for Cloudflare R2, plus the public URL the
 * resulting object will be served from (always under the shared `/chatblobs`
 * prefix). The client uploads directly to storage and then references
 * `publicUrl` from a `message.send`, so no binary ever travels through the
 * signaling server.
 *
 * @param {{ state: object, env?: Record<string, string|undefined> }} ctx
 * @returns {import('express').Router}
 */
function createAttachmentsRouter({ state, env = process.env }) {
  const router = express.Router();
  const config = loadR2Config(env);

  if (!config) {
    console.log('[attachments] R2 is not configured — attachment uploads are disabled');
  }

  /**
   * POST /attachments/presign
   *
   * Body: { peerId, type: 'image'|'file'|'voice', mimeType, sizeBytes }
   * Response 200: { uploadUrl, publicUrl, expiresAt, key, headers, maxBytes }
   */
  router.post(API_ROUTES.ATTACHMENTS_PRESIGN, (req, res) => {
    res.set('Cache-Control', 'no-store');

    const session = getSessionFromRequest(req, state.sessions);
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

    const validated = validateAttachmentRequest(req.body ?? {});
    if (validated.error) {
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
      console.error(`[attachments] presign failed: ${error?.message}`);
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

  return router;
}

module.exports = { createAttachmentsRouter };
