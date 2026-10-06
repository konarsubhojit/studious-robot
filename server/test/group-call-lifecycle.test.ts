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
  const ids = ['owner', 'a', 'b', 'c', 'd', 'e'];
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
  assert.equal(results.filter(result => result.status === 'rejected').length, 2);
  for (const result of results) {
    if (result.status === 'rejected') assert.equal(result.reason.code, 'group_call_full');
  }
  const full = (await store.getCall(callId))!;
  const participant = full.participants.find(person => person.userId !== ids[0] && person.status === 'accepted')!;
  const others = full.participants.filter(person => person.userId !== participant.userId && person.status === 'accepted');
  const left = (await store.transitionCall({ callId, userId: participant.userId, action: 'leave' }))!;
  assert.equal(left.call.status, 'active');
  assert.deepEqual(left.participants.filter(person => others.some(other => other.userId === person.userId)), others);
  const waiting = full.participants.find(person => person.status === 'ringing')!;
  await accept(waiting.userId);
  await assert.rejects(accept(participant.userId), { code: 'group_call_full' });
  await store.transitionCall({ callId, userId: waiting.userId, action: 'leave' });
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

test('memory room capacity, concurrent admissions, live rejoin, membership and final teardown', async () => {
  await verifyLifecycle([createMemoryConversationStore()]);
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
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
