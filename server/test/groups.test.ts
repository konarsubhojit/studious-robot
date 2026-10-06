import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { createConversationStore, createServer } from '../src/index.ts';
import type { ConversationStore, GroupInvitation } from '../src/conversationStore/types.ts';
import type { CreateServerOptions } from '../src/createServer.ts';
import { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } from '../../shared/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';
import { createMemoryStores } from '../src/stores/index.ts';

type Context = import('node:test').TestContext;

async function fixture(t: Context, options: CreateServerOptions = {}) {
  const server = createServer({ accountDeletionGraceMs: 0, accountDeletionSweepIntervalMs: 0, ...options });
  const url = `http://127.0.0.1:${await listenOnRandomPort(server.httpServer)}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await closeTestServer(server);
  });
  async function session(userId: string) {
    const result = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
    assert.equal(result.status, 201);
    return result.body.sessionId as string;
  }
  async function socket(sessionId: string): Promise<Socket> {
    const client = connectClient(url, { auth: { sessionId, signalingVersion: SIGNALING_VERSION }, forceNew: true, transports: ['websocket'] });
    sockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  }
  async function request(method: string, path: string, sessionId: string, body: unknown = {}) {
    const response = await fetch(`${url}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: ['Bearer', sessionId].join(' ') },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  }
  return { ...server, url, session, socket, request };
}

function emit(socket: Socket, event: string, payload: object): Promise<any> {
  return new Promise(resolve => socket.emit(event, { version: SIGNALING_VERSION, ...payload }, resolve));
}

async function accept(url: string, invitation: GroupInvitation, session: string) {
  return postJson(url, `/groups/${invitation.conversationId}/invitations/${invitation.invitationId}/accept`, {}, session);
}

async function inviteAndAccept(store: ConversationStore, conversationId: string, actorId: string, userId: string) {
  const issued = await store.addMembers({ conversationId, actorId, userIds: [userId] });
  assert.ok(issued?.invitations?.[0]);
  return store.acceptInvitation({ conversationId, userId, invitationId: issued.invitations[0].invitationId });
}

function message(conversationId: string, senderId: string, messageId: string = randomUUID(), body = 'study notes') {
  return { conversationId, senderId, messageId, recipientId: conversationId, body, type: 'text',
    attachment: null, replyTo: null, reactions: {}, deletedAt: null, createdAt: new Date().toISOString(), deliveredTo: [], readAt: null };
}

test('explicit invitations grant no REST/socket access; removal revokes all group paths immediately', async t => {
  const f = await fixture(t);
  const [owner, member, outsider] = await Promise.all(['owner', 'member', 'outsider'].map(f.session));
  const ownerSocket = await f.socket(owner);
  const memberSocket = await f.socket(member);
  const outsiderSocket = await f.socket(outsider);
  const created = await postJson(f.url, '/groups', { name: 'Private', inviteeIds: ['member'] }, owner);
  assert.equal(created.status, 201);
  const groupId = created.body.group.conversationId;
  assert.deepEqual(created.body.group.memberIds, ['owner']);
  assert.equal((await getJson(f.url, '/groups', member)).body.groups.length, 0);
  assert.equal((await getJson(f.url, '/groups/invitations', member)).body.invitations.length, 1);
  for (const session of [member, outsider]) {
    for (const path of [`/groups/${groupId}`, `/groups/${groupId}/messages`, `/groups/${groupId}/events`,
      `/groups/${groupId}/messages/search?q=notes`, `/conversations/${groupId}/messages`]) {
      assert.equal((await getJson(f.url, path, session)).status, 403, path);
    }
  }
  for (const socket of [memberSocket, outsiderSocket]) {
    assert.equal((await emit(socket, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: groupId, body: 'unauthorized' })).error.code, 'forbidden');
    assert.equal((await emit(socket, CLIENT_EVENTS.MESSAGE_REACT, { conversationId: groupId, messageId: 'missing', emoji: '👍', action: 'add' })).error.code, 'forbidden');
    assert.equal((await emit(socket, CLIENT_EVENTS.MESSAGE_DELETE, { conversationId: groupId, messageId: 'missing' })).error.code, 'forbidden');
  }
  assert.equal((await accept(f.url, created.body.invitations[0], outsider)).status, 400);
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 200);
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 400);
  const sent = await emit(memberSocket, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: groupId, body: 'study notes' });
  assert.equal(sent.ok, true);
  assert.equal((await getJson(f.url, `/groups/${groupId}/messages/search?q=notes`, member)).body.messages.length, 1);
  assert.equal((await f.request('DELETE', `/groups/${groupId}/members/member`, owner, { reason: 'moderation' })).status, 200);
  for (const path of [`/groups/${groupId}`, `/groups/${groupId}/messages`, `/groups/${groupId}/events`,
    `/groups/${groupId}/messages/search?q=notes`, `/conversations/${groupId}/messages`]) {
    assert.equal((await getJson(f.url, path, member)).status, 403);
  }
  assert.equal((await emit(memberSocket, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: groupId, body: 'after removal' })).error.code, 'forbidden');
  assert.equal((await emit(memberSocket, CLIENT_EVENTS.MESSAGE_DELETE, { conversationId: groupId, messageId: sent.message.messageId })).error.code, 'forbidden');
  assert.equal((await emit(memberSocket, CLIENT_EVENTS.MESSAGE_REACT, { conversationId: groupId, messageId: sent.message.messageId, emoji: '👍', action: 'add' })).error.code, 'forbidden');
  let deliveries = 0;
  memberSocket.on(SERVER_EVENTS.MESSAGE_RECEIVED, () => { deliveries++; });
  assert.equal((await emit(ownerSocket, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: groupId, body: 'after removal' })).ok, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deliveries, 0);
  const events = (await getJson(f.url, `/groups/${groupId}/events`, owner)).body.events;
  assert.equal(events.at(-1).event, 'removed');
  assert.equal(events.at(-1).actorId, 'owner');
  assert.equal(events.at(-1).reason, 'moderation');
});

