'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/index.js');

test('GET /metrics reports room occupancy and signaling counters', async () => {
  const { httpServer } = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  const client = ioClient(url, { forceNew: true, transports: ['websocket'] });
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });

    client.emit('join-room', 'metrics-room');
    // Give the server a moment to process the join.
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${url}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.service, 'studious-robot-signaling');
    assert.equal(body.rooms.activeRooms, 1);
    assert.equal(body.rooms.activeParticipants, 1);
    assert.equal(body.rooms.maxRoomSize, 2);
    assert.ok(body.counters.connectionsTotal >= 1);
    assert.equal(body.counters.joinsTotal, 1);
  } finally {
    client.disconnect();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('invalid room ids are rejected and counted', async () => {
  const { httpServer } = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const url = `http://127.0.0.1:${port}`;

  const client = ioClient(url, { forceNew: true, transports: ['websocket'] });
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });

    client.emit('join-room', 'bad room/id');
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`${url}/metrics`);
    const body = await res.json();
    assert.equal(body.rooms.activeRooms, 0);
    assert.ok(body.counters.invalidPayloadsTotal >= 1);
  } finally {
    client.disconnect();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
