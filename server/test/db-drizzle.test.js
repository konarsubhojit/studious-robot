'use strict';

/**
 * Tests for the Drizzle ORM schema, generated migrations, and runtime client.
 *
 * These are gated on `DATABASE_URL`: when it is unset (the common case in CI
 * and local dev without a database), the whole suite is skipped so the rest of
 * the server tests keep running offline.  When a Postgres connection IS
 * available, the suite applies the generated migrations to a scratch schema and
 * verifies the schema shape plus a basic round-trip insert/select through the
 * Drizzle client.
 *
 * To run against the local/CI Postgres:
 *   DATABASE_URL=******host:5432/db npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { randomUUID } = require('crypto');

const HAS_DB = Boolean(process.env.DATABASE_URL);
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// Schema definitions are import-safe without a DB connection.
const schema = require('../db/schema');

test('schema module exports all five tables', () => {
  for (const name of ['calls', 'callEvents', 'devices', 'auditLog', 'blocks']) {
    assert.ok(schema[name], `schema.${name} should be defined`);
  }
});

test('generated migrations are present and journalled', () => {
  const fs = require('fs');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length >= 1, 'at least one generated .sql migration must exist');

  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  );
  assert.equal(journal.entries.length, files.length, 'journal must track every migration');
});

test('migrations apply and the Drizzle client round-trips', { skip: !HAS_DB }, async () => {
  const { drizzle } = require('drizzle-orm/node-postgres');
  const { migrate } = require('drizzle-orm/node-postgres/migrator');
  const { eq } = require('drizzle-orm');
  const { Pool } = require('pg');

  // Isolate this test run in a throwaway database so it never clobbers app data
  // and so the migrations' `public`-qualified foreign keys resolve correctly.
  const tmpDb = `drizzle_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE DATABASE "${tmpDb}"`);

  const tmpUrl = new URL(process.env.DATABASE_URL);
  tmpUrl.pathname = `/${tmpDb}`;
  const pool = new Pool({ connectionString: tmpUrl.toString() });

  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // Every table should exist.
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tableNames = rows.map((r) => r.table_name);
    for (const expected of ['calls', 'call_events', 'devices', 'audit_log', 'blocks']) {
      assert.ok(tableNames.includes(expected), `missing table ${expected}`);
    }

    // Round-trip a call + event through the typed Drizzle client.
    const callId = randomUUID();
    await db.insert(schema.calls).values({
      callId,
      callerId: 'user-alice',
      calleeId: 'user-bob',
      status: 'ringing',
    });
    await db.insert(schema.callEvents).values({
      eventId: randomUUID(),
      callId,
      event: 'created',
      actor: 'user-alice',
    });

    const found = await db.select().from(schema.calls).where(eq(schema.calls.callId, callId));
    assert.equal(found.length, 1);
    assert.equal(found[0].callerId, 'user-alice');
    assert.equal(found[0].status, 'ringing');
    assert.ok(found[0].createdAt instanceof Date, 'createdAt defaults via now()');

    const events = await db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callId));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'created');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${tmpDb}"`).catch(() => {});
    await admin.end();
  }
});
