import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { API_ROUTES, CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } from '../../shared/index.ts';
import { fanoutConversationEvent } from '../src/domain/conversationFanout.ts';
import { createConversationStore, createMemoryMessageBus, createServer } from '../src/index.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  return {
    ...server,
    url: `http://127.0.0.1:${port}`,
    teardown: async (...sockets: import('socket.io-client').Socket[]) => {
      sockets.forEach((socket) => socket.disconnect());
      await closeTestServer(server);
    },
  };
}

async function createSession(url: string, userId: string): Promise<string> {
  const result = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(result.status, 201);
  return result.body.sessionId;
}

function connect(url: string, sessionId: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { sessionId },
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitFor(socket: import('socket.io-client').Socket, event: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1500);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('group explicit keys retry once, reject mismatches and allow different senders', async () => {
  const { url, teardown } = await startServer();
  const sessions = await Promise.all(['alice', 'bob'].map(id => createSession(url, id)));
  const [alice, bob] = await Promise.all(sessions.map(session => connect(url, session)));
  try {
    const created = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_CREATE, {
      version: SIGNALING_VERSION, name: 'Keys', inviteeIds: ['bob'],
    });
    const conversationId = created.conversation.conversationId;
    const clientMessageId = '27b4f6df-7ae8-44f8-8e3d-51f6d549d552';
    const payload = { version: SIGNALING_VERSION, conversationId, body: 'once', clientMessageId };
    let deliveries = 0;
    bob.on(SERVER_EVENTS.MESSAGE_RECEIVED, () => { deliveries += 1; });
    const first = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, payload);
    assert.equal(first.ok, true);
    assert.notEqual(first.message.messageId, clientMessageId);
    assert.deepEqual(await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, payload), first);
    const rejected = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, { ...payload, body: 'changed' });
    assert.equal(rejected.error.code, 'bad_request');
    const other = await emitWithAck(bob, CLIENT_EVENTS.MESSAGE_SEND, payload);
    assert.equal(other.ok, true);
    assert.notEqual(other.message.messageId, first.message.messageId);
    const deleted = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_DELETE, {
      version: SIGNALING_VERSION, conversationId, messageId: first.message.messageId,
    });
    assert.equal(deleted.ok, true);
    const tombstoneReplay = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, payload);
    assert.equal(tombstoneReplay.ok, true);
    assert.equal(tombstoneReplay.message.messageId, first.message.messageId);
    assert.equal(tombstoneReplay.message.createdAt, first.message.createdAt);
    assert.equal(tombstoneReplay.message.body, '');
    assert.ok(tombstoneReplay.message.deletedAt);
    const history = await getJson(url, `${API_ROUTES.CONVERSATIONS}/${conversationId}/messages`, sessions[0]);
    assert.equal(history.body.messages.length, 2);
    assert.equal(deliveries, 1);
  } finally {
    await teardown(alice, bob);
  }
});