test('legacy socket create/add return invitations, never implicit membership', async t => {
  const f = await fixture(t);
  const [owner, invitee, other] = await Promise.all(['owner', 'invitee', 'other'].map(f.session));
  const socket = await f.socket(owner);
  const created = await emit(socket, CLIENT_EVENTS.CONVERSATION_CREATE, { name: 'Legacy', inviteeIds: ['invitee'] });
  assert.equal(created.ok, true);
  assert.deepEqual(created.conversation.memberIds, ['owner']);
  assert.equal((await getJson(f.url, `/groups/${created.conversation.conversationId}/messages`, invitee)).status, 403);
  const added = await emit(socket, CLIENT_EVENTS.CONVERSATION_MEMBER_ADD, { conversationId: created.conversation.conversationId, userIds: ['other'] });
  assert.equal(added.ok, true);
  assert.deepEqual(added.conversation.memberIds, ['owner']);
  assert.equal(added.invitations[0].inviteeId, 'other');
  assert.equal((await getJson(f.url, `/groups/${created.conversation.conversationId}/messages`, other)).status, 403);
  assert.equal((await accept(f.url, added.invitations[0], other)).status, 200);
});

test('owner/admin authority, owner protection, cancellation and deliberate ownership transfer', async t => {
  const f = await fixture(t);
  const [owner, member, guest] = await Promise.all(['owner', 'member', 'guest'].map(f.session));
  const created = await postJson(f.url, '/groups', { name: 'Roles', inviteeIds: ['member'] }, owner);
  const id = created.body.group.conversationId;
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 200);
  assert.equal((await f.request('PATCH', `/groups/${id}`, member, { name: 'No' })).status, 403);
  assert.equal((await postJson(f.url, `/groups/${id}/invitations`, { userId: 'guest' }, member)).status, 403);
  assert.equal((await postJson(f.url, `/groups/${id}/leave`, {}, owner)).status, 403);
  assert.equal((await f.request('DELETE', `/groups/${id}`, owner)).status, 403);
  assert.equal((await f.request('PATCH', `/groups/${id}/members/member`, owner, { role: 'admin' })).status, 200);
  assert.equal((await f.request('PATCH', `/groups/${id}`, member, { name: 'Renamed' })).status, 200);
  assert.equal((await f.request('DELETE', `/groups/${id}/members/owner`, member)).status, 403);
  assert.equal((await f.request('DELETE', `/groups/${id}/members/member`, member)).status, 403);
  const issued = await postJson(f.url, `/groups/${id}/invitations`, { userId: 'guest' }, member);
  assert.equal(issued.status, 201);
  assert.equal((await f.request('DELETE', `/groups/${id}/invitations/${issued.body.invitation.invitationId}`, guest)).status, 403);
  assert.equal((await f.request('DELETE', `/groups/${id}/invitations/${issued.body.invitation.invitationId}`, member)).status, 204);
  assert.equal((await accept(f.url, issued.body.invitation, guest)).status, 400);
  assert.equal((await postJson(f.url, `/groups/${id}/ownership`, { userId: 'member' }, owner)).status, 200);
  assert.equal((await postJson(f.url, `/groups/${id}/leave`, {}, owner)).status, 200);
  assert.equal((await f.request('DELETE', `/groups/${id}`, member)).status, 204);
  assert.equal((await getJson(f.url, `/groups/${id}`, member)).status, 403);
});

test('symmetric blocks prevent invitations but preserve accepted group access', async t => {
  const f = await fixture(t);
  const [owner, member, guest] = await Promise.all(['owner', 'member', 'guest'].map(f.session));
  const created = await postJson(f.url, '/groups', { name: 'Blocks', inviteeIds: ['member'] }, owner);
  const id = created.body.group.conversationId;
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 200);
  assert.equal((await postJson(f.url, '/blocks', { blockeeId: 'owner' }, guest)).status, 200);
  assert.equal((await postJson(f.url, `/groups/${id}/invitations`, { userId: 'guest' }, owner)).status, 403);
  assert.equal((await f.request('DELETE', '/blocks/owner', guest)).status, 200);
  assert.equal((await postJson(f.url, '/blocks', { blockeeId: 'guest' }, owner)).status, 200);
  assert.equal((await postJson(f.url, `/groups/${id}/invitations`, { userId: 'guest' }, owner)).status, 403);
  assert.equal((await postJson(f.url, '/groups', { name: 'Blocked creation', inviteeIds: ['guest'] }, owner)).status, 403);
  assert.equal((await postJson(f.url, '/blocks', { blockeeId: 'owner' }, member)).status, 200);
  const socket = await f.socket(member);
  assert.equal((await emit(socket, CLIENT_EVENTS.MESSAGE_SEND, { conversationId: id, body: 'still a member' })).ok, true);
  assert.equal((await getJson(f.url, `/groups/${id}/messages`, owner)).body.messages[0].body, 'still a member');
});

test('creation/invitation budgets are shared by REST and sockets and charged per invitee', async t => {
  const f = await fixture(t, { groupCreateRateLimit: 1, groupInviteRateLimit: 2 });
  const owner = await f.session('owner');
  const socket = await f.socket(owner);
  const created = await postJson(f.url, '/groups', { name: 'Budget' }, owner);
  assert.equal(created.status, 201);
  assert.equal((await emit(socket, CLIENT_EVENTS.CONVERSATION_CREATE, { name: 'Too many', inviteeIds: ['a'] })).error.code, 'rate_limited');
  const id = created.body.group.conversationId;
  assert.equal((await emit(socket, CLIENT_EVENTS.CONVERSATION_MEMBER_ADD, { conversationId: id, userIds: ['a', 'b'] })).ok, true);
  const limited = await postJson(f.url, `/groups/${id}/invitations`, { userId: 'c' }, owner);
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retryAfter > 0);
  assert.equal((await getJson(f.url, '/groups', owner)).body.groups.length, 1);
});

