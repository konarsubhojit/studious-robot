// Exercise real SQLite SQL/transactions in Jest without loading a mobile JSI runtime.
const { DatabaseSync } = require('node:sqlite');
const sqlite = new DatabaseSync(':memory:');

function execute(sql, params = []) {
  const statement = sqlite.prepare(sql);
  const rows = statement.columns().length ? statement.all(...params) : [];
  const result = statement.columns().length ? { changes: 0 } : statement.run(...params);
  return { rows, rowsAffected: Number(result.changes) };
}

const db = {
  execute: jest.fn(async (sql, params) => execute(sql, params)),
  executeBatch: jest.fn(async commands => {
    sqlite.exec('BEGIN');
    try {
      for (const [sql, params] of commands) execute(sql, params);
      sqlite.exec('COMMIT');
      return { rowsAffected: 0 };
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }),
  close: jest.fn(),
};

module.exports = {
  open: jest.fn(() => db),
  __db: db,
  __reset: () => {
    for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      if (name === 'chat_records' || name === 'resource_cache') sqlite.exec(`DELETE FROM ${name}`);
    }
  },
};
