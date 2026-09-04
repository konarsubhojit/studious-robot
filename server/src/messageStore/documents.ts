/**
 * Document ↔ domain mapping.
 *
 * Two differences exist between the two, both storage-only: the driver-managed
 * `_id`, and `bodyLower` — the pre-folded copy of the body that
 * `searchMessages` matches against. Neither has ever been given to a caller,
 * and the memory store has no equivalent of either. Stripping them in one
 * named place keeps "the wire shape matches the memory store" a property of
 * the store rather than of each method.
 */

import type { MessageDocument, StoredMessage } from './types.ts';

/**
 * Drop the storage-only fields from a document read back from Mongo.
 */
export function toStoredMessage(document: MessageDocument): StoredMessage {
  const { _id, bodyLower, ...rest } = document;
  return rest;
}

/**
 * {@link toStoredMessage} over a result set.
 */
export function toStoredMessages(documents: MessageDocument[]): StoredMessage[] {
  return documents.map(toStoredMessage);
}
