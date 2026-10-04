import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../db/schema.ts';
import { createAdapter } from '@socket.io/redis-adapter';
import { io as ioClient } from 'socket.io-client';
import { API_ROUTES, CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } from '../../shared/index.ts';
import { createServer, createConversationStore, createMemoryMessageBus } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { createMemoryCache, conversationsCacheKey, messagesCacheKey } from '../src/cache.ts';
import { pushSenders } from '../src/push.ts';
import { buildMessageEnvelope } from '../src/push/envelopes.ts';
import { CONVERSATION_FANOUT_CHANNEL } from '../src/domain/conversationFanout.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

// Exercise the real Redis adapter, including fetchSockets requests, without an
// external Redis service. Only the Redis pub/sub transport is in-process.
function adapterTransport() {
  type Handler = (message: Buffer, channel: string) => void;
  const clients = new Set<PubSubClient>();
  class PubSubClient extends EventEmitter {
    channels = new Map<string, Handler>();
    patterns = new Map<string, Handler>();
    constructor() { super(); clients.add(this); }
    async pSubscribe(pattern: string, handler: Handler) { this.patterns.set(pattern, handler); }
    async subscribe(channels: string[], handler: Handler) {
      for (const channel of channels) this.channels.set(channel, handler);
    }
    async pUnsubscribe(pattern: string) { this.patterns.delete(pattern); }
    async unsubscribe(channel: string) { this.channels.delete(channel); }
    sSubscribe() {}
    async sendCommand(command: string[]) {
      return [command[2], [...clients].filter(client => client.channels.has(command[2])).length];
    }
    async publish(channel: string, message: string | Buffer) {
      const payload = Buffer.from(message);
      for (const client of clients) {
        const handler = client.channels.get(channel);
        if (handler) queueMicrotask(() => handler(payload, channel));
        for (const [pattern, listener] of client.patterns) {
          if (channel.startsWith(pattern.slice(0, -1))) queueMicrotask(() => listener(payload, channel));
        }
      }
    }
  }
  return () => createAdapter(new PubSubClient(), new PubSubClient(), { requestsTimeout: 1000 });
}

async function startServer(options: import('../src/createServer.ts').CreateServerOptions = {}) {
  const conversationStore = options.conversationStore ?? createConversationStore({ db: options.db });
  const server = createServer({ fanoutProbeIntervalMs: 0, ...options, conversationStore });
  const port = await listenOnRandomPort(server.httpServer);
  return { ...server, conversationStore, url: `http://127.0.0.1:${port}` };
}

async function session(url: string, userId: string, deviceId = `device-${userId}`) {
  const result = await postJson(url, '/session', { userId, deviceId });
  assert.equal(result.status, 201);
  return result.body.sessionId as string;
}

