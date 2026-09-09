import express from 'express';
import { isBlocked } from '../security.ts';
import { getSessionFromRequest } from '../lib/auth.ts';
import { normaliseId, normaliseOptionalString } from '../lib/normalize.ts';
import { deriveConversationId, clampMessageLimit } from '../messageStore.ts';
import { toCallTimelineEntry, readCallsBetween, augmentConversationsWithCalls, markMissedCallsRead, mergeTimeline } from '../domain/callTimeline.ts';
import { readCached, writeCached, writeCachedIfNotInvalidated, invalidateCache, conversationsCacheKey, conversationsCachePrefix, messagesCacheKey, messagesCachePrefix } from '../cache.ts';
import { emitToUserSockets } from '../domain/notifications.ts';
import { getPresenceSnapshot } from '../lib/state.ts';
import { SIGNALING_VERSION } from '../config.ts';
import { API_ROUTES, SERVER_EVENTS } from '../../../shared/index.ts';
import { describeError } from '../lib/errors.ts';

/**
 * Text-chat history endpoints.
 *
 * @typedef {import('../stores/contracts.ts').MessageRecord} MessageRecord
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
 */
export type MessageRecord = import('../stores/contracts.ts').MessageRecord;
export type ConversationSummary = {
  conversationId: string;
  peerId: string;
  lastMessage: Record<string, any> | null;
  unreadCount: number;
};

type TimelineCursor = {
  before: string;
  beforeType?: 'message' | 'call';
  beforeMessageId?: string;
  beforeCallId?: string;
};

type HistoryResponse = {
  conversationId: string;
  messages: Array<Record<string, any>>;
  limit: number;
  nextCursor: TimelineCursor | null;
  hasMore: boolean;
};

class HistoryHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseTimelineCursor(query: express.Request['query']): TimelineCursor | null {
  const before = normaliseOptionalString(query?.before);
  if (!before) return null;
  const beforeTypeRaw = normaliseOptionalString(query?.beforeType);
  const beforeType = beforeTypeRaw === 'call' || beforeTypeRaw === 'message'
    ? beforeTypeRaw
    : undefined;
  const beforeMessageId = normaliseOptionalString(query?.beforeMessageId ?? query?.beforeId);
  const beforeCallId = normaliseOptionalString(query?.beforeCallId ?? query?.beforeId);
  return {
    before,
    beforeType,
    beforeMessageId: beforeType === 'call' ? undefined : beforeMessageId ?? undefined,
    beforeCallId: beforeType === 'message' ? undefined : beforeCallId ?? undefined,
  };
}

function cursorForEntry(entry: Record<string, any> | undefined): TimelineCursor | null {
  if (!entry?.createdAt) return null;
  if (entry.type === 'call') {
    return { before: entry.createdAt, beforeType: 'call', beforeCallId: entry.callId };
  }
  return { before: entry.createdAt, beforeType: 'message', beforeMessageId: entry.messageId };
}

