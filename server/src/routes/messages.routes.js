// @ts-check
'use strict';

const express = require('express');
const { isBlocked } = require('../security');
const { getSessionFromRequest } = require('../lib/auth');
const { normaliseId, normaliseOptionalString } = require('../lib/normalize');
const { deriveConversationId, clampMessageLimit } = require('../messageStore');
const {
  toCallTimelineEntry,
  listCallsBetween,
  augmentConversationsWithCalls,
  markMissedCallsRead,
  mergeTimeline,
} = require('../domain/callTimeline');
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
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Text-chat history endpoints.
 *
 * @typedef {import('../stores/contracts').MessageRecord} MessageRecord
 * @typedef {{
 *   conversationId: string,
 *   peerId: string,
 *   lastMessage: Record<string, any>|null,
 *   unreadCount: number,
 * }} ConversationSummary
 *
 * Follows the conventions of `calls.routes.js`: the session comes from
 * `getSessionFromRequest`, a missing/expired session is a 401, and access to
 * another user's conversation is a 403.
 *
 * @param {{ state: import('../stores/contracts').ServerState, io: any }} ctx
 * @returns {import('express').Router}
 */
function createMessagesRouter({ state, io }) {
  const router = express.Router();

  /**
   * GET /messages?peerId=…&limit=…&before=…&include=calls
   *
   * Paginated history for the conversation between the authenticated user and
   * `peerId`, newest first.  `before` is an ISO timestamp cursor: pass the
   * `createdAt` of the oldest entry you already hold to fetch the next page.
   *
   * With `include=calls`, the page becomes a unified conversation timeline:
   * call records between the same two users are normalised into entries and
   * merge-sorted with the messages, and every entry carries a `type`
   * discriminator (`text` or `call`).  The parameter is opt-in, so a client
   * that omits it receives exactly the payload it always did.
   *
   * Response 200: { conversationId, messages: TimelineEntry[], limit }
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
    const includeCalls = String(req.query?.include ?? '')
      .split(',')
      .map((token) => token.trim())
      .includes('calls');

    // Only the first page is cacheable: deep pagination (`before` present) is
    // rare, unbounded in key space and the least latency-sensitive path.
    // The merged timeline is not cached at all: it mixes in live call state,
    // which is invalidated on its own schedule.
    const limit = clampMessageLimit(req.query?.limit);
    const cacheKey = before || includeCalls ? null : messagesCacheKey(conversationId, limit);

    /** @type {MessageRecord[]|undefined} */
    let messages = cacheKey ? await readCached(state, cacheKey) : undefined;
    if (messages === undefined) {
      try {
        messages = /** @type {MessageRecord[]} */ (
          await state.messageStore.listMessages({
            conversationId,
            limit,
            before: before ?? undefined,
          })
        );
      } catch (error) {
        console.error(`[messages] history lookup failed: ${errorMessage(error)}`);
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

    if (!includeCalls) {
      res.status(200).json({
        conversationId,
        messages: participantMessages,
        limit: participantMessages.length,
      });
      return;
    }

    // Calls follow the same visibility rule as `GET /conversations`: a blocked
    // (or blocking) peer contributes nothing to the timeline.
    const hidden =
      isBlocked(state.blocks, session.userId, peerId) ||
      isBlocked(state.blocks, peerId, session.userId);
    const callEntries = hidden
      ? []
      : listCallsBetween(state, session.userId, peerId)
          .filter((call) => (before ? call.createdAt < before : true))
          .map((call) => toCallTimelineEntry(call, session.userId));

    const timeline = mergeTimeline(participantMessages, callEntries, limit);

    res.status(200).json({
      conversationId,
      messages: timeline,
      limit: timeline.length,
    });
  });

  /**
   * GET /messages/search?q=…&limit=…&before=…
   *
   * Full-history text search across every conversation the authenticated user
   * participates in, newest first.  `before` is an ISO timestamp cursor with
   * the same meaning as on `GET /messages`: pass the `createdAt` of the oldest
   * result you already hold to fetch the next page.
   *
   * The scoping is enforced server-side twice: the store only ever matches
   * documents where the caller is the sender or the recipient, and the result
   * set is re-checked here — the same "defence in depth" participant filter
   * `GET /messages` applies.  Conversations with a blocked (or blocking) peer
   * are excluded, exactly as they are from `GET /conversations`.
   *
   * Each result carries enough context (`conversationId`, `peerId`,
   * `messageId`, `createdAt`) for the client to deep-link into the
   * conversation at that message.
   *
   * Response 200: { query, results: Array<message & { peerId }>, limit }
   *   where `limit` is the page size that was applied, so a client can tell a
   *   full page (there may be more) from a partial one (there is not).
   */
  router.get(API_ROUTES.MESSAGES_SEARCH, async (req, res) => {
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    // Search is the most expensive read the API serves (it fans out across
    // every conversation the user is part of), so it is rate limited per user.
    const rateCheck = state.messageSearchRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'message_search.rate_limited',
        actor: session.userId,
        outcome: 'rejected',
      });
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      });
      return;
    }

    const query = normaliseOptionalString(req.query?.q);
    if (!query) {
      res.status(400).json({ error: 'q is required' });
      return;
    }

    const limit = clampMessageLimit(req.query?.limit);
    const before = normaliseOptionalString(req.query?.before);

    /** @type {Array<MessageRecord>} */
    let matches;
    try {
      matches = await state.messageStore.searchMessages({
        userId: session.userId,
        query,
        limit,
        before: before ?? undefined,
      });
    } catch (error) {
      console.error(`[messages] search failed: ${errorMessage(error)}`);
      res.status(503).json({ error: 'message store unavailable' });
      return;
    }

    // Defence in depth: never return a message the caller did not take part in,
    // whatever the store hands back. Unlike `GET /messages`, which addresses a
    // single conversation and can fail the whole request, a search spans every
    // conversation the caller has — so an unexpected document is dropped from
    // the page (and logged) rather than taking search down for everything else.
    const participantMatches = matches.filter(
      (message) => message.senderId === session.userId || message.recipientId === session.userId
    );
    if (participantMatches.length !== matches.length) {
      console.error(
        `[messages] search dropped ${matches.length - participantMatches.length} non-participant result(s)`
      );
    }

    const results = participantMatches
      .map((message) => ({
        ...message,
        peerId: message.senderId === session.userId ? message.recipientId : message.senderId,
      }))
      .filter(
        (message) =>
          !isBlocked(state.blocks, session.userId, message.peerId) &&
          !isBlocked(state.blocks, message.peerId, session.userId)
      );

    res.status(200).json({ query, results, limit });
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
    /** @type {ConversationSummary[]|undefined} */
    let conversations = await readCached(state, cacheKey);
    if (conversations === undefined) {
      try {
        conversations = /** @type {ConversationSummary[]} */ (
          await state.messageStore.listConversations(session.userId)
        );
      } catch (error) {
        console.error(`[messages] conversation summary lookup failed: ${errorMessage(error)}`);
        res.status(503).json({ error: 'message store unavailable' });
        return;
      }
      await writeCached(state, cacheKey, conversations);
    }

    // Calls are part of the same relationship: fold them in so the preview and
    // the unread badge reflect the newest activity, message or call.
    const visible = augmentConversationsWithCalls(state, session.userId, conversations)
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
   * `peerId` as read, and acknowledge that peer's missed calls at the same
   * time — opening a conversation clears both halves of its unread state.
   * Idempotent: replaying the call once nothing is outstanding returns
   * `updated: 0`.
   *
   * When at least one message transitions to read, notifies `peerId` (the
   * original sender of those messages) over their live socket(s) with a
   * `message.read` event, so their chat UI can flip delivery ticks to "read"
   * in realtime without waiting for a refetch.
   *
   * Body: { peerId }
   * Response 200: { conversationId, updated, missedCallsRead }
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
      console.error(`[messages] markRead failed: ${errorMessage(error)}`);
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

    const missedCallsRead = markMissedCallsRead(state, session.userId, peerId);

    res.status(200).json({ conversationId, updated, missedCallsRead });
  });

  return router;
}

module.exports = { createMessagesRouter };