async function connect(url: string, sessionId: string) {
  const socket = ioClient(url, { auth: { sessionId }, forceNew: true, transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function emit(socket: import('socket.io-client').Socket, event: string, payload: object): Promise<any> {
  return new Promise(resolve => socket.emit(event, { version: SIGNALING_VERSION, ...payload }, resolve));
}

function waitFor(socket: import('socket.io-client').Socket, event: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}

async function group(store: import('../src/conversationStore.ts').ConversationStore, userIds: string[]) {
  const created = await store.create({ name: 'Study team', creatorId: userIds[0], inviteeIds: userIds.slice(1) });
  for (const invitation of created.invitations ?? []) {
    await store.acceptInvitation({ conversationId: invitation.conversationId,
      invitationId: invitation.invitationId, userId: invitation.inviteeId });
  }
  return created.conversation.conversationId;
}

test('Redis adapter reaches remote members once; bus evicts all members; offline push is per member', async t => {
  const adapter = adapterTransport();
  const store = createConversationStore();
  const bus = createMemoryMessageBus();
  const firstStores = createMemoryStores();
  const secondStores = createMemoryStores();
  firstStores.attachAdapter = io => io.adapter(adapter());
  secondStores.attachAdapter = io => io.adapter(adapter());
  const firstCache = createMemoryCache();
  const secondCache = createMemoryCache();
  const first = await startServer({ stores: firstStores, conversationStore: store, messageBus: bus, cache: firstCache });
  const second = await startServer({ stores: secondStores, conversationStore: store, messageBus: bus, cache: secondCache });
  const aliceSession = await session(first.url, 'alice');
  const bobSession = await session(second.url, 'bob');
  const carolSession = await session(first.url, 'carol');
  const carolOldSession = await session(first.url, 'carol', 'old-carol');
  const alice = await connect(first.url, aliceSession);
  const bob = await connect(second.url, bobSession);
  t.after(async () => {
    alice.disconnect(); bob.disconnect();
    await closeTestServer(first); await closeTestServer(second); await bus.close();
  });
  const pushes: Array<{ channel: any; data: any }> = [];
  t.mock.method(pushSenders, 'sendMessagePush', async (
    channel: import('../src/push/types.ts').PushChannel,
    data: import('../src/push/types.ts').MessagePushData
  ) => {
    pushes.push({ channel, data });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  });
  for (const [url, token, bearer] of [
    [second.url, 'bob-token', bobSession], [first.url, 'carol-old-token', carolOldSession],
    [first.url, 'carol-token', carolSession],
  ]) {
    assert.equal((await postJson(url, '/devices/register', { provider: 'fcm', pushToken: token }, bearer)).status, 200);
  }
  const conversationId = await group(store, ['alice', 'bob', 'carol']);
  await Promise.all([first.cacheInvalidationSubscriptionReady, second.cacheInvalidationSubscriptionReady,
    first.conversationFanoutSubscriptionReady, second.conversationFanoutSubscriptionReady]);
  for (const cache of [firstCache, secondCache]) {
    for (const userId of ['alice', 'bob', 'carol']) await cache.set(conversationsCacheKey(userId), ['stale']);
    await cache.set(messagesCacheKey(conversationId, 20), ['stale']);
    await cache.set(conversationsCacheKey('outsider'), ['keep']);
  }
  let deliveries = 0;
  bob.on(SERVER_EVENTS.MESSAGE_RECEIVED, () => deliveries++);
  const received = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
  const payload = { conversationId, body: 'group fanout', clientMessageId: '27b4f6df-7ae8-44f8-8e3d-51f6d549d552' };
  const sent = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, payload);
  assert.equal(sent.ok, true);
  assert.equal((await received).message.messageId, sent.message.messageId);
  assert.equal((await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, payload)).message.messageId, sent.message.messageId);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deliveries, 1);
  assert.equal(pushes.length, 1);
  assert.ok(['carol-token', 'carol-old-token'].includes(pushes[0].channel.pushToken));
  assert.equal(pushes[0].data.groupName, 'Study team');
  assert.equal(buildMessageEnvelope(pushes[0].data).title, 'Study team');
  assert.equal(buildMessageEnvelope(pushes[0].data).data.senderId, 'alice');
  assert.equal(pushes[0].data.conversationId, conversationId);
  const stored = await store.getMessage(conversationId, sent.message.messageId, 'alice');
  assert.deepEqual(stored?.deliveredTo, ['bob']);
  for (const cache of [firstCache, secondCache]) {
    for (const userId of ['alice', 'bob', 'carol']) assert.equal(await cache.get(conversationsCacheKey(userId)), undefined);
    assert.equal(await cache.get(messagesCacheKey(conversationId, 20)), undefined);
    assert.deepEqual(await cache.get(conversationsCacheKey('outsider')), ['keep']);
  }
});

