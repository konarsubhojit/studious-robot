// @ts-check
import { NativeModules, Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';

/**
 * WeTalk's chat-message notification.
 *
 * Message pushes are sent *data-only* (see `buildDataBlock` in
 * `server/src/push.js`), exactly like call pushes: a `notification` block would
 * make Android route the push straight to the system tray and skip the app's
 * background handler. Data-only means nothing is displayed unless the app
 * renders it itself — this module is what renders it for chat, the way
 * `incomingCallNotification.js` does for calls.
 *
 * Deliberately *not* the incoming-call channel: that one is `IMPORTANCE_HIGH`
 * with a ringtone, `setOngoing(true)` and a full-screen intent, which is wrong
 * for a chat message. `MessageNotification` posts over its own
 * normal-importance channel with `CATEGORY_MESSAGE`, a `MessagingStyle` body so
 * several messages from the same conversation stack in one shade entry instead
 * of spamming it, and a tap target of `wetalk://chat/{conversationId}`.
 *
 * Like every other optional-native-module wrapper in this app
 * (`callKeep.js`, `incomingCallNotification.js`, `pushNotifications.js`), each
 * helper degrades to a no-op off Android or when the native module is not
 * linked (e.g. a JS-only test run) instead of throwing.
 */

/** Maximum number of recently-seen message ids retained for deduplication. */
const SEEN_MESSAGE_LIMIT = 200;

/**
 * Message ids already delivered to the user through the socket (or already
 * notified about), newest last. Bounded so a long-lived process cannot grow
 * this without limit.
 *
 * @type {string[]}
 */
const seenMessageIds: string[] = [];

/**
 * The conversation currently open on screen, or `null`.
 *
 * @type {{ peerId: string | null, conversationId: string | null } | null}
 */
let activeConversation: { peerId: string | null; conversationId: string | null; } | null = null;

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function getNativeModule() {
  if (Platform.OS !== 'android') return null;
  return NativeModules?.MessageNotification || null;
}

/** Whether the native message-notification module is available. */
export function isMessageNotificationAvailable() {
  return Boolean(getNativeModule());
}

/**
 * Record which conversation is currently open on screen, so a push for that
 * same conversation is not also announced by the OS while the user is looking
 * at it. Pass `null` when no conversation is open.
 *
 * @param {{ peerId?: string | null, conversationId?: string | null } | null} conversation
 */
export function setActiveConversation(conversation: { peerId?: string | null; conversationId?: string | null; } | null) {
  const peerId = (conversation?.peerId ?? '').trim?.() || null;
  const conversationId = (conversation?.conversationId ?? '').trim?.() || null;
  activeConversation = peerId || conversationId ? { peerId, conversationId } : null;
}

/** The conversation currently open on screen, or `null`. */
export function getActiveConversation() {
  return activeConversation;
}

/**
 * Whether the conversation a message belongs to is the one on screen.
 *
 * @param {{ senderId?: string | null, conversationId?: string | null }} message
 * @returns {boolean}
 */
export function isConversationOnScreen({ senderId = null, conversationId = null }: { senderId?: string | null; conversationId?: string | null; } = {}): boolean {
  if (!activeConversation) return false;
  if (senderId && activeConversation.peerId && activeConversation.peerId === senderId) {
    return true;
  }
  return Boolean(
    conversationId &&
      activeConversation.conversationId &&
      activeConversation.conversationId === conversationId,
  );
}

/**
 * Remember that `messageId` already reached the user, so a push carrying the
 * same message (a message can arrive over both the socket and push) does not
 * post a second notification for it.
 *
 * @param {string | null | undefined} messageId
 */
export function markMessageSeen(messageId: string | null | undefined) {
  const trimmed = (messageId ?? '').trim();
  if (!trimmed || seenMessageIds.includes(trimmed)) return;
  seenMessageIds.push(trimmed);
  if (seenMessageIds.length > SEEN_MESSAGE_LIMIT) {
    seenMessageIds.splice(0, seenMessageIds.length - SEEN_MESSAGE_LIMIT);
  }
}

/**
 * Whether `messageId` was already delivered to the user.
 *
 * @param {string | null | undefined} messageId
 * @returns {boolean}
 */
export function hasSeenMessage(messageId: string | null | undefined): boolean {
  const trimmed = (messageId ?? '').trim();
  return Boolean(trimmed) && seenMessageIds.includes(trimmed);
}

/** Clear the dedupe registry and active conversation (test hook / sign-out). */
export function resetMessageNotificationState() {
  seenMessageIds.length = 0;
  activeConversation = null;
}

/**
 * Post (or extend) the chat notification for one conversation.
 *
 * Returns `{ shown: false, reason }` rather than throwing when nothing could be
 * displayed, so the caller can report the failure to the server the way the
 * call path reports `ui_failed` — a message push that arrives but renders
 * nothing must not look like a success.
 *
 * @param {{
 *   messageId?: string,
 *   conversationId?: string,
 *   senderId?: string | null,
 *   title?: string | null,
 *   body?: string | null,
 *   deepLink?: string | null,
 * }} message
 * @returns {Promise<{ shown: boolean, reason?: string }>}
 */
export async function showMessageNotification({
  messageId,
  conversationId,
  senderId = null,
  title = null,
  body = null,
  deepLink = null,
}: {
        messageId?: string;
        conversationId?: string;
        senderId?: string | null;
        title?: string | null;
        body?: string | null;
        deepLink?: string | null;
    } = {}): Promise<{ shown: boolean; reason?: string; }> {
  if (!conversationId) return { shown: false, reason: 'missing_conversation_id' };

  const module = getNativeModule();
  if (!module || typeof module.show !== 'function') {
    return { shown: false, reason: 'module_unavailable' };
  }

  try {
    const result =
      (await module.show(
        conversationId,
        (title || senderId || 'New message').toString(),
        (body || 'Sent you a message').toString(),
        deepLink || `wetalk://chat/${conversationId}`,
      )) ?? {};
    markMessageSeen(messageId);
    logInfo('[MessageNotification] Shown', {
      conversationId,
      senderId,
      channelImportance: result.channelImportance ?? null,
      messageCount: result.messageCount ?? null,
    });
    return { shown: true };
  } catch (error) {
    logError('[MessageNotification] show failed', error);
    return { shown: false, reason: 'notification_threw' };
  }
}

/**
 * Dismiss the chat notification for one conversation, e.g. once its messages
 * have been read in-app.
 *
 * @param {string} conversationId
 * @returns {boolean} `true` when a dismiss request was sent
 */
export function dismissMessageNotification(conversationId: string): boolean {
  const trimmed = (conversationId ?? '').trim();
  if (!trimmed) return false;
  const module = getNativeModule();
  if (!module || typeof module.dismiss !== 'function') return false;

  try {
    module.dismiss(trimmed);
    return true;
  } catch (error) {
    logWarn('[MessageNotification] dismiss failed', { message: errorMessage(error) });
    return false;
  }
}
