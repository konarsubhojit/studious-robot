/**
 * Unit tests for the datastore query-timing helper, its SQL classification,
 * and the telemetry aggregation it feeds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SLOW_QUERY_MS,
  describeSqlStatement,
  isQueryTimingEnabled,
  setQueryTimingSink,
  slowQueryThresholdMs,
  sqlTextOf,
  timeQuery,
} from '../src/lib/queryTiming.ts';
import { createTelemetry } from '../src/telemetry.ts';

/**
 * Collect every record the helper reports while `run` executes, restoring the
 * previous (no-op) sink afterwards so tests never leak instrumentation.
 */
async function withSink(run: () => Promise<void>) {
  const records: any[] = [];
  const release = setQueryTimingSink((record) => records.push(record));
  try {
    await run();
  } finally {
    release();
  }
  return records;
}

/**
 * Silence the console for the duration of `run`: a slow/failed query logs a
 * warning by design, which would otherwise clutter the test output.
 */
async function withQuietConsole(run: () => Promise<void>) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await run();
  } finally {
    console.warn = warn;
  }
}

// ─── Slow-query threshold ─────────────────────────────────────────────────────

test('the default slow-query threshold is 100ms for every backend', () => {
  assert.equal(DEFAULT_SLOW_QUERY_MS, 100);
  assert.equal(slowQueryThresholdMs('pg'), 100);
  assert.equal(slowQueryThresholdMs('mongo'), 100);
  assert.equal(slowQueryThresholdMs('redis'), 100);
});

test('the slow-query threshold is configurable per backend', () => {
  process.env.DB_SLOW_QUERY_MS = '250';
  process.env.MONGO_SLOW_QUERY_MS = '500';
  try {
    assert.equal(slowQueryThresholdMs('pg'), 250);
    assert.equal(slowQueryThresholdMs('mongo'), 500);
    assert.equal(slowQueryThresholdMs('redis'), 100);
  } finally {
    delete process.env.DB_SLOW_QUERY_MS;
    delete process.env.MONGO_SLOW_QUERY_MS;
  }
});

test('an unparseable threshold falls back to the default', () => {
  process.env.DB_SLOW_QUERY_MS = 'soon';
  try {
    assert.equal(slowQueryThresholdMs('pg'), DEFAULT_SLOW_QUERY_MS);
  } finally {
    delete process.env.DB_SLOW_QUERY_MS;
  }
});

// ─── timeQuery ────────────────────────────────────────────────────────────────

test('timeQuery reports a successful query and returns its result', async () => {
  const records = await withSink(async () => {
    const result = await timeQuery(
      { backend: 'pg', operation: 'select', kind: 'read', target: 'users' },
      async () => 'rows'
    );
    assert.equal(result, 'rows');
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].backend, 'pg');
  assert.equal(records[0].operation, 'select');
  assert.equal(records[0].kind, 'read');
  assert.equal(records[0].target, 'users');
  assert.equal(records[0].ok, true);
  assert.equal(records[0].errorCode, null);
  assert.ok(records[0].durationMs >= 0);
});

test('timeQuery reports a failure with its driver code and re-throws untouched', async () => {
  const failure = Object.assign(new Error('boom'), { code: '23505' });
  let records: any[] = [];

  await withQuietConsole(async () => {
    records = await withSink(async () => {
      await assert.rejects(
        () =>
          timeQuery({ backend: 'pg', operation: 'insert', kind: 'write', target: 'users' }, () => {
            throw failure;
          }),
        (error: unknown) => error === failure
      );
    });
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].ok, false);
  assert.equal(records[0].errorCode, '23505');
  assert.equal(records[0].kind, 'write');
});

test('timeQuery flags a query at or over the threshold as slow', async () => {
  process.env.DB_SLOW_QUERY_MS = '5';
  let records: any[] = [];
  try {
    await withQuietConsole(async () => {
      records = await withSink(async () => {
        await timeQuery({ backend: 'pg', operation: 'select', kind: 'read' }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      });
    });
  } finally {
    delete process.env.DB_SLOW_QUERY_MS;
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].slow, true);
});

test('timeQuery labels a blank operation as "other" and a missing target as null', async () => {
  const records = await withSink(async () => {
    await timeQuery({ backend: 'mongo', operation: '   ', kind: 'read' }, async () => undefined);
  });

  assert.equal(records[0].operation, 'other');
  assert.equal(records[0].target, null);
});

test('a throwing sink never breaks the query it measures', async () => {
  const release = setQueryTimingSink(() => {
    throw new Error('sink exploded');
  });
  try {
    const result = await timeQuery(
      { backend: 'redis', operation: 'get', kind: 'read' },
      async () => 'value'
    );
    assert.equal(result, 'value');
  } finally {
    release();
  }
});

