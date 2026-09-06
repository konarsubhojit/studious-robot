/**
 * Store selection: build the message store this process should use.
 *
 * Chat history now lives in the same Postgres database as users, devices and
 * calls, so the choice is no longer "which database" but simply "is Postgres
 * configured". When it is, messages are durable; when it is not (tests, a
 * laptop with no `DATABASE_URL`) the process falls back to the in-memory store
 * and behaves exactly as it did before chat persistence existed.
 *
 * Production still fails closed: losing chat history on restart is a data-loss
 * bug, not a degraded mode, so it has to be opted into explicitly with
 * `ALLOW_IN_MEMORY_MESSAGE_STORE=true`.
 */

import { createMemoryMessageStore } from './memoryStore.ts';
import { createPgMessageStore } from './pgStore.ts';
import type { Database } from '../../db/client.ts';
import type { MessageStore } from './types.ts';

/**
 * Build the message store for this process.
 *
 * @param opts.messageStore - Pre-built store (tests / injection); wins outright.
 * @param opts.db - Drizzle handle, when Postgres is configured.
 */
export function createMessageStore(
  opts: { messageStore?: MessageStore; db?: Database | null; } = {}
): MessageStore {
  if (opts.messageStore) return opts.messageStore;

  if (opts.db) return createPgMessageStore({ db: opts.db });

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_IN_MEMORY_MESSAGE_STORE !== 'true'
  ) {
    throw new Error(
      'DATABASE_URL is required in production (set ALLOW_IN_MEMORY_MESSAGE_STORE=true to opt in)',
    );
  }

  console.log('[messages] using in-memory message store (no database handle was provided)');
  return createMemoryMessageStore();
}
