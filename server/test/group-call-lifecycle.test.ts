import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { createMemoryConversationStore } from '../src/conversationStore/memoryStore.ts';
import { createPgConversationStore } from '../src/conversationStore/pgStore.ts';
import type { ConversationStore } from '../src/conversationStore/types.ts';

async function verifyLifecycle(stores: ConversationStore[]) {
  const ids = ['owner', 'a', 'b', 'c'];
  const store = stores[0];
  const created = await store.create({ creatorId: ids[0], name: 'Mesh lifecycle', inviteeIds: ids.slice(1) });
  const conversationId = created.conversation.conversationId;
  for (const invitation of created.invitations!) {
    await store.acceptInvitation({ conversationId, invitationId: invitation.invitationId, userId: invitation.inviteeId });
  }
  const started = await store.startCall({ conversationId, initiatorId: ids[0], mediaType: 'video', ringTimeoutMs: 60_000 });
  assert.ok(started);
  const callId = started.call.callId;
  const accept = (userId: string, index = 0) => stores[index % stores.length].transitionCall({ callId, userId, action: 'accept' });
  const results = await Promise.allSettled(ids.slice(1).map((id, index) => accept(id, index)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(results.filter(result => result.status === 'rejected').length, 0);
  const full = (await store.getCall(callId))!;
  const participant = full.participants.find(person => person.userId !== ids[0] && person.status === 'accepted')!;
  const others = full.participants.filter(person => person.userId !== participant.userId && person.status === 'accepted');
  const left = (await store.transitionCall({ callId, userId: participant.userId, action: 'leave' }))!;
  assert.equal(left.call.status, 'active');
  assert.deepEqual(left.participants.filter(person => others.some(other => other.userId === person.userId)), others);
  const rejoined = (await accept(participant.userId, 1))!;
  const self = rejoined.participants.find(person => person.userId === participant.userId)!;
  assert.equal(self.status, 'accepted');
  assert.equal(self.leftAt, null);
  assert.ok(Date.parse(self.acceptedAt!) > Date.parse(participant.acceptedAt!));
  const duplicate = (await accept(participant.userId))!;
  assert.equal(duplicate.call.stateVersion, rejoined.call.stateVersion);
  await store.leave({ conversationId, userId: participant.userId });
  await assert.rejects(accept(participant.userId), { code: 'not_member' });
  for (const person of (await store.getCall(callId))!.participants) {
    if (person.userId !== participant.userId) await store.transitionCall({ callId, userId: person.userId, action: 'leave' });
  }
  assert.equal((await store.getCall(callId))!.call.status, 'ended');
  assert.equal(await accept(ids[0]), null);
}

async function verifyHistory(stores: ConversationStore[]) {
  const store = stores[0];
  const owner = 'history-owner';
  const ids = [owner, 'history-a', 'history-b', 'history-c', 'history-new'];
  const created = await store.create({ creatorId: owner, name: 'Durable team', inviteeIds: ids.slice(1) });
  const conversationId = created.conversation.conversationId;
  for (const invitation of created.invitations!) {
    await store.acceptInvitation({ conversationId, invitationId: invitation.invitationId, userId: invitation.inviteeId });
  }
  for (const excludedUserIds of [[], [ids[4]]]) {
    let checkedVisibility = false;
    await assert.rejects(store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio',
      ringTimeoutMs: 60_000, excludedUserIds, canInvite: async () => { checkedVisibility = true; return false; } }), { code: 'group_call_full' });
    assert.equal(checkedVisibility, false, 'the ceiling counts raw membership before eligibility checks');
  }
  assert.equal((await store.listCallHistory({ userId: owner, limit: 20 })).total, 0);
  assert.deepEqual(await store.listMessages({ conversationId, userId: owner, limit: 20 }), []);
  await store.removeMember({ conversationId, actorId: owner, userId: ids[4] });
  await assert.rejects(store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio',
    ringTimeoutMs: 60_000, excludedUserIds: [ids[1]] }), { code: 'forbidden' });
  const started = (await store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000 }))!;
  assert.deepEqual(started.participants.map(person => person.userId).sort(), ids.slice(0, 4).sort());
  await store.transitionCall({ callId: started.call.callId, userId: ids[1], action: 'accept' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const added = (await store.addMembers({ conversationId, actorId: owner, userIds: [ids[4]] }))!;
  await store.acceptInvitation({ conversationId, userId: ids[4], invitationId: added.invitations![0].invitationId });
  assert.equal(await store.transitionCall({ callId: started.call.callId, userId: ids[4], action: 'accept' }), null);
  assert.equal((await store.getCall(started.call.callId))!.participants.length, 4);
  assert.deepEqual(await store.listMessages({ conversationId, userId: ids[4], limit: 20 }), []);
  assert.equal((await store.listCallHistory({ userId: ids[4], limit: 20 })).total, 0);
  await store.removeMember({ conversationId, actorId: owner, userId: ids[1] });
  const removed = (await store.getCall(started.call.callId))!;
  assert.equal(removed.participants.find(person => person.userId === ids[1])!.status, 'left');
  assert.equal((await store.listCallHistory({ userId: ids[1], limit: 20 })).total, 1);
  await assert.rejects(store.listMessages({ conversationId, userId: ids[1], limit: 20 }), { code: 'not_member' });
  await store.expireCall(started.call.callId, Date.now() + 61_000);
  await store.leave({ conversationId, userId: ids[3] });
  assert.equal((await store.getCall(started.call.callId))!.participants.find(person => person.userId === ids[3])!.status, 'declined');
  await store.transitionCall({ callId: started.call.callId, userId: owner, action: 'leave' });
  assert.equal((await store.listCallHistory({ userId: ids[3], limit: 20 })).calls[0].outcome, 'missed');
  const reissued = (await store.addMembers({ conversationId, actorId: owner, userIds: [ids[1]] }))!;
  await store.acceptInvitation({ conversationId, userId: ids[1], invitationId: reissued.invitations![0].invitationId });
  assert.deepEqual(await store.listMessages({ conversationId, userId: ids[1], limit: 20 }), []);
  const retained = await store.listCallHistory({ userId: ids[1], limit: 20 });
  assert.equal(retained.total, 1, 'rejoin retains original history without duplicating membership intervals');
  assert.equal(retained.calls[0].outcome, 'joined');
  const restarted = stores.at(-1)!;
  const joined = await restarted.listMessages({ conversationId, userId: owner, limit: 20 });
  assert.equal(joined[0].messageId, `group-call:${started.call.callId}`);
  assert.equal(joined[0].type, 'system');
  assert.equal(joined[0].body, 'Group audio call · Joined · Ended');
  const missed = await restarted.listMessages({ conversationId, userId: ids[2], limit: 20 });
  assert.equal(missed[0].body, 'Group audio call · Missed · Ended');
  const history = await restarted.listCallHistory({ userId: ids[2], statusFilter: 'missed', limit: 1 });
  assert.equal(history.total, 1);
  assert.equal(history.calls[0].kind, 'group');
  assert.equal(history.calls[0].conversationId, conversationId);
  assert.equal(history.calls[0].groupName, 'Durable team');
  assert.equal(history.calls[0].outcome, 'missed');
  assert.equal(history.calls[0].callStatus, 'ended');
  assert.equal((await restarted.listCallHistory({ userId: 'outsider', limit: 20 })).total, 0);
  const timestamp = started.call.createdAt;
  await assert.rejects(store.saveMessage({ ...joined[0], type: 'text', body: 'forged call history' }), { code: 'forbidden' });
  for (const messageId of ['00000000-0000-4000-8000-000000000000', 'zz-last-message']) {
    await store.saveMessage({ messageId, conversationId, senderId: owner, recipientId: conversationId,
      body: 'notes', type: 'text', createdAt: timestamp, attachment: null, replyTo: null,
      reactions: {}, deletedAt: null, deliveredTo: [], readAt: null });
  }
  const seen: string[] = [];
  let before: string | undefined;
  let beforeMessageId: string | undefined;
  for (let page = 0; page < 4; page++) {
    const rows = await restarted.listMessages({ conversationId, userId: owner, limit: 1, before, beforeMessageId });
    if (!rows.length) break;
    seen.push(rows[0].messageId);
    before = rows[0].createdAt;
    beforeMessageId = rows[0].messageId;
  }
  // Message creation times are server-authoritative, not the supplied timestamp.
  assert.deepEqual(seen, ['zz-last-message', '00000000-0000-4000-8000-000000000000', `group-call:${started.call.callId}`]);
}

async function eligibilityGroup(store: ConversationStore, prefix: string) {
  const owner = `${prefix}-owner`;
  const member = `${prefix}-member`;
  const newcomer = `${prefix}-new`;
  const group = await store.create({ creatorId: owner, name: prefix, inviteeIds: [member, newcomer] });
  const conversationId = group.conversation.conversationId;
  const invitation = group.invitations!.find(person => person.inviteeId === member)!;
  await store.acceptInvitation({ conversationId, invitationId: invitation.invitationId, userId: member });
  return { owner, member, newcomer, conversationId,
    invitation: group.invitations!.find(person => person.inviteeId === newcomer)! };
}

test('memory retries async eligibility against concurrent membership and refuses unchecked inaccessible newcomers', async () => {
  const store = createMemoryConversationStore();
  const { owner, newcomer, conversationId, invitation } = await eligibilityGroup(store, 'eligibility-memory');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const started = store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000,
    canInvite: async userId => { entered(); await gate; return userId !== newcomer; } });
  const refused = assert.rejects(started, { code: 'forbidden' });
  await checking;
  await store.acceptInvitation({ conversationId, userId: newcomer, invitationId: invitation.invitationId });
  release();
  await refused;
  assert.equal((await store.listCallHistory({ userId: owner, limit: 20 })).total, 0);
  assert.deepEqual(await store.listMessages({ conversationId, userId: owner, limit: 20 }), []);
});