test('group messages require active membership and fan out to every current member', async () => {
  const { url, teardown } = await startServer();
  const sessions = await Promise.all(['alice', 'bob', 'carol', 'mallory'].map((id) => createSession(url, id)));
  const [alice, bob, carol, mallory] = await Promise.all(sessions.map((session) => connect(url, session)));
  try {
    const created = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_CREATE, {
      version: SIGNALING_VERSION,
      name: 'Study team',
      inviteeIds: ['bob', 'carol'],
    });
    assert.equal(created.ok, true);
    const conversationId = created.conversation.conversationId;
    assert.deepEqual(created.conversation.memberIds, ['alice', 'bob', 'carol']);

    const bobMessage = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
    const carolMessage = waitFor(carol, SERVER_EVENTS.MESSAGE_RECEIVED);
    const sent = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION,
      conversationId,
      body: 'hello group',
      messageId: 'group-message-1',
    });
    assert.equal(sent.ok, true);
    assert.equal((await bobMessage).message.body, 'hello group');
    assert.equal((await carolMessage).message.messageId, 'group-message-1');

    await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION,
      conversationId,
      body: 'second message',
      messageId: 'group-message-2',
    });
    const list = await getJson(url, API_ROUTES.CONVERSATIONS, sessions[0]);
    assert.equal(list.status, 200);
    assert.equal(list.body.groupConversations[0].conversationId, conversationId);

    const historyPath = `${API_ROUTES.CONVERSATIONS}/${conversationId}/messages`;
    const firstPage = await getJson(url, `${historyPath}?limit=1`, sessions[0]);
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.messages[0].messageId, 'group-message-2');
    assert.equal(firstPage.body.hasMore, true);
    const next = firstPage.body.nextCursor;
    const secondPage = await getJson(
      url,
      `${historyPath}?limit=1&before=${encodeURIComponent(next.before)}&beforeMessageId=${encodeURIComponent(next.beforeMessageId)}`,
      sessions[0]
    );
    assert.equal(secondPage.body.messages[0].messageId, 'group-message-1');
    const unauthorizedHistory = await getJson(url, historyPath, sessions[3]);
    assert.equal(unauthorizedHistory.status, 403);

    const reactionEvent = waitFor(alice, SERVER_EVENTS.MESSAGE_REACTION);
    const reaction = await emitWithAck(bob, CLIENT_EVENTS.MESSAGE_REACT, {
      version: SIGNALING_VERSION,
      conversationId,
      messageId: 'group-message-1',
      emoji: '👍',
      action: 'add',
    });
    assert.equal(reaction.ok, true);
    assert.deepEqual((await reactionEvent).reactions['👍'], ['bob']);

    const typingEvent = waitFor(alice, SERVER_EVENTS.MESSAGE_TYPING);
    bob.emit(CLIENT_EVENTS.MESSAGE_TYPING, {
      version: SIGNALING_VERSION,
      conversationId,
      isTyping: true,
    });
    assert.equal((await typingEvent).senderId, 'bob');

    const unauthorized = await emitWithAck(mallory, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION,
      conversationId,
      body: 'not a member',
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, 'forbidden');
    const unauthorizedDelete = await emitWithAck(mallory, CLIENT_EVENTS.MESSAGE_DELETE, {
      version: SIGNALING_VERSION,
      conversationId,
      messageId: 'group-message-1',
    });
    assert.equal(unauthorizedDelete.ok, false);
    assert.equal(unauthorizedDelete.error.code, 'forbidden');
    const unauthorizedReaction = await emitWithAck(mallory, CLIENT_EVENTS.MESSAGE_REACT, {
      version: SIGNALING_VERSION,
      conversationId,
      messageId: 'group-message-1',
      emoji: '👍',
      action: 'add',
    });
    assert.equal(unauthorizedReaction.ok, false);
    assert.equal(unauthorizedReaction.error.code, 'forbidden');

    const nonOwnerRename = await emitWithAck(bob, CLIENT_EVENTS.CONVERSATION_UPDATE, {
      version: SIGNALING_VERSION,
      conversationId,
      name: 'Renamed',
    });
    assert.equal(nonOwnerRename.ok, false);
    assert.equal(nonOwnerRename.error.code, 'forbidden');

    const addedUpdate = waitFor(mallory, SERVER_EVENTS.CONVERSATION_UPDATED);
    const added = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_MEMBER_ADD, {
      version: SIGNALING_VERSION,
      conversationId,
      userIds: ['mallory'],
    });
    assert.equal(added.ok, true);
    assert.deepEqual(added.conversation.memberIds, ['alice', 'bob', 'carol', 'mallory']);
    assert.equal((await addedUpdate).conversation.membershipVersion, added.conversation.membershipVersion);
    const newMemberHistory = await getJson(url, historyPath, sessions[3]);
    assert.equal(newMemberHistory.body.messages.length, 0);

    const nonOwnerRemoval = await emitWithAck(bob, CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE, {
      version: SIGNALING_VERSION,
      conversationId,
      userId: 'carol',
    });
    assert.equal(nonOwnerRemoval.ok, false);
    assert.equal(nonOwnerRemoval.error.code, 'forbidden');

    const removedUpdate = waitFor(mallory, SERVER_EVENTS.CONVERSATION_UPDATED);
    const removed = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_MEMBER_REMOVE, {
      version: SIGNALING_VERSION,
      conversationId,
      userId: 'mallory',
    });
    assert.equal(removed.ok, true);
    assert.equal(removed.conversation.memberIds.includes('mallory'), false);
    assert.equal((await removedUpdate).conversation.memberIds.includes('mallory'), false);
    assert.equal((await getJson(url, historyPath, sessions[3])).status, 403);

    const departed = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_LEAVE, {
      version: SIGNALING_VERSION,
      conversationId,
    });
    assert.equal(departed.ok, true);
    assert.equal(departed.conversation.memberIds.includes('alice'), false);
    assert.equal(departed.conversation.ownerId, 'bob');
    const departedHistory = await getJson(url, historyPath, sessions[0]);
    assert.equal(departedHistory.status, 403);
    const formerMemberSend = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION,
      conversationId,
      body: 'after leaving',
    });
    assert.equal(formerMemberSend.ok, false);
    assert.equal(formerMemberSend.error.code, 'forbidden');
  } finally {
    await teardown(alice, bob, carol, mallory);
  }
});

