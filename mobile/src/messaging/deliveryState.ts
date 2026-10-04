import { isRetryable } from './sendPipeline';
import type { ChatMessage, OutboxItem } from './types';

export type DeliveryState = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

/** Outbox ownership wins over stale optimistic flags; receipts win once it leaves the outbox. */
export function deriveDeliveryState(message: ChatMessage, outbox?: OutboxItem, inFlight = false): DeliveryState {
  if (message.uploadState === 'failed') return 'failed';
  if (outbox) {
    if (!isRetryable(outbox)) return 'failed';
    return inFlight ? 'sending' : 'queued';
  }
  if (message.readAt) return 'read';
  const delivered = message.deliveredTo ?? [];
  if (message.recipientId ? delivered.includes(message.recipientId) : delivered.length > 0) return 'delivered';
  if (message.failed || message.syncState === 'failed') return 'failed';
  if (message.pending || message.syncState === 'pending' || message.uploadState === 'uploading') return 'queued';
  return 'sent';
}

export function messageDeliveryState(message: ChatMessage): DeliveryState {
  return message.deliveryState ?? deriveDeliveryState(message);
}
