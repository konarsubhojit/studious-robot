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
import { randomUUID } from 'crypto';
import { createServer } from '../src/index.ts';
import * as schema from '../db/schema.ts';
import { getJson, listenOnRandomPort, postJson } from './helpers.ts';

// ─── Fake Drizzle db ──────────────────────────────────────────────────────────

/** Map from a `calls` SQL column name to the property used on a row object. */
const CALL_COLUMN_TO_PROPERTY = new Map(
  Object.entries(schema.calls as unknown as Record<string, any>)
    .filter(([, column]) => typeof column?.name === 'string')
    .map(([property, column]) => [column.name as string, property])
);

/**
 * Compile a Drizzle condition (`and` / `or` of `eq`) into a row predicate.
 *
 * Only the shapes this read path builds are understood; anything else throws so
 * a query change can never silently degrade into "matches everything".
 */
function compilePredicate(node: any): (row: any) => boolean {
  const children: Array<(row: any) => boolean> = [];
  let operator: 'and' | 'or' = 'and';
  let column: string | null = null;

  for (const chunk of node?.queryChunks ?? []) {
    if (Array.isArray(chunk?.value) && chunk?.value.every((part: unknown) => typeof part === 'string')) {
      const text = chunk.value.join('').trim();
      if (text === 'and' || text === 'or') operator = text;
      continue;
    }
    if (chunk?.queryChunks) {
      children.push(compilePredicate(chunk));
      continue;
    }
    if (typeof chunk?.name === 'string' && chunk?.table) {
      column = CALL_COLUMN_TO_PROPERTY.get(chunk.name) ?? chunk.name;
      continue;
    }
    if (column !== null && chunk && 'value' in chunk) {
      const property = column;
      const expected = chunk.value;
      children.push((row: any) => row[property] === expected);
      column = null;
      continue;
    }
    throw new Error(`fake db: unsupported condition chunk ${JSON.stringify(chunk)}`);
  }

  if (children.length === 0) return () => true;
  return (row: any) =>
    operator === 'and' ? children.every((p) => p(row)) : children.some((p) => p(row));
}

/** @returns the row properties named by a list of `desc(column)` expressions. */
function orderProperties(expressions: any[]): string[] {
  const properties: string[] = [];
  for (const expression of expressions) {
    for (const chunk of expression?.queryChunks ?? []) {
      if (typeof chunk?.name === 'string' && chunk?.table) {
        properties.push(CALL_COLUMN_TO_PROPERTY.get(chunk.name) ?? chunk.name);
      }
    }
  }
  return properties;
}

/**
 * A minimal Drizzle stand-in that upserts `calls` rows and answers the
 * filtered, ordered, paged history query against them.
 */
function createFakeCallsDb() {
  const rows = new Map<string, any>();

  /** Seed a call row directly, as if it had been persisted in an earlier run. */
  function seedCall(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const row = {
      callId: randomUUID(),
      callerId: 'user-seed-caller',
      calleeId: 'user-seed-callee',
      status: 'ended',
      endReason: 'ended',
      durationSeconds: 0,
      missedReadAt: null,
      createdAt: now,
      updatedAt: now,
      ringTimeoutAt: null,
      ...overrides,
    };
    rows.set(row.callId, row);
    return row;
  }

  function select(selection?: Record<string, unknown>) {
    const isCount = Boolean(selection);
    return {
      from(table: any) {
        let predicate: (row: any) => boolean = () => true;
        let order: string[] = [];
        let limit = Infinity;
        let offset = 0;

        const resolve = () => {
          if (table !== schema.calls) return [];
          let matched = [...rows.values()].filter(predicate);
          if (isCount) return [{ value: matched.length }];
          for (const property of [...order].reverse()) {
            matched = [...matched].sort((a, b) => {
              const left = a[property] instanceof Date ? a[property].getTime() : a[property];
              const right = b[property] instanceof Date ? b[property].getTime() : b[property];
              if (left === right) return 0;
              return left < right ? 1 : -1; // descending
            });
          }
          return matched.slice(offset, offset + limit);
        };

        const builder: any = {
          where(condition: any) {
            predicate = compilePredicate(condition);
            return builder;
          },
          orderBy(...expressions: any[]) {
            order = orderProperties(expressions);
            return builder;
          },
          limit(value: number) {
            limit = value;
            return builder;
          },
          offset(value: number) {
            offset = value;
            return builder;
          },
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve(resolve()).then(onFulfilled, onRejected);
          },
        };
        return builder;
      },
    };
  }

  return {
    rows,
    seedCall,
    select,
    insert(table: any) {
      return {
        values(values: any) {
          if (table === schema.calls) rows.set(values.callId, { ...values });
          const promise: any = Promise.resolve();
          promise.onConflictDoUpdate = ({ set }: { set: any; }) => {
            if (table === schema.calls) {
              rows.set(values.callId, { ...rows.get(values.callId), ...values, ...set });
            }
            return Promise.resolve();
          };
          promise.onConflictDoNothing = () => Promise.resolve();
          return promise;
        },
      };
    },
    update() {
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
    delete() {
      return { where: () => Promise.resolve() };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(opts?: import('../src/createServer.ts').CreateServerOptions) {
  const server = createServer(opts);
  const port = await listenOnRandomPort(server.httpServer);
  const url = `http://127.0.0.1:${port}`;
  async function teardown() {
    server.httpServer.closeAllConnections?.();
    await new Promise((resolve) => {
      void server.io.close(() => server.httpServer.close(() => resolve(undefined)));
    });
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
  const failingDb = {
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
  };

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