async function verifyEligibilityLock(stores: ConversationStore[], db: Parameters<typeof createPgConversationStore>[0]) {
  const store = stores[0];
  const { owner, member, newcomer, conversationId, invitation } = await eligibilityGroup(store, 'eligibility-pg');
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const started = store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000,
    canInvite: async userId => {
      await db.select().from(schema.blocks).where(eq(schema.blocks.blockerId, userId));
      entered(); await gate; return userId !== newcomer;
    } });
  const refused = assert.rejects(started, { code: 'forbidden' });
  await checking;
  await stores[1].acceptInvitation({ conversationId, userId: newcomer, invitationId: invitation.invitationId });
  release();
  await refused;
  assert.equal((await store.listCallHistory({ userId: owner, limit: 20 })).total, 0);
  const call = (await store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000 }))!;
  assert.deepEqual(call.participants.map(person => person.userId).sort(), [owner, member, newcomer].sort());
  assert.equal((await store.listCallHistory({ userId: owner, limit: 20 })).total, 1);
}

test('memory room capacity, concurrent admissions, live rejoin, membership and final teardown', async () => {
  await verifyLifecycle([createMemoryConversationStore()]);
});

test('memory snapshot membership, atomic start refusal, revocation and durable paginated system history', async () => {
  await verifyHistory([createMemoryConversationStore()]);
});

