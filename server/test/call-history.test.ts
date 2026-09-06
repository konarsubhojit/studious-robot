/**
 * Tests for the durable `GET /calls` history read path.
 *
 * History is served from the `calls` table rather than the in-memory
 * `state.calls` map, so it survives a restart and outlives the in-memory
 * retention window.  These tests inject a fake Drizzle `db` that stores the
 * rows the server persists and answers the history query against them, so they
 * run entirely offline (no DATABASE_URL needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createFakeCallsDb } from './fakeCallsDb.ts';
import { asDatabase, closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  async function teardown() {
    await closeTestServer(server);
  }
  return { ...server, url, teardown };
}

async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

/** Await a fire-and-forget persistence write landing in the fake db. */
async function waitForRows(db: ReturnType<typeof createFakeCallsDb>, expected: number) {
  for (let attempt = 0; attempt < 100 && db.rows.size < expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(db.rows.size, expected, 'expected the calls to have been persisted');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('history: is served from the durable calls table', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const aliceSession = await createSession(url, 'user-history-alice');
    await postJson(url, '/calls', { calleeId: 'ghost-history' }, aliceSession);
    await waitForRows(db, 1);

    const res = await getJson(url, '/calls', aliceSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.calls.length, 1);
    assert.equal(res.body.calls[0].callerId, 'user-history-alice');
    assert.equal(res.body.calls[0].status, 'unreachable');
    assert.equal(res.body.calls[0].endReason, 'unreachable');
    assert.equal(typeof res.body.calls[0].createdAt, 'string');
    assert.equal(typeof res.body.calls[0].updatedAt, 'string');
    assert.equal(res.body.total, 1);
    assert.equal(res.body.hasMore, false);
  } finally {
    await teardown();
  }
});

test('history: survives a server restart', async () => {
  const db = createFakeCallsDb();
  const first = await startServer({ db });
  try {
    const aliceSession = await createSession(first.url, 'user-restart-alice');
    await postJson(first.url, '/calls', { calleeId: 'ghost-restart' }, aliceSession);
    await waitForRows(db, 1);
  } finally {
    await first.teardown();
  }

  // A brand-new process: the in-memory call map starts empty, but the durable
  // rows are still there.
  const second = await startServer({ db });
  try {
    const aliceSession = await createSession(second.url, 'user-restart-alice');
    const res = await getJson(second.url, '/calls', aliceSession);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.calls[0].callerId, 'user-restart-alice');
  } finally {
    await second.teardown();
  }
});

test('history: still returns calls evicted from memory by the retention window', async () => {
  const db = createFakeCallsDb();
  const { url, pruneTerminalCalls, getCall, teardown } = await startServer({ db });
  try {
    const aliceSession = await createSession(url, 'user-retained-alice');
    const created = await postJson(url, '/calls', { calleeId: 'ghost-retained' }, aliceSession);
    await waitForRows(db, 1);

    // Well past CALL_RETENTION_MS: the call leaves the hot map entirely.
    assert.equal(pruneTerminalCalls(Date.now() + 25 * 60 * 60 * 1000), 1);
    assert.equal(getCall(created.body.callId), null);

    const res = await getJson(url, '/calls', aliceSession);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.calls[0].callId, created.body.callId);
  } finally {
    await teardown();
  }
});

test('history: only returns calls the requesting user took part in', async () => {
  const db = createFakeCallsDb();
  db.seedCall({ callerId: 'user-scoped-alice', calleeId: 'user-scoped-bob' });
  db.seedCall({ callerId: 'user-scoped-carol', calleeId: 'user-scoped-bob' });
  db.seedCall({ callerId: 'user-scoped-carol', calleeId: 'user-scoped-dave' });

  const { url, teardown } = await startServer({ db });
  try {
    const aliceSession = await createSession(url, 'user-scoped-alice');
    const alice = await getJson(url, '/calls', aliceSession);
    assert.equal(alice.body.total, 1);
    assert.equal(alice.body.calls[0].calleeId, 'user-scoped-bob');

    const bobSession = await createSession(url, 'user-scoped-bob');
    const bob = await getJson(url, '/calls', bobSession);
    assert.equal(bob.body.total, 2);
  } finally {
    await teardown();
  }
});

test('history: filters by status against the durable rows', async () => {
  const db = createFakeCallsDb();
  db.seedCall({ callerId: 'user-status-alice', status: 'missed', endReason: 'timeout' });
  db.seedCall({ callerId: 'user-status-alice', status: 'ended' });

  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-status-alice');
    const missed = await getJson(url, '/calls?status=missed', session);
    assert.equal(missed.body.total, 1);
    assert.equal(missed.body.calls[0].status, 'missed');

    const all = await getJson(url, '/calls', session);
    assert.equal(all.body.total, 2);
  } finally {
    await teardown();
  }
});

test('history: pages with limit and offset, newest activity first', async () => {
  const db = createFakeCallsDb();
  const base = Date.parse('2024-01-01T00:00:00.000Z');
  for (let i = 0; i < 5; i++) {
    db.seedCall({
      callerId: 'user-paged-alice',
      createdAt: new Date(base + i * 60_000),
      updatedAt: new Date(base + i * 60_000),
    });
  }

  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-paged-alice');

    const firstPage = await getJson(url, '/calls?limit=2', session);
    assert.equal(firstPage.body.calls.length, 2);
    assert.equal(firstPage.body.total, 5);
    assert.equal(firstPage.body.limit, 2);
    assert.equal(firstPage.body.offset, 0);
    assert.equal(firstPage.body.hasMore, true);
    assert.equal(firstPage.body.calls[0].createdAt, new Date(base + 4 * 60_000).toISOString());

    const secondPage = await getJson(url, '/calls?limit=2&offset=2', session);
    assert.equal(secondPage.body.calls.length, 2);
    assert.equal(secondPage.body.offset, 2);
    assert.equal(secondPage.body.hasMore, true);
    assert.equal(secondPage.body.calls[0].createdAt, new Date(base + 2 * 60_000).toISOString());

    const lastPage = await getJson(url, '/calls?limit=2&offset=4', session);
    assert.equal(lastPage.body.calls.length, 1);
    assert.equal(lastPage.body.hasMore, false);

    const beyond = await getJson(url, '/calls?limit=2&offset=10', session);
    assert.equal(beyond.body.calls.length, 0);
    assert.equal(beyond.body.total, 5);
    assert.equal(beyond.body.hasMore, false);
  } finally {
    await teardown();
  }
});

test('history: falls back to resident calls when the query fails', async () => {
  const failingDb = asDatabase({
    ...createFakeCallsDb(),
    select() {
      return {
        from() {
          return {
            where: () => {
              throw new Error('connection terminated');
            },
            then: (resolve: any) => Promise.resolve([]).then(resolve),
          };
        },
      };
    },
  });

  const { url, teardown } = await startServer({ db: failingDb });
  try {
    const session = await createSession(url, 'user-degraded-alice');
    const created = await postJson(url, '/calls', { calleeId: 'ghost-degraded' }, session);

    const res = await getJson(url, '/calls', session);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.calls[0].callId, created.body.callId);
  } finally {
    await teardown();
  }
});
