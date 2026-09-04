import { MongoClient } from 'mongodb';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import {
  DEFAULT_COLLECTION_NAME,
  DEFAULT_CONVERSATION_INDEX_COLLECTION_NAME,
  DEFAULT_DB_NAME,
  mongoClientOptions,
} from '../src/messageStore/mongoConnection.ts';
import { toStoredMessage } from '../src/messageStore/documents.ts';
import { byNewestFirst } from '../src/messageStore/records.ts';
import type {
  ConversationIndexDocument,
  MessageDocument,
} from '../src/messageStore/types.ts';

const BATCH_SIZE = 500;

function isIndexableMessage(message: Document): message is MessageDocument {
  return (
    typeof message.conversationId === 'string' &&
    typeof message.messageId === 'string' &&
    typeof message.senderId === 'string' &&
    typeof message.recipientId === 'string' &&
    typeof message.createdAt === 'string'
  );
}

function addUserSummary(
  summaries: Map<string, ConversationIndexDocument>,
  message: MessageDocument,
  userId: string
): void {
  const key = `${userId}\0${message.conversationId}`;
  const current = summaries.get(key);
  if (!current) {
    summaries.set(key, {
      userId,
      conversationId: message.conversationId,
      peerId: message.senderId === userId ? message.recipientId : message.senderId,
      lastMessage: toStoredMessage(message),
      unreadCount: message.recipientId === userId && !message.readAt ? 1 : 0,
      updatedAt: message.createdAt,
    });
    return;
  }
  if (message.recipientId === userId && !message.readAt) current.unreadCount += 1;
  const stored = toStoredMessage(message);
  if (byNewestFirst(stored, current.lastMessage) < 0) {
    current.lastMessage = stored;
    current.updatedAt = stored.createdAt;
  }
}

function addMessageToSummaries(
  summaries: Map<string, ConversationIndexDocument>,
  message: Document
): boolean {
  if (!isIndexableMessage(message)) return false;

  for (const userId of new Set([message.senderId, message.recipientId])) {
    addUserSummary(summaries, message, userId);
  }
  return true;
}

async function writeSummaries(
  conversationIndex: import('mongodb').Collection,
  summaries: Iterable<ConversationIndexDocument>
): Promise<number> {
  let operations: AnyBulkWriteOperation<Document>[] = [];
  let indexed = 0;
  async function flush(): Promise<void> {
    if (operations.length === 0) return;
    const result = await conversationIndex.bulkWrite(operations, { ordered: false });
    indexed += result.upsertedCount + result.modifiedCount;
    operations = [];
  }

  for (const summary of summaries) {
    operations.push({
      updateOne: {
        filter: { userId: summary.userId, conversationId: summary.conversationId },
        update: { $set: summary },
        upsert: true,
      },
    });
    if (operations.length >= BATCH_SIZE) await flush();
  }
  await flush();
  return indexed;
}

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

    const cursor = messages.find({});
    const summaries = new Map<string, ConversationIndexDocument>();
    let scanned = 0;

    for await (const message of cursor) {
      if (addMessageToSummaries(summaries, message)) scanned += 1;
    }

    const indexed = await writeSummaries(conversationIndex, summaries.values());
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
