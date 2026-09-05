/**
 * Mongo access layer: connecting once, creating the supporting indexes, and
 * reporting where the connection went without ever logging a credential.
 *
 * The connection is established lazily on first use so constructing a store
 * never blocks server start-up, and a failure to create indexes is logged
 * rather than fatal (Cosmos DB throttles index builds under load).
 */

import { MongoClient } from 'mongodb';
import { describeError } from '../lib/errors.ts';
import { timeQuery } from '../lib/queryTiming.ts';
import type {
  MessagesCollection,
  ConversationIndexCollection,
  MongoClientLike,
  MongoConnection,
  MongoFindCursor,
  MongoFilter,
  MongoIndexSpec,
  MongoUpdate,
} from './types.ts';

export const DEFAULT_DB_NAME = 'wetalk';
export const DEFAULT_COLLECTION_NAME = 'messages';
export const DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME = 'conversation_index';
export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MONGO_POOL_MAX = 4;
export const DEFAULT_MONGO_MAX_IDLE_TIME_MS = 120_000;

const instrumentedCollections = new WeakSet<object>();

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function mongoClientOptions(): object {
  return {
    serverSelectionTimeoutMS: DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
    maxPoolSize: positiveInteger(process.env.MONGODB_POOL_MAX, DEFAULT_MONGO_POOL_MAX),
    maxIdleTimeMS: positiveInteger(
      process.env.MONGODB_MAX_IDLE_TIME_MS,
      DEFAULT_MONGO_MAX_IDLE_TIME_MS
    ),
    monitorCommands: true,
  };
}

export function isCosmosThrottle(error: unknown): boolean {
  const failure = ((error ?? {}) as { failure?: unknown; }).failure ?? error;
  const details = (failure ?? {}) as {
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
    errmsg?: unknown;
  };
  return (
    details.code === 16500 ||
    details.code === 429 ||
    /(?:too many requests|request rate is large|retryafterms)/i.test(
      String(details.message ?? details.errmsg ?? '')
    )
  );
}

export function installThrottleLogger(client: MongoClientLike): void {
  client.on?.('commandFailed', (event: unknown) => {
    if (!isCosmosThrottle(event)) return;
    const commandFailure = (event ?? {}) as {
      commandName?: unknown;
      failure?: { code?: unknown; message?: unknown; errmsg?: unknown; };
    };
    const failure = commandFailure.failure ?? {};
    const text = String(failure?.message ?? failure?.errmsg ?? '');
    const retryAfterMs = text.match(/retryafterms[=:]\s*(\d+)/i)?.[1];
    console.warn(
      `[messages] THROTTLED command=${String(commandFailure.commandName ?? 'unknown')}` +
        ` code=${String(failure?.code ?? 16500)}` +
        `${retryAfterMs ? ` retryAfterMs=${retryAfterMs}` : ''}`
    );
  });
}

/**
 * Create one index, logging (rather than throwing) on failure.
 *
 * Cosmos DB can reject or throttle index builds (e.g. a unique index that
 * does not include the shard key); never let that take the server down —
 * reads/writes still work without the index, just less efficiently, or with
 * the corresponding guarantee (sort support, uniqueness) degraded. Each index
 * is attempted independently so one rejection doesn't skip the rest.
 *
 * @param messages - The Mongo collection.
 * @param spec - Index key spec, e.g. `{ conversationId: 1 }`.
 * @param options - Index options, e.g. `{ unique: true }`.
 */
export async function createIndexOrWarn(
  messages: Pick<MessagesCollection, 'createIndex'>,
  spec: MongoIndexSpec,
  options?: object
): Promise<void> {
  try {
    await messages.createIndex(spec, options);
  } catch (error) {
    console.error(
      `[messages] DEGRADED: index creation skipped for ${JSON.stringify(spec)}` +
        `${options ? ` ${JSON.stringify(options)}` : ''} — sorted queries and/or ` +
        `uniqueness guarantees may be affected: ${describeError(error)}`
    );
  }
}

/**
 * Create every index the store depends on.
 *
 * Index creation is idempotent, but Cosmos DB can reject or throttle it; never
 * let that take the server down — reads/writes still work without the indexes,
 * just less efficiently (and, on Cosmos RU, sorted queries may fail outright
 * without the matching composite index — see below).
 *
 * All indexes are prefixed with `conversationId` (the shard/partition key).
 * Azure Cosmos DB for MongoDB (RU) requires:
 *   - unique indexes to include the shard key, and
 *   - `sort()` queries to be served by a matching *direction-specific*
 *     composite index (no collection-scan fallback like vCore/MongoDB).
 * `{ messageId: 1 }` alone can no longer be unique (see `saveMessage`'s upsert
 * for the enforcement fallback), so it is replaced by
 * `{ conversationId: 1, messageId: 1 }`, which preserves the intended guarantee
 * because a `messageId` only ever appears within one conversation.
 */
