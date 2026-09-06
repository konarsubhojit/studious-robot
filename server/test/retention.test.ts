/**
 * Tests for the Postgres retention sweep and for bounded boot hydration.
 *
 * `calls`, `call_events`, `audit_log` and `messages` are append-only.  Before
 * the sweep existed they grew without bound, and because `hydrateCallsAndEventsFromDb`
 * read `calls` and `call_events` in full, an unbounded table also meant an
 * unbounded startup read on every instance.  These tests pin both halves: what
 * the sweep deletes (and, just as importantly, what it must not), and that
 * hydration reads a bounded, newest-first page scoped to the calls it kept.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runRetentionSweep } from '../src/lib/retention.ts';
import { hydrateCallsAndEventsFromDb } from '../src/callPersistence.ts';
import { createStores } from '../src/stores/index.ts';
import * as schema from '../db/schema.ts';
import { asDatabase } from './helpers.ts';
import { DEFAULT_MAX_RETAINED_CALLS } from '../src/config.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row is "expired" relative to the fixed clock the tests inject. */
const NOW = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Build a Drizzle double that records the shape of every delete it is asked to
 * perform, and answers `.returning()` with a caller-chosen row count.
 *
 * The sweep's correctness lives in *which* rows the sub-select targets, which a
 * double cannot evaluate — so the double records the table and the requested
 * limit, and the assertions cover the parts that are decidable without a real
 * Postgres: which tables are touched, whether a sweep runs at all, and that one
 * table failing does not stop the other.
 */