test('adapter receiver drops queued pre-rejoin messages and never duplicates delivery through the bus', async t => {
  const adapter = adapterTransport();
  const store = createConversationStore();
  const bus = createMemoryMessageBus();
  const published = t.mock.method(bus, 'publish');
  let release!: () => void;
  let observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const checking = new Promise<void>(resolve => { observed = resolve; });
  let delayNextCheck = false;
  const receiverStore = {
    ...store,
    async getMember(conversationId: string, userId: string) {
      if (delayNextCheck && userId === 'queued-bob') {
        delayNextCheck = false;
        observed();
        await gate;
      }
      return store.getMember(conversationId, userId);
    },
  };
  const firstStores = createMemoryStores();
  const secondStores = createMemoryStores();
  firstStores.attachAdapter = io => io.adapter(adapter());
  secondStores.attachAdapter = io => io.adapter(adapter());
  const first = await startServer({ stores: firstStores, conversationStore: store, messageBus: bus });
  const second = await startServer({ stores: secondStores, conversationStore: receiverStore, messageBus: bus });
  const alice = await connect(first.url, await session(first.url, 'queued-alice'));
  const bob = await connect(second.url, await session(second.url, 'queued-bob'));
  t.after(async () => {
    release();
    alice.disconnect(); bob.disconnect();
    await closeTestServer(first); await closeTestServer(second); await bus.close();
  });
  await Promise.all([first.conversationFanoutSubscriptionReady, second.conversationFanoutSubscriptionReady]);
  const conversationId = await group(store, ['queued-alice', 'queued-bob']);
  let deliveries = 0;
  bob.on(SERVER_EVENTS.MESSAGE_RECEIVED, () => deliveries++);
  delayNextCheck = true;
  const old = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, { conversationId, body: 'queued old interval' });
  assert.equal(old.ok, true);
  await checking;
  await store.leave({ conversationId, userId: 'queued-bob' });
  const invited = await store.addMembers({ conversationId, actorId: 'queued-alice', userIds: ['queued-bob'] });
  await store.acceptInvitation({ conversationId, invitationId: invited!.invitations![0].invitationId, userId: 'queued-bob' });
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deliveries, 0);
  const received = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
  const fresh = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, { conversationId, body: 'current interval' });
  assert.equal((await received).message.messageId, fresh.message.messageId);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(deliveries, 1);
  assert.equal(published.mock.calls.filter(call => call.arguments[0] === CONVERSATION_FANOUT_CHANNEL).length, 0);
});

test('group read receipts persist independent member lists, are idempotent, and reject outsiders', async t => {
  const server = await startServer();
  t.after(() => closeTestServer(server));
  const sessions = await Promise.all(['reader-alice', 'reader-bob', 'reader-carol', 'reader-outsider']
    .map(id => session(server.url, id)));
  const alice = await connect(server.url, sessions[0]);
  const bob = await connect(server.url, sessions[1]);
  t.after(() => { alice.disconnect(); bob.disconnect(); });
  const conversationId = await group(server.conversationStore, ['reader-alice', 'reader-bob', 'reader-carol']);
  const sent = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, { conversationId, body: 'read independently' });
  assert.equal(sent.ok, true);
  const receipt = waitFor(alice, SERVER_EVENTS.MESSAGE_READ);
  const read = await postJson(server.url, API_ROUTES.MESSAGES_READ, { conversationId }, sessions[1]);
  assert.equal(read.status, 200);
  assert.equal(read.body.updated, 1);
  assert.equal((await receipt).readerId, 'reader-bob');
  assert.equal((await postJson(server.url, API_ROUTES.MESSAGES_READ, { conversationId }, sessions[1])).body.updated, 0);
  const history = () => getJson(server.url, `${API_ROUTES.CONVERSATIONS}/${conversationId}/messages`, sessions[0]);
  assert.deepEqual((await history()).body.messages[0].readBy, ['reader-bob']);
  assert.equal((await postJson(server.url, API_ROUTES.MESSAGES_READ, { conversationId }, sessions[2])).body.updated, 1);
  assert.deepEqual((await history()).body.messages[0].readBy, ['reader-bob', 'reader-carol']);
  assert.equal((await postJson(server.url, API_ROUTES.MESSAGES_READ, { conversationId }, sessions[3])).status, 403);
  await server.conversationStore.leave({ conversationId, userId: 'reader-carol' });
  assert.equal((await postJson(server.url, API_ROUTES.MESSAGES_READ, { conversationId }, sessions[2])).status, 403);
  await server.conversationStore.eraseUserData('reader-carol', 'erased-reader-carol');
  assert.deepEqual((await history()).body.messages[0].readBy, ['reader-bob']);
});

