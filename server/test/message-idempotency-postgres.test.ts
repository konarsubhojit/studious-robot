import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { io as ioClient } from 'socket.io-client';
import * as schema from '../db/schema.ts';
import { createPgMessageStore } from '../src/messageStore/pgStore.ts';
import { createPgConversationStore } from '../src/conversationStore/pgStore.ts';
import { createMessageRecord } from '../src/messageStore.ts';
import { createServer } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

// Existing CI owner connection or an explicit override; only scratch databases are touched.
const databaseUrl = process.env.MESSAGE_IDEMPOTENCY_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test('Postgres constraint converges independent instances, including lost-ack replay', { skip: !databaseUrl }, async (t) => {
  const admin = new Pool({ connectionString: databaseUrl });
  const databaseName = `message_key_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${databaseName}`;
  const pools = [new Pool({ connectionString: url.toString() }), new Pool({ connectionString: url.toString() })];
  t.after(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });
  const databases = pools.map(pool => drizzle(pool, { schema }));
  await migrate(databases[0], { migrationsFolder: fileURLToPath(new URL('../db/migrations', import.meta.url)) });
  const stores = databases.map(db => createPgMessageStore({ db }));

  await t.test('concurrent inserts from independent pools count unread/change only once', async () => {
    const clientMessageId = randomUUID();
    const input = { senderId: 'alice', recipientId: 'bob', body: 'exactly once', clientMessageId };
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => stores[i % 2].saveMessageWithStatus!(input)));
    assert.equal(results.filter(result => result.inserted).length, 1);
    for (const result of results) assert.deepEqual(result.message, results[0].message);
    assert.notEqual(results[0].message.messageId, clientMessageId);
    const { rows } = await pools[0].query('SELECT * FROM messages');
    assert.equal(rows.length, 1);
    const projection = await databases[1].select().from(schema.conversations);
    assert.equal(projection[0].unreadA, 0);
    assert.equal(projection[0].unreadB, 1);
    assert.equal((await databases[1].select().from(schema.messageChanges)).length, 1);

    // Bypass stores entirely: the database, not an in-process check, guarantees it.
    await assert.rejects(databases[1].insert(schema.messages).values({
      ...rows[0], conversationId: 'another-conversation', messageId: randomUUID(),
      senderId: input.senderId, recipientId: input.recipientId, body: input.body,
      type: 'text', createdAt: results[0].message.createdAt, clientMessageId,
    }), (error: unknown) => {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code === '23505';
    });

    const other = await stores[1].saveMessage({ ...input, senderId: 'bob', recipientId: 'alice' });
    assert.notEqual(other.messageId, results[0].message.messageId);
    assert.equal((await databases[0].select().from(schema.messages)).length, 2);

    await stores[0].markDelivered(results[0].message.messageId, 'bob', 'alice:bob');
    await stores[0].reactToMessage({
      conversationId: 'alice:bob', messageId: results[0].message.messageId, userId: 'bob', emoji: '👍', action: 'add',
    });
    const persisted = await stores[0].getMessage('alice:bob', results[0].message.messageId);
    const replay = await stores[1].saveMessageWithStatus!(input);
    assert.equal(replay.inserted, false);
    assert.deepEqual(replay.message, persisted);
    assert.equal((await databases[1].select().from(schema.conversations))[0].unreadB, 1);
  });

  await t.test('two actual signaling servers return identical acks after concurrent sends and ack loss', async (subtest) => {
    const servers = stores.map(messageStore => createServer({ messageStore }));
    const sockets: import('socket.io-client').Socket[] = [];
    subtest.after(async () => {
      sockets.forEach(socket => socket.disconnect());
      await Promise.all(servers.map(server => closeTestServer(server)));
    });
    for (const server of servers) {
      const port = await listenOnRandomPort(server.httpServer);
      const baseUrl = `http://127.0.0.1:${port}`;
      const session = await postJson(baseUrl, '/session', { userId: 'fleet-alice', deviceId: 'fleet-device' });
      await postJson(baseUrl, '/session', { userId: 'fleet-bob', deviceId: 'fleet-bob-device' });
      const socket = ioClient(baseUrl, { auth: { sessionId: session.body.sessionId }, transports: ['websocket'], forceNew: true });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
    }
    const clientMessageId = randomUUID();
    const payload = { version: 2, recipientId: 'fleet-bob', body: 'fleet replay', clientMessageId };
    const send = (socket: import('socket.io-client').Socket): Promise<any> =>
      new Promise(resolve => socket.emit('message.send', payload, resolve));
    const acks = await Promise.all(sockets.map(send));
    assert.equal(acks[0].ok, true);
    assert.deepEqual(acks[0], acks[1]);
    assert.deepEqual(await send(sockets[1]), acks[0], 'reconnect on another instance after lost ack');
    const messages = await stores[0].listMessages({ conversationId: 'fleet-alice:fleet-bob' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].clientMessageId, clientMessageId);
    assert.equal((await stores[0].listConversations('fleet-bob'))[0].unreadCount, 1);
    const deleted: any = await new Promise(resolve => sockets[0].emit('message.delete', {
      version: 2, peerId: 'fleet-bob', messageId: messages[0].messageId,
    }, resolve));
    assert.equal(deleted.ok, true);
    const changesAfterDelete = await databases[0].select().from(schema.messageChanges);
    const tombstoneReplay = await send(sockets[1]);
    assert.equal(tombstoneReplay.ok, true);
    assert.equal(tombstoneReplay.message.messageId, acks[0].message.messageId);
    assert.equal(tombstoneReplay.message.createdAt, acks[0].message.createdAt);
    assert.equal(tombstoneReplay.message.body, '');
    assert.ok(tombstoneReplay.message.deletedAt);
    assert.equal((await stores[0].listMessages({ conversationId: 'fleet-alice:fleet-bob' })).length, 1);
    assert.deepEqual(await databases[1].select().from(schema.messageChanges), changesAfterDelete);
    assert.equal((await stores[0].listConversations('fleet-bob'))[0].unreadCount, 1);
  });

  await t.test('independent group stores use the same sender-scoped constraint', async () => {
    const groups = databases.map(createPgConversationStore);
    const created = await groups[0].create({ creatorId: 'alice', inviteeIds: ['bob'], name: 'Concurrent' });
    const conversationId = created.conversation.conversationId;
    const clientMessageId = randomUUID();
    const input = { conversationId, senderId: 'alice', recipientId: conversationId, body: 'group once', clientMessageId };
    const results = await Promise.all(groups.map(group => group.saveMessage(createMessageRecord(input))));
    assert.equal(results.filter(result => result?.inserted).length, 1);
    assert.deepEqual(results[0]?.message, results[1]?.message);
    const other = await groups[1].saveMessage(createMessageRecord({ ...input, senderId: 'bob' }));
    assert.notEqual(other?.message.messageId, results[0]?.message.messageId);
    const history = await groups[0].listMessages({ conversationId, userId: 'alice', limit: 10 });
    assert.equal(history.length, 2);
  });
});
