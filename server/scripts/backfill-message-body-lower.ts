/**
 * Backfill the storage-only `bodyLower` field on existing messages.
 *
 * `searchMessages` matches a case-insensitive regex against `body` until
 * `MONGODB_MESSAGE_BODY_LOWER_READY=true`, at which point it matches the
 * pre-folded `bodyLower` instead — which is only correct once every document
 * has the field. Run this after enabling `MONGODB_MESSAGE_BODY_LOWER_WRITES`
 * (so new messages already carry it) and before enabling the read flag.
 *
 * Safe to re-run: it only visits documents that are missing or stale, and each
 * update is idempotent.
 */

import { MongoClient } from 'mongodb';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_DB_NAME,
  mongoClientOptions,
} from '../src/messageStore/mongoConnection.ts';
import { bodyLowerOf } from '../src/messageStore/queries.ts';

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required');

  const client = new MongoClient(uri, mongoClientOptions());
  const database = process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME;
  const messagesName =
    process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME;

  await client.connect();
  try {
    const messages = client.db(database).collection(messagesName);
    // The index the flipped read path needs; created here so the backfill and
    // the index build happen in the same maintenance window.
    await messages.createIndex({ conversationId: 1, bodyLower: 1 });

    let operations: AnyBulkWriteOperation<Document>[] = [];
    let scanned = 0;
    let updated = 0;

    async function flush(): Promise<void> {
      if (operations.length === 0) return;
      const result = await messages.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
      operations = [];
    }

    const cursor = messages.find(
      {},
      { projection: { _id: 1, conversationId: 1, messageId: 1, body: 1, bodyLower: 1 } }
    );
    for await (const message of cursor) {
      scanned += 1;
      const expected = bodyLowerOf(message.body);
      if (message.bodyLower === expected) continue;
      operations.push({
        updateOne: {
          // Shard-key prefixed so Cosmos routes each write to one partition.
          filter: { conversationId: message.conversationId, messageId: message.messageId },
          update: { $set: { bodyLower: expected } },
        },
      });
      if (operations.length >= BATCH_SIZE) await flush();
    }
    await flush();

    console.log(
      `[messages] bodyLower backfill complete scanned=${scanned} updated=${updated}`
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[messages] bodyLower backfill failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
