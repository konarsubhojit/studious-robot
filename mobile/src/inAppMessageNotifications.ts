export type InAppMessageNotification = {
  messageId: string;
  conversationId: string;
  senderId: string | null;
  title: string;
  body: string;
  deepLink: string;
};

type Listener = () => void;

const queue: InAppMessageNotification[] = [];
const listeners = new Set<Listener>();

function notifyListeners() {
  listeners.forEach(listener => listener());
}

export function subscribeInAppMessageNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInAppMessageNotificationSnapshot(): InAppMessageNotification | null {
  return queue[0] ?? null;
}

export function enqueueInAppMessageNotification(notification: InAppMessageNotification): boolean {
  const messageId = notification.messageId.trim();
  const conversationId = notification.conversationId.trim();
  if (!messageId || !conversationId) return false;
  if (queue.some(item => item.messageId === messageId)) return false;

  queue.push({
    ...notification,
    messageId,
    conversationId,
  });
  notifyListeners();
  return true;
}

export function dismissInAppMessageNotification(messageId?: string | null): boolean {
  if (queue.length === 0) return false;
  const trimmed = (messageId ?? '').trim();
  const index = trimmed ? queue.findIndex(item => item.messageId === trimmed) : 0;
  if (index < 0) return false;

  queue.splice(index, 1);
  notifyListeners();
  return true;
}

export function resetInAppMessageNotifications() {
  if (queue.length === 0) return;
  queue.splice(0, queue.length);
  notifyListeners();
}
