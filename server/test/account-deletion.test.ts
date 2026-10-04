/**
 * Integration tests for account erasure: the queued request and its grace
 * period (`/account/delete`), and the cascade the sweep then carries out.
 *
 * Mirrors the helper style of `account-export.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from '../../shared/index.ts';
import { createServer } from '../src/index.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import { createConversationStore } from '../src/conversationStore.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson, readJson } from './helpers.ts';

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

async function deleteJson(
  url: string,
  path: string,
  sessionId?: string
): Promise<{ status: number; body: any; }> {
  const response = await fetch(`${url}${path}`, {
    method: 'DELETE',
    headers: sessionId ? { authorization: `Bearer ${sessionId}` } : {},
  });
  return { status: response.status, body: await readJson(response) };
}

test('/account/delete requires a valid session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, 'bad-session')).status, 401);
  assert.equal((await getJson(url, API_ROUTES.ACCOUNT_DELETE, 'bad-session')).status, 401);
  assert.equal((await deleteJson(url, API_ROUTES.ACCOUNT_DELETE, 'bad-session')).status, 401);
});

test('POST /account/delete queues an erasure without extending its grace period', async (t) => {
  const { url, teardown } = await startServer({ accountDeletionGraceMs: 60_000 });
  t.after(teardown);

  const sessionId = await createSession(url, 'delete-alice');

  const first = await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId);
  assert.equal(first.status, 202);
  assert.equal(first.body.status, 'pending');
  assert.ok(
    Date.parse(first.body.scheduledFor) - Date.parse(first.body.requestedAt) >= 60_000,
    'the grace period should be honoured'
  );

  const repeat = await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId);
  assert.equal(repeat.status, 202);
  assert.equal(repeat.body.scheduledFor, first.body.scheduledFor);

  const status = await getJson(url, API_ROUTES.ACCOUNT_DELETE, sessionId);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'pending');
});

test('DELETE /account/delete cancels a pending erasure and the sweep then skips it', async (t) => {
  const { url, runAccountDeletionSweep, teardown } = await startServer({
    accountDeletionGraceMs: 0,
  });
  t.after(teardown);

  const sessionId = await createSession(url, 'delete-bob');
  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);

  const cancelled = await deleteJson(url, API_ROUTES.ACCOUNT_DELETE, sessionId);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  assert.equal(await runAccountDeletionSweep(), 0);
  const status = await getJson(url, API_ROUTES.ACCOUNT_DELETE, sessionId);
  assert.equal(status.body.status, 'none');

  const repeat = await deleteJson(url, API_ROUTES.ACCOUNT_DELETE, sessionId);
  assert.equal(repeat.status, 404);
});

test('the sweep leaves an erasure alone until its grace period elapses', async (t) => {
  const { url, runAccountDeletionSweep, teardown } = await startServer({
    accountDeletionGraceMs: 60 * 60 * 1000,
  });
  t.after(teardown);

  const sessionId = await createSession(url, 'delete-carol');
  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);

  assert.equal(await runAccountDeletionSweep(), 0);
  assert.equal((await getJson(url, API_ROUTES.ACCOUNT_DELETE, sessionId)).body.status, 'pending');

  assert.equal(await runAccountDeletionSweep(Date.now() + 61 * 60 * 1000), 1);
});

test('the sweep erases the account across every store that named it', async (t) => {
  const stores = createMemoryStores();
  const messageStore = createMemoryMessageStore();

  const own = await messageStore.saveMessage({
    messageId: 'own-photo',
    senderId: 'delete-dave',
    recipientId: 'delete-peer',
    body: 'my holiday',
  });
  const received = await messageStore.saveMessage({
    messageId: 'peer-reply',
    senderId: 'delete-peer',
    recipientId: 'delete-dave',
    body: 'looks nice',
  });

  const { url, runAccountDeletionSweep, teardown } = await startServer({
    stores,
    messageStore,
    accountDeletionGraceMs: 0,
  });
  t.after(teardown);

  const sessionId = await createSession(url, 'delete-dave');
  stores.blocks.set('delete-dave', new Set(['delete-peer']));
  stores.blocks.set('delete-peer', new Set(['delete-dave']));
  stores.calls.set('call-1', {
    callId: 'call-1',
    callerId: 'delete-dave',
    calleeId: 'delete-peer',
    status: 'ended',
    createdAt: new Date().toISOString(),
  });
  stores.callEvents.set('call-1', []);
  stores.calls.set('call-2', {
    callId: 'call-2',
    callerId: 'delete-peer',
    calleeId: 'someone-else',
    status: 'ended',
    createdAt: new Date().toISOString(),
  });

  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);
  assert.equal(await runAccountDeletionSweep(), 1);

  // Identity released, so the username can be claimed again.
  assert.equal(stores.users.has('delete-dave'), false);
  // Sessions revoked: the bearer token no longer resolves.
  assert.equal(stores.sessions.size, 0);
  assert.equal(stores.userSessions.has('delete-dave'), false);
  assert.equal((await getJson(url, API_ROUTES.ACCOUNT_EXPORT, sessionId)).status, 401);
  // Devices — and with them the push tokens they hold — are gone.
  assert.equal(stores.devices.size, 0);
  assert.equal(stores.userDevices.has('delete-dave'), false);
  // Blocks removed in both directions.
  assert.equal(stores.blocks.size, 0);
  // Calls the user took part in are gone; other people's are untouched.
  assert.equal(stores.calls.has('call-1'), false);
  assert.equal(stores.callEvents.has('call-1'), false);
  assert.equal(stores.calls.has('call-2'), true);

  // Own message tombstoned; the message the peer sent is left intact, because
  // it is also the peer's history.
  const ownAfter = await messageStore.getMessage(own.conversationId, own.messageId);
  assert.ok(ownAfter?.deletedAt, "the erased user's message should be tombstoned");
  assert.equal(ownAfter?.body, '');
  assert.equal(ownAfter?.attachment, null);
  const receivedAfter = await messageStore.getMessage(received.conversationId, received.messageId);
  assert.equal(receivedAfter?.deletedAt, null);
  assert.equal(receivedAfter?.body, 'looks nice');
});

test('group history is exported and account erasure pseudonymises group state', async (t) => {
  const conversationStore = createConversationStore();
  const { conversation, invitations } = await conversationStore.create({
    name: 'Erasure group',
    creatorId: 'delete-group-user',
    inviteeIds: ['group-peer'],
  });
  await conversationStore.acceptInvitation({
    conversationId: conversation.conversationId, invitationId: invitations![0].invitationId, userId: 'group-peer',
  });
  const message = await conversationStore.saveMessage({
    messageId: 'group-owned-message',
    conversationId: conversation.conversationId,
    senderId: 'delete-group-user',
    recipientId: conversation.conversationId,
    body: 'group history',
    type: 'text',
    attachment: null,
    replyTo: null,
    reactions: {},
    deletedAt: null,
    createdAt: new Date().toISOString(),
    deliveredTo: [],
    readAt: null,
  });
  assert.ok(message);
  const call = await conversationStore.startCall({
    conversationId: conversation.conversationId,
    initiatorId: 'delete-group-user',
    mediaType: 'audio',
    ringTimeoutMs: 60_000,
  });
  assert.ok(call);

  const { url, runAccountDeletionSweep, teardown } = await startServer({
    conversationStore,
    accountDeletionGraceMs: 0,
  });
  t.after(teardown);
  const sessionId = await createSession(url, 'delete-group-user');

  const archive = await getJson(url, API_ROUTES.ACCOUNT_EXPORT, sessionId);
  assert.equal(archive.status, 200);
  assert.equal(archive.body.groupConversations[0].conversationId, conversation.conversationId);
  assert.equal(archive.body.groupMessages[0].body, 'group history');

  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);
  assert.equal(await runAccountDeletionSweep(), 1);
  const erasedMessage = await conversationStore.getMessage(
    conversation.conversationId,
    message.message.messageId,
    'group-peer'
  );
  assert.equal(erasedMessage?.body, '');
  assert.ok(erasedMessage?.deletedAt);
  assert.match(erasedMessage?.senderId ?? '', /^deleted-/);
  assert.equal(await conversationStore.getMember(conversation.conversationId, 'delete-group-user'), null);
  const survivingGroup = await conversationStore.listForUser('group-peer');
  assert.match(survivingGroup[0].creatorId, /^deleted-/);

  const accepted = await conversationStore.transitionCall({
    callId: call.call.callId,
    userId: 'group-peer',
    action: 'accept',
  });
  assert.equal(accepted?.call.status, 'active');
  assert.equal(
    accepted?.participants.find(({ userId }) => userId.startsWith('deleted-'))?.status,
    'left'
  );
});

test('erasure pseudonymises the audit trail instead of dropping it', async (t) => {
  const { url, runAccountDeletionSweep, teardown } = await startServer({
    accountDeletionGraceMs: 0,
  });
  t.after(teardown);

  const erinSession = await createSession(url, 'delete-erin');
  const peerSession = await createSession(url, 'delete-peer');
  assert.equal(
    (await postJson(url, API_ROUTES.BLOCKS, { blockeeId: 'delete-peer' }, erinSession)).status,
    200
  );

  const before = await getJson(url, '/audit-log', peerSession);
  assert.ok(
    before.body.entries.some((entry: any) => entry.actor === 'delete-erin'),
    'the block should be recorded against the actor'
  );

  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, erinSession)).status, 202);
  assert.equal(await runAccountDeletionSweep(), 1);

  const after = await getJson(url, '/audit-log', peerSession);
  const blockEntries = after.body.entries.filter((entry: any) => entry.event === 'block.added');
  assert.equal(blockEntries.length, 1, 'the security record survives the erasure');
  assert.equal(blockEntries[0].target, 'delete-peer');
  assert.notEqual(blockEntries[0].actor, 'delete-erin');
  assert.match(blockEntries[0].actor, /^deleted-/);
});

test('erasure removes the account\u2019s avatar object', async (t) => {
  // An avatar hangs off the profile, not off a message, so the attachment
  // sweep never sees it: without its own step the one picture of the erased
  // person this deployment stores would outlive them, in a bucket with no
  // lifecycle rule to collect it.
  const requests: { url: string; method: string; }[] = [];

  process.env.R2_BUCKET = 'chat';
  process.env.R2_ACCESS_KEY_ID = 'key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  process.env.R2_ENDPOINT = 'https://storage.example';
  t.after(() => {
    delete process.env.R2_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ENDPOINT;
  });

  const { url, runAccountDeletionSweep, teardown } = await startServer({
    accountDeletionGraceMs: 0,
    attachmentFetch: (async (input: any, init: any) => {
      requests.push({ url: String(input), method: String(init?.method) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
  t.after(teardown);

  const sessionId = await createSession(url, 'delete-grace');
  const presigned = await postJson(
    url,
    API_ROUTES.AVATAR_PRESIGN,
    { mimeType: 'image/png', sizeBytes: 1024 },
    sessionId
  );
  assert.equal(presigned.status, 200);
  const published = await fetch(`${url}${API_ROUTES.AVATAR}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionId}` },
    body: JSON.stringify({ key: presigned.body.key }),
  });
  assert.equal(published.status, 200);

  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);
  assert.equal(await runAccountDeletionSweep(), 1);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.ok(
    requests[0].url.startsWith(`https://storage.example/chat/${presigned.body.key}?`),
    `unexpected delete target: ${requests[0].url}`
  );
  assert.ok(requests[0].url.includes('X-Amz-Signature='), 'the delete must be signed');
});

test('erasure removes the attachment objects the erased messages referenced', async (t) => {
  const messageStore = createMemoryMessageStore();
  const requests: { url: string; method: string; }[] = [];

  await messageStore.saveMessage({
    messageId: 'attached',
    senderId: 'delete-frank',
    recipientId: 'delete-peer',
    body: 'file',
    type: 'file',
    attachment: { url: 'chatblobs/conv-1/object.pdf' } as any,
  });

  const { url, runAccountDeletionSweep, teardown } = await startServer({
    messageStore,
    accountDeletionGraceMs: 0,
    attachmentFetch: (async (input: any, init: any) => {
      requests.push({ url: String(input), method: String(init?.method) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
  t.after(teardown);

  process.env.R2_BUCKET = 'chat';
  process.env.R2_ACCESS_KEY_ID = 'key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  process.env.R2_ENDPOINT = 'https://storage.example';
  t.after(() => {
    delete process.env.R2_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ENDPOINT;
  });

  const sessionId = await createSession(url, 'delete-frank');
  assert.equal((await postJson(url, API_ROUTES.ACCOUNT_DELETE, {}, sessionId)).status, 202);
  assert.equal(await runAccountDeletionSweep(), 1);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.ok(
    requests[0].url.startsWith('https://storage.example/chat/chatblobs/conv-1/object.pdf?'),
    `unexpected delete target: ${requests[0].url}`
  );
  assert.ok(requests[0].url.includes('X-Amz-Signature='), 'the delete must be signed');
});
