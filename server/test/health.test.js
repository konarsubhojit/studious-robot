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
    assert.equal(body.service, 'studious-robot-signaling');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.timestamp, 'string');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