test('releasing a superseded sink leaves the current one installed', async () => {
  const first: any[] = [];
  const second: any[] = [];
  const releaseFirst = setQueryTimingSink((record) => first.push(record));
  const releaseSecond = setQueryTimingSink((record) => second.push(record));

  try {
    // A server torn down after another took the sink over must not blind it.
    releaseFirst();
    await timeQuery({ backend: 'pg', operation: 'select', kind: 'read' }, async () => undefined);
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);

    releaseSecond();
    await timeQuery({ backend: 'pg', operation: 'select', kind: 'read' }, async () => undefined);
    assert.equal(second.length, 1);
  } finally {
    releaseSecond();
  }
});

test('DB_QUERY_TIMING=false disables timing entirely', async () => {
  process.env.DB_QUERY_TIMING = 'false';
  try {
    assert.equal(isQueryTimingEnabled(), false);
    const records = await withSink(async () => {
      const result = await timeQuery(
        { backend: 'pg', operation: 'select', kind: 'read' },
        async () => 'rows'
      );
      assert.equal(result, 'rows');
    });
    assert.deepEqual(records, []);
  } finally {
    delete process.env.DB_QUERY_TIMING;
  }
  assert.equal(isQueryTimingEnabled(), true);
});

// ─── SQL classification ───────────────────────────────────────────────────────

test('describeSqlStatement classifies reads and writes and names the table', () => {
  assert.deepEqual(describeSqlStatement('select "user_id" from "users" where "user_id" = $1'), {
    operation: 'select',
    kind: 'read',
    target: 'users',
  });
  assert.deepEqual(describeSqlStatement('insert into "devices" ("device_id") values ($1)'), {
    operation: 'insert',
    kind: 'write',
    target: 'devices',
  });
  assert.deepEqual(describeSqlStatement('update "calls" set "status" = $1'), {
    operation: 'update',
    kind: 'write',
    target: 'calls',
  });
  assert.deepEqual(describeSqlStatement('delete from "blocks" where "blocker_id" = $1'), {
    operation: 'delete',
    kind: 'write',
    target: 'blocks',
  });
});

test('describeSqlStatement degrades safely on an unusable statement', () => {
  assert.deepEqual(describeSqlStatement(''), { operation: 'other', kind: 'write', target: null });
  assert.deepEqual(describeSqlStatement(undefined), {
    operation: 'other',
    kind: 'write',
    target: null,
  });
  assert.equal(describeSqlStatement('BEGIN').target, null);
});

test('sqlTextOf accepts both pg query forms', () => {
  assert.equal(sqlTextOf('select 1'), 'select 1');
  assert.equal(sqlTextOf({ text: 'select 1', values: ['secret'] }), 'select 1');
  assert.equal(sqlTextOf(42), null);
});

// ─── Telemetry aggregation ────────────────────────────────────────────────────

/**
 * @returns a timing record with sensible defaults for the fields under test.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'pg',
    operation: 'select',
    kind: 'read',
    target: 'users',
    durationMs: 10,
    ok: true,
    errorCode: null,
    slow: false,
    ...overrides,
  } as any;
}

test('telemetry counts queries by kind and exposes them on the snapshot', () => {
  const telemetry = createTelemetry();
  telemetry.recordDbQuery(record({ durationMs: 5 }));
  telemetry.recordDbQuery(record({ operation: 'insert', kind: 'write', durationMs: 15 }));
  telemetry.recordDbQuery(
    record({ operation: 'insert', kind: 'write', durationMs: 300, slow: true, ok: false, errorCode: '23505' })
  );

  const snap = telemetry.getSnapshot();
  assert.equal(snap.counters.db_queries_total, 3);
  assert.equal(snap.counters.db_reads_total, 1);
  assert.equal(snap.counters.db_writes_total, 2);
  assert.equal(snap.counters.db_slow_queries_total, 1);
  assert.equal(snap.counters.db_query_errors_total, 1);
  assert.equal(snap.histograms.pg_query_duration_ms.count, 3);
  assert.equal(snap.derived.db_slow_query_rate, 0.3333);
  assert.equal(snap.derived.db_query_error_rate, 0.3333);
});

test('the per-operation breakdown is sorted with the costliest operation first', () => {
  const telemetry = createTelemetry();
  telemetry.recordDbQuery(record({ operation: 'select', durationMs: 10 }));
  telemetry.recordDbQuery(
    record({ backend: 'mongo', operation: 'listConversations', durationMs: 400, slow: true })
  );
  telemetry.recordDbQuery(record({ backend: 'mongo', operation: 'listConversations', durationMs: 200, slow: true }));

  const [first, second] = telemetry.getSnapshot().dbQueries;
  assert.equal(first.backend, 'mongo');
  assert.equal(first.operation, 'listConversations');
  assert.equal(first.kind, 'read');
  assert.equal(first.count, 2);
  assert.equal(first.totalMs, 600);
  assert.equal(first.meanMs, 300);
  assert.equal(first.maxMs, 400);
  assert.equal(first.slow, 2);
  assert.equal(second.operation, 'select');
});

test('the per-operation breakdown is bounded, folding overflow into "other"', () => {
  const telemetry = createTelemetry();
  for (let i = 0; i < 150; i++) {
    telemetry.recordDbQuery(record({ operation: `op_${i}` }));
  }
  const rows = telemetry.getSnapshot().dbQueries;
  assert.ok(rows.length <= 101, `unexpected row count ${rows.length}`);
  assert.ok(rows.some((row) => row.operation === 'other'));
});

test('the overflow row never mixes read cost with write cost', () => {
  const telemetry = createTelemetry();
  // Fill the map, then push both a read and a write past the cap.
  for (let i = 0; i < 100; i++) {
    telemetry.recordDbQuery(record({ operation: `op_${i}` }));
  }
  telemetry.recordDbQuery(record({ operation: 'overflow_read', kind: 'read', durationMs: 7 }));
  telemetry.recordDbQuery(record({ operation: 'overflow_write', kind: 'write', durationMs: 9 }));

  const overflow = telemetry
    .getSnapshot()
    .dbQueries.filter((row) => row.operation === 'other');
  assert.equal(overflow.length, 2);
  assert.equal(overflow.find((row) => row.kind === 'read')?.totalMs, 7);
  assert.equal(overflow.find((row) => row.kind === 'write')?.totalMs, 9);
});

test('the same operation is tracked separately per kind', () => {
  const telemetry = createTelemetry();
  telemetry.recordDbQuery(record({ backend: 'pg', operation: 'with', kind: 'read', durationMs: 4 }));
  telemetry.recordDbQuery(record({ backend: 'pg', operation: 'with', kind: 'write', durationMs: 6 }));

  const rows = telemetry.getSnapshot().dbQueries;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.kind === 'read')?.totalMs, 4);
  assert.equal(rows.find((row) => row.kind === 'write')?.totalMs, 6);
});

test('a non-finite duration is ignored rather than corrupting the totals', () => {
  const telemetry = createTelemetry();
  telemetry.recordDbQuery(record({ durationMs: Number.NaN }));
  assert.equal(telemetry.getSnapshot().counters.db_queries_total, 0);
});

// ─── Mongo store instrumentation ──────────────────────────────────────────────

/** Minimal stand-in for the driver surface the message store touches. */
function createStubMongoClient() {
  const collection = {
    async createIndex() {},
    async updateOne() {
      return { upsertedCount: 1 };
    },
    async updateMany() {
      return { modifiedCount: 0 };
    },
    async findOne() {
      return null;
    },
    find() {
      return {
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return [];
        },
      };
    },
  };
  return {
    async connect() {},
    db() {
      return { collection: () => collection };
    },
    async close() {},
  };
}