async function verifyCallTimestamps(store: ConversationStore) {
  const { owner, member, conversationId } = await eligibilityGroup(store, 'clock-history');
  const started = (await store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000 }))!;
  const accepted = (await store.transitionCall({ callId: started.call.callId, userId: member, action: 'accept' }))!;
  assert.ok(accepted.call.updatedAt >= started.call.createdAt, 'call activity must not precede creation');
  const participant = accepted.participants.find(person => person.userId === member)!;
  assert.ok(participant.acceptedAt! >= participant.invitedAt, 'acceptance must not precede invitation');
  const message = await store.saveMessage({ messageId: 'group_call', conversationId, senderId: owner,
    recipientId: conversationId, body: 'after the call', type: 'text', createdAt: new Date().toISOString(),
    attachment: null, replyTo: null, reactions: {}, deletedAt: null, deliveredTo: [], readAt: null });
  assert.ok(message!.message.createdAt > started.call.createdAt, 'later messages must sort after the call');
  const all = await store.listMessages({ conversationId, userId: owner, limit: 20 });
  const seen: string[] = [];
  let before: string | undefined;
  let beforeMessageId: string | undefined;
  for (let page = 0; page < 3; page++) {
    const rows = await store.listMessages({ conversationId, userId: owner, limit: 1, before, beforeMessageId });
    if (!rows.length) break;
    seen.push(rows[0].messageId);
    before = rows[0].createdAt;
    beforeMessageId = rows[0].messageId;
  }
  assert.deepEqual(seen, all.map(row => row.messageId));
}

