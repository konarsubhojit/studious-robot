/**
 * Document ↔ domain mapping.
 *
 * Exactly one difference exists between the two: the driver-managed `_id`,
 * which no caller has ever been given and which the memory store has no
 * equivalent of. Stripping it in one named place keeps "the wire shape matches
 * the memory store" a property of the store rather than of each method.
 */

import type { MessageDocument, StoredMessage } from './types.ts';

/**
 * Drop the driver-managed `_id` from a document read back from Mongo.
 */
export function toStoredMessage(document: MessageDocument): StoredMessage {
  const { _id, ...rest } = document;
  return rest;
}

/**
 * {@link toStoredMessage} over a result set.
 */
export function toStoredMessages(documents: MessageDocument[]): StoredMessage[] {
  return documents.map(toStoredMessage);
}
