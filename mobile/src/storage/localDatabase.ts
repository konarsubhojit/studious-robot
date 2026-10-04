import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import RNFS from 'react-native-fs';

export const LOCAL_DATABASE_NAME = 'wetalk-local.sqlite';
let database: Promise<DB> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** No session tokens in keys, and no caller-controlled database paths. */
export function dataScope(server: string, userId: string): string {
  return userId.trim()
    ? JSON.stringify([server.trim().replace(/\/+$/, ''), userId.trim()])
    : '';
}

async function initialize(): Promise<DB> {
  const db = open({ name: LOCAL_DATABASE_NAME, location: RNFS.DocumentDirectoryPath });
  try {
    await db.execute('PRAGMA journal_mode = WAL');
    // An acknowledged outbox commit must survive power loss, not just JS teardown.
    await db.execute('PRAGMA synchronous = FULL');
    await db.execute('PRAGMA busy_timeout = 5000');
    await migrateLocalDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** executeBatch is transactional, including the schema version and legacy-row removal. */
export async function migrateLocalDatabase(db: DB): Promise<void> {
  const version = Number((await db.execute('PRAGMA user_version')).rows[0]?.user_version ?? 0);
  if (version > 2) throw new Error('Local database requires a newer app');
  if (version === 0) {
    await db.executeBatch([
      [`CREATE TABLE chat_records (
          scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          peer TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (scope, kind, id)
        ) WITHOUT ROWID`],
      ['CREATE INDEX chat_peer ON chat_records(scope, kind, peer, position)'],
      [`CREATE TABLE resource_cache (
          scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL, PRIMARY KEY (scope, key)
        ) WITHOUT ROWID`],
      ['PRAGMA user_version = 1'],
    ]);
  }
  if (version < 2) {
    await db.executeBatch([
      [`CREATE TABLE outbox (
          scope TEXT NOT NULL, id TEXT NOT NULL, peer TEXT NOT NULL,
          position INTEGER NOT NULL, client_key TEXT NOT NULL,
          attempts INTEGER NOT NULL, last_error TEXT, next_attempt_at INTEGER,
          state TEXT NOT NULL CHECK(state IN ('pending', 'failed')), payload TEXT NOT NULL,
          PRIMARY KEY (scope, id)
        ) WITHOUT ROWID`],
      ['CREATE INDEX outbox_pending ON outbox(scope, state, next_attempt_at, position)'],
      [`INSERT INTO outbox(scope, id, peer, position, client_key, attempts, last_error, next_attempt_at, state, payload)
          SELECT scope, id, peer, position,
            COALESCE(json_extract(payload, '$.clientMessageId'), id),
            COALESCE(json_extract(payload, '$.attempts'), 0),
            json_extract(payload, '$.lastError'), json_extract(payload, '$.nextAttemptAt'),
            CASE WHEN json_extract(payload, '$.state') = 'failed'
              OR COALESCE(json_extract(payload, '$.attempts'), 0) >= 5 THEN 'failed' ELSE 'pending' END,
            payload FROM chat_records WHERE kind = 'outbox'`],
      ["DELETE FROM chat_records WHERE kind = 'outbox'"],
      ['PRAGMA user_version = 2'],
    ]);
  }
}

/** Serialize complete operations, including reads, migration and account cleanup. */
export function withDatabase<T>(operation: (db: DB) => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    database ??= initialize().catch(error => {
      database = null;
      throw error;
    });
    return operation(await database);
  });
  queue = result.catch(() => {});
  return result;
}