test('group message fan-out crosses instances through the message bus', async () => {
  const messageBus = createMemoryMessageBus();
  const conversationStore = createConversationStore();
  const first = await startServer({ messageBus, conversationStore });
  const second = await startServer({ messageBus, conversationStore });
  const aliceSession = await createSession(first.url, 'multi-alice');
  const bobSession = await createSession(second.url, 'multi-bob');
  const alice = await connect(first.url, aliceSession);
  const bob = await connect(second.url, bobSession);
  try {
    await Promise.all([
      first.conversationFanoutSubscriptionReady,
      second.conversationFanoutSubscriptionReady,
    ]);
    const created = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_CREATE, {
      version: SIGNALING_VERSION,
      name: 'Cross instance',
      inviteeIds: ['multi-bob'],
    });
    const received = waitFor(bob, SERVER_EVENTS.MESSAGE_RECEIVED);
    const sent = await emitWithAck(alice, CLIENT_EVENTS.MESSAGE_SEND, {
      version: SIGNALING_VERSION,
      conversationId: created.conversation.conversationId,
      body: 'over the bus',
      messageId: 'bus-message-1',
    });
    assert.equal(sent.ok, true);
    assert.equal((await received).message.body, 'over the bus');
  } finally {
    await first.teardown(alice);
    await second.teardown(bob);
    await messageBus.close();
  }
});

test('group calls ring participants, record individual decisions, and end after the last leaves', async () => {
  const { url, teardown } = await startServer();
  const sessions = await Promise.all(['caller', 'accepting', 'declining'].map((id) => createSession(url, id)));
  const [caller, accepting, declining] = await Promise.all(sessions.map((session) => connect(url, session)));
  try {
    const created = await emitWithAck(caller, CLIENT_EVENTS.CONVERSATION_CREATE, {
      version: SIGNALING_VERSION,
      name: 'Call group',
      inviteeIds: ['accepting', 'declining'],
    });
    const conversationId = created.conversation.conversationId;

    const acceptingRinging = waitFor(accepting, SERVER_EVENTS.CONVERSATION_CALL_UPDATED);
    const decliningRinging = waitFor(declining, SERVER_EVENTS.CONVERSATION_CALL_UPDATED);
    const started = await emitWithAck(caller, CLIENT_EVENTS.CONVERSATION_CALL_START, {
      version: SIGNALING_VERSION,
      conversationId,
      mediaType: 'audio',
    });
    assert.equal(started.ok, true);
    assert.equal(started.call.status, 'ringing');
    assert.equal((await acceptingRinging).call.status, 'ringing');
    assert.equal((await decliningRinging).call.callId, started.call.callId);

    const acceptedUpdate = waitFor(caller, SERVER_EVENTS.CONVERSATION_CALL_UPDATED);
    const accepted = await emitWithAck(accepting, CLIENT_EVENTS.CONVERSATION_CALL_ACCEPT, {
      version: SIGNALING_VERSION,
      callId: started.call.callId,
    });
    assert.equal(accepted.call.status, 'active');
    assert.equal((await acceptedUpdate).participants.find((participant: any) => participant.userId === 'accepting').status, 'accepted');

    const declined = await emitWithAck(declining, CLIENT_EVENTS.CONVERSATION_CALL_DECLINE, {
      version: SIGNALING_VERSION,
      callId: started.call.callId,
    });
    assert.equal(declined.participants.find((participant: any) => participant.userId === 'declining').status, 'declined');

    const leftGroupCall = waitFor(caller, SERVER_EVENTS.CONVERSATION_CALL_UPDATED);
    const leftGroup = await emitWithAck(accepting, CLIENT_EVENTS.CONVERSATION_LEAVE, {
      version: SIGNALING_VERSION,
      conversationId,
    });
    assert.equal(leftGroup.ok, true);
    const afterMemberLeaves = await leftGroupCall;
    assert.equal(
      afterMemberLeaves.participants.find((participant: any) => participant.userId === 'accepting').status,
      'left'
    );
    assert.equal(afterMemberLeaves.call.status, 'active');
    assert.ok(afterMemberLeaves.call.stateVersion > accepted.call.stateVersion);

    const ended = await emitWithAck(caller, CLIENT_EVENTS.CONVERSATION_CALL_LEAVE, {
      version: SIGNALING_VERSION,
      callId: started.call.callId,
    });
    assert.equal(ended.call.status, 'ended');
    assert.ok(ended.call.stateVersion > afterMemberLeaves.call.stateVersion);
  } finally {
    await teardown(caller, accepting, declining);
  }
});