test('account export includes departed intervals and only own messages; erasure preserves shared history and collects last member', async t => {
  const store = createConversationStore();
  const f = await fixture(t, { conversationStore: store });
  const [owner, member, invitee] = await Promise.all(['owner', 'member', 'invitee'].map(f.session));
  const created = await postJson(f.url, '/groups', { name: 'Erasure', inviteeIds: ['member', 'invitee'] }, owner);
  const id = created.body.group.conversationId;
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 200);
  await store.saveMessage(message(id, 'member', 'own'));
  await store.saveMessage(message(id, 'owner', 'not-own'));
  assert.equal((await postJson(f.url, `/groups/${id}/leave`, {}, member)).status, 200);
  const archive = await getJson(f.url, '/account/export?limit=1', member);
  assert.equal(archive.status, 200);
  assert.equal(archive.body.groupMemberships.length, 1);
  assert.ok(archive.body.groupMemberships[0].leftAt);
  assert.deepEqual(archive.body.groupMessages.map((row: any) => row.messageId), ['own']);
  assert.equal((await postJson(f.url, '/account/delete', {}, owner)).status, 202);
  assert.equal(await f.runAccountDeletionSweep(), 1);
  assert.equal(await store.get(id), null, 'no active member remains, so the group is collected');
  assert.equal((await accept(f.url, created.body.invitations[1], invitee)).status, 400);

  const surviving = await store.create({ name: 'Survivors', creatorId: 'member', inviteeIds: ['invitee'] });
  await store.acceptInvitation({ conversationId: surviving.conversation.conversationId,
    invitationId: surviving.invitations![0].invitationId, userId: 'invitee' });
  await store.saveMessage(message(surviving.conversation.conversationId, 'member', 'erased'));
  assert.equal((await postJson(f.url, '/account/delete', {}, member)).status, 202);
  assert.equal(await f.runAccountDeletionSweep(), 1);
  const history = await getJson(f.url, `/groups/${surviving.conversation.conversationId}/messages`, invitee);
  assert.equal(history.status, 200);
  assert.equal(history.body.messages[0].body, '');
  assert.ok(history.body.messages[0].deletedAt);
  assert.match(history.body.messages[0].senderId, /^deleted-/);
  assert.equal((await store.get(surviving.conversation.conversationId))?.ownerId, 'invitee');
  assert.equal((await postJson(f.url, '/account/delete', {}, invitee)).status, 202);
  assert.equal(await f.runAccountDeletionSweep(), 1);
  assert.equal(await store.get(surviving.conversation.conversationId), null);
  assert.equal((await store.listInvitations('invitee')).length, 0);
});

