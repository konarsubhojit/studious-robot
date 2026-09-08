/**
 * Integration tests for `GET /account/export`: strict session ownership,
 * privacy projections, bounded pagination, audit recording and daily limiting.
 *
 * Mirrors the helper style of `messages-search.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from '../../shared/index.ts';
import { createServer } from '../src/index.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  async function teardown() {
    await closeTestServer(server);
  }
  return { ...server, url, teardown };
}

async function createSession(
  url: string,
  userId: string,
  deviceId: string = `device-${userId}`
): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId, idToken: `token-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

test('GET /account/export requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await getJson(url, API_ROUTES.ACCOUNT_EXPORT, 'bad-session');
  assert.equal(res.status, 401);
});

test('GET /account/export returns only session-owner data with sensitive credentials removed', async (t) => {
  const stores = createMemoryStores();
  const messageStore = createMemoryMessageStore();

  const ownLive = await messageStore.saveMessage({
    messageId: 'own-live',
    senderId: 'export-alice',
    recipientId: 'export-bob',
    body: 'photo',
    type: 'image',
    attachment: {
      url: 'https://cdn.example/own.jpg',
      thumbnailUrl: 'https://cdn.example/own-thumb.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 123,
      embeddedData: 'must-not-leave-the-server',
    } as any,
  });
  const ownDeleted = await messageStore.saveMessage({
    messageId: 'own-deleted',
    senderId: 'export-alice',
    recipientId: 'export-bob',
    body: 'remove me',
  });
  await messageStore.deleteMessage(
    ownDeleted.conversationId,
    ownDeleted.messageId,
    'export-alice'
  );
  await messageStore.saveMessage({
    messageId: 'foreign-message',
    senderId: 'export-carol',
    recipientId: 'export-dave',
    body: 'not Alice data',
  });

  stores.devices.set('alice-old-device', {
    deviceId: 'alice-old-device',
    userId: 'export-alice',
    platform: 'ios',
    sessionId: 'secret-session',
    pushProvider: 'apns',
    pushToken: 'secret-push-token',
  });
  stores.devices.set('carol-device', {
    deviceId: 'carol-device',
    userId: 'export-carol',
    platform: 'android',
    sessionId: null,
    pushProvider: 'fcm',
    pushToken: 'foreign-token',
  });

  const ownCall = {
    callId: 'own-call',
    callerId: 'export-bob',
    calleeId: 'export-alice',
    status: 'ended',
    createdAt: '2026-09-08T07:00:00.000Z',
    updatedAt: '2026-09-08T07:01:00.000Z',
  };
  stores.calls.set(ownCall.callId, ownCall);
  stores.callEvents.set(ownCall.callId, [
    {
      eventId: 'own-event',
      callId: ownCall.callId,
      event: 'ended',
      actor: 'export-bob',
      timestamp: '2026-09-08T07:01:00.000Z',
    },
  ]);
  stores.calls.set('foreign-call', {
    callId: 'foreign-call',
    callerId: 'export-carol',
    calleeId: 'export-dave',
    status: 'ended',
    createdAt: '2026-09-08T06:00:00.000Z',
  });
  stores.callEvents.set('foreign-call', [
    {
      eventId: 'foreign-event',
      callId: 'foreign-call',
      event: 'ended',
      actor: 'export-carol',
      timestamp: '2026-09-08T06:01:00.000Z',
    },
  ]);

  const { url, teardown } = await startServer({
    stores,
    messageStore,
    accountExportRateLimit: 10,
    verifyIdToken: async (token) => ({
      authUid: `uid-${token}`,
      email: token === 'token-export-alice' ? 'alice@example.test' : null,
      authProvider: 'test',
    }),
  });
  t.after(teardown);

  const aliceSession = await createSession(url, 'export-alice');
  const bobSession = await createSession(url, 'export-bob');
  const carolSession = await createSession(url, 'export-carol');
  await createSession(url, 'export-dave');

  // Alice's outgoing and Bob's incoming block both concern Alice. Only the
  // outgoing relationship belongs in `blocks`; both belong in her audit data.
  await postJson(url, '/blocks', { blockeeId: 'export-bob' }, aliceSession);
  await postJson(url, '/blocks', { blockeeId: 'export-alice' }, bobSession);
  await postJson(url, '/blocks', { blockeeId: 'export-dave' }, carolSession);

  // A userId query cannot switch the export subject away from the bearer.
  const res = await getJson(
    url,
    `${API_ROUTES.ACCOUNT_EXPORT}?userId=export-carol`,
    aliceSession
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.schemaVersion, 1);
  assert.equal(res.body.profile.userId, 'export-alice');
  assert.equal(res.body.profile.email, 'alice@example.test');
  assert.equal('authUid' in res.body.profile, false);

  assert.deepEqual(
    new Set(res.body.messages.map((message: any) => message.messageId)),
    new Set(['own-live', 'own-deleted'])
  );
  const tombstone = res.body.messages.find((message: any) => message.messageId === 'own-deleted');
  assert.ok(tombstone.deletedAt);
  assert.equal(tombstone.body, '');
  const attachment = res.body.messages.find((message: any) => message.messageId === ownLive.messageId);
  assert.equal(attachment.attachment.url, 'https://cdn.example/own.jpg');
  assert.equal(attachment.attachment.thumbnailUrl, 'https://cdn.example/own-thumb.jpg');
  assert.deepEqual(Object.keys(attachment.attachment).sort(), ['thumbnailUrl', 'url']);
  assert.equal(JSON.stringify(res.body).includes('must-not-leave-the-server'), false);
  assert.equal(JSON.stringify(res.body).includes('not Alice data'), false);

  assert.deepEqual(res.body.calls.map((call: any) => call.callId), ['own-call']);
  assert.deepEqual(res.body.callEvents.map((event: any) => event.eventId), ['own-event']);

  assert.deepEqual(
    new Set(res.body.devices.map((device: any) => device.deviceId)),
    new Set(['alice-old-device', 'device-export-alice'])
  );
  for (const device of res.body.devices) {
    assert.equal('pushToken' in device, false);
    assert.equal('sessionId' in device, false);
  }
  assert.deepEqual(res.body.blocks, ['export-bob']);

  assert.ok(
    res.body.audit.some(
      (entry: any) => entry.event === 'block.added' && entry.actor === 'export-alice'
    )
  );
  assert.ok(
    res.body.audit.some(
      (entry: any) => entry.event === 'block.added' && entry.target === 'export-alice'
    )
  );
  assert.equal(
    res.body.audit.some((entry: any) => entry.actor === 'export-carol'),
    false
  );
  assert.ok(
    res.body.audit.some(
      (entry: any) => entry.event === 'account.exported' && entry.actor === 'export-alice'
    )
  );
});

test('GET /account/export paginates all own messages with a bounded before cursor', async (t) => {
  const messageStore = createMemoryMessageStore();
  for (let index = 0; index < 3; index++) {
    await messageStore.saveMessage({
      messageId: `page-${index}`,
      senderId: 'page-alice',
      recipientId: 'page-bob',
      body: `message ${index}`,
    });
  }

  const { url, teardown } = await startServer({
    messageStore,
    accountExportRateLimit: 10,
  });
  t.after(teardown);
  const session = await createSession(url, 'page-alice');

  const first = await getJson(url, `${API_ROUTES.ACCOUNT_EXPORT}?limit=2`, session);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.messages.map((message: any) => message.messageId),
    ['page-2', 'page-1']
  );
  assert.equal(first.body.pagination.messages.hasMore, true);
  assert.ok(first.body.pagination.messages.nextBefore);

  const second = await getJson(
    url,
    `${API_ROUTES.ACCOUNT_EXPORT}?limit=2&before=${encodeURIComponent(
      first.body.pagination.messages.nextBefore
    )}`,
    session
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.messages.map((message: any) => message.messageId),
    ['page-0']
  );
  assert.equal(second.body.pagination.messages.hasMore, false);
  assert.equal(second.body.pagination.messages.nextBefore, null);
});

test('GET /account/export applies a strict per-account daily rate limit', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);
  const session = await createSession(url, 'daily-alice');

  const first = await getJson(url, API_ROUTES.ACCOUNT_EXPORT, session);
  assert.equal(first.status, 200);

  const second = await getJson(url, API_ROUTES.ACCOUNT_EXPORT, session);
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'too many requests');
  assert.ok(second.body.retryAfter > 86_000);
});

test('GET /account/export reports an unavailable message store', async (t) => {
  const messageStore = createMemoryMessageStore();
  messageStore.listUserMessages = async () => {
    throw new Error('store down');
  };
  const { url, teardown } = await startServer({ messageStore });
  t.after(teardown);
  const session = await createSession(url, 'degraded-export-alice');

  const res = await getJson(url, API_ROUTES.ACCOUNT_EXPORT, session);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'account export unavailable');
});