export async function ensureMessageIndexes(messages: MessagesCollection): Promise<void> {
  await createIndexOrWarn(messages, { conversationId: 1, createdAt: -1 });
  // Ascending counterpart — Cosmos composite indexes are direction specific, so
  // the descending index above does not also serve an ascending sort.
  await createIndexOrWarn(messages, { conversationId: 1, createdAt: 1 });
  // Shard-key-prefixed uniqueness on messageId.
  await createIndexOrWarn(messages, { conversationId: 1, messageId: 1 }, { unique: true });
  // Serves `listMessages`'s actual `{ createdAt: -1, messageId: -1 }` tiebreak
  // sort (Cosmos composite indexes must match sorted fields exactly, including
  // the tiebreak field).
  await createIndexOrWarn(messages, { conversationId: 1, createdAt: -1, messageId: -1 });
  // Supports `searchMessages`' body lookup. Deliberately a plain
  // shard-key-prefixed index rather than a `text` index: Azure Cosmos DB for
  // MongoDB (RU) does not support text indexes / `$text`, so the search is
  // expressed as a case-insensitive literal match on `body` (see
  // `searchMessages`), which is served identically on the in-memory store,
  // MongoDB/vCore and Cosmos RU.
  await createIndexOrWarn(messages, { conversationId: 1, body: 1 });
  // The same lookup once `MONGODB_MESSAGE_BODY_LOWER_READY` is on: the search
  // then matches the pre-folded `bodyLower` without `$options: 'i'`, which the
  // `body` index above cannot serve.
  await createIndexOrWarn(messages, { conversationId: 1, bodyLower: 1 });
}

export async function ensureConversationIndex(
  conversationIndex: ConversationIndexCollection
): Promise<void> {
  await createIndexOrWarn(
    conversationIndex,
    { userId: 1, conversationId: 1 },
    { unique: true }
  );
  await createIndexOrWarn(conversationIndex, {
    userId: 1,
    updatedAt: -1,
    conversationId: 1,
  });
}

function instrumentMongoCursor<T>(
  cursor: MongoFindCursor<T>,
  collectionName: string
): MongoFindCursor<T> {
  const originalToArray = cursor.toArray.bind(cursor);
  cursor.toArray = () =>
    timeQuery({ backend: 'mongo', operation: 'find', kind: 'read', target: collectionName }, () =>
      originalToArray()
    );
  return cursor;
}

/**
 * Patch the narrow collection object in place so every driver call is timed.
 *
 * The connector owns these collection handles, and the WeakSet makes the patch
 * idempotent if a test or retry path hands the same object back again.
 */
function instrumentMongoCollection<T>(
  collection: import('./types.ts').MongoCollection<T>,
  collectionName: string
): import('./types.ts').MongoCollection<T> {
  if (instrumentedCollections.has(collection)) return collection;
  instrumentedCollections.add(collection);

  if (typeof collection.find === 'function') {
    const originalFind = collection.find.bind(collection);
    collection.find = ((filter: MongoFilter, options?: object) =>
      instrumentMongoCursor(originalFind(filter, options), collectionName)) as typeof collection.find;
  }

  if (typeof collection.findOne === 'function') {
    const originalFindOne = collection.findOne.bind(collection);
    collection.findOne = ((filter: MongoFilter) =>
      timeQuery({ backend: 'mongo', operation: 'findOne', kind: 'read', target: collectionName }, () =>
        originalFindOne(filter)
      )) as typeof collection.findOne;
  }

  if (typeof collection.findOneAndUpdate === 'function') {
    const originalFindOneAndUpdate = collection.findOneAndUpdate.bind(collection);
    collection.findOneAndUpdate = ((filter: MongoFilter, update: MongoUpdate, options?: object) =>
      timeQuery(
        { backend: 'mongo', operation: 'findOneAndUpdate', kind: 'write', target: collectionName },
        () => originalFindOneAndUpdate(filter, update, options)
      )) as typeof collection.findOneAndUpdate;
  }

  if (typeof collection.updateOne === 'function') {
    const originalUpdateOne = collection.updateOne.bind(collection);
    collection.updateOne = ((filter: MongoFilter, update: MongoUpdate, options?: object) =>
      timeQuery({ backend: 'mongo', operation: 'updateOne', kind: 'write', target: collectionName }, () =>
        originalUpdateOne(filter, update, options)
      )) as typeof collection.updateOne;
  }

  if (typeof collection.updateMany === 'function') {
    const originalUpdateMany = collection.updateMany.bind(collection);
    collection.updateMany = ((filter: MongoFilter, update: MongoUpdate) =>
      timeQuery({ backend: 'mongo', operation: 'updateMany', kind: 'write', target: collectionName }, () =>
        originalUpdateMany(filter, update)
      )) as typeof collection.updateMany;
  }

  if (typeof collection.bulkWrite === 'function') {
    const originalBulkWrite = collection.bulkWrite.bind(collection);
    collection.bulkWrite = ((operations: import('./types.ts').MongoBulkWriteOperation[], options?: object) =>
      timeQuery({ backend: 'mongo', operation: 'bulkWrite', kind: 'write', target: collectionName }, () =>
        originalBulkWrite(operations, options)
      )) as typeof collection.bulkWrite;
  }

  return collection;
}