test('direct and group deltas/search share cursors and never expose left-member history', async t => {
  const server = await startServer();
  t.after(() => closeTestServer(server));
  const sessions = await Promise.all(['delta-alice', 'delta-bob', 'delta-outsider'].map(id => session(server.url, id)));
  const alice = await connect(server.url, sessions[0]);
  const bob = await connect(server.url, sessions[1]);
  t.after(() => { alice.disconnect(); bob.disconnect(); });
  const store = server.conversationStore;
  const conversationId = await group(store, ['delta-alice', 'delta-bob']);
  const direct = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: 'delta-alice:delta-bob', body: 'shared needle direct' });
  const grouped = await emit(bob, CLIENT_EVENTS.MESSAGE_SEND, { conversationId, body: 'shared needle group' });
  assert.equal(direct.ok, true);
  assert.equal(grouped.ok, true);
  const reaction = await emit(alice, CLIENT_EVENTS.MESSAGE_REACT, { conversationId,
    messageId: grouped.message.messageId, emoji: '👍', action: 'add' });
  assert.equal(reaction.ok, true);
  const since = '2000-01-01T00:00:00.000Z';
  const syncPath = `${API_ROUTES.MESSAGES_SYNC}?since=${since}&limit=1`;
  const changes: any[] = [];
  let cursor: string | null = null;
  do {
    const result = await getJson(server.url, `${syncPath}${cursor ? `&cursor=${cursor}` : ''}`, sessions[0]);
    assert.equal(result.status, 200);
    changes.push(...result.body.changes);
    cursor = result.body.nextCursor;
  } while (cursor);
  assert.deepEqual(changes.map(change => change.type), ['new', 'new', 'reactions']);
  assert.equal(new Set(changes.map(change => change.changeId)).size, 3);
  const searchPath = `${API_ROUTES.MESSAGES_SEARCH}?q=shared%20needle&limit=1`;
  const firstSearch = await getJson(server.url, searchPath, sessions[0]);
  assert.equal(firstSearch.body.results[0].conversationId, conversationId);
  assert.equal(firstSearch.body.hasMore, true);
  const next = firstSearch.body.nextCursor;
  const secondSearch = await getJson(server.url,
    `${searchPath}&before=${encodeURIComponent(next.before)}&beforeMessageId=${next.beforeMessageId}`, sessions[0]);
  assert.equal(secondSearch.body.results[0].conversationId, direct.message.conversationId);
  assert.equal(secondSearch.body.hasMore, false);
  const groupSearch = `${API_ROUTES.MESSAGES_SEARCH}?q=shared&conversationId=${conversationId}`;
  assert.equal((await getJson(server.url, groupSearch, sessions[2])).status, 403);
  await store.leave({ conversationId, userId: 'delta-bob' });
  assert.equal((await getJson(server.url, groupSearch, sessions[1])).status, 403);
  const leftSearch = await getJson(server.url, `${API_ROUTES.MESSAGES_SEARCH}?q=shared`, sessions[1]);
  assert.deepEqual(leftSearch.body.results.map((message: any) => message.conversationId), [direct.message.conversationId]);
  const leftSync = await getJson(server.url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, sessions[1]);
  assert.deepEqual(leftSync.body.changes.map((change: any) => change.message.conversationId), [direct.message.conversationId]);
  const reinvited = await store.addMembers({ conversationId, actorId: 'delta-alice', userIds: ['delta-bob'] });
  await store.acceptInvitation({ conversationId, invitationId: reinvited!.invitations![0].invitationId, userId: 'delta-bob' });
  assert.deepEqual((await getJson(server.url, groupSearch, sessions[1])).body.results, []);
  const rejoinedSync = await getJson(server.url, `${API_ROUTES.MESSAGES_SYNC}?since=${since}`, sessions[1]);
  assert.deepEqual(rejoinedSync.body.changes.map((change: any) => change.message.conversationId), [direct.message.conversationId]);
  const removed = await emit(alice, CLIENT_EVENTS.MESSAGE_DELETE, { conversationId, messageId: grouped.message.messageId });
  assert.equal(removed.ok, false, 'only the author can delete');
});