test('group attachment scope and downloads enforce active membership and join watermark', async t => {
  const env = { R2_ACCOUNT_ID: 'test-account', R2_BUCKET: 'private-test', R2_ACCESS_KEY_ID: 'test-id', R2_SECRET_ACCESS_KEY: 'test-secret' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const store = createConversationStore();
  const f = await fixture(t, { conversationStore: store });
  const [owner, member] = await Promise.all(['owner', 'member'].map(f.session));
  const created = await postJson(f.url, '/groups', { name: 'Media', inviteeIds: ['member'] }, owner);
  const id = created.body.group.conversationId;
  const payload = { groupId: id, type: 'image', mimeType: 'image/jpeg', sizeBytes: 100 };
  assert.equal((await postJson(f.url, '/attachments/presign', payload, member)).status, 403);
  const upload = await postJson(f.url, '/attachments/presign', payload, owner);
  assert.equal(upload.status, 200);
  assert.ok(upload.body.key.startsWith(`chatblobs/group_${id}/`));
  const sent = await store.saveMessage({ ...message(id, 'owner', 'media-old'), type: 'image',
    attachment: { url: upload.body.key, mimeType: 'image/jpeg', sizeBytes: 100 } });
  assert.ok(sent);
  const path = `/attachments/download?groupId=${id}&messageId=media-old&key=${encodeURIComponent(upload.body.key)}`;
  assert.equal((await getJson(f.url, path, owner)).status, 200);
  assert.equal((await getJson(f.url, path, member)).status, 403);
  assert.equal((await accept(f.url, created.body.invitations[0], member)).status, 200);
  assert.equal((await getJson(f.url, path, member)).status, 403, 'knowing a key does not expose pre-join media');
  await store.saveMessage({ ...message(id, 'owner', 'media-new'), type: 'image',
    attachment: { url: upload.body.key, mimeType: 'image/jpeg', sizeBytes: 100 } });
  const visible = path.replace('media-old', 'media-new');
  assert.equal((await getJson(f.url, visible, member)).status, 200);
  assert.equal((await f.request('DELETE', `/groups/${id}/members/member`, owner)).status, 200);
  assert.equal((await getJson(f.url, visible, member)).status, 403);
  assert.equal((await postJson(f.url, '/attachments/presign', payload, member)).status, 403);
});

async function watermarkAndCapacity(t: Context, store: ConversationStore) {
  await t.test('new joins/rejoins never backfill history, reactions, replies or explicit-key retries', async () => {
    const created = await store.create({ name: 'Watermark', creatorId: 'owner', inviteeIds: ['member'] });
    const id = created.conversation.conversationId;
    const old = await store.saveMessage({ ...message(id, 'owner', 'before'), clientMessageId: randomUUID() });
    assert.ok(old);
    await store.acceptInvitation({ conversationId: id, invitationId: created.invitations![0].invitationId, userId: 'member' });
    assert.deepEqual(await store.listMessages({ conversationId: id, userId: 'member', limit: 100 }), []);
    assert.equal(await store.getMessage(id, 'before', 'member'), null);
    assert.deepEqual(await store.searchMessages({ conversationId: id, userId: 'member', query: 'notes', limit: 100 }), []);
    assert.equal(await store.reactToMessage({ conversationId: id, messageId: 'before', userId: 'member', emoji: '👍', action: 'add' }), null);
    await assert.rejects(store.saveMessage({ ...message(id, 'member'), replyTo: 'before' }), { code: 'forbidden' });
    const own = await store.saveMessage({ ...message(id, 'member', 'during'), clientMessageId: randomUUID() });
    assert.ok(own);
    await store.removeMember({ conversationId: id, actorId: 'owner', userId: 'member', reason: 'removed' });
    await assert.rejects(store.listMessages({ conversationId: id, userId: 'member', limit: 100 }), { code: 'not_member' });
    await store.saveMessage(message(id, 'owner', 'between'));
    await inviteAndAccept(store, id, 'owner', 'member');
    assert.deepEqual(await store.listMessages({ conversationId: id, userId: 'member', limit: 100 }), []);
    await assert.rejects(store.saveMessage({ ...own.message }), { code: 'forbidden' });
    await store.saveMessage(message(id, 'owner', 'after'));
    assert.deepEqual((await store.listMessages({ conversationId: id, userId: 'member', limit: 100 })).map(row => row.messageId), ['after']);
    const intervals = await store.exportMemberships('member');
    assert.equal(intervals.length, 2);
    assert.notEqual(intervals[0].memberId, intervals[1].memberId);
    assert.equal(intervals[0].departureActorId, 'owner');
    assert.equal(intervals[0].departureReason, 'removed');
    assert.ok(intervals[0].removedAt);
    assert.equal(intervals[1].leftAt, null);
  });
  await t.test('duplicate invitation/accept and concurrent final-slot capacity are atomic', async () => {
    const created = await store.create({ name: 'Capacity', creatorId: 'capacity-owner', inviteeIds: [] });
    const id = created.conversation.conversationId;
    for (let index = 0; index < 14; index++) await inviteAndAccept(store, id, 'capacity-owner', `capacity-${index}`);
    const invitations = await store.addMembers({ conversationId: id, actorId: 'capacity-owner', userIds: ['last-a', 'last-b'] });
    assert.ok(invitations?.invitations);
    await assert.rejects(store.addMembers({ conversationId: id, actorId: 'capacity-owner', userIds: ['last-a'] }), { code: 'invalid_members' });
    const results = await Promise.allSettled(invitations.invitations.map(invitation => store.acceptInvitation({
      conversationId: id, invitationId: invitation.invitationId, userId: invitation.inviteeId,
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'group_full');
    assert.equal((await store.listMembers(id)).length, 16);
    await assert.rejects(store.addMembers({ conversationId: id, actorId: 'capacity-owner', userIds: ['overflow'] }), { code: 'group_full' });
    const winner = invitations.invitations[results.findIndex(result => result.status === 'fulfilled')];
    await assert.rejects(store.acceptInvitation({ conversationId: id, invitationId: winner.invitationId, userId: winner.inviteeId }), { code: 'invalid_invitation' });
  });
  await t.test('simultaneous duplicate invitations and acceptance cannot create duplicate intervals', async () => {
    const group = await store.create({ name: 'Duplicates', creatorId: 'duplicate-owner', inviteeIds: [] });
    const conversationId = group.conversation.conversationId;
    const issued = await Promise.allSettled([0, 1].map(() =>
      store.addMembers({ conversationId, actorId: 'duplicate-owner', userIds: ['duplicate-member'] })));
    assert.equal(issued.filter(result => result.status === 'fulfilled').length, 1);
    const invitations = await store.listInvitations('duplicate-member');
    assert.equal(invitations.length, 1);
    const accepted = await Promise.allSettled([0, 1].map(() =>
      store.acceptInvitation({ conversationId, invitationId: invitations[0].invitationId, userId: 'duplicate-member' })));
    assert.equal(accepted.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await store.exportMemberships('duplicate-member')).length, 1);
  });
}

async function attachmentErasure(t: Context, store: ConversationStore) {
  async function queued(id: string) {
    return (await store.listAttachmentCleanup(500)).filter(key => key.startsWith(`chatblobs/group_${id}/`));
  }
  function media(conversationId: string, senderId: string, messageId: string, key: string) {
    return { ...message(conversationId, senderId, messageId), type: 'image',
      attachment: { url: key, mimeType: 'image/jpeg', sizeBytes: 100 } };
  }

  await t.test('erasing a copied attachment reference preserves the surviving sender reference', async () => {
    const group = await store.create({ name: 'Copied media', creatorId: 'media-owner', inviteeIds: ['media-copier'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'media-copier' });
    const key = `chatblobs/group_${id}/shared.jpg`;
    const ownKey = `chatblobs/group_${id}/copier.jpg`;
    await store.saveMessage(media(id, 'media-owner', 'original', key));
    await store.saveMessage(media(id, 'media-copier', 'copy', key));
    await store.saveMessage(media(id, 'media-copier', 'unshared', ownKey));
    await store.eraseUserData('media-copier', 'deleted-media-copier');
    const erased = await store.eraseUserMessages('media-copier', 'deleted-media-copier', 500);
    assert.deepEqual(erased.attachmentUrls, [ownKey]);
    assert.equal(erased.messagesTombstoned, 2);
    assert.equal((await store.getMessage(id, 'original', 'media-owner'))?.attachment?.url, key);
    assert.equal((await store.getMessage(id, 'copy', 'media-owner'))?.attachment, null);
    await store.eraseUserData('media-owner', 'deleted-media-owner');
    assert.equal((await store.eraseUserMessages('media-owner', 'deleted-media-owner', 500)).messagesProcessed, 0);
    assert.deepEqual(await queued(id), [ownKey, key].sort());
    assert.deepEqual(await store.exportMessages({ userId: 'deleted-media-owner', conversationId: id, limit: 100 }), []);
  });

  await t.test('last member without messages cannot cascade another erasure pending batches', async () => {
    const group = await store.create({ name: 'Interleaved erasure', creatorId: 'pending-owner', inviteeIds: ['empty-member'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'empty-member' });
    const keys = [1, 2].map(n => `chatblobs/group_${id}/pending-${n}.jpg`);
    for (const [index, key] of keys.entries()) await store.saveMessage(media(id, 'pending-owner', `pending-${index}`, key));
    // Pause A between membership erasure and batching while B finishes erasure.
    await store.eraseUserData('pending-owner', 'deleted-pending-owner');
    await store.eraseUserData('empty-member', 'deleted-empty-member');
    assert.equal((await store.eraseUserMessages('empty-member', 'deleted-empty-member', 500)).messagesProcessed, 0);
    assert.deepEqual(await store.exportMessages({ userId: 'pending-owner', conversationId: id, limit: 100 }), []);
    assert.deepEqual(await queued(id), keys);
    assert.equal((await store.eraseUserMessages('pending-owner', 'deleted-pending-owner', 1)).messagesProcessed, 0);
    assert.deepEqual(await store.exportMessages({ userId: 'deleted-pending-owner', conversationId: id, limit: 100 }), []);
    assert.deepEqual(await store.exportMemberships('deleted-empty-member'), []);
  });

  await t.test('shared keys across erasure pages are collected only after the last live reference', async () => {
    const group = await store.create({ name: 'Paged media', creatorId: 'paged-owner', inviteeIds: ['paged-survivor'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'paged-survivor' });
    const key = `chatblobs/group_${id}/paged.jpg`;
    await store.saveMessage(media(id, 'paged-owner', 'page-1', key));
    await store.saveMessage(media(id, 'paged-owner', 'page-2', key));
    await store.eraseUserData('paged-owner', 'deleted-paged-owner');
    assert.deepEqual((await store.eraseUserMessages('paged-owner', 'deleted-paged-owner', 1)).attachmentUrls, []);
    assert.deepEqual(await queued(id), []);
    assert.deepEqual((await store.eraseUserMessages('paged-owner', 'deleted-paged-owner', 1)).attachmentUrls, [key]);
    assert.deepEqual(await queued(id), [key]);
  });

  await t.test('last-member collection racing another erasure batch durably captures every reference', async () => {
    const group = await store.create({ name: 'Collection race', creatorId: 'race-last', inviteeIds: ['race-former'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'race-former' });
    const keys = [1, 2].map(n => `chatblobs/group_${id}/race-${n}.jpg`);
    for (const [n, key] of keys.entries()) await store.saveMessage(media(id, 'race-former', `race-${n}`, key));
    await store.eraseUserData('race-former', 'deleted-race-former');
    await Promise.all([
      store.eraseUserMessages('race-former', 'deleted-race-former', 1),
      store.eraseUserData('race-last', 'deleted-race-last'),
    ]);
    assert.deepEqual(await queued(id), keys);
    assert.deepEqual(await store.exportMessages({ userId: 'race-former', conversationId: id, limit: 100 }), []);
    assert.deepEqual(await store.exportMessages({ userId: 'deleted-race-former', conversationId: id, limit: 100 }), []);
    assert.deepEqual(await store.exportMemberships('deleted-race-last'), []);
  });

  await t.test('concurrent erasure of shared references captures cleanup exactly once', async () => {
    const group = await store.create({ name: 'Concurrent media', creatorId: 'concurrent-owner', inviteeIds: ['concurrent-member', 'concurrent-survivor'] });
    const id = group.conversation.conversationId;
    for (const invitation of group.invitations!) await store.acceptInvitation({
      conversationId: id, invitationId: invitation.invitationId, userId: invitation.inviteeId,
    });
    const key = `chatblobs/group_${id}/concurrent.jpg`;
    const users = ['concurrent-owner', 'concurrent-member'];
    for (const userId of users) await store.saveMessage(media(id, userId, userId, key));
    await Promise.all(users.map(userId => store.eraseUserData(userId, `deleted-${userId}`)));
    const pages = await Promise.all(users.map(userId => store.eraseUserMessages(userId, `deleted-${userId}`, 1)));
    assert.equal(pages.reduce((sum, page) => sum + page.messagesProcessed, 0), 2);
    assert.deepEqual(pages.flatMap(page => page.attachmentUrls), [key]);
    assert.deepEqual(await queued(id), [key]);
    await store.eraseUserData('concurrent-survivor', 'deleted-concurrent-survivor');
    assert.deepEqual(await store.exportMemberships('deleted-concurrent-owner'), []);
  });

  await t.test('last member erasure collects a former member who sent media and left normally', async () => {
    const group = await store.create({ name: 'Former media', creatorId: 'last-member', inviteeIds: ['former-member'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'former-member' });
    const key = `chatblobs/group_${id}/former.jpg`;
    await store.saveMessage(media(id, 'former-member', 'former', key));
    await store.leave({ conversationId: id, userId: 'former-member' });
    assert.equal((await store.getMessage(id, 'former', 'last-member'))?.attachment?.url, key);
    await store.eraseUserData('last-member', 'deleted-last-member');
    assert.equal((await store.eraseUserMessages('last-member', 'deleted-last-member', 1)).messagesProcessed, 0);
    assert.deepEqual(await store.exportMessages({ userId: 'former-member', conversationId: id, limit: 100 }), []);
    assert.deepEqual(await store.exportMemberships('former-member'), []);
    assert.deepEqual(await store.exportMemberships('deleted-last-member'), []);
    assert.deepEqual(await queued(id), [key]);
    // A's later erasure cannot lose or duplicate the independently held key.
    await store.eraseUserData('former-member', 'deleted-former-member');
    assert.equal((await store.eraseUserMessages('former-member', 'deleted-former-member', 1)).messagesProcessed, 0);
    assert.deepEqual(await queued(id), [key]);
  });

  await t.test('historical whitespace-padded surviving references use JavaScript trim semantics', async () => {
    const group = await store.create({ name: 'Trim media', creatorId: 'trim-owner', inviteeIds: ['trim-copy'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'trim-copy' });
    const whitespace = ['\t\n', '\r\v\f', '\u00a0\u1680', '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a',
      '\u2028\u2029\u202f\u205f\u3000\ufeff'];
    const keys = whitespace.map((_, n) => `chatblobs/group_${id}/trim-${n}.jpg`);
    for (const [n, padding] of whitespace.entries()) {
      await store.saveMessage(media(id, 'trim-owner', `survivor-${n}`, `${padding}${keys[n]}${padding}`));
      await store.saveMessage(media(id, 'trim-copy', `candidate-${n}`, ` ${keys[n]}\t`));
    }
    await store.eraseUserData('trim-copy', 'deleted-trim-copy');
    assert.deepEqual((await store.eraseUserMessages('trim-copy', 'deleted-trim-copy', 500)).attachmentUrls, []);
    assert.deepEqual(await queued(id), []);
    for (const [n, padding] of whitespace.entries()) {
      assert.equal((await store.getMessage(id, `survivor-${n}`, 'trim-owner'))?.attachment?.url, `${padding}${keys[n]}${padding}`);
    }
    await store.eraseUserData('trim-owner', 'deleted-trim-owner');
    assert.deepEqual(await queued(id), keys);
  });
}

async function attachmentCleanupRetries(t: Context, store: ConversationStore, reopen: () => ConversationStore) {
  // Isolate the worker assertions from earlier store-level erasure cases.
  for (const url of await store.listAttachmentCleanup(500)) await store.acknowledgeAttachmentCleanup(url);
  const group = await store.create({ name: 'Retry media', creatorId: 'retry-owner', inviteeIds: [] });
  const id = group.conversation.conversationId;
  const keys = Array.from({ length: 501 }, (_, n) => `chatblobs/group_${id}/retry-${String(n).padStart(3, '0')}.jpg`);
  for (const [n, key] of keys.entries()) {
    await store.saveMessage({ ...message(id, 'retry-owner', `retry-${n}`), type: 'image',
      attachment: { url: key, mimeType: 'image/jpeg', sizeBytes: 100 } });
  }
  await store.eraseUserData('retry-owner', 'deleted-retry-owner');
  // Simulate a crash between commit of collection and the first object DELETE.
  const restarted = reopen();
  assert.deepEqual(await restarted.exportMemberships('deleted-retry-owner'), []);
  assert.deepEqual(await restarted.listAttachmentCleanup(500), keys.slice(0, 500));
  assert.deepEqual(await restarted.listAttachmentCleanup(500, keys[499]), keys.slice(500));
  const envKeys = ['R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_ACCOUNT_ID'];
  const previous = envKeys.map(key => process.env[key]);
  t.after(() => envKeys.forEach((key, n) => {
    if (previous[n] === undefined) delete process.env[key];
    else process.env[key] = previous[n];
  }));
  envKeys.forEach(key => { delete process.env[key]; });
  const stores = createMemoryStores();
  stores.accountDeletions.set('retry-owner', { userId: 'retry-owner', status: 'completed',
    requestedAt: new Date().toISOString(), scheduledFor: new Date().toISOString(), completedAt: new Date().toISOString() });
  let failing = true;
  const attempts: string[] = [];
  const f = await fixture(t, { stores, conversationStore: restarted, attachmentFetch: async (input, init) => {
    assert.equal(init?.method, 'DELETE');
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.slice('/chat/'.length));
    attempts.push(key);
    assert.ok(keys.includes(key));
    if (failing && key === keys[0]) throw new Error('simulated object storage outage');
    return new Response(null, { status: failing && key === keys[1] ? 503 : key === keys[500] ? 404 : 204 });
  } });
  assert.equal(await f.runAccountDeletionSweep(), 0);
  assert.deepEqual(await restarted.listAttachmentCleanup(1), [keys[0]], 'no storage config must preserve the queue');
  process.env.R2_BUCKET = 'chat';
  process.env.R2_ACCESS_KEY_ID = 'test-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.R2_ENDPOINT = 'https://storage.example';
  assert.equal(await f.runAccountDeletionSweep(), 0, 'completed jobs must not need to run again');
  assert.deepEqual(attempts, keys, 'failed keys cannot stall the bounded sweep');
  assert.deepEqual(await restarted.listAttachmentCleanup(500), keys.slice(0, 2));
  failing = false;
  assert.equal(await f.runAccountDeletionSweep(), 0);
  assert.deepEqual(attempts.slice(501), keys.slice(0, 2));
  assert.deepEqual(await restarted.listAttachmentCleanup(500), []);
  await f.runAccountDeletionSweep();
  assert.equal(attempts.length, 503, 'acknowledged keys are not retried');
}

test('memory attachment erasure protects surviving references and pending cleanup', async t => {
  const store = createConversationStore();
  await attachmentErasure(t, store);
  await t.test('bounded cleanup retries survive completed jobs', async t => attachmentCleanupRetries(t, store, () => store));
});

test('REST leave and removal notify all call participants, including the departing member', async t => {
  for (const operation of ['leave', 'remove']) {
    for (const status of ['ringing', 'accepted'] as const) {
      await t.test(`${operation} ${status} participant`, async t => {
        const store = createConversationStore();
        const f = await fixture(t, { conversationStore: store });
        const owner = await f.session('call-owner');
        const member = await f.session('call-member');
        const sockets = await Promise.all([owner, member].map(f.socket));
        const group = await store.create({ name: 'REST calls', creatorId: 'call-owner', inviteeIds: ['call-member'] });
        const id = group.conversation.conversationId;
        await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'call-member' });
        const started = await store.startCall({ conversationId: id,
          initiatorId: status === 'ringing' ? 'call-owner' : 'call-member', mediaType: 'audio', ringTimeoutMs: 60_000 });
        assert.ok(started);
        let previous = started;
        if (status === 'accepted') {
          const declined = await store.transitionCall({ callId: started.call.callId, userId: 'call-owner', action: 'decline' });
          assert.ok(declined);
          previous = declined;
        }
        const previousVersion = previous.call.stateVersion;
        const notifications = sockets.map(socket => new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('REST departure call notification missing')), 1500);
          socket.once(SERVER_EVENTS.CONVERSATION_CALL_UPDATED, payload => { clearTimeout(timer); resolve(payload); });
        }));
        const received = Promise.all(notifications);
        const result = operation === 'leave'
          ? await f.request('POST', `/groups/${id}/leave`, member)
          : await f.request('DELETE', `/groups/${id}/members/call-member`, owner);
        assert.equal(result.status, 200);
        for (const payload of await received) {
          assert.equal(payload.version, SIGNALING_VERSION);
          assert.equal(payload.conversationId, id);
          assert.equal(payload.callId, started.call.callId);
          assert.equal(payload.call.stateVersion, previousVersion + 1);
          assert.equal(payload.call.status, status === 'accepted' ? 'ended' : started.call.status);
          assert.equal(payload.participants.find((participant: any) => participant.userId === 'call-member').status, 'left');
        }
        // An ended call must not be rescheduled by the ringing-timeout worker.
        if (status === 'accepted') {
          assert.equal(await store.expireCall(started.call.callId, Date.now() + 120_000), null);
          assert.deepEqual(await store.listExpiredCallIds(Date.now() + 120_000), []);
        }
      });
    }
  }
});

async function verifyCallLog(t: Context, store: ConversationStore, restartStore: () => ConversationStore = () => store) {
  const f = await fixture(t, { conversationStore: store });
  const owner = await f.session('log-owner');
  const member = await f.session('log-member');
  const outsider = await f.session('log-outsider');
  const group = await store.create({ name: 'Log team', creatorId: 'log-owner', inviteeIds: ['log-member'] });
  const id = group.conversation.conversationId;
  await store.acceptInvitation({ conversationId: id, userId: 'log-member', invitationId: group.invitations![0].invitationId });
  const first = (await store.startCall({ conversationId: id, initiatorId: 'log-owner', mediaType: 'audio', ringTimeoutMs: 60_000 }))!;
  await store.expireCall(first.call.callId, Date.now() + 61_000);
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = (await store.startCall({ conversationId: id, initiatorId: 'log-owner', mediaType: 'video', ringTimeoutMs: 60_000 }))!;
  await store.transitionCall({ callId: second.call.callId, userId: 'log-member', action: 'accept' });
  await store.transitionCall({ callId: second.call.callId, userId: 'log-member', action: 'leave' });
  await store.transitionCall({ callId: second.call.callId, userId: 'log-owner', action: 'leave' });
  await postJson(f.url, '/calls', { calleeId: 'log-ghost', mediaType: 'audio' }, owner);
  assert.equal((await getJson(f.url, '/calls')).status, 401);
  assert.equal((await getJson(f.url, '/calls', outsider)).body.total, 0);
  const log = (await getJson(f.url, '/calls', owner)).body;
  assert.equal(log.total, 3);
  const groupEntry = log.calls.find((entry: any) => entry.callId === first.call.callId);
  assert.equal(groupEntry.kind, 'group');
  assert.equal(groupEntry.conversationId, id);
  assert.equal(groupEntry.groupName, 'Log team');
  assert.equal(groupEntry.initiatorId, 'log-owner');
  assert.equal(groupEntry.calleeId, undefined);
  assert.equal(log.calls.find((entry: any) => entry.kind !== 'group').calleeId, 'log-ghost');
  const paged: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const page = (await getJson(f.url, `/calls?limit=1&offset=${offset}`, owner)).body;
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, offset < 2);
    paged.push(page.calls[0].callId);
  }
  assert.deepEqual(paged, log.calls.map((entry: any) => entry.callId));
  const missed = (await getJson(f.url, '/calls?status=missed', member)).body;
  assert.equal(missed.total, 1);
  assert.equal(missed.calls[0].callId, first.call.callId);
  const timeline = (await getJson(f.url, `/conversations/${id}/messages?limit=1`, member)).body;
  assert.equal(timeline.messages[0].type, 'system');
  assert.equal(timeline.messages[0].body, 'Group video call · Joined · Ended');
  assert.equal(timeline.hasMore, true);
  const older = (await getJson(f.url, `/groups/${id}/messages?limit=1&before=${encodeURIComponent(timeline.nextCursor.before)}&beforeMessageId=${timeline.nextCursor.beforeMessageId}`, member)).body;
  assert.equal(older.messages[0].body, 'Group audio call · Missed · Ended');
  const restarted = await fixture(t, { conversationStore: restartStore() });
  const restartedMember = await restarted.session('log-member');
  const recovered = (await getJson(restarted.url, `/groups/${id}/messages`, restartedMember)).body;
  assert.deepEqual(recovered.messages.map((entry: any) => entry.body), [
    'Group video call · Joined · Ended', 'Group audio call · Missed · Ended',
  ]);
  assert.equal((await getJson(restarted.url, '/calls', restartedMember)).body.total, 2);
  await store.removeMember({ conversationId: id, actorId: 'log-owner', userId: 'log-member' });
  assert.equal((await getJson(f.url, '/calls', member)).body.total, 2);
  assert.equal((await getJson(restarted.url, '/calls', restartedMember)).body.total, 2);
  assert.equal((await getJson(f.url, `/groups/${id}/messages`, member)).status, 403);
}

