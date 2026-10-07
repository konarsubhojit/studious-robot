import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { pendingMigrations } from '../scripts/check-pending-migrations.ts';

const folder = fileURLToPath(new URL('../db/migrations', import.meta.url));
const migrations = readMigrationFiles({ migrationsFolder: folder });

test('migration verification detects absent journals, pending rows, and changed hashes', async () => {
  const applied = migrations.map(migration => ({ hash: migration.hash, created_at: String(migration.folderMillis) }));
  const client = (rows: Record<string, unknown>[], journal: string | null = 'drizzle.__drizzle_migrations') => ({
    query: async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ journal }] : rows }),
  });
  assert.deepEqual(await pendingMigrations(client(applied), folder), []);
  assert.equal((await pendingMigrations(client([], null), folder)).length, migrations.length);
  assert.deepEqual(await pendingMigrations(client(applied.slice(0, -1)), folder), [migrations.at(-1)!.folderMillis]);
  assert.deepEqual(await pendingMigrations(client([{ ...applied[0], hash: 'changed' }, ...applied.slice(1)]), folder),
    [migrations[0].folderMillis]);
});

test('migration verification propagates database failures', async () => {
  await assert.rejects(pendingMigrations({
    query: async () => { throw new Error('database unavailable'); },
  }, folder), /database unavailable/);
});