test('group push fanout obeys the 16-member cap and retry suppression', async t => {
  const server = await startServer();
  t.after(() => closeTestServer(server));
  const users = Array.from({ length: 16 }, (_, index) => `cap-${index}`);
  const sessions = await Promise.all(users.map(id => session(server.url, id)));
  const sender = await connect(server.url, sessions[0]);
  t.after(() => sender.disconnect());
  const conversationId = await group(server.conversationStore, users);
  for (const [index, bearer] of sessions.entries()) {
    await postJson(server.url, '/devices/register', { provider: 'fcm', pushToken: `cap-token-${index}` }, bearer);
  }
  const pushes: string[] = [];
  t.mock.method(pushSenders, 'sendMessagePush', async (channel: import('../src/push/types.ts').PushChannel) => {
    pushes.push(channel.pushToken);
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  });
  const payload = { conversationId, body: 'bounded amplification',
    clientMessageId: 'b0a735f9-899b-428e-a07d-3fe4180c26bc' };
  assert.equal((await emit(sender, CLIENT_EVENTS.MESSAGE_SEND, payload)).ok, true);
  assert.equal((await emit(sender, CLIENT_EVENTS.MESSAGE_SEND, payload)).ok, true);
  assert.equal(pushes.length, 15);
  assert.equal(new Set(pushes).size, 15);
  assert.ok(!pushes.includes('cap-token-0'));
});