/**
 * Best-effort extraction of the Mongo host(s) for startup logging, without
 * ever logging credentials embedded in the connection string.
 */
export function safeMongoHost(mongoClient: MongoClientLike | null, uri?: string): string {
  try {
    const options = mongoClient?.options ?? mongoClient?.s?.options;
    const hosts = options?.hosts;
    if (Array.isArray(hosts) && hosts.length) {
      return hosts
        .map((h: { host?: string; port?: number; }) =>
          h?.host ? `${h.host}${h.port ? `:${h.port}` : ''}` : String(h)
        )
        .join(',');
    }
  } catch {
    // Fall through to URI parsing below.
  }
  if (!uri) return 'unknown';
  try {
    // Strip credentials before ever touching the URI for logging purposes.
    const withoutCreds = uri.replace(/\/\/[^@/]+@/, '//');
    const match = withoutCreds.match(/^[a-zA-Z+]+:\/\/([^/?]+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The lazily-connecting accessor a Mongo store issues every query through. */
export type MongoConnector = {
  /** Connect (once) and return the messages collection. */
  connect: () => Promise<MongoConnection>;
  /** Close the client, if one was ever opened.  Idempotent; never throws. */
  close: () => Promise<void>;
};

/**
 * Build the lazily-connecting accessor the Mongo store issues every query
 * through.
 *
 * `connect` establishes the connection (and creates indexes) on first call and
 * resolves with the same connection thereafter; a failed connect is not cached,
 * so a later call retries rather than inheriting the failure forever.
 */
export function createMongoConnector({
  uri,
  database,
  collection,
  conversationIndexCollection,
  enableConversationIndex,
  client,
}: {
  uri?: string;
  database: string;
  collection: string;
  conversationIndexCollection: string;
  enableConversationIndex: boolean;
  client?: MongoClientLike;
}): MongoConnector {
  let clientPromise: Promise<MongoConnection> | null = null;
  let closed = false;

  function connect(): Promise<MongoConnection> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mongoClient: MongoClientLike =
          client ??
          // The driver's `MongoClient` is a superset of the surface this store
          // uses; the structural view keeps the call sites checked without
          // pinning them to the driver's generics.
          ((new MongoClient((uri as string), {
            ...mongoClientOptions(),
          }) as unknown) as MongoClientLike);
        installThrottleLogger(mongoClient);
        if (typeof mongoClient.connect === 'function') {
          await mongoClient.connect();
        }
        const messages = instrumentMongoCollection(
          mongoClient.db(database).collection(collection) as MessagesCollection,
          collection
        ) as MessagesCollection;
        const conversationIndex = enableConversationIndex
          ? (instrumentMongoCollection(
              mongoClient
                .db(database)
                .collection(conversationIndexCollection) as ConversationIndexCollection,
              conversationIndexCollection
            ) as ConversationIndexCollection)
          : null;

        await ensureMessageIndexes(messages);
        if (conversationIndex) {
          await ensureConversationIndex(conversationIndex);
        }

        const host = safeMongoHost(mongoClient, uri);
        const retryWritesDisabled = /retrywrites=false/i.test(uri || '');
        console.log(
          `[messages] Mongo message store ready (host=${host} db=${database} ` +
            `collection=${collection} retryWrites=${retryWritesDisabled ? 'disabled' : 'default'})`
        );
        return { mongoClient, messages, conversationIndex };
      })().catch((error) => {
        // Reset so a later call can retry rather than caching a failed connect.
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  async function close(): Promise<void> {
    if (closed || !clientPromise) return;
    closed = true;
    try {
      const { mongoClient } = await clientPromise;
      await mongoClient.close();
    } catch (error) {
      console.warn(`[messages] error while closing Mongo client: ${describeError(error)}`);
    }
  }

  return { connect, close };
}
