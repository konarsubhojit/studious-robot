import { normalizeTimestamp, timestampMs } from '../../../shared/time';
import type { ChatMessage, SocketMessageCursor } from './types';

/**
 * Move a conversation's cursor forward without letting an out-of-order socket
 * delivery move it backwards. The message id breaks ties for messages sharing
 * the same server timestamp.
 */
export function advanceSocketMessageCursor(
  current: SocketMessageCursor | undefined,
  message: Pick<ChatMessage, 'messageId' | 'createdAt'>,
): SocketMessageCursor | undefined {
  if (!message.messageId || !message.createdAt) {
    return current;
  }
  const createdAt = normalizeTimestamp(message.createdAt);
  if (!Number.isFinite(timestampMs(createdAt))) return current;
  if (!current) return { messageCreatedAt: createdAt, messageId: message.messageId };

  const nextTime = timestampMs(createdAt);
  const currentTime = timestampMs(current.messageCreatedAt);
  if (nextTime < currentTime || (nextTime === currentTime && message.messageId <= current.messageId)) {
    return current;
  }
  return { messageCreatedAt: createdAt, messageId: message.messageId };
}
