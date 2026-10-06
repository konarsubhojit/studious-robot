import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  groupCallParticipants as callParticipantsTable,
  groupCalls as callsTable,
  groupConversationMembers as membersTable,
  groupConversations as conversationsTable,
  groupMessages as messagesTable,
  groupMessageChanges as changesTable,
  groupInvitations as invitationsTable,
  groupMembershipEvents as eventsTable,
  blocks as blocksTable,
  groupAttachmentCleanup as attachmentCleanupTable,
} from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import { applyReaction, applyTombstone } from '../messageStore/records.ts';
import type { StoredMessage } from '../messageStore/types.ts';
import type { MessageChange } from '../messageStore/types.ts';
import { clampExportReadLimit } from '../messageStore/queries.ts';
import {
  ConversationStoreError,
  type ConversationMember,
  type ConversationSnapshot,
  type ConversationStore,
  type GroupCall,
  type GroupCallChange,
  type GroupCallParticipant,
} from './types.ts';
import type { GroupInvitation, GroupMembershipEvent } from './types.ts';
import { assertActiveGroupMember, assertGroupCallMembership, INVITATION_TTL_MS, requireGroupAdmin, validateInvitees } from './authorization.ts';
import { attachmentScopeFromKey } from '../attachments.ts';
import { GROUP_CALL_MESSAGE_PREFIX, MAX_GROUP_CALL_PARTICIPANTS, groupCallHistoryEntry, groupCallTimelineMessage } from '../../../shared/groupCalls.ts';

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
  accept: { ringing: 'accepted', left: 'accepted', declined: 'accepted' },
  decline: { ringing: 'declined' },
  leave: { ringing: 'left', accepted: 'left' },
};

async function assertGroupCallCapacity(tx: Tx, callId: string): Promise<void> {
  const accepted = await tx
    .select({ userId: callParticipantsTable.userId })
    .from(callParticipantsTable)
    .where(and(
      eq(callParticipantsTable.callId, callId),
      eq(callParticipantsTable.status, 'accepted'),
    ));
  if (accepted.length >= MAX_GROUP_CALL_PARTICIPANTS) {
    throw new ConversationStoreError(
      'group_call_full',
      `Group call is full; mesh calls support up to ${MAX_GROUP_CALL_PARTICIPANTS} participants`,
    );
  }
}

// ECMAScript WhiteSpace + LineTerminator, including historical stored URLs.
const JS_TRIM_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const normalizedAttachmentUrl = sql<string>`btrim(${messagesTable.attachment}->>'url', ${JS_TRIM_WHITESPACE})`;

type LifecycleMethods = Pick<ConversationStore, 'listInvitations' | 'acceptInvitation' | 'cancelInvitation' |
  'listMembershipEvents' | 'exportMemberships' | 'exportMessages' | 'setRole' | 'transferOwnership' | 'deleteGroup'>;
type LifecycleContext = {
  db: Database;
  lockedGroup: (id: string, tx: Tx) => Promise<ConversationRow>;
  requireActiveMember: (id: string, userId: string, tx: Tx) => Promise<ConversationMember>;
  membersFor: (id: string, tx?: Tx | Database) => Promise<ConversationMember[]>;
  advance: (tx: Tx, conversation: ConversationRow) => Promise<ConversationRow>;
  record: (tx: Tx, conversation: ConversationRow, event: string, actorId: string, userId?: string | null, reason?: string | null) => Promise<void>;
};

function activityTime(conversation: ConversationRow): Date {
  return new Date(Math.max(Date.now(), conversation.updatedAt.getTime() + 1));
}

