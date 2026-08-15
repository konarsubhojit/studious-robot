'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/index.js');

test('GET /health returns ok status', async () => {
  const { httpServer } = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'wetalk-signaling');
    assert.deepEqual(body.messageStore, { type: 'memory', status: 'ready' });
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.timestamp, 'string');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('GET /health reports a failed Mongo startup check without blocking the server', async () => {
  const messageStore = {
    type: 'mongo',
    ready: async () => {
      throw new Error('network unavailable');
    },
    close: async () => {},
  };
  const { httpServer } = createServer({ messageStore });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.messageStore, { type: 'mongo', status: 'unavailable' });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('GET /health reports a successful Mongo startup check', async () => {
  const messageStore = {
    type: 'mongo',
    ready: async () => {},
    close: async () => {},
  };
  const { httpServer } = createServer({ messageStore });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.messageStore, { type: 'mongo', status: 'ready' });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
