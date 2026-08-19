'use strict';

const express = require('express');
const { isBlocked } = require('../security');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normaliseOptionalString } = require('../lib/normalize');
const { deriveConversationId, clampMessageLimit } = require('../messageStore');
const {
  readCached,
  writeCached,
  invalidateCache,
  conversationsCacheKey,
  conversationsCachePrefix,
  messagesCacheKey,
  messagesCachePrefix,
} = require('../cache');
const { emitToUserSockets } = require('../domain/notifications');
const { getPresenceSnapshot } = require('../lib/state');
const { SIGNALING_VERSION } = require('../config');
const { API_ROUTES, SERVER_EVENTS } = require('../../../shared');

/**
 * Text-chat history endpoints.
 *
 * Follows the conventions of `calls.routes.js`: the session comes from
 * `getSessionFromRequest`, a missing/expired session is a 401, and access to
 * another user's conversation is a 403.
 *
 * @param {{ state: object, io: object }} ctx
 * @returns {import('express').Router}
 */
function createMessagesRouter({ state, io }) {
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
  router.get(API_ROUTES.MESSAGES, async (req, res) => {
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

    // Only the first page is cacheable: deep pagination (`before` present) is
    // rare, unbounded in key space and the least latency-sensitive path.
    const limit = clampMessageLimit(req.query?.limit);
    const cacheKey = before ? null : messagesCacheKey(conversationId, limit);

    let messages = cacheKey ? await readCached(state, cacheKey) : undefined;
    if (messages === undefined) {
      try {
        messages = await state.messageStore.listMessages({
          conversationId,
          limit,
          before: before ?? undefined,
        });
      } catch (error) {
        console.error(`[messages] history lookup failed: ${error?.message}`);
        res.status(503).json({ error: 'message store unavailable' });
        return;
      }
      if (cacheKey) await writeCached(state, cacheKey, messages);
    }

    // Defence in depth: only ever return messages the caller took part in.
    const participantMessages = messages.filter(
      (message) => message.senderId === session.userId || message.recipientId === session.userId
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

  /**
   * GET /conversations
   *
   * Chat-list summary for the authenticated user: one entry per conversation
   * they participate in, newest-activity first, ready to render a Teams/Slack
   * style contact list without fetching each conversation's full history.
   *
   * Applies the same blocklist visibility rule as `GET /users` so a blocked
   * (or blocking) peer's conversation never appears in the list.
   *
   * Each entry's `online` flag mirrors `GET /presence/:userId`, so the chat
   * list can render a presence dot per row without an extra request.
   *
   * Response 200: { conversations: Array<{ conversationId, peerId, lastMessage, unreadCount, online }> }
   */
  router.get(API_ROUTES.CONVERSATIONS, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    // The cached value is the raw store result: the blocklist filter and the
    // presence flag below are evaluated per request so neither can go stale.
    const cacheKey = conversationsCacheKey(session.userId);
    let conversations = await readCached(state, cacheKey);
    if (conversations === undefined) {
      try {
        conversations = await state.messageStore.listConversations(session.userId);
      } catch (error) {
        console.error(`[messages] conversation summary lookup failed: ${error?.message}`);
        res.status(503).json({ error: 'message store unavailable' });
        return;
      }
      await writeCached(state, cacheKey, conversations);
    }

    const visible = conversations
      .filter(
        (conversation) =>
          !isBlocked(state.blocks, session.userId, conversation.peerId) &&
          !isBlocked(state.blocks, conversation.peerId, session.userId)
      )
      .map((conversation) => ({
        ...conversation,
        online: getPresenceSnapshot(state, conversation.peerId).online,
      }));

    res.status(200).json({ conversations: visible });
  });

  /**
   * POST /messages/read
   *
   * Mark every unread message the authenticated user has received from
   * `peerId` as read.  Idempotent: replaying the call once nothing is
   * outstanding returns `updated: 0`.
   *
   * When at least one message transitions to read, notifies `peerId` (the
   * original sender of those messages) over their live socket(s) with a
   * `message.read` event, so their chat UI can flip delivery ticks to "read"
   * in realtime without waiting for a refetch.
   *
   * Body: { peerId }
   * Response 200: { conversationId, updated }
   */
  router.post(API_ROUTES.MESSAGES_READ, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const peerId = normaliseId(req.body?.peerId);
    if (!peerId) {
      res.status(400).json({ error: 'peerId is required' });
      return;
    }
    if (peerId === session.userId) {
      res.status(400).json({ error: 'peerId must be another user' });
      return;
    }

    const conversationId = deriveConversationId(session.userId, peerId);

    let updated;
    try {
      updated = await state.messageStore.markRead(conversationId, session.userId);
    } catch (error) {
      console.error(`[messages] markRead failed: ${error?.message}`);
      res.status(503).json({ error: 'message store unavailable' });
      return;
    }

    if (updated > 0) {
      // Read receipts change both the reader's and the sender's unread counts.
      await invalidateCache(
        state,
        conversationsCachePrefix(session.userId),
        conversationsCachePrefix(peerId),
        messagesCachePrefix(conversationId)
      );
    }

    if (updated > 0 && io) {
      const readAt = new Date().toISOString();
      emitToUserSockets(io, peerId, SERVER_EVENTS.MESSAGE_READ, {
        version: SIGNALING_VERSION,
        conversationId,
        readerId: session.userId,
        readAt,
      });
    }

    res.status(200).json({ conversationId, updated });
  });

  return router;
}

module.exports = { createMessagesRouter };