test('PostgreSQL group sync, search, receipts and remote registrations survive store recreation',
  { skip: !process.env.DATABASE_URL }, async t => {
    const databaseName = `group_fanout_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    databaseUrl.pathname = `/${databaseName}`;
    const pool = new Pool({ connectionString: databaseUrl.toString() });
    const db = drizzle(pool, { schema });
    const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
    const sockets: Array<import('socket.io-client').Socket> = [];
    const bus = createMemoryMessageBus();
    t.after(async () => {
      sockets.forEach(socket => socket.disconnect());
      for (const server of servers) await closeTestServer(server);
      await bus.close();
      await pool.end();
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    });
    await migrate(db, { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname });
    const adapter = adapterTransport();
    for (let index = 0; index < 2; index++) {
      const stores = createMemoryStores();
      stores.attachAdapter = io => io.adapter(adapter());
      servers.push(await startServer({ db, stores, messageBus: bus }));
    }
    const [first, second] = servers;
    const aliceSession = await session(first.url, 'pg-alice');
    const bobSession = await session(second.url, 'pg-bob');
    const carolSession = await session(second.url, 'pg-carol');
    const outsiderSession = await session(second.url, 'pg-outsider');
    const alice = await connect(first.url, aliceSession);
    const bob = await connect(second.url, bobSession);
    sockets.push(alice, bob);
    await postJson(second.url, '/devices/register', { provider: 'fcm', pushToken: 'remote-carol' }, carolSession);
    const pushes: string[] = [];
    t.mock.method(pushSenders, 'sendMessagePush', async (channel: import('../src/push/types.ts').PushChannel) => {
      pushes.push(channel.pushToken);
      return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
    });
    const conversationId = await group(first.conversationStore, ['pg-alice', 'pg-bob', 'pg-carol']);
    const directReceived = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
    const direct = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, { recipientId: 'pg-bob', body: 'durable needle direct' });
    await directReceived;
    const received = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
    const payload = { conversationId, body: 'durable needle group',
      clientMessageId: 'abc54faa-f205-4abf-9395-872b36d58298' };
    const sent = await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, payload);
    assert.equal(sent.ok, true);
    assert.equal((await received).message.messageId, sent.message.messageId);
    assert.equal((await emit(alice, CLIENT_EVENTS.MESSAGE_SEND, payload)).ok, true);
    assert.deepEqual(pushes, ['remote-carol']);
    const read = await postJson(second.url, API_ROUTES.MESSAGES_READ, { conversationId }, bobSession);
    assert.equal(read.status, 200);
    assert.equal(read.body.updated, 1);
    assert.equal((await postJson(second.url, API_ROUTES.MESSAGES_READ, { conversationId }, bobSession)).body.updated, 0);
    const reopened = createConversationStore({ db });
    const persisted = await reopened.getMessage(conversationId, sent.message.messageId, 'pg-alice');
    assert.deepEqual(persisted?.readBy, ['pg-bob']);
    assert.deepEqual(persisted?.deliveredTo, ['pg-bob']);
    // Tie every change timestamp: the shared numeric sequence must still page
    // direct/group/receipt events exactly once through the unchanged cursor.
    await pool.query('UPDATE group_message_changes SET changed_at = $1 WHERE conversation_id = $2',
      [direct.message.createdAt, conversationId]);
    const syncPath = `${API_ROUTES.MESSAGES_SYNC}?since=2000-01-01T00:00:00.000Z&limit=1`;
    const types: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await getJson(first.url, `${syncPath}${cursor ? `&cursor=${cursor}` : ''}`, aliceSession);
      assert.equal(result.status, 200);
      types.push(...result.body.changes.map((change: any) => change.type));
      cursor = result.body.nextCursor;
    } while (cursor);
    assert.deepEqual(types, ['new', 'new', 'edited']);
    const search = `${API_ROUTES.MESSAGES_SEARCH}?q=durable%20needle`;
    const results = await getJson(second.url, search, bobSession);
    assert.equal(results.status, 200);
    assert.equal(results.body.results.length, 2);
    assert.equal((await getJson(second.url, `${search}&conversationId=${conversationId}`, outsiderSession)).status, 403);
    await reopened.leave({ conversationId, userId: 'pg-bob' });
    assert.equal((await getJson(second.url, `${search}&conversationId=${conversationId}`, bobSession)).status, 403);
    const departedSearch = await getJson(second.url, search, bobSession);
    assert.deepEqual(departedSearch.body.results.map((message: any) => message.conversationId), [direct.message.conversationId]);
    const departedSync = await getJson(second.url,
      `${API_ROUTES.MESSAGES_SYNC}?since=2000-01-01T00:00:00.000Z`, bobSession);
    assert.deepEqual(departedSync.body.changes.map((change: any) => change.message.conversationId), [direct.message.conversationId]);
    assert.equal((await postJson(second.url, API_ROUTES.MESSAGES_READ, { conversationId }, carolSession)).body.updated, 1);
    assert.deepEqual((await reopened.getMessage(conversationId, sent.message.messageId, 'pg-alice'))?.readBy, ['pg-bob', 'pg-carol']);
    assert.equal((await emit(alice, CLIENT_EVENTS.MESSAGE_DELETE,
      { conversationId, messageId: sent.message.messageId })).ok, true);
    const deletedSync = await getJson(first.url,
      `${API_ROUTES.MESSAGES_SYNC}?since=${direct.message.createdAt}`, aliceSession);
    assert.deepEqual(deletedSync.body.changes.map((change: any) => change.type), ['edited', 'deleted']);
    assert.equal(deletedSync.body.changes[0].message.body, '');
    await reopened.eraseUserData('pg-carol', 'erased-pg-carol');
    const erased = await reopened.getMessage(conversationId, sent.message.messageId, 'pg-alice');
    assert.ok(!erased?.readBy?.includes('pg-carol'));
  });
