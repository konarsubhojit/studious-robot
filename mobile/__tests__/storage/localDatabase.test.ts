import { open } from '@op-engineering/op-sqlite';
import { migrateLocalDatabase, withDatabase } from '../../src/storage/localDatabase';
import { clearChatDb, flushChatDb, loadChatSnapshot, resetChatDbCache, saveChatSnapshot } from '../../src/storage/chatDb';
import { drainQueuedMessages, restoreOutboxMessages } from '../../src/messaging/sendPipeline';

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs', exists: jest.fn(async () => false),
}));

const db = open({ name: 'migration-test' });
const legacyPayload = JSON.stringify({
  messageId: 'same-id', clientMessageId: 'client-key', recipientId: 'bob',
  body: 'preserved', attempts: 2, lastError: 'network', nextAttemptAt: Date.now() + 60_000,
});

beforeEach(async () => {
  resetChatDbCache();
  await db.executeBatch([
    ['DROP TABLE IF EXISTS outbox'],
    ['DROP TABLE IF EXISTS chat_records'],
    ['DROP TABLE IF EXISTS resource_cache'],
    [`CREATE TABLE chat_records (
      scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      peer TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(scope, kind, id)
    ) WITHOUT ROWID`],
    [`CREATE TABLE resource_cache (
      scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(scope, key)
    ) WITHOUT ROWID`],
    ['PRAGMA user_version = 1'],
    ...['legacy', 'alice', 'other-account'].map(scope => [
      'INSERT INTO chat_records VALUES (?, ?, ?, ?, ?, ?)',
      [scope, 'outbox', 'same-id', 'bob', 3, legacyPayload],
    ] as [string, (string | number)[]]),
    ['INSERT INTO chat_records VALUES (?, ?, ?, ?, ?, ?)',
      ['alice', 'drafts', 'bob', 'bob', 0, '{"text":"keep draft"}']],
  ]);
});

afterEach(() => { resetChatDbCache(); });

test('v1 migration preserves payloads, client keys, deadlines, scopes and non-outbox records', async () => {
  await migrateLocalDatabase(db);
  expect((await db.execute('PRAGMA user_version')).rows[0].user_version).toBe(2);
  const rows = (await db.execute('SELECT * FROM outbox ORDER BY scope')).rows;
  expect(rows.map(row => row.scope)).toEqual(['alice', 'legacy', 'other-account']);
  for (const row of rows) {
    expect(row).toMatchObject({
      id: 'same-id', peer: 'bob', position: 3, client_key: 'client-key', attempts: 2,
      last_error: 'network', state: 'pending', payload: legacyPayload,
      next_attempt_at: JSON.parse(legacyPayload).nextAttemptAt,
    });
  }
  expect((await db.execute('SELECT kind FROM chat_records')).rows).toEqual([{ kind: 'drafts' }]);
  await migrateLocalDatabase(db);
  expect((await db.execute('SELECT id FROM outbox')).rows).toHaveLength(3);
});

test('migration rolls back schema, version and legacy-row removal together on failure', async () => {
  await db.execute(`CREATE TEMP TRIGGER reject_migration BEFORE DELETE ON chat_records
    WHEN OLD.kind = 'outbox' BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END`);
  try {
    await expect(migrateLocalDatabase(db)).rejects.toThrow('migration interrupted');
    expect((await db.execute('PRAGMA user_version')).rows[0].user_version).toBe(1);
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name = 'outbox'")).rows).toEqual([]);
    expect((await db.execute("SELECT payload FROM chat_records WHERE kind = 'outbox'")).rows)
      .toEqual(Array.from({ length: 3 }, () => ({ payload: legacyPayload })));
  } finally {
    await db.execute('DROP TRIGGER reject_migration');
  }
  await migrateLocalDatabase(db);
  expect((await db.execute('SELECT id FROM outbox')).rows).toHaveLength(3);
});

test('cold reload retains a retry deadline and failed mirror; account deletion removes only its outbox', async () => {
  await migrateLocalDatabase(db);
  // Initialize the normal connection against the migrated schema.
  await withDatabase(async connection => { expect(connection).toBe(db); });
  const snapshot = await loadChatSnapshot('alice');
  const failed = { messageId: 'terminal', recipientId: 'carol', body: 'rejected',
    attempts: 1, state: 'failed' as const, nextAttemptAt: null, lastError: 'blocked' };
  const retry = { messageId: 'retry', clientMessageId: 'retry-key', recipientId: 'dave',
    body: 'transient', attempts: 3, state: 'pending' as const,
    nextAttemptAt: Date.now() + 4000, lastError: 'server error' };
  saveChatSnapshot({ outbox: [...snapshot.outbox, failed, retry] }, 'alice');
  await flushChatDb('alice');
  resetChatDbCache();
  const restored = await loadChatSnapshot('alice');
  expect(restored.outbox[0]).toEqual(JSON.parse(legacyPayload));
  expect(restored.outbox[1]).toEqual(failed);
  expect(restored.outbox[2]).toEqual(retry);
  expect((await db.execute("SELECT client_key, attempts, last_error, next_attempt_at, state FROM outbox WHERE scope = 'alice' AND id = 'retry'")).rows[0])
    .toMatchObject({ client_key: 'retry-key', attempts: 3, last_error: 'server error',
      next_attempt_at: retry.nextAttemptAt, state: 'pending' });
  const send = jest.fn(async () => true);
  await drainQueuedMessages([restored.outbox[0], restored.outbox[2]], send);
  expect(send).not.toHaveBeenCalled();
  expect(restoreOutboxMessages({}, restored.outbox, 'alice').carol[0].syncState).toBe('failed');
  await clearChatDb('alice');
  resetChatDbCache();
  expect((await loadChatSnapshot('alice')).outbox).toEqual([]);
  expect((await loadChatSnapshot('other-account')).outbox[0]).toEqual(JSON.parse(legacyPayload));
  expect((await loadChatSnapshot('legacy')).outbox[0]).toEqual(JSON.parse(legacyPayload));
});