test('group call ring deadlines survive process timers and reject late accepts', async () => {
  const store = createConversationStore();
  const { conversation } = await store.create({
    name: 'Expiry group',
    creatorId: 'expiry-caller',
    inviteeIds: ['expiry-invitee'],
  });
  const sweptCall = await store.startCall({
    conversationId: conversation.conversationId,
    initiatorId: 'expiry-caller',
    mediaType: 'audio',
    ringTimeoutMs: 0,
  });
  assert.ok(sweptCall);
  assert.deepEqual(await store.listExpiredCallIds(), [sweptCall.call.callId]);
  const expired = await store.expireCall(sweptCall.call.callId);
  assert.equal(expired?.call.status, 'ended');
  assert.equal(expired?.call.stateVersion, 2);
  assert.equal(await store.expireCall(sweptCall.call.callId), null);

  const lateCall = await store.startCall({
    conversationId: conversation.conversationId,
    initiatorId: 'expiry-caller',
    mediaType: 'audio',
    ringTimeoutMs: 0,
  });
  assert.ok(lateCall);
  const lateAccept = await store.transitionCall({
    callId: lateCall.call.callId,
    userId: 'expiry-invitee',
    action: 'accept',
  });
  assert.equal(lateAccept?.call.status, 'ended');
  assert.equal(lateAccept?.expired, true);
  assert.equal(lateAccept?.call.stateVersion, 2);
});

test('ring expiry declines pending invitees without ending an active group call', async () => {
  const store = createConversationStore();
  const { conversation } = await store.create({
    name: 'Active expiry group',
    creatorId: 'active-caller',
    inviteeIds: ['active-member', 'still-ringing'],
  });
  const started = await store.startCall({
    conversationId: conversation.conversationId,
    initiatorId: 'active-caller',
    mediaType: 'audio',
    ringTimeoutMs: 20,
  });
  assert.ok(started);
  const accepted = await store.transitionCall({
    callId: started.call.callId,
    userId: 'active-member',
    action: 'accept',
  });
  assert.equal(accepted?.call.status, 'active');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const expired = await store.expireCall(started.call.callId);
  assert.equal(expired?.call.status, 'active');
  assert.equal(expired?.call.stateVersion, 3);
  assert.equal(
    expired?.participants.find(({ userId }) => userId === 'active-member')?.status,
    'accepted'
  );
  assert.equal(
    expired?.participants.find(({ userId }) => userId === 'still-ringing')?.status,
    'declined'
  );
});

test('call fan-out drops snapshots older than the newest committed state version', async () => {
  const emitted: number[] = [];
  const io = {
    to: () => ({
      emit: (_eventName: string, payload: any) => emitted.push(payload.call.stateVersion),
    }),
  };
  const event = (stateVersion: number) => ({
    conversationId: 'group-call-version',
    eventName: SERVER_EVENTS.CONVERSATION_CALL_UPDATED,
    recipientIds: ['version-member'],
    payload: {
      version: SIGNALING_VERSION,
      conversationId: 'group-call-version',
      callId: 'version-call',
      call: { callId: 'version-call', stateVersion },
    },
  });

  await fanoutConversationEvent(io, {} as any, event(2));
  await fanoutConversationEvent(io, {} as any, event(1));
  assert.deepEqual(emitted, [2]);
});
