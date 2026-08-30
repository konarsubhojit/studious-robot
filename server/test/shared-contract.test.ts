import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { API_ROUTES, CLIENT_EVENTS, SERVER_EVENTS, HEALTH_RESPONSE, SESSION_RESPONSE, parseEventPayload, s } from '../../shared/index.ts';
import { closeTestServer, listenOnRandomPort, readJson } from './helpers.ts';

/**
 * Contract tests for `@wetalk/shared`: the schema helper itself, and the
 * server's use of it to reject malformed inbound payloads instead of letting a
 * handler throw.
 */

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param clients */
  async function teardown(...clients: import('socket.io-client').Socket[]) {
    clients.forEach((client) => client.disconnect());
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param auth - Socket.IO handshake auth payload.
 */
function connect(url: string, auth?: Record<string, unknown>): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth, forceNew: true, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/**
 * @returns the server's acknowledgement
 */
function emitWithAck(socket: import('socket.io-client').Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

type IsAny<T> = 0 extends (1 & T) ? true : false;

/**
 * @returns the created session id
 */
async function createSession(url: string, userId: string): Promise<string> {
  const response = await fetch(`${url}${API_ROUTES.SESSION}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, deviceId: `device-${userId}` }),
  });
  const body = await readJson(response);
  assert.equal(response.status, 201);
  const parsed = SESSION_RESPONSE.safeParse(body);
  assert.equal(parsed.success, true);
  return body.sessionId;
}

// ─── schema helper ───────────────────────────────────────────────────────────

test('schema helper validates, trims and strips unknown keys', () => {
  const schema = s.object({
    id: s.id(),
    count: s.number({ integer: true, min: 0 }),
    flag: s.boolean().optional(),
  });

  const good = schema.safeParse({ id: '  abc  ', count: 2, extra: 'dropped' });
  assert.equal(good.success, true);
  assert.deepEqual(good.data, { id: 'abc', count: 2 });

  const missing = schema.safeParse({ count: 2 });
  assert.equal(missing.success, false);
  assert.equal(missing.error.path, 'id');

  const wrongType = schema.safeParse({ id: 'abc', count: 1.5 });
  assert.equal(wrongType.success, false);
  assert.match(wrongType.error.message, /integer/);

  assert.equal(schema.safeParse(null).success, false);
  assert.equal(schema.safeParse(undefined).success, false);
});

test('schema helper preserves parsed object/record types at the API boundary', () => {
  const schema = s.object({
    id: s.id(),
    count: s.number({ integer: true, min: 0 }),
    tags: s.array(s.string({ min: 1 })),
    labels: s.record(s.number({ integer: true })).optional(),
  });

  const parsed = schema.parse({
    id: 'abc',
    count: 3,
    tags: ['one', 'two'],
    labels: { urgent: 1 },
  });

  // compile-time type checks: these fail if parsed fields are typed `any`
  const id: string = parsed.id;
  const count: number = parsed.count;
  const tags: string[] = parsed.tags;
  const labels: Record<string, number> | undefined = parsed.labels;
  const parsedIsAny: IsAny<typeof parsed> = false;
  const labelsIsAny: IsAny<typeof labels> = false;

  assert.equal(id, 'abc');
  assert.equal(count, 3);
  assert.deepEqual(tags, ['one', 'two']);
  assert.deepEqual(labels, { urgent: 1 });
  assert.equal(parsedIsAny, false);
  assert.equal(labelsIsAny, false);
});

test('signaling payload schemas cover both directions and pass unknown events through', () => {
  const outbound = parseEventPayload(CLIENT_EVENTS.CALL_INITIATE, {
    version: 1,
    calleeId: 'bob',
  });
  assert.equal(outbound.success, true);

  const inbound = parseEventPayload(
    SERVER_EVENTS.CALL_INCOMING,
    {
      version: 1,
      callId: 'call-1',
      call: { callId: 'call-1', callerId: 'alice', calleeId: 'bob', status: 'ringing' },
    },
    'server'
  );
  assert.equal(inbound.success, true);
  assert.equal(inbound.data.call.status, 'ringing');

  const wrongVersion = parseEventPayload(CLIENT_EVENTS.CALL_ACCEPT, { version: 99, callId: 'c' });
  assert.equal(wrongVersion.success, false);

  // An event without a contract yet must not be silently dropped.
  const unknownEvent = parseEventPayload('not.a.real.event', { anything: true });
  assert.equal(unknownEvent.success, true);
});

// ─── server-side rejection of malformed payloads ─────────────────────────────

test('malformed signaling payloads are rejected with bad_request, not crashes', async (t) => {
  const { url, teardown } = await startServer();
  const session = await createSession(url, 'schema-alice');
  await createSession(url, 'schema-bob');
  const socket = await connect(url, { sessionId: session });
  t.after(() => teardown(socket));

  const cases: [string, Record<string, unknown>][] = [
    [CLIENT_EVENTS.CALL_INITIATE, { version: 1 }],
    [CLIENT_EVENTS.CALL_INITIATE, { version: 1, calleeId: 42 }],
    [CLIENT_EVENTS.CALL_INCOMING_ACK, { version: 1 }],
    [CLIENT_EVENTS.CALL_ACCEPT, { version: 1, callId: '' }],
    [CLIENT_EVENTS.CALL_END, { version: 1, callId: null }],
    [CLIENT_EVENTS.RTC_OFFER, { version: 1, callId: 'call-1', sdp: 'not-an-object' }],
    [CLIENT_EVENTS.RTC_CANDIDATE, { version: 1, callId: 'call-1' }],
    [CLIENT_EVENTS.CALL_STATE_REPORT, { version: 1, activeCallIds: [7] }],
    [CLIENT_EVENTS.MESSAGE_SEND, { version: 1, recipientId: 'schema-bob', body: 42 }],
  ];

  for (const [event, payload] of cases) {
    const ack = await emitWithAck(socket, event, payload);
    assert.equal(ack.ok, false, `${event} should be rejected`);
    assert.equal(ack.error.code, 'bad_request', `${event} should fail as bad_request`);
    assert.equal(ack.event, event);
  }

  // The connection survives every rejection and still serves valid traffic.
  assert.equal(socket.connected, true);
  const ok = await emitWithAck(socket, CLIENT_EVENTS.CALL_INITIATE, {
    version: 1,
    calleeId: 'schema-bob',
  });
  assert.equal(ok.ok, true);
});

test('fire-and-forget message.typing drops malformed payloads without disconnecting', async (t) => {
  const { url, teardown } = await startServer();
  const session = await createSession(url, 'typing-alice');
  await createSession(url, 'typing-bob');
  const socket = await connect(url, { sessionId: session });
  t.after(() => teardown(socket));

  socket.emit(CLIENT_EVENTS.MESSAGE_TYPING, { version: 1, recipientId: 'typing-bob' });
  socket.emit(CLIENT_EVENTS.MESSAGE_TYPING, { version: 1, recipientId: 42, isTyping: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(socket.connected, true);
});

// ─── REST contract ───────────────────────────────────────────────────────────

test('GET /health is served from the shared route table and matches its schema', async (t) => {
  const { url, teardown } = await startServer();
  t.after(() => teardown());

  const response = await fetch(`${url}${API_ROUTES.HEALTH}`);
  assert.equal(response.status, 200);
  const parsed = HEALTH_RESPONSE.safeParse(await response.json());
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.status, 'ok');
});
