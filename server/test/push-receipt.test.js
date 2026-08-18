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