function buildDeleteRecorder({
  deleted = new Map<unknown, number>(),
  failFor = new Set<unknown>(),
  selected = new Map<unknown, unknown[]>(),
} = {}) {
  const calls: { table: unknown; limit: number | null; }[] = [];

  const db = {
    calls,
    select() {
      return {
        from(table: unknown) {
          // Thenable as well as chainable: the composite-key `messages` sweep
          // awaits its sub-select and then deletes row by row, because matching
          // on `messageId` alone could take a row from another conversation.
          const chain: any = {
            table,
            where: () => chain,
            orderBy: () => chain,
            limit(n: number) {
              chain.limitValue = n;
              return chain;
            },
            then(resolve: (rows: unknown[]) => unknown) {
              return Promise.resolve(selected.get(table) ?? []).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    delete(table: unknown) {
      return {
        where(condition: any) {
          return {
            returning() {
              if (failFor.has(table)) {
                return Promise.reject(new Error('lock timeout'));
              }
              calls.push({ table, limit: condition?.limitValue ?? null });
              const count = deleted.get(table) ?? 0;
              return Promise.resolve(Array.from({ length: count }, (_, i) => ({ id: i })));
            },
          };
        },
      };
    },
  };

  return db;
}

test('the retention sweep prunes calls and the audit log, and reports what it deleted', async () => {
  const db = buildDeleteRecorder({
    deleted: new Map<unknown, number>([
      [schema.calls, 3],
      [schema.auditLog, 7],
    ]),
  });

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 90 * DAY_MS,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  assert.deepEqual(result, { calls: 3, auditLog: 7, messages: 0 });
  assert.deepEqual(
    db.calls.map((entry) => entry.table),
    [schema.calls, schema.auditLog],
    'both append-only tables are swept'
  );
});

test('call_events is never swept directly — it cascades with its call', async () => {
  const db = buildDeleteRecorder();

  await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 90 * DAY_MS,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  assert.ok(
    !db.calls.some((entry) => entry.table === schema.callEvents),
    'deleting a call must take its events with it, in one statement'
  );
});

test('a retention of 0 disables that table\'s sweep without disabling the other', async () => {
  const db = buildDeleteRecorder({ deleted: new Map<unknown, number>([[schema.auditLog, 2]]) });

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 0,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  assert.deepEqual(result, { calls: 0, auditLog: 2, messages: 0 });
  assert.deepEqual(db.calls.map((entry) => entry.table), [schema.auditLog]);
});

test('a failing table does not stop the other from being swept', async () => {
  const db = buildDeleteRecorder({
    deleted: new Map<unknown, number>([[schema.auditLog, 5]]),
    failFor: new Set<unknown>([schema.calls]),
  });

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 90 * DAY_MS,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  assert.equal(result.calls, 0, 'the failure is absorbed, not propagated');
  assert.equal(result.auditLog, 5, 'the audit sweep still ran');
});

test('the sweep is a no-op without Postgres', async () => {
  const result = await runRetentionSweep(null, {
    now: NOW,
    callRetentionMs: 90 * DAY_MS,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  assert.deepEqual(result, { calls: 0, auditLog: 0, messages: 0 });
});

test('messages are kept forever unless an operator sets a retention window', async () => {
  const db = buildDeleteRecorder({
    selected: new Map<unknown, unknown[]>([
      [schema.messages, [{ conversationId: 'alice:bob', messageId: 'm-1' }]],
    ]),
  });

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 90 * DAY_MS,
    auditRetentionMs: 180 * DAY_MS,
    messageRetentionMs: 0,
  });

  // Chat is the user's own content, not a record the server made about them;
  // deleting it because a background job decided it was old is data loss, so
  // the default has to be "keep".
  assert.equal(result.messages, 0);
  assert.ok(!db.calls.some((entry) => entry.table === schema.messages));
});

test('an explicit message retention window prunes expired messages', async () => {
  const db = buildDeleteRecorder({
    deleted: new Map<unknown, number>([[schema.messages, 1]]),
    selected: new Map<unknown, unknown[]>([
      [
        schema.messages,
        [
          { conversationId: 'alice:bob', messageId: 'm-1' },
          { conversationId: 'alice:carol', messageId: 'm-2' },
        ],
      ],
    ]),
  });

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 0,
    auditRetentionMs: 0,
    messageRetentionMs: 30 * DAY_MS,
  });

  assert.equal(result.messages, 2, 'both selected rows are deleted');
  // One delete per row, each keyed by the *composite* key: `messageId` is
  // client-supplied and only unique within its conversation.
  assert.deepEqual(db.calls.map((entry) => entry.table), [schema.messages, schema.messages]);
});

test('a message sweep that finds nothing issues no deletes', async () => {
  const db = buildDeleteRecorder();

  const result = await runRetentionSweep(asDatabase(db), {
    now: NOW,
    callRetentionMs: 0,
    auditRetentionMs: 0,
    messageRetentionMs: 30 * DAY_MS,
  });

  assert.equal(result.messages, 0);
  assert.equal(db.calls.length, 0);
});

// ─── Bounded hydration ───────────────────────────────────────────────────────

/**
 * Build a Drizzle double for hydration that records the `limit` the caller
 * asked for and the call ids it scoped the event read to.
 */
function buildHydrationDb(callRows: any[], eventRows: any[]) {
  const observed: { limit: number | null; eventScope: unknown; eventWhereCalled: boolean; } = {
    limit: null,
    eventScope: null,
    eventWhereCalled: false,
  };

  const db = {
    observed,
    select() {
      return {
        from(table: unknown) {
          const rows = table === schema.calls ? callRows : eventRows;
          const chain: any = {
            where(condition: unknown) {
              if (table === schema.callEvents) {
                observed.eventWhereCalled = true;
                observed.eventScope = condition;
              }
              return chain;
            },
            orderBy: () => chain,
            limit(n: number) {
              if (table === schema.calls) observed.limit = n;
              return chain;
            },
            then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
          };
          return chain;
        },
      };
    },
  };

  return db;
}

/** Minimal in-memory stores, as `createServer` builds them. */
function buildState() {
  return createStores();
}

test('boot hydration reads at most MAX_RETAINED_CALLS rows, not the whole table', async () => {
  const callRows = [
    {
      callId: '00000000-0000-4000-8000-000000000001',
      callerId: 'alice',
      calleeId: 'bob',
      status: 'ended',
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    },
  ];
  const db = buildHydrationDb(callRows, []);

  await hydrateCallsAndEventsFromDb(asDatabase(db), buildState() as any);

  assert.equal(
    db.observed.limit,
    DEFAULT_MAX_RETAINED_CALLS,
    'the in-memory map is capped at this, so reading more only feeds pruneOldCalls'
  );
});

test('event hydration is scoped to the calls that were kept', async () => {
  const callRows = [
    {
      callId: '00000000-0000-4000-8000-000000000002',
      callerId: 'alice',
      calleeId: 'bob',
      status: 'ended',
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    },
  ];
  const eventRows = [
    {
      eventId: '00000000-0000-4000-8000-0000000000e1',
      callId: '00000000-0000-4000-8000-000000000002',
      event: 'ended',
      actor: 'alice',
      reason: null,
      createdAt: new Date(NOW),
    },
  ];
  const db = buildHydrationDb(callRows, eventRows);
  const state = buildState();

  await hydrateCallsAndEventsFromDb(asDatabase(db), state as any);

  assert.ok(db.observed.eventWhereCalled, 'the event read must carry an IN (...) predicate');
  assert.equal(state.callEvents.get('00000000-0000-4000-8000-000000000002')?.length, 1);
});

test('no calls hydrated means the event table is not read at all', async () => {
  const db = buildHydrationDb([], [{ eventId: 'x', callId: 'y', event: 'ended' }]);
  const state = buildState();

  await hydrateCallsAndEventsFromDb(asDatabase(db), state as any);

  assert.equal(db.observed.eventWhereCalled, false, 'an empty IN (...) is a full scan, so skip it');
  assert.equal(state.callEvents.size, 0);
});
