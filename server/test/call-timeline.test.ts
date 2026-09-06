/**
 * Tests for the durable conversation-timeline call reads.
 *
 * The chat timeline, the chat list and missed-call acknowledgement used to read
 * the in-memory `state.calls` map, which is bounded by `CALL_RETENTION_MS` /
 * `MAX_RETAINED_CALLS` and emptied by a restart.  A call that aged out of it
 * therefore still appeared in `GET /calls` but had silently vanished from the
 * conversation — and an unacknowledged missed call that aged out could never be
 * marked read, so it came back unread on the next restart.
 *
 * Every test below seeds a row *only* into the fake `calls` table, never into
 * `state.calls`, which is exactly the state an evicted or pre-restart call is
 * in.  They run entirely offline (no DATABASE_URL needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { createServer } from '../src/index.ts';
import { createMemoryMessageStore } from '../src/messageStore.ts';
import { createFakeCallsDb } from './fakeCallsDb.ts';
import { closeTestServer, getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The fake db answers `calls` queries only, so messages come from the in-memory
 * store: these tests are about the call side of the timeline, and every
 * conversation they assert on is therefore contributed purely by a call.
 */
async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer({ messageStore: createMemoryMessageStore(), ...opts });
  const port = await listenOnRandomPort(server.httpServer);
  async function teardown() {
    await closeTestServer(server);
  }
  return { ...server, url: `http://127.0.0.1:${port}`, teardown };
}

async function createSession(url: string, userId: string): Promise<string> {
  const res = await postJson(url, '/session', { userId, deviceId: `device-${userId}` });
  assert.equal(res.status, 201);
  return res.body.sessionId;
}

function isoAgo(ms: number): Date {
  return new Date(Date.now() - ms);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('timeline: a call only in the durable table still appears in the conversation', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-alice');
    const seeded = db.seedCall({
      callerId: 'user-tl-alice',
      calleeId: 'user-tl-bob',
      status: 'ended',
      endReason: 'ended',
      durationSeconds: 42,
      createdAt: isoAgo(60_000),
      updatedAt: isoAgo(60_000),
    });

    const res = await getJson(url, '/messages?peerId=user-tl-bob&include=calls', session);
    assert.equal(res.status, 200);

    const calls = res.body.messages.filter((entry: any) => entry.type === 'call');
    assert.equal(calls.length, 1, 'the evicted call should still be on the timeline');
    assert.equal(calls[0].callId, seeded.callId);
    assert.equal(calls[0].direction, 'outgoing');
    assert.equal(calls[0].status, 'ended');
    assert.equal(calls[0].durationSeconds, 42);
  } finally {
    await teardown();
  }
});

test('timeline: a cancelled call is still reported as cancelled from the table', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-cancel');
    db.seedCall({
      callerId: 'user-tl-cancel',
      calleeId: 'user-tl-peer',
      status: 'ended',
      endReason: 'cancelled',
      createdAt: isoAgo(1_000),
      updatedAt: isoAgo(1_000),
    });

    const res = await getJson(url, '/messages?peerId=user-tl-peer&include=calls', session);
    const [call] = res.body.messages.filter((entry: any) => entry.type === 'call');
    assert.equal(call.status, 'cancelled', 'the call log and the chat must agree');
    assert.equal(call.endReason, 'cancelled');
  } finally {
    await teardown();
  }
});

test('timeline: the before cursor pages the durable calls', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-page');
    const older = db.seedCall({
      callerId: 'user-tl-page',
      calleeId: 'user-tl-peer2',
      createdAt: isoAgo(120_000),
      updatedAt: isoAgo(120_000),
    });
    db.seedCall({
      callerId: 'user-tl-page',
      calleeId: 'user-tl-peer2',
      createdAt: isoAgo(10_000),
      updatedAt: isoAgo(10_000),
    });

    const cursor = new Date(Date.now() - 60_000).toISOString();
    const res = await getJson(
      url,
      `/messages?peerId=user-tl-peer2&include=calls&before=${encodeURIComponent(cursor)}`,
      session,
    );
    const calls = res.body.messages.filter((entry: any) => entry.type === 'call');
    assert.equal(calls.length, 1, 'only the call older than the cursor should come back');
    assert.equal(calls[0].callId, older.callId);
  } finally {
    await teardown();
  }
});

