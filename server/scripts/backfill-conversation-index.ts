import { MongoClient } from 'mongodb';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME,
  DEFAULT_DB_NAME,
  mongoClientOptions,
} from '../src/messageStore/mongoConnection.ts';

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required');

  const client = new MongoClient(uri, mongoClientOptions());
  const database = process.env.MONGODB_DB_NAME?.trim() || DEFAULT_DB_NAME;
  const messagesName =
    process.env.MONGODB_MESSAGES_COLLECTION?.trim() || DEFAULT_COLLECTION_NAME;
  const indexName =
    process.env.MONGODB_CONVERSATION_INDEX_COLLECTION?.trim() ||
    DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME;

  await client.connect();
  try {
    const db = client.db(database);
    const messages = db.collection(messagesName);
    const conversationIndex = db.collection(indexName);
    await conversationIndex.createIndex(
      { userId: 1, conversationId: 1 },
      { unique: true }
    );
    await conversationIndex.createIndex({
      userId: 1,
      updatedAt: -1,
      conversationId: 1,
    });

    const cursor = messages.find(
      {},
      {
        projection: {
          _id: 0,
          conversationId: 1,
          senderId: 1,
          recipientId: 1,
          createdAt: 1,
        },
      }
    );
    let operations: AnyBulkWriteOperation<Document>[] = [];
    let scanned = 0;
    let indexed = 0;

    async function flush(): Promise<void> {
      if (operations.length === 0) return;
      const result = await conversationIndex.bulkWrite(operations, { ordered: false });
      indexed += result.upsertedCount + result.modifiedCount;
      operations = [];
    }

    for await (const message of cursor) {
      if (
        typeof message.conversationId !== 'string' ||
        typeof message.senderId !== 'string' ||
        typeof message.recipientId !== 'string'
      ) {
        continue;
      }
      const updatedAt =
        typeof message.createdAt === 'string'
          ? message.createdAt
          : new Date(0).toISOString();
      for (const userId of new Set([message.senderId, message.recipientId])) {
        operations.push({
          updateOne: {
            filter: { userId, conversationId: message.conversationId },
            update: {
              $setOnInsert: { userId, conversationId: message.conversationId },
              $max: { updatedAt },
            },
            upsert: true,
          },
        });
      }
      scanned += 1;
      if (operations.length >= BATCH_SIZE) await flush();
    }
    await flush();
    console.log(
      `[messages] conversation index backfill complete scanned=${scanned} updated=${indexed}`
    );
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[messages] conversation index backfill failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
