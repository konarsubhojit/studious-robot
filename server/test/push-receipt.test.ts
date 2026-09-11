import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { captureConsoleLog, closeTestServer, listenOnRandomPort, postJson } from './helpers.ts';

async function startServer() {
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    await closeTestServer(server);
  }

  return { ...server, url, teardown };
}

/**
 * @param url - Base URL of the server under test.
 * @returns the created session id
 */
async function createSession(url: string, userId: string, deviceId: string = `device-${userId}`): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

test('push receipt records a valid stage keyed by callId and session device', async (t) => {
  const logs = captureConsoleLog();
  t.after(() => logs.restore());
  const { url, teardown } = await startServer();
  t.after(teardown);

  const callerSession = await createSession(url, 'user-alice');
  const calleeSession = await createSession(url, 'user-bob', 'device-bob-phone');
  const created = await postJson(url, '/calls', {
    sessionId: callerSession,
    calleeId: 'user-bob',
  });
  assert.equal(created.status, 201);

  const res = await postJson(url, '/devices/push-receipt', {
    sessionId: calleeSession,
    callId: created.body.callId,
    stage: 'received',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'recorded');
  assert.equal(res.body.deviceId, 'device-bob-phone');
  assert.equal(res.body.stage, 'received');
  assert.equal(typeof res.body.latencyMs, 'number');
  assert.ok(
    logs.lines.some(
      (line) =>
        line.includes('[push] Receipt') &&
        line.includes(`callId=${created.body.callId}`) &&
        line.includes('device=device-bob-phone') &&
        line.includes('stage=received') &&
        line.includes('latencyMs=')
    )
  );
});

test('push receipt accepts a plain deviceId without a live session', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-cold-start',
    callId: 'call-not-in-memory',
    stage: 'ui_failed',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.deviceId, 'device-cold-start');
  assert.equal(res.body.latencyMs, null);
});

test('push receipt times a call created on another instance from the shared record', async (t) => {
  // The receipt lands on whichever instance the load balancer picked, which is
  // not necessarily the one that created the call: timing it against the local
  // registry alone reported `latencyMs=N/A` for exactly the cross-instance
  // pushes worth measuring.
  const createdAt = new Date(Date.now() - 1_500).toISOString();
  const shared = {
    get: async (callId: string) =>
      callId === 'call-on-peer-instance'
        ? ({
            callId,
            callerId: 'user-alice',
            calleeId: 'user-bob',
            status: 'ringing',
            createdAt,
            updatedAt: createdAt,
          } as any)
        : null,
    save: async () => {},
    transitionAtomic: async () => ({ ok: false as const, error: 'not_found' as const }),
    listActiveCallsForUser: async () => [],
  };
  const stores = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    callState: shared,
  });
  const server = createServer({ stores });
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  t.after(() => closeTestServer(server));

  const res = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-bob-phone',
    callId: 'call-on-peer-instance',
    stage: 'received',
  });

  assert.equal(res.status, 202);
  assert.ok(res.body.latencyMs >= 1_500, `expected a real latency, got ${res.body.latencyMs}`);
});

test('push receipt rejects invalid stages', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-1',
    callId: 'call-1',
    stage: 'opened',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid stage');
});

test('push receipt records answer-path stages with their failure reason', async (t) => {
  const logs = captureConsoleLog();
  t.after(() => logs.restore());
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-cold-start',
    callId: 'call-answer-1',
    stage: 'answer_failed',
    reason: 'socket_not_connected',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.stage, 'answer_failed');
  assert.equal(res.body.reason, 'socket_not_connected');
  assert.ok(
    logs.lines.some(
      (line) =>
        line.includes('[push] Receipt') &&
        line.includes('stage=answer_failed') &&
        line.includes('reason=socket_not_connected')
    )
  );
});

test('push receipt accepts every answer-path stage', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  for (const stage of [
    'answer_attempted',
    'answer_accepted',
    'accept_tapped',
    'decline_tapped',
  ]) {
    const res = await postJson(url, '/devices/push-receipt', {
      deviceId: 'device-cold-start',
      callId: 'call-answer-2',
      stage,
    });
    assert.equal(res.status, 202, `stage ${stage} should be accepted`);
    assert.equal(res.body.stage, stage);
  }
});

test('push receipt records message stages keyed by messageId', async (t) => {
  const logs = captureConsoleLog();
  t.after(() => logs.restore());
  const { url, teardown } = await startServer();
  t.after(teardown);

  const session = await createSession(url, 'user-bob', 'device-bob-phone');
  const res = await postJson(url, '/devices/push-receipt', {
    sessionId: session,
    messageId: 'message-1',
    stage: 'notification_shown',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'recorded');
  assert.equal(res.body.messageId, 'message-1');
  assert.equal(res.body.callId, undefined);
  assert.equal(res.body.deviceId, 'device-bob-phone');
  assert.equal(res.body.stage, 'notification_shown');
  assert.ok(
    logs.lines.some(
      (line) =>
        line.includes('[push] Receipt') &&
        line.includes('messageId=message-1') &&
        line.includes('stage=notification_shown')
    )
  );
});

test('push receipt accepts every message stage and rejects call-only stages', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  for (const stage of [
    'received',
    'notification_shown',
    'notification_failed',
    'notification_suppressed',
  ]) {
    const res = await postJson(url, '/devices/push-receipt', {
      deviceId: 'device-1',
      messageId: 'message-2',
      stage,
    });
    assert.equal(res.status, 202, `stage ${stage} should be accepted`);
    assert.equal(res.body.stage, stage);
  }

  const wrongStage = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-1',
    messageId: 'message-2',
    stage: 'ui_displayed',
  });
  assert.equal(wrongStage.status, 400);
  assert.equal(wrongStage.body.error, 'invalid stage');
});

test('push receipt requires a callId or a messageId', async (t) => {
  const { url, teardown } = await startServer();
  t.after(teardown);

  const res = await postJson(url, '/devices/push-receipt', {
    deviceId: 'device-1',
    stage: 'received',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'callId or messageId is required');
});

test('push receipt accepts the duplicate-answer stage', async (t) => {
  const logs = captureConsoleLog();
  t.after(() => logs.restore());
  const { url, teardown } = await startServer();
  t.after(teardown);

  const sessionId = await createSession(url, 'user-dup');
  const res = await postJson(url, '/devices/push-receipt', {
    sessionId,
    callId: 'call-dup',
    stage: 'answer_skipped_duplicate',
    reason: 'already_accepted',
  });

  assert.equal(res.status, 202);
  assert.ok(
    logs.lines.some(
      (line) =>
        line.includes('stage=answer_skipped_duplicate') && line.includes('reason=already_accepted')
    ),
    'suppressed duplicates must be visible server-side'
  );
});
