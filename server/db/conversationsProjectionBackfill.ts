import { readFileSync } from 'fs';

const CONVERSATIONS_BACKFILL_START = '-- conversations-backfill:start';
const CONVERSATIONS_BACKFILL_END = '-- conversations-backfill:end';

const CONVERSATIONS_MIGRATION_URL = new URL(
  './migrations/0013_daily_gwen_stacy.sql',
  import.meta.url
);

export function extractConversationsBackfillSql(migrationSql: string): string {
  const start = migrationSql.indexOf(CONVERSATIONS_BACKFILL_START);
  const end = migrationSql.indexOf(CONVERSATIONS_BACKFILL_END);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find conversations backfill block in migration 0013');
  }

  const sql = migrationSql
    .slice(start + CONVERSATIONS_BACKFILL_START.length, end)
    .trim();

  if (!sql.startsWith('INSERT INTO "conversations"')) {
    throw new Error('Conversations backfill block must insert into conversations');
  }

  return sql;
}

export function getConversationsBackfillSql(): string {
  return extractConversationsBackfillSql(readFileSync(CONVERSATIONS_MIGRATION_URL, 'utf8'));
}

