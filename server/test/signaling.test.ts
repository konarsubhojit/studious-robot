import test from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { createServer } from '../src/index.ts';
import { listenOnRandomPort, readJson } from './helpers.ts';

/**
 * Helper: start a server on an ephemeral port and return its URL + teardown.
 */
async function startServer() {
  const { httpServer, io } = createServer();
  const port = await listenOnRandomPort(httpServer);
  const url = `http://127.0.0.1:${port}`;

  /** @param {...import('socket.io-client').Socket} clients */
  async function teardown(...clients: import('socket.io-client').Socket[]) {
    clients.forEach((c) => c.disconnect());
    // closeAllConnections() (Node 18.2+) forces lingering keep-alive connections
    // to close so that httpServer.close() can finish promptly.
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => io.close(() => httpServer.close(() => resolve(undefined))));
  }

  return { url, teardown };
}

let nextClientId = 0;
/**
 * Helper: connect a client and wait for the 'connect' event.
 *
 * @param {string} url
 * @returns {Promise<import('socket.io-client').Socket>}
 */
async function connect(url: string): Promise<import('socket.io-client').Socket> {
  nextClientId += 1;
  const userId = `legacy-test-${nextClientId}`;
  const response = await fetch(`${url}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const session = await readJson(response);
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth: { sessionId: session.sessionId },
      forceNew: true,
      transports: ['websocket'],
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

test('unauthenticated sockets cannot join or inject legacy signaling', async () => {
  const { url, teardown } = await startServer();
  const authenticated = await connect(url);
  const guest = await (new Promise((resolve, reject) => {
      const socket = ioClient(url, { forceNew: true, transports: ['websocket'] });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    }) as Promise<import('socket.io-client').Socket>);
  try {
    authenticated.emit('join-room', 'secured-room');
    guest.emit('join-room', 'secured-room');
    let received = false;
    authenticated.once('offer', () => {
      received = true;
    });
    guest.emit('offer', { roomId: 'secured-room', sdp: { type: 'offer' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received, false);
  } finally {
    await teardown(authenticated, guest);
  }
});

/**
 * Helper: wait for a specific event on a socket, with a short timeout.
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

// ─── join-room: first two users join successfully ───────────────────────────

test('first two clients join the same room successfully', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2] = await Promise.all([connect(url), connect(url)]);

  try {
    const peerJoinedPromise = waitFor(c1, 'peer-joined');

    c1.emit('join-room', 'room-abc');
    c2.emit('join-room', 'room-abc');

    const peerJoined = await peerJoinedPromise;
    assert.equal(peerJoined.id, c2.id);
  } finally {
    await teardown(c1, c2);
  }
});

// ─── join-room: third client gets room-full ──────────────────────────────────

test('third client receives room-full', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2, c3] = await Promise.all([connect(url), connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-xyz');
    c2.emit('join-room', 'room-xyz');

    // Give c1 and c2 time to join before c3 attempts.
    await new Promise((r) => setTimeout(r, 50));

    const roomFullPromise = waitFor(c3, 'room-full');
    c3.emit('join-room', 'room-xyz');

    const roomFull = await roomFullPromise;
    assert.equal(roomFull.roomId, 'room-xyz');
  } finally {
    await teardown(c1, c2, c3);
  }
});

// ─── offer relay ────────────────────────────────────────────────────────────

test('offer is relayed only to the peer in the room', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2, c3] = await Promise.all([connect(url), connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-offer');
    c2.emit('join-room', 'room-offer');
    c3.emit('join-room', 'other-room');

    await new Promise((r) => setTimeout(r, 50));

    const offerForC2 = waitFor(c2, 'offer');

    // c3 should NOT receive the offer; use a short timeout to verify.
    let c3ReceivedOffer = false;
    c3.once('offer', () => {
      c3ReceivedOffer = true;
    });

    c1.emit('offer', { roomId: 'room-offer', sdp: { type: 'offer', sdp: 'mock-sdp' } });

    const offer = await offerForC2;
    assert.equal(offer.from, c1.id);
    assert.deepEqual(offer.sdp, { type: 'offer', sdp: 'mock-sdp' });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c3ReceivedOffer, false, 'c3 should not receive an offer meant for another room');
  } finally {
    await teardown(c1, c2, c3);
  }
});

// ─── answer relay ───────────────────────────────────────────────────────────

test('answer is relayed only to the peer in the room', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2] = await Promise.all([connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-answer');
    c2.emit('join-room', 'room-answer');

    await new Promise((r) => setTimeout(r, 50));

    const answerForC1 = waitFor(c1, 'answer');
    c2.emit('answer', { roomId: 'room-answer', sdp: { type: 'answer', sdp: 'mock-answer-sdp' } });

    const answer = await answerForC1;
    assert.equal(answer.from, c2.id);
    assert.deepEqual(answer.sdp, { type: 'answer', sdp: 'mock-answer-sdp' });
  } finally {
    await teardown(c1, c2);
  }
});

// ─── ICE candidate relay ─────────────────────────────────────────────────────

test('ice-candidate is relayed only to the peer in the room', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2] = await Promise.all([connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-ice');
    c2.emit('join-room', 'room-ice');

    await new Promise((r) => setTimeout(r, 50));

    const iceForC2 = waitFor(c2, 'ice-candidate');
    c1.emit('ice-candidate', { roomId: 'room-ice', candidate: { candidate: 'mock-candidate' } });

    const ice = await iceForC2;
    assert.equal(ice.from, c1.id);
    assert.deepEqual(ice.candidate, { candidate: 'mock-candidate' });
  } finally {
    await teardown(c1, c2);
  }
});

// ─── disconnect cleanup ──────────────────────────────────────────────────────

test('remaining peer receives peer-left when the other disconnects', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2] = await Promise.all([connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-dc');
    c2.emit('join-room', 'room-dc');

    await new Promise((r) => setTimeout(r, 50));

    // Capture c2's id before disconnecting, since socket.id becomes null after disconnect.
    const c2Id = c2.id;
    const peerLeftPromise = waitFor(c1, 'peer-left');
    c2.disconnect();

    const peerLeft = await peerLeftPromise;
    assert.equal(peerLeft.id, c2Id);
  } finally {
    await teardown(c1);
  }
});

test('after disconnect a third client can now join the vacated slot', async () => {
  const { url, teardown } = await startServer();
  const [c1, c2, c3] = await Promise.all([connect(url), connect(url), connect(url)]);

  try {
    c1.emit('join-room', 'room-rejoin');
    c2.emit('join-room', 'room-rejoin');

    await new Promise((r) => setTimeout(r, 50));

    // c2 leaves; c1 should hear peer-left.
    const peerLeftPromise = waitFor(c1, 'peer-left');
    c2.disconnect();
    await peerLeftPromise;

    // Now c3 should be able to join without room-full.
    const peerJoinedPromise = waitFor(c1, 'peer-joined');
    c3.emit('join-room', 'room-rejoin');
    const peerJoined = await peerJoinedPromise;
    assert.equal(peerJoined.id, c3.id);
  } finally {
    await teardown(c1, c3);
  }
});