test('chat list: a durable call becomes the conversation last activity', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-list');
    const seeded = db.seedCall({
      callerId: 'user-tl-list',
      calleeId: 'user-tl-listpeer',
      createdAt: isoAgo(5_000),
      updatedAt: isoAgo(5_000),
    });

    const res = await getJson(url, '/conversations', session);
    assert.equal(res.status, 200);
    const conversation = res.body.conversations.find((c: any) => c.peerId === 'user-tl-listpeer');
    assert.ok(conversation, 'a call-only peer should still be a conversation');
    assert.equal(conversation.lastActivity.type, 'call');
    assert.equal(conversation.lastActivity.callId, seeded.callId);
  } finally {
    await teardown();
  }
});

test('chat list: an unread missed call in the table counts once, not twice', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-unread');
    // Recent *and* unread, so it is returned by both bounded queries: the fold
    // by callId is what stops the badge doubling.
    db.seedCall({
      callerId: 'user-tl-caller',
      calleeId: 'user-tl-unread',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(3_000),
      updatedAt: isoAgo(3_000),
    });

    const res = await getJson(url, '/conversations', session);
    const conversation = res.body.conversations.find((c: any) => c.peerId === 'user-tl-caller');
    assert.ok(conversation);
    assert.equal(conversation.unreadCount, 1, 'the missed call must be counted exactly once');
    assert.equal(conversation.lastActivity.status, 'missed');
  } finally {
    await teardown();
  }
});

test('chat list: an old unread missed call still raises the badge', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-old');
    // Far outside any retention window: only the unread query can find it, and
    // an unread badge that expired with retention would be the worse lie.
    db.seedCall({
      callerId: 'user-tl-oldcaller',
      calleeId: 'user-tl-old',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(400 * 24 * 60 * 60 * 1000),
      updatedAt: isoAgo(400 * 24 * 60 * 60 * 1000),
    });

    const res = await getJson(url, '/conversations', session);
    const conversation = res.body.conversations.find((c: any) => c.peerId === 'user-tl-oldcaller');
    assert.ok(conversation, 'an unacknowledged missed call must survive the retention window');
    assert.equal(conversation.unreadCount, 1);
  } finally {
    await teardown();
  }
});

test('read: acknowledging clears a missed call that is only in the table', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-ack');
    const seeded = db.seedCall({
      callerId: 'user-tl-ackpeer',
      calleeId: 'user-tl-ack',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(9_000),
      updatedAt: isoAgo(9_000),
    });

    const res = await postJson(url, '/messages/read', { peerId: 'user-tl-ackpeer' }, session);
    assert.equal(res.status, 200);
    assert.equal(res.body.missedCallsRead, 1, 'the evicted missed call should be acknowledged');
    assert.ok(db.rows.get(seeded.callId).missedReadAt, 'the table row must carry the timestamp');

    // The badge must not come back — this is the restart-resurrection bug.
    const after = await getJson(url, '/conversations', session);
    const conversation = after.body.conversations.find((c: any) => c.peerId === 'user-tl-ackpeer');
    assert.equal(conversation?.unreadCount ?? 0, 0);
  } finally {
    await teardown();
  }
});

test('read: acknowledging is idempotent and reports nothing the second time', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-idem');
    db.seedCall({
      callerId: 'user-tl-idempeer',
      calleeId: 'user-tl-idem',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(9_000),
      updatedAt: isoAgo(9_000),
    });

    const first = await postJson(url, '/messages/read', { peerId: 'user-tl-idempeer' }, session);
    assert.equal(first.body.missedCallsRead, 1);
    const second = await postJson(url, '/messages/read', { peerId: 'user-tl-idempeer' }, session);
    assert.equal(second.body.missedCallsRead, 0, 'an acknowledged call must not be counted again');
  } finally {
    await teardown();
  }
});

