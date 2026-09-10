import assert from 'node:assert/strict';
import test from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { CALL_TRANSITION_CHANNEL } from '../src/config.ts';
import { createServer } from '../src/index.ts';
import { pushSenders } from '../src/push.ts';
import { closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  return {
    ...server,
    url: `http://127.0.0.1:${port}`,
    teardown: () => closeTestServer(server),
  };
}

async function createSession(url: string, userId: string, deviceId: string): Promise<string> {
  const response = await postJson(url, '/session', { userId, deviceId });
  assert.equal(response.status, 201);
  return response.body.sessionId;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function spyOnIncomingPush() {
  const original = pushSenders.sendIncomingCallPush;
  const calls: Array<{ channel: unknown; payload: unknown; }> = [];
  pushSenders.sendIncomingCallPush = async (channel, payload) => {
    calls.push({ channel, payload });
    return { ok: true, provider: channel.provider, deviceId: channel.deviceId };
  };
  return { calls, restore: () => { pushSenders.sendIncomingCallPush = original; } };
}

function emitWithAck(socket: ReturnType<typeof ioClient>, event: string, payload: object): Promise<unknown> {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

test('an online callee is not pushed until its incoming-call acknowledgement times out', async (t) => {
  const oldTimeout = process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
  process.env.INCOMING_CALL_ACK_TIMEOUT_MS = '30';
  t.after(() => {
    if (oldTimeout === undefined) delete process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
    else process.env.INCOMING_CALL_ACK_TIMEOUT_MS = oldTimeout;
  });

  const push = spyOnIncomingPush();
  t.after(push.restore);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'caller', 'caller-device');
  const calleeSession = await createSession(url, 'callee', 'callee-device');
  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'callee-token' }, calleeSession);

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  t.after(() => callee.disconnect());
  await new Promise<void>(resolve => callee.once('connect', () => resolve()));

  const created = await postJson(url, '/calls', { calleeId: 'callee' }, callerSession);
  assert.equal(created.status, 201);
  assert.equal(push.calls.length, 0, 'the live device rings through its socket first');

  await wait(80);
  assert.equal(push.calls.length, 1, 'the unacknowledged live device receives one fallback push');
});

test('an incoming-call acknowledgement prevents the timeout fallback push', async (t) => {
  const oldTimeout = process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
  process.env.INCOMING_CALL_ACK_TIMEOUT_MS = '50';
  t.after(() => {
    if (oldTimeout === undefined) delete process.env.INCOMING_CALL_ACK_TIMEOUT_MS;
    else process.env.INCOMING_CALL_ACK_TIMEOUT_MS = oldTimeout;
  });

  const push = spyOnIncomingPush();
  t.after(push.restore);
  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'caller-ack', 'caller-ack-device');
  const calleeSession = await createSession(url, 'callee-ack', 'callee-ack-device');
  await postJson(url, '/devices/register', { provider: 'fcm', pushToken: 'callee-ack-token' }, calleeSession);

  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  t.after(() => callee.disconnect());
  await new Promise<void>(resolve => callee.once('connect', () => resolve()));

  const created = await postJson(url, '/calls', { calleeId: 'callee-ack' }, callerSession);
  assert.equal(created.status, 201);
  await emitWithAck(callee, 'call.incoming.ack', { version: 1, callId: created.body.callId });

  await wait(100);
  assert.equal(push.calls.length, 0);
});

test('a call transition reaches sockets and the cross-instance message bus', async (t) => {
  const published: Array<{ channel: string; message: unknown; }> = [];
  const messageBus: import('../src/messageBus.ts').MessageBus = {
    type: 'memory',
    publish: async (channel, message) => { published.push({ channel, message }); },
    subscribe: async () => async () => {},
    close: async () => {},
  };
  const { url, teardown } = await startServer({ messageBus });
  t.after(teardown);

  const callerSession = await createSession(url, 'caller-transition', 'caller-transition-device');
  const calleeSession = await createSession(url, 'callee-transition', 'callee-transition-device');
  const caller = ioClient(url, { auth: { sessionId: callerSession } });
  const callee = ioClient(url, { auth: { sessionId: calleeSession } });
  t.after(() => caller.disconnect());
  t.after(() => callee.disconnect());
  await Promise.all([
    new Promise<void>(resolve => caller.once('connect', () => resolve())),
    new Promise<void>(resolve => callee.once('connect', () => resolve())),
  ]);

  const stateChanged = new Promise<any>(resolve => {
    const onStateChanged = (payload: any) => {
      if (payload.status === 'accepted') resolve(payload);
      else caller.once('call.state_changed', onStateChanged);
    };
    caller.once('call.state_changed', onStateChanged);
  });
  const created = await postJson(url, '/calls', { calleeId: 'callee-transition' }, callerSession);
  assert.equal(created.status, 201);
  await emitWithAck(callee, 'call.accept', { version: 1, callId: created.body.callId });

  const transition = await stateChanged;
  assert.equal(transition.status, 'accepted');
  await wait(0);
  const transitions = published.filter(entry => entry.channel === CALL_TRANSITION_CHANNEL);
  assert.equal(transitions.length, 1);
  const message = transitions[0].message as Record<string, unknown>;
  // The publishing instance is stamped so subscribers can ignore their own echo.
  assert.equal(typeof message.instanceId, 'string');
  assert.notEqual(message.instanceId, '');
  const { instanceId: _instanceId, ...rest } = message;
  assert.deepEqual(rest, {
    callId: created.body.callId,
    previousStatus: 'ringing',
    status: 'accepted',
    actor: 'callee-transition',
    reason: null,
  });
});
