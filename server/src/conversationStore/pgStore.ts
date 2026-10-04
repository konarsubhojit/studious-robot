import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  groupCallParticipants as callParticipantsTable,
  groupCalls as callsTable,
  groupConversationMembers as membersTable,
  groupConversations as conversationsTable,
  groupMessages as messagesTable,
} from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import { applyReaction, applyTombstone } from '../messageStore/records.ts';
import type { StoredMessage } from '../messageStore/types.ts';
import {
  ConversationStoreError,
  type ConversationMember,
  type ConversationSnapshot,
  type ConversationStore,
  type GroupCall,
  type GroupCallChange,
  type GroupCallParticipant,
} from './types.ts';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ConversationRow = typeof conversationsTable.$inferSelect;
type MemberRow = typeof membersTable.$inferSelect;
type MessageRow = typeof messagesTable.$inferSelect;
type CallRow = typeof callsTable.$inferSelect;
type CallParticipantRow = typeof callParticipantsTable.$inferSelect;
const PARTICIPANT_TRANSITIONS: Record<
  'accept' | 'decline' | 'leave',
  Partial<Record<GroupCallParticipant['status'], GroupCallParticipant['status']>>
> = {
  accept: { ringing: 'accepted' },
  decline: { ringing: 'declined' },
  leave: { ringing: 'left', accepted: 'left' },
};