test('GET /calls merges durable group attribution with direct calls, paginates and rechecks membership', async t => {
  await verifyCallLog(t, createConversationStore());
});

test('memory store interval and race contract', async t => {
  await watermarkAndCapacity(t, createConversationStore());
});

test('invitations expire after exactly seven days and can then be replaced', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = createConversationStore();
  const created = await store.create({ name: 'Expiry', creatorId: 'owner', inviteeIds: ['member'] });
  const invitation = created.invitations![0];
  assert.equal(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt), 7 * 24 * 60 * 60 * 1000);
  t.mock.timers.setTime(Date.parse(invitation.expiresAt));
  assert.deepEqual(await store.listInvitations('member'), []);
  await assert.rejects(store.acceptInvitation({ conversationId: invitation.conversationId,
    invitationId: invitation.invitationId, userId: 'member' }), { code: 'invalid_invitation' });
  assert.ok((await store.addMembers({ conversationId: invitation.conversationId, actorId: 'owner', userIds: ['member'] }))?.invitations?.[0]);
});

test('PostgreSQL migration, durable admission and transaction races', { skip: !process.env.DATABASE_URL }, async t => {
  const databaseName = `groups_536_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString() });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL('../db/migrations', import.meta.url).pathname });
  const store = createConversationStore({ db });
  await t.test('group call HTTP history survives server/store recreation and preserves attribution', async t =>
    verifyCallLog(t, store, () => createConversationStore({ db })));
  await watermarkAndCapacity(t, store);
  await attachmentErasure(t, store);
  await t.test('durable cleanup survives store recreation and object storage failure', async t =>
    attachmentCleanupRetries(t, store, () => createConversationStore({ db })));
  await t.test('invitation durability, database expiry and symmetric durable blocks', async () => {
    const group = await store.create({ name: 'Durable', creatorId: 'durable-owner', inviteeIds: ['durable-member'] });
    const id = group.conversation.conversationId;
    const invitation = group.invitations![0];
    assert.equal((await createConversationStore({ db }).listInvitations('durable-member'))[0].invitationId, invitation.invitationId);
    await db.update(schema.groupInvitations).set({ expiresAt: new Date(0) }).where(eq(schema.groupInvitations.invitationId, invitation.invitationId));
    await assert.rejects(store.acceptInvitation({ conversationId: id, invitationId: invitation.invitationId, userId: invitation.inviteeId }), { code: 'invalid_invitation' });
    await inviteAndAccept(store, id, 'durable-owner', 'durable-member');
    await db.insert(schema.blocks).values({ blockerId: 'durable-guest', blockeeId: 'durable-owner' });
    await assert.rejects(store.addMembers({ conversationId: id, actorId: 'durable-owner', userIds: ['durable-guest'] }), { code: 'forbidden' });
    await db.delete(schema.blocks).where(eq(schema.blocks.blockerId, 'durable-guest'));
    await db.insert(schema.blocks).values({ blockerId: 'durable-owner', blockeeId: 'durable-guest' });
    await assert.rejects(store.addMembers({ conversationId: id, actorId: 'durable-owner', userIds: ['durable-guest'] }), { code: 'forbidden' });
    await db.insert(schema.blocks).values({ blockerId: 'durable-owner', blockeeId: 'durable-member' });
    assert.ok(await store.saveMessage(message(id, 'durable-member')));
  });
  await t.test('removal/send serialize and erasure retains other members history then cascades last-member cleanup', async () => {
    const group = await store.create({ name: 'Race', creatorId: 'race-owner', inviteeIds: ['race-member'] });
    const id = group.conversation.conversationId;
    await store.acceptInvitation({ conversationId: id, invitationId: group.invitations![0].invitationId, userId: 'race-member' });
    const results = await Promise.allSettled([
      store.saveMessage(message(id, 'race-member', 'raced')),
      store.removeMember({ conversationId: id, actorId: 'race-owner', userId: 'race-member' }),
    ]);
    assert.equal(results[1].status, 'fulfilled');
    const history = await store.listMessages({ conversationId: id, userId: 'race-owner', limit: 100 });
    assert.equal(history.length, results[0].status === 'fulfilled' ? 1 : 0);
    await assert.rejects(store.saveMessage(message(id, 'race-member')), { code: 'not_member' });
    await inviteAndAccept(store, id, 'race-owner', 'race-member');
    await store.saveMessage(message(id, 'race-owner', 'survives'));
    await store.reactToMessage({ conversationId: id, messageId: 'survives', userId: 'race-member', emoji: '👍', action: 'add' });
    await store.saveMessage(message(id, 'race-member', 'erase-me'));
    await store.eraseUserData('race-member', 'deleted-race-member');
    await store.eraseUserMessages('race-member', 'deleted-race-member', 500);
    const erased = await store.getMessage(id, 'erase-me', 'race-owner');
    assert.equal(erased?.body, '');
    assert.equal(erased?.senderId, 'deleted-race-member');
    assert.ok(erased?.deletedAt);
    assert.deepEqual((await store.getMessage(id, 'survives', 'race-owner'))?.reactions, {});
    await store.eraseUserData('race-owner', 'deleted-race-owner');
    await store.eraseUserMessages('race-owner', 'deleted-race-owner', 500);
    assert.equal(await store.get(id), null);
    assert.equal((await db.select().from(schema.groupConversationMembers).where(eq(schema.groupConversationMembers.conversationId, id))).length, 0);
    assert.equal((await db.select().from(schema.groupInvitations).where(eq(schema.groupInvitations.conversationId, id))).length, 0);
    assert.equal((await db.select().from(schema.groupMessages).where(eq(schema.groupMessages.conversationId, id))).length, 0);
  });
});
