import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { normaliseCorrelationId, resolveSocketIdentity } from '../src/lib/auth.ts';
import { SIGNALING_VERSION } from '../src/config.ts';
import { captureConsoleLog, listenOnRandomPort, readJson } from './helpers.ts';

test('correlation ids are normalised to log-safe, bounded strings', () => {
  assert.equal(normaliseCorrelationId('  wt-abc123  '), 'wt-abc123');
  assert.equal(normaliseCorrelationId('wt-a\nb c'), 'wt-abc');
  assert.equal(normaliseCorrelationId('x'.repeat(200))?.length, 64);
  assert.equal(normaliseCorrelationId(''), null);
  assert.equal(normaliseCorrelationId('   '), null);
  assert.equal(normaliseCorrelationId(42), null);
  assert.equal(normaliseCorrelationId('@@@'), null);
});

test('socket identity carries the handshake correlation id for sessions and guests', () => {
  const sessions: import('../src/stores/contracts.ts').SessionStore = new Map([
    [
      'session-1',
      {
        sessionId: 'session-1',
        userId: 'user-1',
        deviceId: 'device-1',
        platform: 'android',
        createdAt: new Date().toISOString(),
        expiresAt: null,
      },
    ],
  ]);

  const authenticated = resolveSocketIdentity(
    { handshake: { auth: { sessionId: 'session-1', correlationId: 'wt-trace-1' } } },
    sessions
  );
  assert.equal(authenticated.userId, 'user-1');
  assert.equal(authenticated.correlationId, 'wt-trace-1');

  const guest = resolveSocketIdentity(
    { handshake: { auth: { correlationId: 'wt-trace-2' } } },
    sessions
  );
  assert.equal(guest.sessionId, null);
  assert.equal(guest.correlationId, 'wt-trace-2');

  const withoutCorrelation = resolveSocketIdentity({ handshake: { auth: {} } }, sessions);
  assert.equal(withoutCorrelation.correlationId, null);
});

test('a call initiated over the socket is logged with the client correlation id', async () => {
  const server = createServer({
    verifyIdToken: async (idToken) => ({
      authUid: idToken,
      email: `${idToken}@example.com`,
      authProvider: 'password',
    }),
  });
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  /**
   * @returns the created session document
   */
  async function createSession(userId: string): Promise<any> {
    const response = await fetch(`${url}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, deviceId: `${userId}-device`, idToken: `account-${userId}` }),
    });
    return readJson(response);
  }

  const logs = captureConsoleLog();
  let caller: import('socket.io-client').Socket | undefined;
  let callee: import('socket.io-client').Socket | undefined;
  try {
    const callerSession = await createSession('user-caller');
    const calleeSession = await createSession('user-callee');

    const connect = (sessionId: string, correlationId: string): Promise<import('socket.io-client').Socket> =>
      new Promise((resolve, reject) => {
        const socket = ioClient(url, {
          auth: { sessionId, correlationId },
          forceNew: true,
          transports: ['websocket'],
        });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
      });

    caller = await connect(callerSession.sessionId, 'wt-caller-trace');
    callee = await connect(calleeSession.sessionId, 'wt-callee-trace');

    const ack = await (new Promise((resolve) => {
        caller?.emit(
          'call.initiate',
          { version: SIGNALING_VERSION, calleeId: 'user-callee' },
          resolve
        );
      }) as Promise<any>);
    assert.equal(ack.ok, true);
    const { callId } = ack.call;

    assert.ok(
      logs.lines.some((line) => line.includes('socket connected') && line.includes('correlationId=wt-caller-trace')),
      'the connection log carries the correlation id'
    );
    assert.ok(
      logs.lines.some(
        (line) =>
          line.includes('call.correlation') &&
          line.includes(`callId=${callId}`) &&
          line.includes('correlationId=wt-caller-trace')
      ),
      'the call is linked to the caller correlation id'
    );
  } finally {
    logs.restore();
    caller?.disconnect();
    callee?.disconnect();
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
  }
});