function toCall(row: CallRow): GroupCall {
  return {
    callId: row.callId,
    conversationId: row.conversationId,
    initiatorId: row.initiatorId,
    mediaType: row.mediaType as GroupCall['mediaType'],
    status: row.status as GroupCall['status'],
    stateVersion: row.stateVersion,
    ringTimeoutAt: row.ringTimeoutAt ? new Date(row.ringTimeoutAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
  };
}

function toCallParticipant(row: CallParticipantRow): GroupCallParticipant {
  return {
    callId: row.callId,
    userId: row.userId,
    status: row.status as GroupCallParticipant['status'],
    invitedAt: new Date(row.invitedAt).toISOString(),
    acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
    leftAt: row.leftAt ? new Date(row.leftAt).toISOString() : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function toMember(row: MemberRow): ConversationMember {
  return {
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role as ConversationMember['role'],
    joinedAt: new Date(row.joinedAt).toISOString(),
    leftAt: row.leftAt ? new Date(row.leftAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    messageId: row.messageId,
    ...(row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}),
    conversationId: row.conversationId,
    senderId: row.senderId,
    recipientId: row.conversationId,
    body: row.body,
    type: row.type,
    attachment:
      (row.attachment as import('../../../shared/signaling/schemas.ts').AttachmentRecord | null) ??
      null,
    replyTo: row.replyTo ?? null,
    reactions: (row.reactions as Record<string, string[]>) ?? {},
    deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    deliveredTo: [],
    readAt: null,
  };
}

function toSnapshot(row: ConversationRow, members: ConversationMember[]): ConversationSnapshot {
  return {
    conversationId: row.conversationId,
    name: row.name,
    creatorId: row.creatorId,
    ownerId: members.find(({ role }) => role === 'owner')?.userId ?? row.creatorId,
    memberIds: members.filter((member) => member.leftAt === null).map(({ userId }) => userId),
    membershipVersion: row.membershipVersion,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function createPgConversationStore(db: Database): ConversationStore {
  async function membersFor(conversationId: string, tx: Tx | Database = db): Promise<ConversationMember[]> {
    const rows = await tx
      .select()
      .from(membersTable)
      .where(and(eq(membersTable.conversationId, conversationId), isNull(membersTable.leftAt)))
      .orderBy(asc(membersTable.joinedAt), asc(membersTable.userId));
    return rows.map(toMember);
  }

  async function snapshotFor(row: ConversationRow, tx: Tx | Database = db): Promise<ConversationSnapshot> {
    return toSnapshot(row, await membersFor(row.conversationId, tx));
  }

  async function requireActiveMember(
    conversationId: string,
    userId: string,
    tx: Tx
  ): Promise<ConversationMember> {
    const [row] = await tx
      .select()
      .from(membersTable)
      .where(
        and(
          eq(membersTable.conversationId, conversationId),
          eq(membersTable.userId, userId),
          isNull(membersTable.leftAt)
        )
      )
      .limit(1);
    if (!row) throw new ConversationStoreError('not_member', 'not an active member');
    return toMember(row);
  }

  async function callChange(call: CallRow, tx: Tx | Database = db): Promise<GroupCallChange> {
    const rows = await tx
      .select()
      .from(callParticipantsTable)
      .where(eq(callParticipantsTable.callId, call.callId))
      .orderBy(asc(callParticipantsTable.invitedAt), asc(callParticipantsTable.userId));
    return { call: toCall(call), participants: rows.map(toCallParticipant) };
  }

  async function expireLockedCall(
    call: CallRow,
    tx: Tx,
    now: Date
  ): Promise<GroupCallChange> {
    await tx
      .update(callParticipantsTable)
      .set({ status: 'declined', leftAt: now, updatedAt: now })
      .where(and(eq(callParticipantsTable.callId, call.callId), eq(callParticipantsTable.status, 'ringing')));
    if (call.status === 'ringing') {
      await tx
        .update(callParticipantsTable)
        .set({ status: 'left', leftAt: now, updatedAt: now })
        .where(and(eq(callParticipantsTable.callId, call.callId), eq(callParticipantsTable.status, 'accepted')));
    }
    const participants = await tx
      .select({ status: callParticipantsTable.status })
      .from(callParticipantsTable)
      .where(eq(callParticipantsTable.callId, call.callId));
    const remainsActive = call.status === 'active' &&
      participants.some(({ status }) => status === 'accepted');
    const status: GroupCall['status'] = remainsActive ? 'active' : 'ended';
    const [updatedCall] = await tx
      .update(callsTable)
      .set({
        status,
        stateVersion: call.stateVersion + 1,
        updatedAt: now,
        endedAt: status === 'ended' ? now : call.endedAt,
      })
      .where(eq(callsTable.callId, call.callId))
      .returning();
    return { ...(await callChange(updatedCall, tx)), expired: true };
  }

  return {
    async create({ name, creatorId, inviteeIds }) {
      const userIds = [creatorId, ...inviteeIds];
      if (userIds.length < 2) {
        throw new ConversationStoreError('invalid_members', 'a group must have at least two members');
      }
      if (new Set(userIds).size !== userIds.length) {
        throw new ConversationStoreError('invalid_members', 'duplicate conversation members');
      }
      if (userIds.length > 16) {
        throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
      }
      return db.transaction(async (tx) => {
        const now = new Date();
        const [conversation] = await tx
          .insert(conversationsTable)
          .values({
            name,
            creatorId,
            membershipVersion: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const insertedMembers = await tx
          .insert(membersTable)
          .values(
            userIds.map((userId) => ({
              conversationId: conversation.conversationId,
              userId,
              role: userId === creatorId ? 'owner' : 'member',
              joinedAt: now,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .returning();
        const members = insertedMembers.map(toMember);
        return {
          conversation: toSnapshot(conversation, members),
          members,
          changedMember: members.find(({ userId }) => userId === creatorId),
        };
      });
    },

    async get(conversationId) {
      const [row] = await db
        .select()
        .from(conversationsTable)
        .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
        .limit(1);
      return row ? snapshotFor(row) : null;
    },

    async getMember(conversationId, userId) {
      const [row] = await db
        .select()
        .from(membersTable)
        .where(
          and(
            eq(membersTable.conversationId, conversationId),
            eq(membersTable.userId, userId),
            isNull(membersTable.leftAt)
          )
        )
        .limit(1);
      return row ? toMember(row) : null;
    },

    listMembers: membersFor,

    async listForUser(userId) {
      const rows = await db
        .select({ conversation: conversationsTable })
        .from(conversationsTable)
        .innerJoin(
          membersTable,
          and(
            eq(membersTable.conversationId, conversationsTable.conversationId),
            eq(membersTable.userId, userId),
            isNull(membersTable.leftAt)
          )
        )
        .where(isNull(conversationsTable.deletedAt))
        .orderBy(desc(conversationsTable.updatedAt));
      return Promise.all(rows.map(({ conversation }) => snapshotFor(conversation)));
    },

    async listMessages({ conversationId, userId, limit, before, beforeMessageId }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(and(
            eq(conversationsTable.conversationId, conversationId),
            isNull(conversationsTable.deletedAt)
          ))
          .for('update')
          .limit(1);
        if (!conversation) {
          throw new ConversationStoreError('not_member', 'not an active member');
        }
        const member = await requireActiveMember(conversationId, userId, tx);
        const cursor = before
          ? beforeMessageId
            ? or(
                lt(messagesTable.createdAt, before),
                and(
                  eq(messagesTable.createdAt, before),
                  lt(messagesTable.messageId, beforeMessageId)
                )
              )
            : lt(messagesTable.createdAt, before)
          : undefined;
        const rows = await tx
          .select()
          .from(messagesTable)
          .where(cursor
            ? and(
                eq(messagesTable.conversationId, conversationId),
                gte(messagesTable.createdAt, member.joinedAt),
                cursor
              )
            : and(eq(messagesTable.conversationId, conversationId), gte(messagesTable.createdAt, member.joinedAt)))
          .orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
          .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
        return rows.map(toMessage);
      });
    },

    async updateName({ conversationId, actorId, name }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const actor = await requireActiveMember(conversationId, actorId, tx);
        if (actor.role !== 'owner' && actor.role !== 'admin') {
          throw new ConversationStoreError('forbidden', 'only owners and admins can update the group');
        }
        const [updated] = await tx
          .update(conversationsTable)
          .set({
            name,
            updatedAt: new Date(),
            membershipVersion: conversation.membershipVersion + 1,
          })
          .where(eq(conversationsTable.conversationId, conversationId))
          .returning();
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(updated, members), members };
      });
    },

    async addMembers({ conversationId, actorId, userIds }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const actor = await requireActiveMember(conversationId, actorId, tx);
        if (actor.role !== 'owner' && actor.role !== 'admin') {
          throw new ConversationStoreError('forbidden', 'only owners and admins can manage group members');
        }
        const currentMembers = await membersFor(conversationId, tx);
        const previousMemberships = userIds.length > 0
          ? await tx.select({ userId: membersTable.userId })
            .from(membersTable)
            .where(and(
              eq(membersTable.conversationId, conversationId),
              inArray(membersTable.userId, userIds)
            ))
          : [];
        if (
          userIds.length === 0 ||
          new Set(userIds).size !== userIds.length ||
          userIds.includes(actorId) ||
          previousMemberships.length > 0
        ) {
          throw new ConversationStoreError('invalid_members', 'invalid or previously joined group member');
        }
        if (currentMembers.length + userIds.length > 16) {
          throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
        }
        const now = new Date();
        await tx.insert(membersTable).values(userIds.map((userId) => ({
          conversationId,
          userId,
          role: 'member',
          joinedAt: now,
          createdAt: now,
          updatedAt: now,
        })));
        const [updated] = await tx
          .update(conversationsTable)
          .set({ updatedAt: now, membershipVersion: conversation.membershipVersion + 1 })
          .where(eq(conversationsTable.conversationId, conversationId))
          .returning();
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(updated, members), members };
      });
    },

    async removeMember({ conversationId, actorId, userId }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const actor = await requireActiveMember(conversationId, actorId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        if (actor.role !== 'owner' && actor.role !== 'admin') {
          throw new ConversationStoreError('forbidden', 'only owners and admins can manage group members');
        }
        if (member.role === 'owner' || actorId === userId) {
          throw new ConversationStoreError('forbidden', 'the owner cannot be removed');
        }
        const now = new Date();
        const [leftMemberRow] = await tx
          .update(membersTable)
          .set({ leftAt: now, updatedAt: now })
          .where(and(
            eq(membersTable.conversationId, conversationId),
            eq(membersTable.userId, userId),
            isNull(membersTable.leftAt)
          ))
          .returning();
        const [updatedConversation] = await tx
          .update(conversationsTable)
          .set({ updatedAt: now, membershipVersion: conversation.membershipVersion + 1 })
          .where(eq(conversationsTable.conversationId, conversationId))
          .returning();
        const activeCalls = await tx
          .select({ call: callsTable })
          .from(callParticipantsTable)
          .innerJoin(callsTable, eq(callsTable.callId, callParticipantsTable.callId))
          .where(and(
            eq(callsTable.conversationId, conversationId),
            eq(callParticipantsTable.userId, userId),
            or(eq(callParticipantsTable.status, 'ringing'), eq(callParticipantsTable.status, 'accepted'))
          ));
        const callChanges: GroupCallChange[] = [];
        for (const { call } of activeCalls) {
          const [updatedParticipant] = await tx
            .update(callParticipantsTable)
            .set({ status: 'left', leftAt: now, updatedAt: now })
            .where(and(
              eq(callParticipantsTable.callId, call.callId),
              eq(callParticipantsTable.userId, userId),
              or(eq(callParticipantsTable.status, 'ringing'), eq(callParticipantsTable.status, 'accepted'))
            ))
            .returning();
          if (!updatedParticipant) continue;
          const statuses = await tx
            .select({ status: callParticipantsTable.status })
            .from(callParticipantsTable)
            .where(eq(callParticipantsTable.callId, call.callId));
          const hasActiveParticipant = statuses.some(({ status }) => status === 'ringing' || status === 'accepted');
          const [updatedCall] = await tx
            .update(callsTable)
            .set({
              status: hasActiveParticipant ? call.status : 'ended',
              stateVersion: call.stateVersion + 1,
              updatedAt: now,
              endedAt: hasActiveParticipant ? call.endedAt : now,
            })
            .where(eq(callsTable.callId, call.callId))
            .returning();
          callChanges.push(await callChange(updatedCall, tx));
        }
        const members = await membersFor(conversationId, tx);
        return {
          conversation: toSnapshot(updatedConversation, members),
          members,
          changedMember: toMember(leftMemberRow),
          callChanges,
        };
      });
    },

    async leave({ conversationId, userId }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const member = await requireActiveMember(conversationId, userId, tx);
        const now = new Date();
        const [leftMemberRow] = await tx
          .update(membersTable)
          .set({ leftAt: now, updatedAt: now })
          .where(
            and(
              eq(membersTable.conversationId, conversationId),
              eq(membersTable.userId, userId),
              isNull(membersTable.leftAt)
            )
          )
          .returning();
        const changed = await tx
          .update(conversationsTable)
          .set({
            updatedAt: now,
            membershipVersion: conversation.membershipVersion + 1,
          })
          .where(eq(conversationsTable.conversationId, conversationId))
          .returning();
        let previousOwnerId: string | undefined;
        if (member.role === 'owner') {
          previousOwnerId = userId;
          const [nextOwner] = await tx
            .select()
            .from(membersTable)
            .where(and(eq(membersTable.conversationId, conversationId), isNull(membersTable.leftAt)))
            .orderBy(asc(membersTable.joinedAt), asc(membersTable.userId))
            .limit(1);
          if (nextOwner) {
            await tx
              .update(membersTable)
              .set({ role: 'owner', updatedAt: now })
              .where(and(eq(membersTable.conversationId, conversationId), eq(membersTable.userId, nextOwner.userId)));
          } else {
            await tx
              .update(conversationsTable)
              .set({ deletedAt: now })
              .where(eq(conversationsTable.conversationId, conversationId));
            changed[0].deletedAt = now;
          }
        }
        const callRows = await tx
          .select({ call: callsTable, participant: callParticipantsTable })
          .from(callParticipantsTable)
          .innerJoin(callsTable, eq(callsTable.callId, callParticipantsTable.callId))
          .where(and(
            eq(callsTable.conversationId, conversationId),
            eq(callParticipantsTable.userId, userId),
            or(
              eq(callParticipantsTable.status, 'ringing'),
              eq(callParticipantsTable.status, 'accepted')
            )
          ))
          .orderBy(asc(callsTable.callId));
        const callChanges: GroupCallChange[] = [];
        for (const { call } of callRows) {
          const [updatedParticipant] = await tx
            .update(callParticipantsTable)
            .set({ status: 'left', leftAt: now, updatedAt: now })
            .where(and(
              eq(callParticipantsTable.callId, call.callId),
              eq(callParticipantsTable.userId, userId),
              or(
                eq(callParticipantsTable.status, 'ringing'),
                eq(callParticipantsTable.status, 'accepted')
              )
            ))
            .returning();
          if (!updatedParticipant) continue;
          const participantRows = await tx
            .select({ status: callParticipantsTable.status })
            .from(callParticipantsTable)
            .where(eq(callParticipantsTable.callId, call.callId));
          const hasActiveParticipant = participantRows.some(({ status }) =>
            status === 'ringing' || status === 'accepted'
          );
          const [updatedCall] = await tx
            .update(callsTable)
            .set({
              status: hasActiveParticipant ? call.status : 'ended',
              stateVersion: call.stateVersion + 1,
              updatedAt: now,
              endedAt: hasActiveParticipant ? call.endedAt : now,
            })
            .where(eq(callsTable.callId, call.callId))
            .returning();
          callChanges.push(await callChange(updatedCall, tx));
        }
        const members = await membersFor(conversationId, tx);
        const result = {
          conversation: toSnapshot(changed[0], members),
          members,
          changedMember: toMember(leftMemberRow),
          callChanges,
          ...(previousOwnerId ? { previousOwnerId } : {}),
        };
        return result;
      });
    },

    async saveMessage(message) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, message.conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        await requireActiveMember(message.conversationId, message.senderId, tx);
        const members = await membersFor(message.conversationId, tx);
        const [inserted] = await tx
          .insert(messagesTable)
          .values({
            conversationId: message.conversationId,
            messageId: message.messageId,
            clientMessageId: message.clientMessageId ?? null,
            senderId: message.senderId,
            body: message.body,
            type: message.type ?? 'text',
            attachment: message.attachment ?? null,
            replyTo: message.replyTo ?? null,
            reactions: message.reactions ?? {},
            deletedAt: message.deletedAt ?? null,
            createdAt: message.createdAt,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return { message: toMessage(inserted), recipients: members.map(({ userId }) => userId), inserted: true };
        }
        const [existing] = await tx
          .select()
          .from(messagesTable)
          .where(message.clientMessageId
            ? and(eq(messagesTable.senderId, message.senderId), eq(messagesTable.clientMessageId, message.clientMessageId))
            : and(
              eq(messagesTable.conversationId, message.conversationId),
              eq(messagesTable.messageId, message.messageId)
            )
          )
          .limit(1);
        return existing
          ? { message: toMessage(existing), recipients: members.map(({ userId }) => userId), inserted: false }
          : null;
      });
    },

    async getMessage(conversationId, messageId) {
      const [row] = await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
        .limit(1);
      return row ? toMessage(row) : null;
    },

    async deleteMessage({ conversationId, messageId, userId }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const member = await requireActiveMember(conversationId, userId, tx);
        const [existing] = await tx
          .select()
          .from(messagesTable)
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .for('update')
          .limit(1);
        if (!existing || new Date(existing.createdAt).getTime() < Date.parse(member.joinedAt) ||
            existing.deletedAt || existing.senderId !== userId) return null;
        const tombstone = applyTombstone(toMessage(existing), new Date().toISOString());
        const [updated] = await tx
          .update(messagesTable)
          .set({ body: '', attachment: null, reactions: {}, deletedAt: tombstone.deletedAt })
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .returning();
        return { message: toMessage(updated), recipients: (await membersFor(conversationId, tx)).map(({ userId: id }) => id) };
      });
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const member = await requireActiveMember(conversationId, userId, tx);
        const [existing] = await tx
          .select()
          .from(messagesTable)
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .for('update')
          .limit(1);
        if (!existing || new Date(existing.createdAt).getTime() < Date.parse(member.joinedAt) || existing.deletedAt) return null;
        const reactions = applyReaction(
          (existing.reactions as Record<string, string[]>) ?? {},
          emoji,
          userId,
          action
        );
        const [updated] = await tx
          .update(messagesTable)
          .set({ reactions })
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .returning();
        return { message: toMessage(updated), recipients: (await membersFor(conversationId, tx)).map(({ userId: id }) => id) };
      });
    },

    async startCall({ conversationId, initiatorId, mediaType, ringTimeoutMs, excludedUserIds = [] }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        await requireActiveMember(conversationId, initiatorId, tx);
        const excluded = new Set(excludedUserIds);
        const invitees = (await membersFor(conversationId, tx))
          .filter(({ userId }) => userId !== initiatorId && !excluded.has(userId));
        if (invitees.length === 0) return null;
        const now = new Date();
        const [call] = await tx
          .insert(callsTable)
          .values({
            conversationId,
            initiatorId,
            mediaType,
            status: 'ringing',
            stateVersion: 1,
            ringTimeoutAt: new Date(now.getTime() + ringTimeoutMs),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const participants = await tx
          .insert(callParticipantsTable)
          .values([initiatorId, ...invitees.map(({ userId }) => userId)].map((userId) => ({
            callId: call.callId,
            userId,
            status: userId === initiatorId ? 'accepted' : 'ringing',
            invitedAt: now,
            acceptedAt: userId === initiatorId ? now : null,
            updatedAt: now,
          })))
          .returning();
        return { call: toCall(call), participants: participants.map(toCallParticipant) };
      });
    },

    async transitionCall({
      callId,
      userId,
      action,
    }: {
      callId: string;
      userId: string;
      action: 'accept' | 'decline' | 'leave';
    }) {
      return db.transaction(async (tx) => {
      const [callRef] = await tx
        .select({ conversationId: callsTable.conversationId })
          .from(callsTable)
          .where(eq(callsTable.callId, callId))
        .limit(1);
      if (!callRef) return null;
      const [conversation] = await tx
        .select({ conversationId: conversationsTable.conversationId })
        .from(conversationsTable)
        .where(and(
          eq(conversationsTable.conversationId, callRef.conversationId),
          isNull(conversationsTable.deletedAt)
        ))
        .for('update')
        .limit(1);
      if (!conversation) return null;
      const [call] = await tx
        .select()
        .from(callsTable)
        .where(eq(callsTable.callId, callId))
        .for('update')
        .limit(1);
      if (!call || call.status === 'ended') return null;
      await requireActiveMember(call.conversationId, userId, tx);
        const [participant] = await tx
          .select()
          .from(callParticipantsTable)
          .where(and(eq(callParticipantsTable.callId, callId), eq(callParticipantsTable.userId, userId)))
          .for('update')
          .limit(1);
        if (!participant) return null;

        const now = new Date();
        if (
          participant.status === 'ringing' &&
          call.ringTimeoutAt &&
          call.ringTimeoutAt.getTime() <= now.getTime()
        ) {
          return expireLockedCall(call, tx, now);
        }
        const nextStatus =
          PARTICIPANT_TRANSITIONS[action][participant.status as GroupCallParticipant['status']] ?? null;
        if (!nextStatus) return callChange(call, tx);

        await tx
          .update(callParticipantsTable)
          .set({
            status: nextStatus,
            acceptedAt: nextStatus === 'accepted' ? now : participant.acceptedAt,
            leftAt: nextStatus === 'declined' || nextStatus === 'left' ? now : participant.leftAt,
            updatedAt: now,
          })
          .where(and(eq(callParticipantsTable.callId, callId), eq(callParticipantsTable.userId, userId)));
        const participantRows = await tx
          .select()
          .from(callParticipantsTable)
          .where(eq(callParticipantsTable.callId, callId));
        const hasActiveParticipant = participantRows.some(({ status }) =>
          status === 'ringing' || status === 'accepted'
        );
        let status: GroupCall['status'] = call.status as GroupCall['status'];
        if (nextStatus === 'accepted') status = 'active';
        else if (!hasActiveParticipant) status = 'ended';
        const [updatedCall] = await tx
          .update(callsTable)
          .set({
            status,
            stateVersion: call.stateVersion + 1,
            updatedAt: now,
            endedAt: status === 'ended' ? now : call.endedAt,
          })
          .where(eq(callsTable.callId, callId))
          .returning();
        return callChange(updatedCall, tx);
      });
    },

    async expireCall(callId, nowMs = Date.now()) {
      return db.transaction(async (tx) => {
        const [callRef] = await tx
          .select({ conversationId: callsTable.conversationId })
          .from(callsTable)
          .where(eq(callsTable.callId, callId))
          .limit(1);
        if (!callRef) return null;
        await tx
          .select({ conversationId: conversationsTable.conversationId })
          .from(conversationsTable)
          .where(eq(conversationsTable.conversationId, callRef.conversationId))
          .for('update')
          .limit(1);
        const [call] = await tx
          .select()
          .from(callsTable)
          .where(eq(callsTable.callId, callId))
          .for('update')
          .limit(1);
        const now = new Date(nowMs);
        if (
          !call ||
          (call.status !== 'ringing' && call.status !== 'active') ||
          !call.ringTimeoutAt ||
          call.ringTimeoutAt.getTime() > now.getTime()
        ) return null;
        const ringing = await tx
          .select({ callId: callParticipantsTable.callId })
          .from(callParticipantsTable)
          .where(and(
            eq(callParticipantsTable.callId, callId),
            eq(callParticipantsTable.status, 'ringing')
          ))
          .limit(1);
        if (ringing.length === 0) return null;
        return expireLockedCall(call, tx, now);
      });
    },

    async listExpiredCallIds(now = Date.now()) {
      const rows = await db
        .select({ callId: callsTable.callId })
        .from(callsTable)
        .where(and(
          inArray(callsTable.status, ['ringing', 'active']),
          lte(callsTable.ringTimeoutAt, new Date(now)),
          sql`exists (
            select 1 from ${callParticipantsTable}
            where ${callParticipantsTable.callId} = ${callsTable.callId}
              and ${callParticipantsTable.status} = 'ringing'
          )`
        ))
        .limit(100);
      return rows.map(({ callId }) => callId);
    },

    async eraseUserData(userId, pseudonym) {
      return db.transaction(async (tx) => {
        const memberships = await tx
          .select()
          .from(membersTable)
          .where(eq(membersTable.userId, userId));
        const callRows = await tx
          .select({ call: callsTable })
          .from(callsTable)
          .leftJoin(callParticipantsTable, eq(callParticipantsTable.callId, callsTable.callId))
          .where(or(
            eq(callsTable.initiatorId, userId),
            eq(callParticipantsTable.userId, userId)
          ));
        const conversationIds = new Set([
          ...memberships.map(({ conversationId }) => conversationId),
          ...callRows.map(({ call }) => call.conversationId),
        ]);
        for (const conversationId of [...conversationIds].sort()) {
          await tx
            .select({ conversationId: conversationsTable.conversationId })
            .from(conversationsTable)
            .where(eq(conversationsTable.conversationId, conversationId))
            .for('update')
            .limit(1);
        }

        const now = new Date();
        const ownerMemberships = memberships.filter(
          (member) => member.role === 'owner' && member.leftAt === null
        );
        for (const member of ownerMemberships) {
          const [replacement] = await tx
            .select()
            .from(membersTable)
            .where(and(
              eq(membersTable.conversationId, member.conversationId),
              isNull(membersTable.leftAt),
              ne(membersTable.userId, userId)
            ))
            .orderBy(asc(membersTable.joinedAt), asc(membersTable.userId))
            .limit(1);
          if (replacement) {
            await tx
              .update(membersTable)
              .set({ role: 'owner', updatedAt: now })
              .where(and(
                eq(membersTable.conversationId, member.conversationId),
                eq(membersTable.userId, replacement.userId)
              ));
          } else {
            await tx
              .update(conversationsTable)
              .set({ deletedAt: now })
              .where(eq(conversationsTable.conversationId, member.conversationId));
          }
        }
        for (const conversationId of memberships.map(({ conversationId }) => conversationId)) {
          await tx
            .update(conversationsTable)
            .set({
              updatedAt: now,
              membershipVersion: sql`${conversationsTable.membershipVersion} + 1`,
            })
            .where(eq(conversationsTable.conversationId, conversationId));
        }
        await tx
          .update(membersTable)
          .set({
            userId: pseudonym,
            role: 'member',
            leftAt: sql`coalesce(${membersTable.leftAt}, ${now})`,
            updatedAt: now,
          })
          .where(eq(membersTable.userId, userId));

        const affectedCallIds = [...new Set(callRows.map(({ call }) => call.callId))];
        await tx
          .update(callParticipantsTable)
          .set({
            status: 'left',
            leftAt: now,
            updatedAt: now,
            userId: pseudonym,
          })
          .where(and(
            eq(callParticipantsTable.userId, userId),
            or(
              eq(callParticipantsTable.status, 'ringing'),
              eq(callParticipantsTable.status, 'accepted')
            )
          ));
        await tx
          .update(callParticipantsTable)
          .set({ userId: pseudonym })
          .where(eq(callParticipantsTable.userId, userId));
        for (const callId of affectedCallIds) {
          const [call] = await tx
            .select()
            .from(callsTable)
            .where(eq(callsTable.callId, callId))
            .for('update')
            .limit(1);
          if (!call) continue;
          const participants = await tx
            .select({ status: callParticipantsTable.status })
            .from(callParticipantsTable)
            .where(eq(callParticipantsTable.callId, callId));
          const hasActiveParticipant = participants.some(({ status }) =>
            status === 'ringing' || status === 'accepted'
          );
          await tx
            .update(callsTable)
            .set({
              initiatorId: call.initiatorId === userId ? pseudonym : call.initiatorId,
              status: !hasActiveParticipant ? 'ended' : call.status,
              stateVersion: call.stateVersion + 1,
              updatedAt: now,
              endedAt: !hasActiveParticipant ? now : call.endedAt,
            })
            .where(eq(callsTable.callId, callId));
        }
        await tx
          .update(callsTable)
          .set({ initiatorId: pseudonym })
          .where(eq(callsTable.initiatorId, userId));
        await tx
          .update(conversationsTable)
          .set({ creatorId: pseudonym })
          .where(eq(conversationsTable.creatorId, userId));

        return { conversationIds: [...conversationIds] };
      });
    },

    async eraseUserMessages(userId, pseudonym, limit) {
      const batchSize = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.senderId, userId))
          .orderBy(
            asc(messagesTable.createdAt),
            asc(messagesTable.conversationId),
            asc(messagesTable.messageId)
          )
          .limit(batchSize)
          .for('update');
        const now = new Date().toISOString();
        const attachmentUrls: string[] = [];
        const conversationIds = new Set<string>();
        let messagesTombstoned = 0;
        for (const row of rows) {
          conversationIds.add(row.conversationId);
          const update: Partial<typeof messagesTable.$inferInsert> = { senderId: pseudonym };
          if (!row.deletedAt) {
            messagesTombstoned += 1;
            const url = (row.attachment as { url?: unknown } | null)?.url;
            if (typeof url === 'string') attachmentUrls.push(url);
            update.body = '';
            update.attachment = null;
            update.reactions = {};
            update.deletedAt = now;
          }
          await tx
            .update(messagesTable)
            .set(update)
            .where(and(
              eq(messagesTable.conversationId, row.conversationId),
              eq(messagesTable.messageId, row.messageId)
            ));
        }
        return {
          attachmentUrls,
          conversationIds: [...conversationIds],
          messagesTombstoned,
          messagesProcessed: rows.length,
        };
      });
    },
  };
}

export { createPgConversationStore };
