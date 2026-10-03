import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/memory.ts';
import { pushSenders } from '../src/push.ts';
import { buildCallEnvelope, buildMessageEnvelope } from '../src/push/envelopes.ts';
import type { CallPushData, MessagePushData } from '../src/push/types.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

async function startIdentityServer(t: import('node:test').TestContext) {
  const stores = createMemoryStores();
  const server = createServer({ stores });
  t.after(() => closeTestServer(server));
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  const caller = await postJson(url, '/session', {
    userId: 'identity-alice', deviceId: 'identity-alice-device',
  });
  const callee = await postJson(url, '/session', {
    userId: 'identity-bob', deviceId: 'identity-bob-device',
  });
  assert.equal(caller.status, 201);
  assert.equal(callee.status, 201);
  const registered = await postJson(url, '/devices/register', {
    provider: 'fcm', pushToken: 'identity-bob-token',
  }, callee.body.sessionId);
  assert.equal(registered.status, 200);

  async function updateName(displayName: string | null) {
    const response = await fetch(`${url}/profile`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + caller.body.sessionId,
      },
      body: JSON.stringify({ displayName }),
    });
    assert.equal(response.status, 200);
    assert.equal(stores.users.get('identity-alice')?.displayName, displayName);
  }
  await updateName('Alice Stored');
  return { url, sessionId: caller.body.sessionId as string, updateName };
}

test('incoming call push uses the stored profile, not client-supplied names', async (t) => {
  const calls: CallPushData[] = [];
  const original = pushSenders.sendIncomingCallPush;
  t.after(() => { pushSenders.sendIncomingCallPush = original; });
  pushSenders.sendIncomingCallPush = async (channel, data) => {
    calls.push(data);
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  const { url, sessionId } = await startIdentityServer(t);
  const created = await postJson(url, '/calls', {
    calleeId: 'identity-bob', callerDisplayName: 'Spoofed Caller',
  }, sessionId);
  assert.equal(created.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callerId, 'identity-alice');
  assert.equal(calls[0].callerDisplayName, 'Alice Stored');
  const envelope = buildCallEnvelope(calls[0]);
  assert.equal(envelope.body, 'Call from Alice Stored');
  assert.equal(envelope.data.callerDisplayName, 'Alice Stored');
  assert.equal(envelope.data.callerId, 'identity-alice');
});

test('message push reads the current stored profile and falls back after it is cleared', async (t) => {
  const messages: MessagePushData[] = [];
  const original = pushSenders.sendMessagePush;
  t.after(() => { pushSenders.sendMessagePush = original; });
  pushSenders.sendMessagePush = async (channel, data) => {
    messages.push(data);
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  const { url, sessionId, updateName } = await startIdentityServer(t);
  const socket = ioClient(url, { auth: { sessionId }, reconnection: false });
  t.after(() => socket.disconnect());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  async function sendMessage(body: string) {
    const ack = await socket.emitWithAck('message.send', {
      version: 2, recipientId: 'identity-bob', body,
      senderId: 'spoofed-id', senderDisplayName: 'Spoofed Sender',
    });
    assert.equal(ack.ok, true);
  }
  await sendMessage('  hello   there  ');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderId, 'identity-alice');
  assert.equal(messages[0].senderDisplayName, 'Alice Stored');
  const envelope = buildMessageEnvelope(messages[0]);
  assert.equal(envelope.title, 'Alice Stored');
  assert.equal(envelope.body, 'hello there');
  assert.equal(envelope.data.senderId, 'identity-alice');

  await updateName('Alice Renamed');
  await sendMessage('renamed');
  assert.equal(messages[1].senderDisplayName, 'Alice Renamed');
  assert.equal(buildMessageEnvelope(messages[1]).title, 'Alice Renamed');

  await updateName(null);
  await sendMessage('cleared');
  assert.equal(messages.length, 3);
  assert.equal(messages[2].senderDisplayName, null);
  assert.equal(buildMessageEnvelope(messages[2]).title, 'identity-alice');
});
