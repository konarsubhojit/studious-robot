import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { listenOnRandomPort } from './helpers.ts';
import { createMemoryStores } from '../src/stores/index.ts';

/**
 * Start a server on an ephemeral port and return its URL plus the full server
 * handle (so tests can call `shutdown()` directly).
 *
 * @param {import('../src/createServer.ts').CreateServerOptions} [opts]
 */
async function startServer(opts: import('../src/createServer.ts').CreateServerOptions = {}) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  return { ...server, url: `http://127.0.0.1:${port}`, port };
}

/**
 * Connect a Socket.IO client and resolve once connected.
 *
 * @param {string} url
 * @returns {Promise<import('socket.io-client').Socket>}
 */
function connect(url: string): Promise<import('socket.io-client').Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { forceNew: true, transports: ['websocket'] });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

/**
 * Wait for a named event on a socket, with a timeout.
 *
 * @param {import('socket.io-client').Socket} socket
 * @param {string} event
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function waitFor(socket: import('socket.io-client').Socket, event: string, timeoutMs: number = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Simple GET helper returning `{ status, body }`.
 *
 * @param {string} url
 * @returns {Promise<{ status: number|undefined, body: any }>}
 */
function getJson(url: string): Promise<{ status: number | undefined; body: any; }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      })
      .on('error', reject);
  });
}

// ─── notify connected clients on drain ──────────────────────────────────────

test('shutdown() notifies connected clients with server.draining', async () => {
  const server = await startServer();
  const client = await connect(server.url);
  try {
    const drainingPromise = waitFor(client, 'server.draining');
    const shutdownDone = server.shutdown({ reason: 'SIGTERM' });

    const payload = await drainingPromise;
    assert.equal(payload.reason, 'SIGTERM');
    assert.ok(payload.ts, 'draining notice carries a timestamp');

    await shutdownDone;
  } finally {
    client.disconnect();
  }
});

// ─── presence cleanup ───────────────────────────────────────────────────────

test('shutdown() removes local connections from presence', async () => {
  const server = await startServer();
  const client = await connect(server.url);
  // Give the server a tick to register the connection.
  await waitFor(client, 'connect-ack', 200).catch(() => {});
  assert.ok(client.id, 'the client reports a socket id once connected');
  const userId = server.io.sockets.sockets.get(client.id)?.data?.identity?.userId;
  assert.ok(userId, 'server tracked a userId for the connection');

  assert.equal(server.getPresence(userId).online, true);

  await server.shutdown();

  const presence = server.getPresence(userId);
  assert.equal(presence.online, false);
  assert.equal(presence.activeConnections, 0);
  assert.ok(presence.lastSeen, 'lastSeen is set after draining');

  client.disconnect();
});

// ─── server stops accepting connections ─────────────────────────────────────

test('shutdown() closes the HTTP server so it stops listening', async () => {
  const server = await startServer();
  await server.shutdown();

  await assert.rejects(
    () => getJson(`${server.url}/health`),
    /ECONNREFUSED/,
    'health endpoint is unreachable after shutdown'
  );
});

// ─── /health reports draining ───────────────────────────────────────────────

test('/health reports 503 draining once shutdown begins', async () => {
  // Use a long drain timeout and a live client so the server stays up long
  // enough to observe the draining health response mid-shutdown.
  const server = await startServer({ shutdownDrainMs: 1000 });
  const client = await connect(server.url);

  const shutdownDone = server.shutdown();
  // The server is still listening while waiting for the socket to drain.
  const health = await getJson(`${server.url}/health`);
  assert.equal(health.status, 503);
  assert.equal(health.body.status, 'draining');

  client.disconnect();
  await shutdownDone;
});

// ─── new connections rejected while draining ────────────────────────────────

test('connections opened during drain are rejected with server.draining', async () => {
  const server = await startServer({ shutdownDrainMs: 1000 });
  const keepAlive = await connect(server.url);

  const shutdownDone = server.shutdown();

  // Attempt a brand-new connection while the server is still draining.
  const late = ioClient(server.url, { forceNew: true, transports: ['websocket'] });
  try {
    const notice = await waitFor(late, 'server.draining', 800);
    assert.equal(notice.reason, 'shutdown');
  } finally {
    late.disconnect();
    keepAlive.disconnect();
    await shutdownDone;
  }
});

// ─── idempotency ────────────────────────────────────────────────────────────

test('shutdown() is idempotent and returns the same promise', async () => {
  const server = await startServer();
  const first = server.shutdown();
  const second = server.shutdown();
  assert.equal(first, second, 'repeated shutdown() calls share one promise');
  await first;
});

// ─── stores.close() is invoked ──────────────────────────────────────────────

test('shutdown() closes pluggable stores that expose close()', async () => {
  const stores = createMemoryStores();
  let closed = false;
  stores.close = async () => {
    closed = true;
  };

  const server = await startServer({ stores });
  await server.shutdown();
  assert.equal(closed, true, 'stores.close() was awaited during shutdown');
});
