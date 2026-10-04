import express from 'express';
import { SERVER_EVENTS, SIGNALING_VERSION } from '../../../shared/index.ts';
import { ConversationStoreError, type ConversationChange } from '../conversationStore.ts';
import { getSessionFromRequestAsync } from '../lib/auth.ts';
import { isDirectoryVisibleAsync } from '../security.ts';
import { checkGroupAdmissionRate } from '../domain/groupAdmission.ts';
import { fanoutConversationEvent } from '../domain/conversationFanout.ts';
import type { ServerState } from '../stores/contracts.ts';
import { clampMessageLimit } from '../messageStore.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nameFrom(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw new ConversationStoreError('invalid_members', 'name must contain 1–100 characters');
  }
  return value.trim();
}

function userFrom(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ConversationStoreError('invalid_members', 'userId is required');
  }
  return value.trim();
}

function storeErrorStatus(code: ConversationStoreError['code']): number {
  if (code === 'not_member' || code === 'forbidden') return 403;
  return code === 'group_full' ? 409 : 400;
}

function createGroupsRouter({ state, io }: { state: ServerState; io: import('socket.io').Server }): express.Router {
  const router = express.Router();
  type Operation = (req: express.Request, res: express.Response, userId: string, groupId: string) => Promise<void>;
  function endpoint(method: 'get' | 'post' | 'patch' | 'delete', path: string, operation: Operation) {
    router[method](path, async (req, res) => {
      try {
        const session = await getSessionFromRequestAsync(req, state);
        if (!session) { res.status(401).json({ error: 'invalid session' }); return; }
        const groupId = String(req.params.groupId ?? '');
        if (groupId && !uuid.test(groupId)) { res.status(400).json({ error: 'invalid groupId' }); return; }
        if (req.params.invitationId && !uuid.test(String(req.params.invitationId))) {
          res.status(400).json({ error: 'invalid invitationId' }); return;
        }
        await operation(req, res, session.userId, groupId);
      } catch (error) {
        if (error instanceof ConversationStoreError) {
          res.status(storeErrorStatus(error.code)).json({ error: error.message, code: error.code });
          return;
        }
        console.error(`[groups] operation failed: ${error instanceof Error ? error.message : String(error)}`);
        res.status(503).json({ error: 'group store unavailable' });
      }
    });
  }

  async function updated(result: ConversationChange | null, actorId: string): Promise<ConversationChange> {
    if (!result) throw new ConversationStoreError('not_member', 'not an active member');
    await fanoutConversationEvent(io, state, {
      conversationId: result.conversation.conversationId, eventName: SERVER_EVENTS.CONVERSATION_UPDATED,
      recipientIds: [...new Set([...result.conversation.memberIds, ...(result.changedMember ? [result.changedMember.userId] : [])])],
      payload: { version: SIGNALING_VERSION, conversation: result.conversation, updatedBy: actorId },
    });
    return result;
  }

  async function admission(res: express.Response, actorId: string, create: boolean, userIds: string[]): Promise<boolean> {
    const limited = await checkGroupAdmissionRate(state, actorId, create, userIds.length);
    if (limited) {
      const retryAfter = Math.max(1, Math.ceil((limited.resetAt - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'too many requests', retryAfter });
      return false;
    }
    for (const userId of userIds) {
      if (!(await isDirectoryVisibleAsync(state, actorId, userId))) {
        throw new ConversationStoreError('forbidden', 'blocked accounts cannot be invited');
      }
    }
    return true;
  }

  endpoint('get', '/groups', async (_req, res, userId) => {
    res.json({ groups: await state.conversationStore.listForUser(userId) });
  });
  endpoint('get', '/groups/invitations', async (_req, res, userId) => {
    res.json({ invitations: await state.conversationStore.listInvitations(userId) });
  });
  endpoint('post', '/groups', async (req, res, creatorId) => {
    const name = nameFrom(req.body?.name);
    const raw = req.body?.inviteeIds ?? [];
    if (!Array.isArray(raw) || raw.length > 15) throw new ConversationStoreError('invalid_members', 'invalid invitees');
    const inviteeIds = raw.map(userFrom);
    if (!(await admission(res, creatorId, true, inviteeIds))) return;
    const result = await updated(await state.conversationStore.create({ creatorId, name, inviteeIds }), creatorId);
    res.status(201).json({ group: result.conversation, invitations: result.invitations });
  });
  endpoint('get', '/groups/:groupId', async (_req, res, userId, groupId) => {
    res.json({ group: await state.conversationStore.get(groupId, userId) });
  });
  endpoint('post', '/groups/:groupId/invitations', async (req, res, actorId, conversationId) => {
    const userId = userFrom(req.body?.userId);
    if (!(await admission(res, actorId, false, [userId]))) return;
    const result = await updated(await state.conversationStore.addMembers({ conversationId, actorId, userIds: [userId] }), actorId);
    res.status(201).json({ invitation: result.invitations![0] });
  });
  endpoint('post', '/groups/:groupId/invitations/:invitationId/accept', async (req, res, userId, conversationId) => {
    const result = await updated(await state.conversationStore.acceptInvitation({
      conversationId, invitationId: String(req.params.invitationId), userId,
    }), userId);
    res.json({ group: result.conversation });
  });
  endpoint('delete', '/groups/:groupId/invitations/:invitationId', async (req, res, actorId, conversationId) => {
    await state.conversationStore.cancelInvitation({ conversationId, actorId, invitationId: String(req.params.invitationId) });
    res.status(204).end();
  });
  endpoint('post', '/groups/:groupId/leave', async (_req, res, userId, conversationId) => {
    res.json({ group: (await updated(await state.conversationStore.leave({ conversationId, userId }), userId)).conversation });
  });
  endpoint('delete', '/groups/:groupId/members/:userId', async (req, res, actorId, conversationId) => {
    const reason = req.body?.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
      throw new ConversationStoreError('invalid_members', 'reason must be at most 200 characters');
    }
    res.json({ group: (await updated(await state.conversationStore.removeMember({
      conversationId, actorId, userId: userFrom(req.params.userId), reason,
    }), actorId)).conversation });
  });
  endpoint('patch', '/groups/:groupId', async (req, res, actorId, conversationId) => {
    res.json({ group: (await updated(await state.conversationStore.updateName({
      conversationId, actorId, name: nameFrom(req.body?.name),
    }), actorId)).conversation });
  });
  endpoint('patch', '/groups/:groupId/members/:userId', async (req, res, actorId, conversationId) => {
    const role = req.body?.role;
    if (role !== 'admin' && role !== 'member') throw new ConversationStoreError('invalid_members', 'invalid role');
    res.json({ group: (await updated(await state.conversationStore.setRole({
      conversationId, actorId, userId: userFrom(req.params.userId), role,
    }), actorId)).conversation });
  });
  endpoint('post', '/groups/:groupId/ownership', async (req, res, actorId, conversationId) => {
    res.json({ group: (await updated(await state.conversationStore.transferOwnership({
      conversationId, actorId, userId: userFrom(req.body?.userId),
    }), actorId)).conversation });
  });
  endpoint('delete', '/groups/:groupId', async (_req, res, actorId, conversationId) => {
    await state.conversationStore.deleteGroup(conversationId, actorId);
    res.status(204).end();
  });
  endpoint('get', '/groups/:groupId/events', async (_req, res, userId, conversationId) => {
    res.json({ events: await state.conversationStore.listMembershipEvents(conversationId, userId) });
  });
  endpoint('get', '/groups/:groupId/messages/search', async (req, res, userId, conversationId) => {
    const query = req.query.q;
    if (typeof query !== 'string' || !query.trim() || query.length > 200) {
      throw new ConversationStoreError('invalid_members', 'query must contain 1–200 characters');
    }
    const limited = await state.messageSearchRateLimiter.check(userId);
    if (!limited.allowed) { res.status(429).json({ error: 'too many requests' }); return; }
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    if (before && Number.isNaN(Date.parse(before))) throw new ConversationStoreError('invalid_members', 'invalid cursor');
    res.json({ messages: await state.conversationStore.searchMessages({
      conversationId, userId, query: query.trim(), limit: clampMessageLimit(req.query.limit), before,
      beforeMessageId: typeof req.query.beforeMessageId === 'string' ? req.query.beforeMessageId : undefined,
    }) });
  });
  endpoint('get', '/groups/:groupId/messages', async (req, res, userId, conversationId) => {
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    if (before && Number.isNaN(Date.parse(before))) throw new ConversationStoreError('invalid_members', 'invalid cursor');
    const limit = clampMessageLimit(req.query.limit);
    const messages = await state.conversationStore.listMessages({ conversationId, userId, limit: limit + 1, before,
      beforeMessageId: typeof req.query.beforeMessageId === 'string' ? req.query.beforeMessageId : undefined });
    const page = messages.slice(0, limit);
    const last = page.at(-1);
    res.json({ messages: page, hasMore: messages.length > limit,
      nextCursor: messages.length > limit && last ? { before: last.createdAt, beforeMessageId: last.messageId } : null });
  });
  return router;
}

export { createGroupsRouter };
