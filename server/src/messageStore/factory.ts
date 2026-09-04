/**
 * Store selection: build the message store this process should use from the
 * environment.
 *
 * Development and tests may use memory explicitly. Production fails closed
 * unless Mongo is configured or `ALLOW_IN_MEMORY_MESSAGE_STORE=true` is set.
 */

import { MongoClient, MongoParseError } from 'mongodb';
import { describeError } from '../lib/errors.ts';
import { createMemoryMessageStore } from './memoryStore.ts';
import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME,
  DEFAULT_DB_NAME,
  mongoClientOptions,
} from './mongoConnection.ts';
import { createMongoMessageStore } from './mongoStore.ts';
import type { MessageStore, MongoClientLike } from './types.ts';

/**
 * Whether `error` came from the driver rejecting the connection string itself.
 *
 * The connection-string parser ships its own `MongoParseError` class (from
 * `mongodb-connection-string-url`), so an `instanceof` check alone misses some
 * URI errors — the error name is checked as well.
 */
function isMongoUriError(error: unknown): boolean {
  if (error instanceof MongoParseError) return true;
  return (
    error instanceof Error &&
    (error.name === 'MongoParseError' || error.name === 'MongoInvalidArgumentError')
  );
}

/**
 * Build the message store for this process from the environment.
 *
 * @param opts.messageStore - Pre-built store (tests / injection).
 */
export function createMessageStore(opts: { messageStore?: MessageStore; } = {}): MessageStore {
  if (opts.messageStore) return opts.messageStore;

  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_IN_MEMORY_MESSAGE_STORE !== 'true'
    ) {
      throw new Error(
        'MONGODB_URI is required in production (set ALLOW_IN_MEMORY_MESSAGE_STORE=true to opt in)',
      );
    }
    console.log('[messages] using in-memory message store (MONGODB_URI is not set)');
    return createMemoryMessageStore();
  }

  let client;
  try {
    client = new MongoClient(uri, {
      ...mongoClientOptions(),
    });
  } catch (error) {
    // Only the driver's own parse/validation errors say anything about the
    // URI; anything else (a broken driver import, an out-of-memory failure, …)
    // must keep its own context instead of being blamed on configuration.
    if (isMongoUriError(error)) {
      throw new Error(`Invalid MONGODB_URI: ${describeError(error)}`);
    }
    throw new Error(`Failed to create the MongoDB client: ${describeError(error)}`);
  }

  return createMongoMessageStore({
    uri,
    dbName: process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME,
    collectionName: process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME,
    conversationIndexCollectionName:
      process.env.MONGODB_CONVERSATION_INDEX_COLLECTION?.trim() ||
      DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME,
    conversationIndexWrites:
      process.env.MONGODB_CONVERSATION_INDEX_WRITES === 'true' ||
      process.env.MONGODB_CONVERSATION_INDEX_READY === 'true',
    conversationIndexReady: process.env.MONGODB_CONVERSATION_INDEX_READY === 'true',
    bodyLowerWrites:
      process.env.MONGODB_MESSAGE_BODY_LOWER_WRITES === 'true' ||
      process.env.MONGODB_MESSAGE_BODY_LOWER_READY === 'true',
    bodyLowerReady: process.env.MONGODB_MESSAGE_BODY_LOWER_READY === 'true',
    // The driver's client is a superset of the surface the store uses; see
    // `MongoClientLike` for why the store is typed structurally.
    client: (client as unknown) as MongoClientLike,
  });
}
