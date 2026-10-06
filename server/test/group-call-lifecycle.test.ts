import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
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
    await assert.rejects(store.startCall({ conversationId, initiatorId: owner, mediaType: 'audio',
      ringTimeoutMs: 60_000, excludedUserIds }), { code: 'group_call_full' });
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
  assert.equal((await store.listCallHistory({ userId: ids[1], limit: 20 })).total, 0);
  await assert.rejects(store.listMessages({ conversationId, userId: ids[1], limit: 20 }), { code: 'not_member' });
  await store.expireCall(started.call.callId, Date.now() + 61_000);
  await store.leave({ conversationId, userId: ids[3] });
  assert.equal((await store.getCall(started.call.callId))!.participants.find(person => person.userId === ids[3])!.status, 'declined');
  await store.transitionCall({ callId: started.call.callId, userId: owner, action: 'leave' });
  const restarted = stores.at(-1)!;
  const joined = await restarted.listMessages({ conversationId, userId: owner, limit: 20 });
  assert.equal(joined[0].messageId, started.call.callId);
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
  assert.deepEqual(seen, ['zz-last-message', '00000000-0000-4000-8000-000000000000', started.call.callId]);
}

test('memory room capacity, concurrent admissions, live rejoin, membership and final teardown', async () => {
  await verifyLifecycle([createMemoryConversationStore()]);
});

test('memory snapshot membership, atomic start refusal, revocation and durable paginated system history', async () => {
  await verifyHistory([createMemoryConversationStore()]);
});
// Explicit test-only URL: never migrate a deployed/shared database.
const databaseUrl = process.env.GROUP_CALL_TEST_DATABASE_URL;
test('Postgres locks serialize capacity and rejoin across independent pools', { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const databaseName = `group_call_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${databaseName}`;
  const pools = [new Pool({ connectionString: url.toString() }), new Pool({ connectionString: url.toString() })];
  try {
    const databases = pools.map(pool => drizzle(pool, { schema }));
    await migrate(databases[0], { migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)) });
    await verifyLifecycle(databases.map(db => createPgConversationStore(db)));
    await verifyHistory(databases.map(db => createPgConversationStore(db)));
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
