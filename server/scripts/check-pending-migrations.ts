import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Pool } from 'pg';

type MigrationClient = {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
};

export async function pendingMigrations(client: MigrationClient, folder = './db/migrations'): Promise<number[]> {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const table = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS journal");
  const applied = table.rows[0]?.journal
    ? (await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations')).rows
    : [];
  return migrations
    .filter(migration => !applied.some(row =>
      Number(row.created_at) === migration.folderMillis && row.hash === migration.hash))
    .map(migration => migration.folderMillis);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('migration verification requires DATABASE_URL_DIRECT or DATABASE_URL');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  try {
    const pending = await pendingMigrations(pool);
    if (pending.length) {
      console.error(`migration verification: pending migrations: ${pending.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('migration verification: no pending migrations');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('migration verification failed: pending migrations or unavailable migration journal');
    process.exitCode = 1;
  });
}