function pageResponse(
  conversationId: string,
  entries: Array<Record<string, any>>,
  limit: number,
): HistoryResponse {
  const page = entries.slice(0, limit);
  const nextCursor = entries.length > limit ? cursorForEntry(page[page.length - 1]) : null;
  return {
    conversationId,
    messages: page,
    limit: page.length,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

async function readMessagePage({
  state,
  conversationId,
  cursor,
  readLimit,
}: {
  state: import('../stores/contracts.ts').ServerState;
  conversationId: string;
  cursor: TimelineCursor | null;
  readLimit: number;
}): Promise<MessageRecord[]> {
  const cacheKey = cursor ? null : messagesCacheKey(conversationId, readLimit);
  const cacheStartedAt = Date.now();
  const cached = cacheKey ? await readCached(state, cacheKey) : undefined;
  if (cached !== undefined) return cached;
  const messages = (await state.messageStore.listMessages({
    conversationId,
    limit: readLimit,
    before: cursor?.before,
    beforeMessageId: cursor?.beforeMessageId,
    withLookahead: true,
  })) as MessageRecord[];
  if (cacheKey) {
    await writeCachedIfNotInvalidated(
      state,
      cacheKey,
      messages,
      [messagesCachePrefix(conversationId)],
      cacheStartedAt
    );
  }
  return messages;
}

async function buildHistoryResponse({
  state,
  sessionUserId,
  peerId,
  conversationId,
  cursor,
  includeCalls,
  limit,
}: {
  state: import('../stores/contracts.ts').ServerState;
  sessionUserId: string;
  peerId: string;
  conversationId: string;
  cursor: TimelineCursor | null;
  includeCalls: boolean;
  limit: number;
}): Promise<HistoryResponse> {
  const readLimit = limit + 1;
  const messages = await readMessagePage({ state, conversationId, cursor, readLimit });
  const participantMessages = messages.filter(
    (message) => message.senderId === sessionUserId || message.recipientId === sessionUserId
  );
  if (participantMessages.length !== messages.length) {
    throw new HistoryHttpError(403, 'not a participant in this conversation');
  }
  if (!includeCalls) return pageResponse(conversationId, participantMessages, limit);

  const hidden =
    isBlocked(state.blocks, sessionUserId, peerId) ||
    isBlocked(state.blocks, peerId, sessionUserId);
  const callEntries = hidden
    ? []
    : (await readCallsBetween(
        state,
        sessionUserId,
        peerId,
        cursor?.before,
        cursor?.beforeCallId,
        cursor?.beforeType === 'message',
      )).map((call) => toCallTimelineEntry(call, sessionUserId));
  return pageResponse(
    conversationId,
    mergeTimeline(participantMessages, callEntries, readLimit),
    limit,
  );
}

function createMessagesRouter({ state, io }: { state: import('../stores/contracts.ts').ServerState; io: any; }): import('express').Router {
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
    const cursor = parseTimelineCursor(req.query);
    if (cursor && Number.isNaN(Date.parse(cursor.before))) {
      res.status(400).json({ error: 'before cursor must be an ISO timestamp' });
      return;
    }
    const includeCalls = String(req.query?.include ?? '')
      .split(',')
      .map((token) => token.trim())
      .includes('calls');

    const limit = clampMessageLimit(req.query?.limit);
    try {
      res.status(200).json(await buildHistoryResponse({
        state,
        sessionUserId: session.userId,
        peerId,
        conversationId,
        cursor,
        includeCalls,
        limit,
      }));
    } catch (error) {
      if (error instanceof HistoryHttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error(`[messages] history lookup failed: ${describeError(error)}`);
      res.status(503).json({ error: 'message store unavailable' });
    }
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
    const cursor = parseTimelineCursor(req.query);
    if (cursor && Number.isNaN(Date.parse(cursor.before))) {
      res.status(400).json({ error: 'before cursor must be an ISO timestamp' });
      return;
    }

    let matches: Array<MessageRecord>;
    try {
      matches = await state.messageStore.searchMessages({
        userId: session.userId,
        query,
        limit: limit + 1,
        before: cursor?.before,
        beforeMessageId: cursor?.beforeMessageId,
        withLookahead: true,
      });
    } catch (error) {
      console.error(`[messages] search failed: ${describeError(error)}`);
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

    const resultsWithLookahead = participantMatches
      .map((message) => ({
        ...message,
        peerId: message.senderId === session.userId ? message.recipientId : message.senderId,
      }))
      .filter(
        (message) =>
          !isBlocked(state.blocks, session.userId, message.peerId) &&
          !isBlocked(state.blocks, message.peerId, session.userId)
      );
    const results = resultsWithLookahead.slice(0, limit);
    const nextCursor = resultsWithLookahead.length > limit
      ? cursorForEntry(results[results.length - 1])
      : null;

    res.status(200).json({ query, results, limit: results.length, nextCursor, hasMore: Boolean(nextCursor) });
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
    let conversations: ConversationSummary[] | undefined = await readCached(state, cacheKey);
    if (conversations === undefined) {
      try {
        conversations = (await state.messageStore.listConversations(session.userId) as ConversationSummary[]);
      } catch (error) {
        console.error(`[messages] conversation summary lookup failed: ${describeError(error)}`);
        res.status(503).json({ error: 'message store unavailable' });
        return;
      }
      await writeCached(state, cacheKey, conversations);
    }

    // Calls are part of the same relationship: fold them in so the preview and
    // the unread badge reflect the newest activity, message or call.
    const visible = (await augmentConversationsWithCalls(state, session.userId, conversations))
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
      updated = await state.messageStore.markRead(conversationId, session.userId, peerId);
    } catch (error) {
      console.error(`[messages] markRead failed: ${describeError(error)}`);
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

    const missedCallsRead = await markMissedCallsRead(state, session.userId, peerId);

    res.status(200).json({ conversationId, updated, missedCallsRead });
  });

  return router;
}

export { createMessagesRouter };
