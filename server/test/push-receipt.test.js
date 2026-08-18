'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');
const { captureConsoleLog } = require('./helpers');

async function startServer() {
  const server = createServer();
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  async function teardown() {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => server.io.close(() => server.httpServer.close(resolve)));
  }

  return { ...server, url, teardown };
}

async function postJson(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function createSession(url, userId, deviceId = `device-${userId}`) {
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
