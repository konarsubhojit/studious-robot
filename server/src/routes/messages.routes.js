'use strict';

const express = require('express');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normaliseOptionalString } = require('../lib/normalize');
const { deriveConversationId } = require('../messageStore');

/**
 * Text-chat history endpoints.
 *
 * Follows the conventions of `calls.routes.js`: the session comes from
 * `getSessionFromRequest`, a missing/expired session is a 401, and access to
 * another user's conversation is a 403.
 *
 * @param {{ state: object }} ctx
 * @returns {import('express').Router}
 */
function createMessagesRouter({ state }) {
  const router = express.Router();

  /**
   * GET /messages?peerId=…&limit=…&before=…
   *
   * Paginated history for the conversation between the authenticated user and
   * `peerId`, newest first.  `before` is an ISO timestamp cursor: pass the
   * `createdAt` of the oldest message you already hold to fetch the next page.
   *
   * Response 200: { conversationId, messages: Message[], limit }
   */
  router.get('/messages', async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const peerId = normaliseId(req.query?.peerId);
    if (!peerId) {
      res.status(400).json({ error: 'peerId is required' });
      return;
    }
    if (peerId === session.userId) {
      res.status(400).json({ error: 'peerId must be another user' });
      return;
    }

    const conversationId = deriveConversationId(session.userId, peerId);
    const before = normaliseOptionalString(req.query?.before);

    let messages;
    try {
      messages = await state.messageStore.listMessages({
        conversationId,
        limit: req.query?.limit,
        before: before ?? undefined,
      });
    } catch (error) {
      console.error(`[messages] history lookup failed: ${error?.message}`);
      res.status(503).json({ error: 'message store unavailable' });
      return;
    }

    // Defence in depth: only ever return messages the caller took part in.
    const participantMessages = messages.filter(
      (message) => message.senderId === session.userId || message.recipientId === session.userId,
    );
    if (participantMessages.length !== messages.length) {
      res.status(403).json({ error: 'not a participant in this conversation' });
      return;
    }

    res.status(200).json({
      conversationId,
      messages: participantMessages,
      limit: participantMessages.length,
    });
  });

  return router;
}

module.exports = { createMessagesRouter };