test('memory call history preserves chronological timestamps within one clock tick', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await verifyCallTimestamps(createMemoryConversationStore());
});

test('memory timeline pagination uses the same ID ordering as its cursor for tied timestamps', async () => {
  const store = createMemoryConversationStore();
  const { owner, conversationId } = await eligibilityGroup(store, 'cursor-history');
  const started = (await store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio', ringTimeoutMs: 60_000 }))!;
  const message = (await store.saveMessage({ messageId: 'group_call', conversationId, senderId: owner,
    recipientId: conversationId, body: 'tied row', type: 'text', createdAt: new Date().toISOString(),
    attachment: null, replyTo: null, reactions: {}, deletedAt: null, deliveredTo: [], readAt: null }))!;
  // Seed a timestamp tie through the memory store's retained message reference.
  message.message.createdAt = started.call.createdAt;
  const first = await store.listMessages({ conversationId, userId: owner, limit: 1 });
  assert.equal(first[0].messageId, 'group_call');
  const second = await store.listMessages({ conversationId, userId: owner, limit: 1,
    before: first[0].createdAt, beforeMessageId: first[0].messageId });
  assert.equal(second[0].messageId, `group-call:${started.call.callId}`);
});
// Explicit test-only URL: never migrate a deployed/shared database.
const databaseUrl = process.env.GROUP_CALL_TEST_DATABASE_URL;
test('Postgres locks serialize capacity and rejoin across independent pools', { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const databaseName = `group_call_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${databaseName}`;
  const pools = [new Pool({ connectionString: url.toString(), max: 1 }), new Pool({ connectionString: url.toString(), max: 1 })];
  try {
    const databases = pools.map(pool => drizzle(pool, { schema }));
    await migrate(databases[0], { migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)) });
    await verifyLifecycle(databases.map(db => createPgConversationStore(db)));
    await verifyHistory(databases.map(db => createPgConversationStore(db)));
    await verifyEligibilityLock(databases.map(db => createPgConversationStore(db)), databases[0]);
    const store = createPgConversationStore(databases[0]);
    const blocked = await eligibilityGroup(store, 'blocked-pg');
    await databases[0].insert(schema.blocks).values({ blockerId: blocked.member, blockeeId: blocked.owner });
    await assert.rejects(store.startCall({ conversationId: blocked.conversationId, initiatorId: blocked.owner,
      mediaType: 'audio', ringTimeoutMs: 60_000 }), { code: 'forbidden' });
    assert.equal((await store.listCallHistory({ userId: blocked.owner, limit: 20 })).total, 0);
    await databases[0].delete(schema.blocks).where(eq(schema.blocks.blockerId, blocked.member));
    await verifyCallTimestamps(store);
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
