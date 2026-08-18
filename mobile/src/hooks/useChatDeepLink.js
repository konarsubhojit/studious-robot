import { useCallback, useEffect, useRef, useState } from 'react';
import { logInfo, logWarn } from '../appLogger';
import { addChatLinkListener, getInitialChatLink } from '../pushNotifications';

/**
 * Resolve the peer whose conversation a `wetalk://chat/{conversationId}` deep
 * link points at.
 *
 * Prefers the authoritative conversation list; falls back to the server's own
 * conversation-id derivation (`deriveConversationId` in
 * `server/src/messageStore.js` sorts and joins the two participant ids with
 * `:`) so a notification tapped before the list has loaded — the cold-start
 * case — still opens the right chat.
 *
 * @param {{
 *   conversationId: string,
 *   userId?: string | null,
 *   conversations?: Array<{ conversationId?: string, peerId?: string }>,
 * }} params
 * @returns {string | null}
 */
export function resolveChatPeerId({ conversationId, userId, conversations = [] }) {
  const trimmedConversationId = (conversationId ?? '').trim();
  if (!trimmedConversationId) return null;

  const known = conversations.find(c => c.conversationId === trimmedConversationId);
  if (known?.peerId) return known.peerId;

  const trimmedUserId = (userId ?? '').trim();
  if (!trimmedUserId) return null;
  if (trimmedConversationId.startsWith(`${trimmedUserId}:`)) {
    return trimmedConversationId.slice(trimmedUserId.length + 1) || null;
  }
  if (trimmedConversationId.endsWith(`:${trimmedUserId}`)) {
    return trimmedConversationId.slice(0, -(trimmedUserId.length + 1)) || null;
  }
  return null;
}

/**
 * Open the conversation a chat notification points at.
 *
 * Covers both entry points, mirroring the call flow's deep-link handling: the
 * URL the app was cold-started from (`getInitialChatLink`) and links delivered
 * while it is already running (`addChatLinkListener`). A link that arrives
 * before identity/conversations are known is held until the peer can be
 * resolved, so a tap that launches the app is never dropped.
 *
 * @param {{
 *   userId?: string | null,
 *   conversations?: Array<{ conversationId?: string, peerId?: string }>,
 *   onOpenConversation: (peerId: string) => void,
 * }} params
 */
export default function useChatDeepLink({ userId, conversations = [], onOpenConversation }) {
  const [pendingConversationId, setPendingConversationId] = useState(null);
  const onOpenConversationRef = useRef(onOpenConversation);

  useEffect(() => {
    onOpenConversationRef.current = onOpenConversation;
  }, [onOpenConversation]);

  const openConversation = useCallback(conversationId => {
    if (conversationId) setPendingConversationId(conversationId);
  }, []);

  // 1. Cold start: the app was launched by tapping a message notification.
  useEffect(() => {
    getInitialChatLink()
      .then(descriptor => {
        if (descriptor?.conversationId) {
          logInfo('[Chat] App launched from message notification', descriptor);
          openConversation(descriptor.conversationId);
        }
      })
      .catch(error => {
        logWarn('[Chat] Failed to read initial chat link', { message: error?.message });
      });
  }, [openConversation]);

  // 2. Warm start: a notification tapped while the app is already running.
  useEffect(() => {
    return addChatLinkListener(descriptor => openConversation(descriptor.conversationId));
  }, [openConversation]);

  // 3. Route once the peer behind the conversation id can be resolved.
  useEffect(() => {
    if (!pendingConversationId) return;
    const peerId = resolveChatPeerId({
      conversationId: pendingConversationId,
      userId,
      conversations,
    });
    if (!peerId) return;
    setPendingConversationId(null);
    onOpenConversationRef.current?.(peerId);
  }, [pendingConversationId, userId, conversations]);
}