test('read: another user cannot acknowledge a missed call addressed to someone else', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-mallory');
    const seeded = db.seedCall({
      callId: randomUUID(),
      callerId: 'user-tl-mallory',
      calleeId: 'user-tl-victim',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(9_000),
      updatedAt: isoAgo(9_000),
    });

    // Mallory placed the call; only the callee may acknowledge it.
    const res = await postJson(url, '/messages/read', { peerId: 'user-tl-victim' }, session);
    assert.equal(res.status, 200);
    assert.equal(res.body.missedCallsRead, 0);
    assert.equal(db.rows.get(seeded.callId).missedReadAt, null, 'the row must be untouched');
  } finally {
    await teardown();
  }
});

test('timeline: falls back to resident calls when the durable query fails', async () => {
  const db = createFakeCallsDb();
  const failing = {
    ...db,
    select() {
      throw new Error('connection terminated');
    },
  };
  const { url, teardown } = await startServer({
    db: failing as unknown as import('../db/client.ts').Database,
  });
  try {
    const session = await createSession(url, 'user-tl-down');
    // Place a real call so it is resident in `state.calls`, then read it back
    // with the durable path broken.
    await postJson(url, '/calls', { calleeId: 'user-tl-downpeer' }, session);

    const res = await getJson(url, '/messages?peerId=user-tl-downpeer&include=calls', session);
    assert.equal(res.status, 200, 'a database outage must degrade, not fail the request');
    const calls = res.body.messages.filter((entry: any) => entry.type === 'call');
    assert.equal(calls.length, 1, 'the resident call should still be served');

    const list = await getJson(url, '/conversations', session);
    assert.equal(list.status, 200);
    assert.ok(list.body.conversations.some((c: any) => c.peerId === 'user-tl-downpeer'));
  } finally {
    await teardown();
  }
});

test('timeline: a full page of calls still pages without skipping entries', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-deep');
    // More calls than one page holds, each a distinct second apart so the
    // ordering — and therefore the cursor over it — is unambiguous.
    const total = 25;
    for (let index = 0; index < total; index++) {
      db.seedCall({
        callerId: 'user-tl-deep',
        calleeId: 'user-tl-deeppeer',
        createdAt: isoAgo((total - index) * 1_000),
        updatedAt: isoAgo((total - index) * 1_000),
      });
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query = `/messages?peerId=user-tl-deeppeer&include=calls&limit=10${
        cursor ? `&before=${encodeURIComponent(cursor)}` : ''
      }`;
      const res: any = await getJson(url, query, session);
      assert.equal(res.status, 200);
      const calls = res.body.messages.filter((entry: any) => entry.type === 'call');
      if (calls.length === 0) break;
      for (const call of calls) seen.add(call.callId);
      cursor = calls[calls.length - 1].createdAt;
    }

    assert.equal(seen.size, total, 'paging must visit every call exactly once');
  } finally {
    await teardown();
  }
});

test('read: acknowledging does not reorder the call log', async () => {
  const db = createFakeCallsDb();
  const { url, teardown } = await startServer({ db });
  try {
    const session = await createSession(url, 'user-tl-order');
    const missed = db.seedCall({
      callerId: 'user-tl-orderpeer',
      calleeId: 'user-tl-order',
      status: 'missed',
      endReason: null,
      missedReadAt: null,
      createdAt: isoAgo(600_000),
      updatedAt: isoAgo(600_000),
    });
    const newer = db.seedCall({
      callerId: 'user-tl-order',
      calleeId: 'user-tl-othepeer',
      createdAt: isoAgo(1_000),
      updatedAt: isoAgo(1_000),
    });

    const before = await getJson(url, '/calls', session);
    assert.equal(before.body.calls[0].callId, newer.callId);

    await postJson(url, '/messages/read', { peerId: 'user-tl-orderpeer' }, session);

    // Acknowledging is not a state transition, so it must not touch the column
    // the call log is ordered by.
    const after = await getJson(url, '/calls', session);
    assert.equal(
      after.body.calls[0].callId,
      newer.callId,
      'the acknowledged call must not jump to the top of the log',
    );
    assert.ok(db.rows.get(missed.callId).missedReadAt, 'but it must still be acknowledged');
  } finally {
    await teardown();
  }
});
