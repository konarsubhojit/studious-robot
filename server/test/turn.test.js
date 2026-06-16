'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createTurnCredentials } = require('../src/turn.js');
const { resolveTurn } = require('../src/config.js');
const { createServer } = require('../src/index.js');

test('resolveTurn is disabled without secret/urls', () => {
  assert.equal(resolveTurn({}).enabled, false);
  assert.equal(resolveTurn({ TURN_SECRET: 's' }).enabled, false);
  assert.equal(resolveTurn({ TURN_URLS: 'turn:host:3478' }).enabled, false);
});

test('resolveTurn parses urls and ttl when enabled', () => {
  const turn = resolveTurn({
    TURN_SECRET: 'shared-secret',
    TURN_URLS: 'turn:host:3478, turns:host:5349 ',
    TURN_TTL_SECONDS: '3600',
  });
  assert.equal(turn.enabled, true);
  assert.deepEqual(turn.urls, ['turn:host:3478', 'turns:host:5349']);
  assert.equal(turn.ttlSeconds, 3600);
});

test('createTurnCredentials mints HMAC-SHA1 coturn credentials', () => {
  const turn = {
    enabled: true,
    secret: 'shared-secret',
    urls: ['turn:host:3478'],
    ttlSeconds: 600,
  };
  const nowMs = 1_000_000_000_000;
  const creds = createTurnCredentials(turn, { nowMs });

  const expectedExpiry = Math.floor(nowMs / 1000) + 600;
  assert.equal(creds.username, String(expectedExpiry));
  assert.equal(creds.ttl, 600);
  assert.deepEqual(creds.urls, ['turn:host:3478']);

  const expectedCredential = crypto
    .createHmac('sha1', 'shared-secret')
    .update(creds.username)
    .digest('base64');
  assert.equal(creds.credential, expectedCredential);
  assert.deepEqual(creds.iceServers, [
    { urls: ['turn:host:3478'], username: creds.username, credential: creds.credential },
  ]);
});

test('createTurnCredentials embeds an optional name label', () => {
  const turn = { enabled: true, secret: 's', urls: ['turn:host:3478'], ttlSeconds: 10 };
  const creds = createTurnCredentials(turn, { name: 'alice', nowMs: 0 });
  assert.equal(creds.username, '10:alice');
});

test('createTurnCredentials throws when TURN is not configured', () => {
  assert.throws(() => createTurnCredentials({ enabled: false }), /not configured/);
});

test('GET /turn-credentials returns 404 when TURN is unconfigured', async () => {
  const { httpServer } = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/turn-credentials`);
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('GET /turn-credentials issues credentials when configured', async () => {
  const config = {
    port: 0,
    host: '127.0.0.1',
    maxRoomSize: 2,
    corsOrigin: '*',
    redisUrl: null,
    sentryDsn: null,
    environment: 'test',
    instanceId: 'test-instance',
    turn: { enabled: true, secret: 'shared-secret', urls: ['turn:host:3478'], ttlSeconds: 300 },
  };
  const { httpServer, metrics } = createServer({ config });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/turn-credentials`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.username, 'string');
    assert.equal(typeof body.credential, 'string');
    assert.equal(body.ttl, 300);
    assert.deepEqual(body.urls, ['turn:host:3478']);
    assert.equal(metrics.snapshot().turnCredentialsIssuedTotal, 1);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('/health and /metrics include the instance id', async () => {
  const config = {
    port: 0,
    host: '127.0.0.1',
    maxRoomSize: 2,
    corsOrigin: '*',
    redisUrl: null,
    sentryDsn: null,
    environment: 'test',
    instanceId: 'instance-xyz',
    turn: { enabled: false, secret: null, urls: [], ttlSeconds: 1 },
  };
  const { httpServer } = createServer({ config });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.instance, 'instance-xyz');
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
    assert.equal(metrics.instance, 'instance-xyz');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
