import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { CLIENT_EVENTS, SERVER_EVENTS, SIGNALING_VERSION } from '../../shared/index.ts';
import { createConversationStore, createMemoryMessageBus, createServer } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

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

    const departed = await emitWithAck(alice, CLIENT_EVENTS.CONVERSATION_LEAVE, {
      version: SIGNALING_VERSION,
      conversationId,
    });
    assert.equal(departed.ok, true);
    assert.equal(departed.conversation.memberIds.includes('alice'), false);
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

    await emitWithAck(accepting, CLIENT_EVENTS.CONVERSATION_CALL_LEAVE, {
      version: SIGNALING_VERSION,
      callId: started.call.callId,
    });
    const ended = await emitWithAck(caller, CLIENT_EVENTS.CONVERSATION_CALL_LEAVE, {
      version: SIGNALING_VERSION,
      callId: started.call.callId,
    });
    assert.equal(ended.call.status, 'ended');
  } finally {
    await teardown(caller, accepting, declining);
  }
});