test('every mongo store method reports one timing labelled read or write', async () => {
  const { createMongoMessageStore } = await import('../src/messageStore.ts');
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: createStubMongoClient() });

  const records = await withSink(async () => {
    await store.listMessages({ conversationId: 'alice:bob' });
    await store.listConversations('alice');
    await store.saveMessage({ senderId: 'alice', recipientId: 'bob', body: 'hi' });
    await store.markRead('alice:bob', 'bob');
  });

  assert.deepEqual(
    records.map((entry) => [entry.backend, entry.operation, entry.kind]),
    [
      ['mongo', 'listMessages', 'read'],
      ['mongo', 'listConversations', 'read'],
      ['mongo', 'saveMessage', 'write'],
      ['mongo', 'markRead', 'write'],
    ]
  );
  assert.ok(records.every((entry) => entry.target === 'messages' && entry.ok));

  await store.close?.();
});

test('the one-time mongo connect/index build is not billed to the first query', async () => {
  const { createMongoMessageStore } = await import('../src/messageStore.ts');
  const client = createStubMongoClient();
  const slowConnect = {
    ...client,
    async connect() {
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
  };
  const store = createMongoMessageStore({ uri: 'mongodb://stub', client: slowConnect });

  const records = await withSink(async () => {
    await store.listMessages({ conversationId: 'alice:bob' });
  });

  assert.equal(records.length, 1);
  assert.ok(
    records[0].durationMs < 50,
    `connect time leaked into the query timing: ${records[0].durationMs}ms`
  );

  await store.close?.();
});

// ─── Postgres pool instrumentation ────────────────────────────────────────────

test('the Postgres pool times every statement, including failures', async () => {
  const previous = process.env.DATABASE_URL;
  // Port 1 is never listening: the statement fails fast, which is enough to
  // prove the wrapper measures and classifies it (the driver never has to
  // succeed for the timing path to be exercised).
  process.env.DATABASE_URL = 'postgres://wetalk@127.0.0.1:1/wetalk';
  const { getPool, closeDb } = await import('../db/client.ts');

  let records: any[] = [];
  try {
    await withQuietConsole(async () => {
      records = await withSink(async () => {
        const pool = getPool();
        await assert.rejects(() => pool.query('select "user_id" from "users" where "user_id" = $1', ['alice']));
      });
    });
  } finally {
    await closeDb().catch(() => {});
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].backend, 'pg');
  assert.equal(records[0].operation, 'select');
  assert.equal(records[0].kind, 'read');
  assert.equal(records[0].target, 'users');
  assert.equal(records[0].ok, false);
});