function lifecycleMethods({ db, lockedGroup, requireActiveMember, membersFor, advance, record }: LifecycleContext): LifecycleMethods {
  return {
    async listInvitations(userId) {
      const rows = await db.select().from(invitationsTable).where(and(
        eq(invitationsTable.inviteeId, userId), isNull(invitationsTable.acceptedAt),
        isNull(invitationsTable.cancelledAt), sql`${invitationsTable.expiresAt} > ${new Date()}`
      )).orderBy(asc(invitationsTable.createdAt));
      return rows.map(toInvitation);
    },

    async acceptInvitation({ conversationId, invitationId, userId }) {
      return db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        const [invitation] = await tx.select().from(invitationsTable).where(and(
          eq(invitationsTable.invitationId, invitationId), eq(invitationsTable.conversationId, conversationId),
          eq(invitationsTable.inviteeId, userId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt)
        )).for('update').limit(1);
        const now = activityTime(conversation);
        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) throw new ConversationStoreError('invalid_invitation', 'invitation unavailable');
        const active = await membersFor(conversationId, tx);
        if (active.some(member => member.userId === userId)) throw new ConversationStoreError('invalid_members', 'already an active member');
        if (active.length >= 16) throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
        const [row] = await tx.insert(membersTable).values({
          conversationId, userId, role: 'member', joinedAt: now, createdAt: now, updatedAt: now
        }).returning();
        await tx.update(invitationsTable).set({ acceptedAt: now }).where(eq(invitationsTable.invitationId, invitationId));
        const updated = await advance(tx, conversation);
        await record(tx, updated, 'accepted', userId, userId);
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(updated, members), members, changedMember: toMember(row) };
      });
    },

    async cancelInvitation({ conversationId, invitationId, actorId }) {
      await db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        requireGroupAdmin(await requireActiveMember(conversationId, actorId, tx));
        const [row] = await tx.update(invitationsTable).set({ cancelledAt: new Date() }).where(and(
          eq(invitationsTable.invitationId, invitationId), eq(invitationsTable.conversationId, conversationId),
          isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt)
        )).returning();
        if (!row) throw new ConversationStoreError('invalid_invitation', 'invitation unavailable');
        await record(tx, await advance(tx, conversation), 'invitation_cancelled', actorId, row.inviteeId);
      });
    },

    async listMembershipEvents(conversationId, userId) {
      return db.transaction(async tx => {
        await lockedGroup(conversationId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        const rows = await tx.select().from(eventsTable).where(and(
          eq(eventsTable.conversationId, conversationId), gte(eventsTable.createdAt, new Date(member.joinedAt))
        )).orderBy(asc(eventsTable.membershipVersion), asc(eventsTable.createdAt), asc(eventsTable.eventId));
        return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() } as GroupMembershipEvent));
      });
    },

    async exportMemberships(userId) {
      return (await db.select().from(membersTable).where(eq(membersTable.userId, userId))
        .orderBy(asc(membersTable.joinedAt), asc(membersTable.memberId))).map(toMember);
    },

    async exportMessages({ userId, conversationId, limit, before, beforeMessageId }) {
      const cursor = before ? beforeMessageId
        ? or(lt(messagesTable.createdAt, before), and(eq(messagesTable.createdAt, before), lt(messagesTable.messageId, beforeMessageId)))
        : lt(messagesTable.createdAt, before) : undefined;
      const rows = await db.select().from(messagesTable).where(and(
        eq(messagesTable.senderId, userId), eq(messagesTable.conversationId, conversationId), cursor
      )).orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
        .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
      return rows.map(toMessage);
    },

    async setRole({ conversationId, actorId, userId, role }) {
      return db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        const actor = await requireActiveMember(conversationId, actorId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        if (actor.role !== 'owner' || member.role === 'owner') throw new ConversationStoreError('forbidden', 'only owner may change non-owner roles');
        await tx.update(membersTable).set({ role, updatedAt: new Date() }).where(eq(membersTable.memberId, member.memberId));
        const updated = await advance(tx, conversation);
        await record(tx, updated, 'role_changed', actorId, userId, role);
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(updated, members), members };
      });
    },

    async transferOwnership({ conversationId, actorId, userId }) {
      return db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        const actor = await requireActiveMember(conversationId, actorId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        if (actor.role !== 'owner' || member.role !== 'admin') throw new ConversationStoreError('forbidden', 'ownership requires an active admin');
        const now = new Date();
        await tx.update(membersTable).set({ role: 'admin', updatedAt: now }).where(eq(membersTable.memberId, actor.memberId));
        await tx.update(membersTable).set({ role: 'owner', updatedAt: now }).where(eq(membersTable.memberId, member.memberId));
        const updated = await advance(tx, conversation);
        await record(tx, updated, 'ownership_transferred', actorId, userId);
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(updated, members), members, previousOwnerId: actorId };
      });
    },

    async deleteGroup(conversationId, actorId) {
      await db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        const actor = await requireActiveMember(conversationId, actorId, tx);
        if (actor.role !== 'owner' || (await membersFor(conversationId, tx)).length !== 1) {
          throw new ConversationStoreError('forbidden', 'only owner may delete a group without other members');
        }
        const now = new Date();
        await tx.update(membersTable).set({ leftAt: now, departureActorId: actorId, departureReason: 'group_deleted', updatedAt: now })
          .where(eq(membersTable.memberId, actor.memberId));
        await tx.update(invitationsTable).set({ cancelledAt: now }).where(and(
          eq(invitationsTable.conversationId, conversationId), isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt)
        ));
        const updated = await advance(tx, conversation);
        await tx.update(conversationsTable).set({ deletedAt: now }).where(eq(conversationsTable.conversationId, conversationId));
        await record(tx, updated, 'deleted', actorId, actorId);
      });
    },
  };
}

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
    memberId: row.memberId,
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role as ConversationMember['role'],
    joinedAt: new Date(row.joinedAt).toISOString(),
    leftAt: row.leftAt ? new Date(row.leftAt).toISOString() : null,
    removedAt: row.removedAt ? new Date(row.removedAt).toISOString() : null,
    departureActorId: row.departureActorId,
    departureReason: row.departureReason,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function toInvitation(row: typeof invitationsTable.$inferSelect): GroupInvitation {
  return { ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null };
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
    deliveredTo: (row.deliveredTo as string[]) ?? [],
    readBy: (row.readBy as string[]) ?? [],
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
  async function lockedGroup(conversationId: string, tx: Tx): Promise<ConversationRow> {
    const [row] = await tx.select().from(conversationsTable)
      .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
      .for('update').limit(1);
    if (!row) throw new ConversationStoreError('not_member', 'not an active member');
    return row;
  }

  async function record(tx: Tx, conversation: ConversationRow, event: string, actorId: string, userId: string | null = null, reason: string | null = null): Promise<void> {
    await tx.insert(eventsTable).values({ conversationId: conversation.conversationId,
      membershipVersion: conversation.membershipVersion, event, actorId, userId, reason, createdAt: conversation.updatedAt });
  }

  async function advance(tx: Tx, conversation: ConversationRow): Promise<ConversationRow> {
    const [updated] = await tx.update(conversationsTable)
      .set({ updatedAt: activityTime(conversation), membershipVersion: conversation.membershipVersion + 1 })
      .where(eq(conversationsTable.conversationId, conversation.conversationId)).returning();
    return updated;
  }

  async function checkBlocks(tx: Tx, actorId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const [block] = await tx.select().from(blocksTable).where(or(
      and(eq(blocksTable.blockerId, actorId), inArray(blocksTable.blockeeId, userIds)),
      and(eq(blocksTable.blockeeId, actorId), inArray(blocksTable.blockerId, userIds))
    )).limit(1);
    if (block) throw new ConversationStoreError('forbidden', 'blocked accounts cannot be invited');
  }

  async function invite(tx: Tx, conversation: ConversationRow, actorId: string, userIds: string[]) {
    validateInvitees(actorId, userIds);
    if (!userIds.length) throw new ConversationStoreError('invalid_members', 'invitees required');
    await checkBlocks(tx, actorId, userIds);
    const active = await membersFor(conversation.conversationId, tx);
    if (active.length >= 16) throw new ConversationStoreError('group_full', 'a group can have at most 16 members');
    const now = new Date();
    await tx.update(invitationsTable).set({ cancelledAt: now }).where(and(
      eq(invitationsTable.conversationId, conversation.conversationId),
      isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt), lte(invitationsTable.expiresAt, now)
    ));
    const pending = await tx.select().from(invitationsTable).where(and(
      eq(invitationsTable.conversationId, conversation.conversationId), inArray(invitationsTable.inviteeId, userIds),
      isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt)
    ));
    if (pending.length || active.some(member => userIds.includes(member.userId))) {
      throw new ConversationStoreError('invalid_members', 'already a member or pending invitee');
    }
    const updated = await advance(tx, conversation);
    const rows = await tx.insert(invitationsTable).values(userIds.map(inviteeId => ({
      conversationId: conversation.conversationId, inviteeId, issuerId: actorId,
      membershipVersion: updated.membershipVersion, createdAt: now, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS)
    }))).returning();
    for (const userId of userIds) await record(tx, updated, 'invited', actorId, userId);
    return { conversation: updated, invitations: rows.map(toInvitation) };
  }
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

  async function collectEmptyGroups(tx: Tx, conversationIds: Iterable<string>): Promise<void> {
    for (const conversationId of [...conversationIds].sort()) {
      await tx.select().from(conversationsTable).where(eq(conversationsTable.conversationId, conversationId)).for('update');
      if ((await membersFor(conversationId, tx)).length) continue;
      // Capture former members' and concurrently erasing members' references
      // without loading an unbounded history into the worker.
      await tx.execute(sql`
        insert into ${attachmentCleanupTable} (url)
        select distinct ${normalizedAttachmentUrl} from ${messagesTable}
        where ${messagesTable.conversationId} = ${conversationId}
          and ${messagesTable.deletedAt} is null
          and jsonb_typeof(${messagesTable.attachment}->'url') = 'string'
        on conflict do nothing
      `);
      await tx.delete(conversationsTable).where(eq(conversationsTable.conversationId, conversationId));
    }
  }

  async function replaceErasedOwner(tx: Tx, member: MemberRow, userId: string, now: Date): Promise<void> {
    const [replacement] = await tx.select().from(membersTable).where(and(
      eq(membersTable.conversationId, member.conversationId), isNull(membersTable.leftAt), ne(membersTable.userId, userId)
    )).orderBy(asc(membersTable.joinedAt), asc(membersTable.userId)).limit(1);
    if (replacement) {
      await tx.update(membersTable).set({ role: 'owner', updatedAt: now }).where(eq(membersTable.memberId, replacement.memberId));
      const [conversation] = await tx.select().from(conversationsTable).where(eq(conversationsTable.conversationId, member.conversationId));
      await record(tx, conversation, 'ownership_transferred', userId, replacement.userId, 'account_erasure');
    } else {
      await tx.update(conversationsTable).set({ deletedAt: now }).where(eq(conversationsTable.conversationId, member.conversationId));
    }
  }

  async function eraseReactions(tx: Tx, conversationIds: string[], userId: string): Promise<void> {
    if (!conversationIds.length) return;
    await tx.update(messagesTable).set({
      reactions: sql`coalesce((
        select jsonb_object_agg(key, value - ${userId})
        from jsonb_each(${messagesTable.reactions})
        where jsonb_array_length(value - ${userId}) > 0
      ), '{}'::jsonb)`,
      readBy: sql`${messagesTable.readBy} - ${userId}`,
      deliveredTo: sql`${messagesTable.deliveredTo} - ${userId}`,
    }).where(and(inArray(messagesTable.conversationId, conversationIds),
      or(sql`exists (select 1 from jsonb_each(${messagesTable.reactions}) where value ? ${userId})`,
        sql`${messagesTable.readBy} ? ${userId}`, sql`${messagesTable.deliveredTo} ? ${userId}`)));
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
    return assertActiveGroupMember(row ? toMember(row) : null);
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
    ...lifecycleMethods({ db, lockedGroup, requireActiveMember, membersFor, advance, record }),
    async create({ name, creatorId, inviteeIds }) {
      validateInvitees(creatorId, inviteeIds);
      return db.transaction(async (tx) => {
        await checkBlocks(tx, creatorId, inviteeIds);
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
            [creatorId].map((userId) => ({
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
        await record(tx, conversation, 'created', creatorId, creatorId);
        const issued = inviteeIds.length ? await invite(tx, conversation, creatorId, inviteeIds) : null;
        return {
          conversation: toSnapshot(issued?.conversation ?? conversation, members),
          members,
          changedMember: members.find(({ userId }) => userId === creatorId),
          invitations: issued?.invitations ?? [],
        };
      });
    },

    async get(conversationId, userId) {
      if (userId) return db.transaction(async tx => {
        const row = await lockedGroup(conversationId, tx);
        await requireActiveMember(conversationId, userId, tx);
        return snapshotFor(row, tx);
      });
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
        .innerJoin(conversationsTable, eq(conversationsTable.conversationId, membersTable.conversationId))
        .where(
          and(
            eq(membersTable.conversationId, conversationId),
            eq(membersTable.userId, userId),
            isNull(membersTable.leftAt),
            isNull(conversationsTable.deletedAt)
          )
        )
        .limit(1);
      return row ? assertActiveGroupMember(toMember(row.group_conversation_members)) : null;
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
        const callCursor = before ? beforeMessageId
          ? or(lt(callsTable.createdAt, new Date(before)), and(eq(callsTable.createdAt, new Date(before)),
            lt(sql<string>`${GROUP_CALL_MESSAGE_PREFIX} || ${callsTable.callId}::text`, beforeMessageId)))
          : lt(callsTable.createdAt, new Date(before)) : undefined;
        const callRows = await tx.select({ call: callsTable, participant: callParticipantsTable })
          .from(callsTable).innerJoin(callParticipantsTable, and(
            eq(callParticipantsTable.callId, callsTable.callId), eq(callParticipantsTable.userId, userId)))
          .where(and(eq(callsTable.conversationId, conversationId), gte(callsTable.createdAt, new Date(member.joinedAt)), callCursor))
          .orderBy(desc(callsTable.createdAt), desc(callsTable.callId))
          .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
        return [...rows.map(toMessage), ...callRows.map(({ call, participant }) =>
          groupCallTimelineMessage(toCall(call), toCallParticipant(participant)))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.messageId.localeCompare(a.messageId))
          .slice(0, Math.min(Math.max(Math.floor(limit) || 1, 1), 101));
      });
    },

    async searchMessages({ conversationId, userId, query, limit, before, beforeMessageId, createdAtAfter }) {
      return db.transaction(async tx => {
        if (conversationId) {
          await lockedGroup(conversationId, tx);
          await requireActiveMember(conversationId, userId, tx);
        }
        const cursor = before ? beforeMessageId
          ? or(lt(messagesTable.createdAt, before), and(eq(messagesTable.createdAt, before), lt(messagesTable.messageId, beforeMessageId)))
          : lt(messagesTable.createdAt, before) : undefined;
        const rows = await tx.select({ message: messagesTable }).from(messagesTable)
          .innerJoin(membersTable, and(eq(membersTable.conversationId, messagesTable.conversationId),
            eq(membersTable.userId, userId), isNull(membersTable.leftAt), isNull(membersTable.removedAt)))
          .innerJoin(conversationsTable, and(eq(conversationsTable.conversationId, messagesTable.conversationId),
            isNull(conversationsTable.deletedAt)))
          .where(and(
          conversationId ? eq(messagesTable.conversationId, conversationId) : undefined,
          gte(messagesTable.createdAt, membersTable.joinedAt),
          createdAtAfter ? gte(messagesTable.createdAt, createdAtAfter) : undefined,
          isNull(messagesTable.deletedAt),
          sql`to_tsvector('simple', ${messagesTable.body}) @@ plainto_tsquery('simple', ${query})`, cursor
        )).orderBy(desc(messagesTable.createdAt), desc(messagesTable.messageId))
          .limit(clampExportReadLimit(limit));
        return rows.map(({ message }) => toMessage(message));
      });
    },

    async listMessageChanges({ userId, since, afterChangedAt, afterChangeId, createdAtAfter, limit }) {
      const rows = await db.select({ change: changesTable, message: messagesTable })
        .from(changesTable)
        .innerJoin(messagesTable, and(eq(messagesTable.conversationId, changesTable.conversationId),
          eq(messagesTable.messageId, changesTable.messageId)))
        .innerJoin(membersTable, and(eq(membersTable.conversationId, messagesTable.conversationId),
          eq(membersTable.userId, userId), isNull(membersTable.leftAt), isNull(membersTable.removedAt)))
        .innerJoin(conversationsTable, and(eq(conversationsTable.conversationId, messagesTable.conversationId),
          isNull(conversationsTable.deletedAt)))
        .where(and(
          gte(messagesTable.createdAt, membersTable.joinedAt),
          gt(changesTable.changedAt, since),
          createdAtAfter ? gte(messagesTable.createdAt, createdAtAfter) : undefined,
          afterChangedAt && afterChangeId ? or(gt(changesTable.changedAt, afterChangedAt),
            and(eq(changesTable.changedAt, afterChangedAt), gt(changesTable.changeId, BigInt(afterChangeId)))) : undefined
        ))
        .orderBy(asc(changesTable.changedAt), asc(changesTable.changeId))
        .limit(clampExportReadLimit(limit));
      return rows.map(({ change, message }) => ({ changeId: String(change.changeId),
        type: change.changeType as MessageChange['type'],
        changedAt: new Date(change.changedAt).toISOString(), message: toMessage(message) }));
    },

    async markRead(conversationId, userId) {
      return db.transaction(async tx => {
        const conversation = await lockedGroup(conversationId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        const updated = await tx.update(messagesTable).set({
          readBy: sql`${messagesTable.readBy} || ${JSON.stringify([userId])}::jsonb`,
          deliveredTo: sql`CASE WHEN ${messagesTable.deliveredTo} @> ${JSON.stringify([userId])}::jsonb
            THEN ${messagesTable.deliveredTo} ELSE ${messagesTable.deliveredTo} || ${JSON.stringify([userId])}::jsonb END`,
        }).where(and(eq(messagesTable.conversationId, conversationId), ne(messagesTable.senderId, userId),
          gte(messagesTable.createdAt, member.joinedAt), isNull(messagesTable.deletedAt),
          sql`NOT (${messagesTable.readBy} @> ${JSON.stringify([userId])}::jsonb)`))
          .returning({ messageId: messagesTable.messageId });
        if (updated.length) {
          const changedAt = activityTime(conversation);
          await tx.insert(changesTable).values(updated.map(({ messageId }) => ({
            conversationId, messageId, changeType: 'edited', changedAt: changedAt.toISOString(),
          })));
          await tx.update(conversationsTable).set({ updatedAt: changedAt })
            .where(eq(conversationsTable.conversationId, conversationId));
        }
        return updated.length;
      });
    },

    async markDelivered(conversationId, messageId, userId) {
      return db.transaction(async tx => {
        await lockedGroup(conversationId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        const [updated] = await tx.update(messagesTable).set({
          deliveredTo: sql`CASE WHEN ${messagesTable.deliveredTo} @> ${JSON.stringify([userId])}::jsonb
            THEN ${messagesTable.deliveredTo} ELSE ${messagesTable.deliveredTo} || ${JSON.stringify([userId])}::jsonb END`,
        }).where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId),
          gte(messagesTable.createdAt, member.joinedAt))).returning();
        return updated ? toMessage(updated) : null;
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
        requireGroupAdmin(actor);
        const [updated] = await tx
          .update(conversationsTable)
          .set({
            name,
            updatedAt: activityTime(conversation),
            membershipVersion: conversation.membershipVersion + 1,
          })
          .where(eq(conversationsTable.conversationId, conversationId))
          .returning();
        const members = await membersFor(conversationId, tx);
        await record(tx, updated, 'renamed', actorId);
        return { conversation: toSnapshot(updated, members), members };
      });
    },

    async addMembers({ conversationId, actorId, userIds }) {
      return db.transaction(async (tx) => {
        const conversation = await lockedGroup(conversationId, tx);
        const actor = await requireActiveMember(conversationId, actorId, tx);
        requireGroupAdmin(actor);
        const issued = await invite(tx, conversation, actorId, userIds);
        const members = await membersFor(conversationId, tx);
        return { conversation: toSnapshot(issued.conversation, members), members, invitations: issued.invitations };
      });
    },

    async removeMember({ conversationId, actorId, userId, reason }) {
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
        requireGroupAdmin(actor);
        if (member.role === 'owner' || actorId === userId) {
          throw new ConversationStoreError('forbidden', 'the owner cannot be removed');
        }
        const now = activityTime(conversation);
        const [leftMemberRow] = await tx
          .update(membersTable)
          .set({ leftAt: now, removedAt: now, departureActorId: actorId, departureReason: reason ?? 'removed', updatedAt: now })
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
        await record(tx, updatedConversation, 'removed', actorId, userId, reason ?? 'removed');
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
        if (member.role === 'owner') throw new ConversationStoreError('forbidden', 'transfer ownership before leaving');
        const now = activityTime(conversation);
        const [leftMemberRow] = await tx
          .update(membersTable)
          .set({ leftAt: now, departureActorId: userId, departureReason: 'left', updatedAt: now })
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
        await record(tx, changed[0], 'left', userId, userId, 'left');
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
        };
        return result;
      });
    },

    async saveMessage(message) {
      if (message.messageId.startsWith(GROUP_CALL_MESSAGE_PREFIX)) {
        throw new ConversationStoreError('forbidden', 'group call timeline IDs are reserved');
      }
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
          .from(conversationsTable)
          .where(and(eq(conversationsTable.conversationId, message.conversationId), isNull(conversationsTable.deletedAt)))
          .for('update')
          .limit(1);
        if (!conversation) return null;
        const member = await requireActiveMember(message.conversationId, message.senderId, tx);
        if (message.attachment && attachmentScopeFromKey(message.attachment.url.trim()) !== `group_${message.conversationId}`) {
          throw new ConversationStoreError('forbidden', 'attachment must belong to this group');
        }
        if (message.replyTo) {
          const [parent] = await tx.select().from(messagesTable).where(and(
            eq(messagesTable.conversationId, message.conversationId), eq(messagesTable.messageId, message.replyTo),
            gte(messagesTable.createdAt, member.joinedAt)
          )).limit(1);
          if (!parent) throw new ConversationStoreError('forbidden', 'reply is outside membership interval');
        }
        const members = await membersFor(message.conversationId, tx);
        const createdAt = activityTime(conversation);
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
            createdAt: createdAt.toISOString(),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          await tx.insert(changesTable).values({ conversationId: message.conversationId,
            messageId: message.messageId, changeType: 'new', changedAt: createdAt.toISOString() });
          await tx.update(conversationsTable).set({ updatedAt: createdAt })
            .where(eq(conversationsTable.conversationId, message.conversationId));
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
        if (existing && (existing.conversationId !== message.conversationId || Date.parse(existing.createdAt) < Date.parse(member.joinedAt))) {
          throw new ConversationStoreError('forbidden', 'message is outside membership interval');
        }
        return existing
          ? { message: toMessage(existing), recipients: members.map(({ userId }) => userId), inserted: false }
          : null;
      });
    },

    async getMessage(conversationId, messageId, userId) {
      return db.transaction(async tx => {
        await lockedGroup(conversationId, tx);
        const member = await requireActiveMember(conversationId, userId, tx);
        const [row] = await tx.select().from(messagesTable).where(and(
          eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId),
          gte(messagesTable.createdAt, member.joinedAt)
        )).limit(1);
        return row ? toMessage(row) : null;
      });
    },

    async deleteMessage({ conversationId, messageId, userId }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
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
        const changedAt = activityTime(conversation);
        const tombstone = applyTombstone(toMessage(existing), changedAt.toISOString());
        const [updated] = await tx
          .update(messagesTable)
          .set({ body: '', attachment: null, reactions: {}, deletedAt: tombstone.deletedAt })
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .returning();
        await tx.insert(changesTable).values({ conversationId, messageId, changeType: 'deleted',
          changedAt: changedAt.toISOString() });
        await tx.update(conversationsTable).set({ updatedAt: changedAt })
          .where(eq(conversationsTable.conversationId, conversationId));
        return { message: toMessage(updated), recipients: (await membersFor(conversationId, tx)).map(({ userId: id }) => id) };
      });
    },

    async reactToMessage({ conversationId, messageId, userId, emoji, action }) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx
          .select()
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
        if (JSON.stringify(reactions) === JSON.stringify(existing.reactions)) {
          return { message: toMessage(existing), recipients: (await membersFor(conversationId, tx)).map(member => member.userId) };
        }
        const [updated] = await tx
          .update(messagesTable)
          .set({ reactions })
          .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.messageId, messageId)))
          .returning();
        const changedAt = activityTime(conversation);
        await tx.insert(changesTable).values({ conversationId, messageId, changeType: 'reactions',
          changedAt: changedAt.toISOString() });
        await tx.update(conversationsTable).set({ updatedAt: changedAt })
          .where(eq(conversationsTable.conversationId, conversationId));
        return { message: toMessage(updated), recipients: (await membersFor(conversationId, tx)).map(({ userId: id }) => id) };
      });
    },

    async getCall(callId) {
      const [call] = await db.select().from(callsTable)
        .where(eq(callsTable.callId, callId)).limit(1);
      return call ? callChange(call) : null;
    },

    async listCallHistory({ userId, statusFilter, limit, offset = 0 }) {
      const status = sql<string>`case when ${callParticipantsTable.acceptedAt} is null
        and (${callsTable.status} = 'ended' or ${callParticipantsTable.status} in ('declined', 'left'))
        then 'missed' else ${callsTable.status} end`;
      const where = and(eq(callParticipantsTable.userId, userId), sql`exists (
        select 1 from ${membersTable} where ${membersTable.conversationId} = ${callsTable.conversationId}
        and ${membersTable.userId} = ${userId} and ${membersTable.joinedAt} <= ${callsTable.createdAt}
        and (${membersTable.leftAt} is null or ${membersTable.leftAt} >= ${callsTable.createdAt})
        and (${membersTable.removedAt} is null or ${membersTable.removedAt} >= ${callsTable.createdAt})
      )`, statusFilter ? eq(status, statusFilter) : undefined);
      const query = () => db.select({ call: callsTable, participant: callParticipantsTable, name: conversationsTable.name })
        .from(callsTable)
        .innerJoin(callParticipantsTable, eq(callParticipantsTable.callId, callsTable.callId))
        .innerJoin(conversationsTable, eq(conversationsTable.conversationId, callsTable.conversationId)).where(where);
      const [rows, totals] = await Promise.all([
        query().orderBy(desc(callsTable.updatedAt), desc(callsTable.createdAt), desc(callsTable.callId)).limit(limit).offset(offset),
        db.select({ value: count() }).from(callsTable)
          .innerJoin(callParticipantsTable, eq(callParticipantsTable.callId, callsTable.callId))
          .innerJoin(conversationsTable, eq(conversationsTable.conversationId, callsTable.conversationId)).where(where),
      ]);
      return { calls: rows.map(({ call, participant, name }) =>
        groupCallHistoryEntry(toCall(call), toCallParticipant(participant), name)), total: Number(totals[0]?.value ?? 0) };
    },

    async startCall({ conversationId, initiatorId, mediaType, ringTimeoutMs, excludedUserIds = [], canInvite }) {
      for (;;) {
        // Directory checks can use this same pool; do not hold a transaction
        // connection while waiting for them. Prove coverage again under lock.
        const snapshot = canInvite ? await membersFor(conversationId) : [];
        if (snapshot.length) assertActiveGroupMember(snapshot.find(member => member.userId === initiatorId));
        const reachable = new Map<string, boolean>(canInvite && snapshot.length <= MAX_GROUP_CALL_PARTICIPANTS
          ? await Promise.all(snapshot.filter(member => member.userId !== initiatorId)
            .map(async ({ userId }): Promise<[string, boolean]> => [userId, await canInvite(userId)]))
          : []);
        const result = await db.transaction(async (tx) => {
          const [conversation] = await tx
            .select()
            .from(conversationsTable)
            .where(and(eq(conversationsTable.conversationId, conversationId), isNull(conversationsTable.deletedAt)))
            .for('update')
            .limit(1);
          if (!conversation) return null;
          await requireActiveMember(conversationId, initiatorId, tx);
          const members = await membersFor(conversationId, tx);
          assertGroupCallMembership(members, excludedUserIds);
          const invitees = members.filter(({ userId }) => userId !== initiatorId);
          if (invitees.length === 0) return null;
          if (canInvite && invitees.some(({ userId }) => !reachable.has(userId))) return 'retry' as const;
          if (canInvite && invitees.some(({ userId }) => !reachable.get(userId))) {
            throw new ConversationStoreError('forbidden', 'All current members must be reachable to start a group call');
          }
          await checkBlocks(tx, initiatorId, invitees.map(({ userId }) => userId));
          const now = activityTime(conversation);
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
        if (result !== 'retry') return result;
      }
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
        if (action === 'accept' && participant.status !== 'accepted') {
          await assertGroupCallCapacity(tx, callId);
        }
        const nextStatus =
          PARTICIPANT_TRANSITIONS[action][participant.status as GroupCallParticipant['status']] ?? null;
        if (!nextStatus) return callChange(call, tx);

        await tx
          .update(callParticipantsTable)
          .set({
            status: nextStatus,
            acceptedAt: nextStatus === 'accepted'
              ? new Date(Math.max(now.getTime(), (participant.acceptedAt?.getTime() ?? now.getTime()) + 1))
              : participant.acceptedAt,
            leftAt: nextStatus === 'accepted' ? null : now,
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
        let memberships = await tx
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
        const userInvitations = await tx.select().from(invitationsTable).where(or(
          eq(invitationsTable.inviteeId, userId), eq(invitationsTable.issuerId, userId)
        ));
        const conversationIds = new Set([
          ...memberships.map(({ conversationId }) => conversationId),
          ...callRows.map(({ call }) => call.conversationId),
          ...userInvitations.map(({ conversationId }) => conversationId),
        ]);
        for (const conversationId of [...conversationIds].sort()) {
          await tx
            .select({ conversationId: conversationsTable.conversationId })
            .from(conversationsTable)
            .where(eq(conversationsTable.conversationId, conversationId))
            .for('update')
            .limit(1);
        }
        memberships = await tx.select().from(membersTable).where(eq(membersTable.userId, userId));

        const now = new Date();
        const ownerMemberships = memberships.filter(
          (member) => member.role === 'owner' && member.leftAt === null
        );
        for (const member of ownerMemberships) {
          await replaceErasedOwner(tx, member, userId, now);
        }
        const membershipGroupIds = [...new Set(memberships.map(({ conversationId }) => conversationId))];
        for (const conversationId of membershipGroupIds) {
          await tx
            .update(conversationsTable)
            .set({
              updatedAt: sql`greatest(${now}, ${conversationsTable.updatedAt} + interval '1 millisecond')`,
              membershipVersion: sql`${conversationsTable.membershipVersion} + 1`,
            })
            .where(eq(conversationsTable.conversationId, conversationId));
        }
        await tx
          .update(membersTable)
          .set({
            userId: pseudonym,
            role: 'member',
            leftAt: sql`coalesce(${membersTable.leftAt}, (
              select ${conversationsTable.updatedAt} from ${conversationsTable}
              where ${conversationsTable.conversationId} = ${membersTable.conversationId}
            ), ${now})`,
            departureActorId: sql`coalesce(${membersTable.departureActorId}, ${pseudonym})`,
            departureReason: sql`coalesce(${membersTable.departureReason}, 'account_erasure')`,
            updatedAt: now,
          })
          .where(eq(membersTable.userId, userId));
        await tx.update(membersTable).set({ departureActorId: pseudonym }).where(eq(membersTable.departureActorId, userId));
        await tx.update(invitationsTable).set({ cancelledAt: now }).where(and(
          or(eq(invitationsTable.inviteeId, userId), eq(invitationsTable.issuerId, userId)),
          isNull(invitationsTable.acceptedAt), isNull(invitationsTable.cancelledAt)
        ));
        await tx.update(invitationsTable).set({ issuerId: pseudonym }).where(eq(invitationsTable.issuerId, userId));
        await tx.update(invitationsTable).set({ inviteeId: pseudonym }).where(eq(invitationsTable.inviteeId, userId));
        await tx.update(eventsTable).set({ actorId: pseudonym }).where(eq(eventsTable.actorId, userId));
        await tx.update(eventsTable).set({ userId: pseudonym }).where(eq(eventsTable.userId, userId));
        await eraseReactions(tx, membershipGroupIds, userId);
        for (const conversationId of new Set(memberships.map(member => member.conversationId))) {
          const [conversation] = await tx.select().from(conversationsTable).where(eq(conversationsTable.conversationId, conversationId));
          if (conversation) await record(tx, conversation, 'erased', pseudonym, pseudonym, 'account_erasure');
        }

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
        await collectEmptyGroups(tx, conversationIds);

        return { conversationIds: [...conversationIds] };
      });
    },

    async eraseUserMessages(userId, pseudonym, limit) {
      const batchSize = Math.min(Math.max(Math.floor(limit) || 1, 1), 500);
      return db.transaction(async (tx) => {
        const page = await tx
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.senderId, userId))
          .orderBy(
            asc(messagesTable.createdAt),
            asc(messagesTable.conversationId),
            asc(messagesTable.messageId)
          )
          .limit(batchSize);
        // All group paths lock the group before its messages, including erasure.
        for (const conversationId of [...new Set(page.map(row => row.conversationId))].sort()) {
          await tx.select().from(conversationsTable).where(eq(conversationsTable.conversationId, conversationId)).for('update');
        }
        const rows = page.length ? await tx.select().from(messagesTable).where(and(
          eq(messagesTable.senderId, userId),
          or(...page.map(row => and(eq(messagesTable.conversationId, row.conversationId), eq(messagesTable.messageId, row.messageId))))
        )).for('update') : [];
        const now = new Date().toISOString();
        const attachmentCandidates = new Set<string>();
        const conversationIds = new Set<string>();
        let messagesTombstoned = 0;
        for (const row of rows) {
          conversationIds.add(row.conversationId);
          const update: Partial<typeof messagesTable.$inferInsert> = { senderId: pseudonym };
          if (!row.deletedAt) {
            messagesTombstoned += 1;
            const url = (row.attachment as { url?: unknown } | null)?.url;
            if (typeof url === 'string') attachmentCandidates.add(url.trim());
            update.body = '';
            update.attachment = null;
            update.reactions = {};
            update.deletedAt = now;
            await tx.insert(changesTable).values({ conversationId: row.conversationId,
              messageId: row.messageId, changeType: 'deleted', changedAt: now });
          }
          await tx
            .update(messagesTable)
            .set(update)
            .where(and(
              eq(messagesTable.conversationId, row.conversationId),
              eq(messagesTable.messageId, row.messageId)
            ));
        }
        // The group locks also serialize saves and other erasure batches.
        // A group-scoped key can be copied, so only its last live reference
        // may schedule object deletion, regardless of the message's sender.
        const attachmentUrl = normalizedAttachmentUrl;
        const survivors = attachmentCandidates.size ? await tx.selectDistinct({ url: attachmentUrl }).from(messagesTable).where(and(
          inArray(messagesTable.conversationId, [...conversationIds]),
          isNull(messagesTable.deletedAt), inArray(attachmentUrl, [...attachmentCandidates])
        )) : [];
        const survivingUrls = new Set(survivors.map(({ url }) => url));
        const attachmentUrls = [...attachmentCandidates].filter(url => !survivingUrls.has(url));
        if (attachmentUrls.length) await tx.insert(attachmentCleanupTable)
          .values(attachmentUrls.map(url => ({ url }))).onConflictDoNothing();
        await collectEmptyGroups(tx, conversationIds);
        return {
          attachmentUrls,
          conversationIds: [...conversationIds],
          messagesTombstoned,
          messagesProcessed: rows.length,
        };
      });
    },
    async listAttachmentCleanup(limit, after) {
      const rows = await db.select().from(attachmentCleanupTable)
        .where(after === undefined ? undefined : sql`${attachmentCleanupTable.url} > ${after}`)
        .orderBy(asc(attachmentCleanupTable.url)).limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 500));
      return rows.map(({ url }) => url);
    },
    async acknowledgeAttachmentCleanup(url) {
      await db.delete(attachmentCleanupTable).where(eq(attachmentCleanupTable.url, url));
    },
  };
}

export { createPgConversationStore };
