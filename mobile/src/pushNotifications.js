import { Linking, Platform } from 'react-native';
import { getApp } from '@react-native-firebase/app';
import {
  flushDurableLogs,
  logBackgroundInfo,
  logBackgroundWarn,
  logError,
  logInfo,
  logWarn,
} from './appLogger';
import {
  clearPendingAnswer,
  displayIncomingCall as displayCallKeepIncomingCall,
  endCall as endCallKeepCall,
} from './callKeep';
import { isCallConnectionLive } from './incomingCallNotification';
import {
  hasSeenMessage,
  isConversationOnScreen,
  markMessageSeen,
  showMessageNotification,
} from './messageNotification';
import { loadDeviceId, loadSettings } from './settingsStorage';

/**
 * Push notification helpers for the WeTalk mobile app.
 *
 * Provides three capabilities:
 *  1. Deep-link parsing  – convert `wetalk://call/{callId}` and
 *     `wetalk://chat/{conversationId}` URLs into descriptors.
 *  2. App-launch detection – retrieve the URL the app was opened from
 *     (notification tap while the app was killed or backgrounded).
 *  3. Push-token registration – persist the device push token with the
 *     signaling server so offline delivery can be attempted.
 *
 * Note: obtaining the raw OS-level push token requires a native push library
 * (e.g. @react-native-firebase/messaging on Android, or
 * @react-native-community/push-notification-ios on iOS).  The
 * `registerPushToken` helper below accepts a token that the host application
 * has already retrieved via such a library, and it registers it with the
 * signaling server's POST /devices/register endpoint.
 */

// ─── Deep-link helpers ────────────────────────────────────────────────────────

const DEEP_LINK_SCHEME = 'wetalk';
const DEFAULT_SIGNALING_URL = process.env.SIGNALING_URL || 'http://localhost:4173';
// `received` / `ui_displayed` / `ui_failed` cover push delivery and ringing;
// the `answer_*` stages cover what happened after the user tapped Answer, so a
// call that rings but cannot be picked up is diagnosable from server logs
// without device access.
const RECEIPT_STAGES = new Set([
  'received',
  'ui_displayed',
  'ui_failed',
  'answer_attempted',
  'answer_failed',
  'answer_accepted',
  'answer_skipped_duplicate',
  'accept_tapped',
  'decline_tapped',
]);
// Message pushes report the same `received` stage plus what the device did
// with it, so "the provider accepted it" (which proves nothing about the
// handset) is no longer the only server-side evidence a message push exists.
const MESSAGE_RECEIPT_STAGES = new Set([
  'received',
  'notification_shown',
  'notification_failed',
  'notification_suppressed',
]);

/** Envelope `type` values the server sends (see `server/src/push.js`). */
export const PUSH_TYPE_CALL = 'call.incoming';
export const PUSH_TYPE_CALL_CANCELLED = 'call.cancelled';
export const PUSH_TYPE_MESSAGE = 'message.received';

/**
 * Parse a WeTalk deep-link URL into a call descriptor.
 *
 * Expected format: `wetalk://call/{callId}`
 *
 * @param {string | null | undefined} url
 * @returns {{ callId: string } | null}
 */
export function parseCallDeepLink(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // `wetalk://call/{callId}` → protocol=wetalk:, host=call, pathname=/{callId}
  const callId = parsed.pathname?.replace(/^\//, '').trim();
  if (parsed.host === 'call' && callId) {
    return { callId };
  }

  return null;
}

/**
 * Return the call descriptor for the URL the app was launched from, if any.
 * Returns `null` when the app was opened normally (not from a notification tap).
 *
 * @returns {Promise<{ callId: string } | null>}
 */
export async function getInitialCallLink() {
  try {
    const url = await Linking.getInitialURL();
    return parseCallDeepLink(url);
  } catch (error) {
    logWarn('[Push] getInitialURL failed', { message: error?.message });
    return null;
  }
}

/**
 * Subscribe to deep-link URLs received while the app is already running
 * (e.g. a notification tap that brings a backgrounded app to the foreground).
 *
 * @param {(descriptor: { callId: string }) => void} callback
 * @returns {() => void} Unsubscribe function – call it in the effect cleanup.
 */
export function addCallLinkListener(callback) {
  const subscription = Linking.addEventListener('url', ({ url }) => {
    const descriptor = parseCallDeepLink(url);
    if (descriptor) {
      logInfo('[Push] Deep-link received', descriptor);
      callback(descriptor);
    }
  });
  return () => subscription?.remove();
}

/**
 * Parse a WeTalk chat deep-link URL into a conversation descriptor.
 *
 * Expected format: `wetalk://chat/{conversationId}` — the link a message
 * notification opens (see `buildMessageEnvelope` in `server/src/push.js`).
 *
 * @param {string | null | undefined} url
 * @returns {{ conversationId: string } | null}
 */
export function parseChatDeepLink(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  const conversationId = decodeURIComponent(parsed.pathname?.replace(/^\//, '') ?? '').trim();
  if (parsed.host === 'chat' && conversationId) {
    return { conversationId };
  }

  return null;
}

/**
 * Return the conversation descriptor for the URL the app was launched from, if
 * any. The chat counterpart of {@link getInitialCallLink}, so a notification
 * tap that cold-starts the app still opens the right conversation.
 *
 * @returns {Promise<{ conversationId: string } | null>}
 */
export async function getInitialChatLink() {
  try {
    const url = await Linking.getInitialURL();
    return parseChatDeepLink(url);
  } catch (error) {
    logWarn('[Push] getInitialURL failed', { message: error?.message });
    return null;
  }
}

/**
 * Subscribe to chat deep-link URLs received while the app is already running.
 *
 * @param {(descriptor: { conversationId: string }) => void} callback
 * @returns {() => void} Unsubscribe function – call it in the effect cleanup.
 */
export function addChatLinkListener(callback) {
  const subscription = Linking.addEventListener('url', ({ url }) => {
    const descriptor = parseChatDeepLink(url);
    if (descriptor) {
      logInfo('[Push] Chat deep-link received', descriptor);
      callback(descriptor);
    }
  });
  return () => subscription?.remove();
}

// ─── Push-token registration ──────────────────────────────────────────────────

/**
 * Register a device push token with the signaling server.
 *
 * The token must be obtained before calling this function using a native push
 * library appropriate for the platform.
 *
 * @param {{
 *   sessionId: string,
 *   signalingUrl: string,
 *   provider: 'apns' | 'fcm',
 *   pushToken: string,
 * }} opts
 * @returns {Promise<boolean>} `true` on success
 */
export async function registerPushToken({ sessionId, signalingUrl, provider, pushToken }) {
  try {
    const response = await fetch(`${signalingUrl.trim()}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, provider, pushToken }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      logWarn('[Push] registerPushToken failed', {
        status: response.status,
        error: body?.error,
      });
      return false;
    }

    logInfo('[Push] Push token registered', {
      provider,
      deviceId: body?.deviceId,
    });
    return true;
  } catch (error) {
    logError('[Push] registerPushToken threw', error);
    return false;
  }
}

/**
 * Unregister the push token for the current device session.
 *
 * @param {{ sessionId: string, signalingUrl: string }} opts
 * @returns {Promise<boolean>} `true` on success
 */
export async function unregisterPushToken({ sessionId, signalingUrl }) {
  try {
    const response = await fetch(`${signalingUrl.trim()}/devices/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      logWarn('[Push] unregisterPushToken failed', {
        status: response.status,
        error: body?.error,
      });
      return false;
    }

    logInfo('[Push] Push token unregistered');
    return true;
  } catch (error) {
    logError('[Push] unregisterPushToken threw', error);
    return false;
  }
}

// ─── Native push-token acquisition ────────────────────────────────────────────
//
// The raw OS push token is obtained through @react-native-firebase/messaging,
// using its modular API (`getMessaging(app)` + free functions that take the
// resulting instance as their first argument) rather than the deprecated
// namespaced API (`messaging().foo()`).
//
// @react-native-firebase/messaging is an *optional* native dependency: when it
// (and the matching google-services.json / APNs entitlement) is not
// installed, the helpers below degrade gracefully to a no-op so the JS bundle
// still builds and runs.  This mirrors the server's env-gated push delivery,
// which simply skips when the APNs/FCM credentials are absent.

/**
 * @typedef {object} MessagingHandle
 * @property {import('@react-native-firebase/messaging').FirebaseMessagingTypes.Module} instance
 *   The default-app messaging instance, as returned by `getMessaging(getApp())`.
 * @property {typeof import('@react-native-firebase/messaging')} api
 *   The modular free-function exports (`getToken`, `requestPermission`, …).
 */

/** Cached result of the optional native messaging module lookup. */
let cachedMessaging;
let hasLoggedMissingMessaging = false;

/**
 * Lazily resolve the optional @react-native-firebase/messaging module and the
 * default-app messaging instance via the modular `getMessaging(app)` API.
 * Returns `null` when the package is not installed. The lookup is memoised so
 * a missing module is only logged once.
 *
 * @returns {MessagingHandle | null}
 */
export function loadMessaging() {
  if (cachedMessaging !== undefined) return cachedMessaging;
  try {
    const api = require('@react-native-firebase/messaging');
    const instance = api.getMessaging(getApp());
    cachedMessaging = { instance, api };
  } catch {
    cachedMessaging = null;
    if (!hasLoggedMissingMessaging) {
      logWarn('[Push] Native messaging module not installed; skipping push token acquisition');
      hasLoggedMissingMessaging = true;
    }
  }
  return cachedMessaging;
}

/** Reset the memoised messaging module (test hook). */
export function _resetMessagingCache() {
  cachedMessaging = undefined;
  hasLoggedMissingMessaging = false;
}

/**
 * Acquire the device push token from the native messaging library, requesting
 * notification permission first.  Returns `null` (never throws) when the native
 * library is unavailable, permission is denied, or no token can be retrieved.
 *
 * Firebase Cloud Messaging issues a single token on both platforms (on iOS it
 * proxies to APNs internally), so the provider is reported as `'fcm'`.
 *
 * @returns {Promise<{ provider: 'fcm', pushToken: string } | null>}
 */
export async function getPushToken() {
  const handle = loadMessaging();
  if (!handle) return null;

  try {
    const { instance, api } = handle;
    const authStatus = await api.requestPermission(instance);
    const { AuthorizationStatus } = api;
    const granted =
      authStatus === AuthorizationStatus?.AUTHORIZED ||
      authStatus === AuthorizationStatus?.PROVISIONAL;
    if (!granted) {
      logWarn('[Push] Notification permission not granted', { authStatus });
      return null;
    }

    // On iOS the APNs token must be available before the FCM token can be read.
    if (Platform.OS === 'ios' && typeof api.registerDeviceForRemoteMessages === 'function') {
      await api.registerDeviceForRemoteMessages(instance);
    }

    const pushToken = await api.getToken(instance);
    if (!pushToken) {
      logWarn('[Push] Native messaging returned an empty token');
      return null;
    }
    return { provider: 'fcm', pushToken };
  } catch (error) {
    // The message/name here already distinguish a genuinely-missing/
    // misconfigured native module (e.g. Firebase throws "No Firebase App
    // '[DEFAULT]' has been created" when google-services.json /
    // GoogleService-Info.plist isn't wired into the build) from any other
    // unexpected failure, instead of a bare, unhelpful TypeError.
    logError('[Push] getPushToken threw', error);
    return null;
  }
}

/**
 * Acquire the device push token and register it with the signaling server in a
 * single step.  Safe to call repeatedly; returns `false` (never throws) when no
 * token is available or registration fails.
 *
 * @param {{ sessionId: string, signalingUrl: string }} opts
 * @returns {Promise<boolean>} `true` when a token was acquired and registered
 */
export async function registerForPushNotifications({ sessionId, signalingUrl }) {
  if (!sessionId || !signalingUrl) return false;
  const token = await getPushToken();
  if (!token) return false;
  return registerPushToken({
    sessionId,
    signalingUrl,
    provider: token.provider,
    pushToken: token.pushToken,
  });
}

/**
 * Parse the incoming-call payload from an FCM/APNs data message.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {{ callId: string, callerId: string | null, deepLink: string } | null}
 */
export function _extractIncomingCallFromMessage(remoteMessage) {
  const data = remoteMessage?.data ?? {};
  const callId = typeof data.callId === 'string' ? data.callId.trim() : '';
  if (!callId) return null;

  const parsedCallerId = typeof data.callerId === 'string' ? data.callerId.trim() : '';
  const parsedDeepLink = typeof data.deepLink === 'string' ? data.deepLink.trim() : '';

  return {
    callId,
    callerId: parsedCallerId || null,
    deepLink: parsedDeepLink || `wetalk://call/${callId}`,
  };
}

/**
 * Parse the received-message payload from an FCM/APNs data message.
 *
 * Mirrors {@link _extractIncomingCallFromMessage}: message pushes are data-only
 * too, so FCM displays nothing by itself and every field the app needs to
 * render the notification has to come out of `data`.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {{
 *   messageId: string,
 *   conversationId: string,
 *   senderId: string | null,
 *   title: string,
 *   body: string,
 *   deepLink: string,
 * } | null}
 */
export function _extractMessageFromMessage(remoteMessage) {
  const data = remoteMessage?.data ?? {};
  const messageId = typeof data.messageId === 'string' ? data.messageId.trim() : '';
  const conversationId = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  if (!messageId || !conversationId) return null;

  const senderId = typeof data.senderId === 'string' ? data.senderId.trim() : '';
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const body = typeof data.body === 'string' ? data.body.trim() : '';
  const deepLink = typeof data.deepLink === 'string' ? data.deepLink.trim() : '';

  return {
    messageId,
    conversationId,
    senderId: senderId || null,
    title: title || senderId || 'New message',
    body: body || 'Sent you a message',
    deepLink: deepLink || `wetalk://chat/${conversationId}`,
  };
}

/**
 * Classify a push by the envelope `type` the server sends.
 *
 * Falls back to the payload shape for pushes produced before `type` was
 * carried through, so an older server release still rings calls.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {string | null}
 */
export function _extractPushType(remoteMessage) {
  const data = remoteMessage?.data ?? {};
  const type = typeof data.type === 'string' ? data.type.trim() : '';
  if (type) return type;
  if (typeof data.callId === 'string' && data.callId.trim()) return PUSH_TYPE_CALL;
  if (typeof data.messageId === 'string' && data.messageId.trim()) return PUSH_TYPE_MESSAGE;
  return null;
}

function getReceiptBaseUrl(remoteMessage) {
  const data = remoteMessage?.data ?? {};
  const fromPayload =
    typeof data.receiptUrl === 'string'
      ? data.receiptUrl.trim()
      : typeof data.signalingUrl === 'string'
      ? data.signalingUrl.trim()
      : '';
  if (fromPayload) return fromPayload;
  return null;
}

async function resolveReceiptBaseUrl(remoteMessage) {
  const fromPayload = getReceiptBaseUrl(remoteMessage);
  if (fromPayload) return fromPayload;
  const settings = await loadSettings({ signalingUrl: DEFAULT_SIGNALING_URL }).catch(() => ({
    signalingUrl: DEFAULT_SIGNALING_URL,
  }));
  return (settings.signalingUrl || DEFAULT_SIGNALING_URL).trim();
}

/**
 * Report a call- or message-lifecycle stage to the server.
 *
 * Exactly one of `callId` / `messageId` identifies what the receipt is about;
 * message receipts exist because "accepted by provider" says nothing about
 * whether the handset ever displayed anything, the same trap that hid the
 * incoming-call bug.
 *
 * Callers that hold a live session (e.g. the in-app call flow) can pass
 * `sessionId` / `signalingUrl` explicitly; background push handlers instead
 * pass the `remoteMessage` the values are read from.
 *
 * @param {{
 *   remoteMessage?: object | null,
 *   callId?: string | null,
 *   messageId?: string | null,
 *   stage: string,
 *   reason?: string | null,
 *   sessionId?: string | null,
 *   signalingUrl?: string | null,
 * }} opts
 * @returns {Promise<boolean>} `true` when the receipt was accepted
 */
export async function sendPushReceipt({
  remoteMessage,
  callId = null,
  messageId = null,
  stage,
  reason = null,
  sessionId: explicitSessionId = null,
  signalingUrl: explicitSignalingUrl = null,
}) {
  const trimmedCallId = typeof callId === 'string' ? callId.trim() : '';
  const trimmedMessageId = typeof messageId === 'string' ? messageId.trim() : '';
  const allowedStages = trimmedCallId ? RECEIPT_STAGES : MESSAGE_RECEIPT_STAGES;
  if (
    (!trimmedCallId && !trimmedMessageId) ||
    !allowedStages.has(stage) ||
    typeof fetch !== 'function'
  ) {
    return false;
  }
  try {
    const data = remoteMessage?.data ?? {};
    const sessionId =
      (typeof explicitSessionId === 'string' ? explicitSessionId.trim() : '') ||
      (typeof data.sessionId === 'string' ? data.sessionId.trim() : '');
    const deviceId =
      typeof data.deviceId === 'string' && data.deviceId.trim()
        ? data.deviceId.trim()
        : await loadDeviceId();
    const signalingUrl =
      (typeof explicitSignalingUrl === 'string' ? explicitSignalingUrl.trim() : '') ||
      (await resolveReceiptBaseUrl(remoteMessage));
    if (!signalingUrl || (!sessionId && !deviceId)) return false;

    const response = await fetch(`${signalingUrl.replace(/\/+$/, '')}/devices/push-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : { deviceId }),
        ...(trimmedCallId ? { callId: trimmedCallId } : { messageId: trimmedMessageId }),
        stage,
        ...(reason ? { reason } : {}),
      }),
    });
    if (!response.ok) {
      await logBackgroundWarn('[Push] push receipt failed', { status: response.status, stage });
      return false;
    }
    return true;
  } catch (error) {
    await logBackgroundWarn('[Push] push receipt threw', { message: error?.message, stage });
    return false;
  }
}

/**
 * Render (or deliberately suppress) the notification for a message push.
 *
 * Shared by the background and foreground handlers so both report the same
 * receipt stages: a message push that arrives but displays nothing has to be
 * as visible in server logs as one that rings.
 *
 * @param {{
 *   remoteMessage: object | null | undefined,
 *   message: {
 *     messageId: string,
 *     conversationId: string,
 *     senderId: string | null,
 *     title: string,
 *     body: string,
 *     deepLink: string,
 *   },
 * }} opts
 * @returns {Promise<{ shown: boolean, reason?: string }>}
 */
async function displayMessagePush({ remoteMessage, message }) {
  // The same message can arrive over both the socket and push; the socket copy
  // marks it seen, so the push must not announce it a second time.
  if (hasSeenMessage(message.messageId)) {
    await sendPushReceipt({
      remoteMessage,
      messageId: message.messageId,
      stage: 'notification_suppressed',
      reason: 'already_delivered',
    });
    return { shown: false, reason: 'already_delivered' };
  }

  // The conversation is on screen: `useMessaging` already rendered the message
  // in-app, so an OS notification for it would be noise. Messages for any other
  // conversation still notify.
  if (
    isConversationOnScreen({
      senderId: message.senderId,
      conversationId: message.conversationId,
    })
  ) {
    markMessageSeen(message.messageId);
    await sendPushReceipt({
      remoteMessage,
      messageId: message.messageId,
      stage: 'notification_suppressed',
      reason: 'conversation_on_screen',
    });
    return { shown: false, reason: 'conversation_on_screen' };
  }

  const result = await showMessageNotification(message).catch(error => ({
    shown: false,
    reason: 'notification_threw',
    message: error?.message,
  }));
  await sendPushReceipt({
    remoteMessage,
    messageId: message.messageId,
    stage: result.shown ? 'notification_shown' : 'notification_failed',
    reason: result.reason ?? null,
  });
  return result;
}

/**
 * Handle a `call.cancelled` push: the call stopped ringing, so whatever OS UI
 * this device is showing for it must go away.
 *
 * A killed app has no socket and therefore never sees `call.state_changed`, so
 * without this push its incoming-call notification stays on screen — and stays
 * tappable — long after the call ended.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {Promise<{ callId: string, reason: string | null } | null>}
 */
async function handleCallCancelledPush(remoteMessage) {
  const data = remoteMessage?.data ?? {};
  const callId = typeof data.callId === 'string' ? data.callId.trim() : '';
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (!callId) {
    logWarn('[Push] Call-cancelled push missing callId');
    return null;
  }

  logInfo('[Push] Call cancelled push received', { callId, reason: reason || null });
  clearPendingAnswer(callId, reason || 'call_cancelled_push');
  try {
    endCallKeepCall(callId);
  } catch (error) {
    logWarn('[Push] Failed to dismiss cancelled call UI', { callId, message: error?.message });
  }
  return { callId, reason: reason || null };
}

/**
 * Background push callback used by @react-native-firebase/messaging.
 *
 * Dispatches on the envelope `type` the server sends: message pushes carry no
 * `callId`, so parsing every push as a call silently dropped every message.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {Promise<object | null>} the call or message descriptor that was
 *   handled, or `null` when the push could not be handled
 */
export async function handleBackgroundPushMessage(remoteMessage) {
  const type = _extractPushType(remoteMessage);
  if (type === PUSH_TYPE_MESSAGE) {
    return handleBackgroundMessagePush(remoteMessage);
  }
  if (type === PUSH_TYPE_CALL_CANCELLED) {
    const cancelled = await handleCallCancelledPush(remoteMessage);
    await flushDurableLogs();
    return cancelled;
  }
  if (type !== PUSH_TYPE_CALL) {
    await logBackgroundWarn('[Push] Background push of unknown type ignored', {
      type: type ?? null,
    });
    await flushDurableLogs();
    return null;
  }

  const incoming = _extractIncomingCallFromMessage(remoteMessage);
  if (!incoming) {
    await logBackgroundWarn('[Push] Background message missing call payload');
    await flushDurableLogs();
    return null;
  }

  await sendPushReceipt({ remoteMessage, callId: incoming.callId, stage: 'received' });
  await logBackgroundInfo('[Push] Background call push received', {
    callId: incoming.callId,
    callerId: incoming.callerId,
  });

  // Surface the OS-level incoming-call UI (CallKeep) so the call rings
  // full-screen even when the app was cold-started by this push. Degrades to a
  // no-op when the native callkeep module is not installed.
  await logBackgroundInfo('[Push] Calling CallKeep displayIncomingCall', {
    callId: incoming.callId,
  });
  const displayResult = await displayCallKeepIncomingCall({
    callId: incoming.callId,
    callerId: incoming.callerId,
  }).catch(error => ({
    shown: false,
    reason: 'telecom_threw',
    message: error?.message,
  }));
  await logBackgroundInfo('[Push] CallKeep displayIncomingCall resolved', {
    callId: incoming.callId,
    ...displayResult,
  });
  // The branded notification is posted independently of whether Telecom ever
  // created a CallKeep connection, so record which of the two happened: a ring
  // with no live connection is answerable only through the app's own
  // connection-independent accept path.
  const connectionLive = await isCallConnectionLive(incoming.callId);
  await sendPushReceipt({
    remoteMessage,
    callId: incoming.callId,
    stage: displayResult.shown ? 'ui_displayed' : 'ui_failed',
    reason:
      connectionLive === null ? null : connectionLive ? 'connection_live' : 'connection_missing',
  });
  await logBackgroundInfo('[Push] Background message handler exit', {
    callId: incoming.callId,
    uiStage: displayResult.shown ? 'ui_displayed' : 'ui_failed',
    connectionLive,
  });
  await flushDurableLogs();

  return incoming;
}

/**
 * Handle a `message.received` push that arrived while the app is backgrounded
 * or killed.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {Promise<object | null>}
 */
async function handleBackgroundMessagePush(remoteMessage) {
  const message = _extractMessageFromMessage(remoteMessage);
  if (!message) {
    await logBackgroundWarn('[Push] Background message push missing message payload');
    await flushDurableLogs();
    return null;
  }

  await sendPushReceipt({ remoteMessage, messageId: message.messageId, stage: 'received' });
  await logBackgroundInfo('[Push] Background message push received', {
    messageId: message.messageId,
    conversationId: message.conversationId,
    senderId: message.senderId,
  });

  const result = await displayMessagePush({ remoteMessage, message });
  await logBackgroundInfo('[Push] Background message push handler exit', {
    messageId: message.messageId,
    shown: result.shown,
    reason: result.reason ?? null,
  });
  await flushDurableLogs();

  return message;
}

/**
 * Install the Firebase background message handler when the native messaging
 * module is available.
 *
 * @returns {boolean} `true` when a handler was registered
 */
export function installBackgroundMessageHandler() {
  const handle = loadMessaging();
  if (!handle) return false;

  const { instance, api } = handle;
  if (typeof api.setBackgroundMessageHandler !== 'function') {
    logWarn('[Push] Native messaging module has no background handler API');
    return false;
  }

  api.setBackgroundMessageHandler(instance, async remoteMessage => {
    try {
      const incoming = await handleBackgroundPushMessage(remoteMessage);
      if (!incoming) {
        logWarn('[Push] Background message ignored');
      }
    } catch (error) {
      logError('[Push] Background message handler failed', error);
    }
  });
  return true;
}

/**
 * Handle a push that arrived while the app is in the foreground.
 *
 * `setBackgroundMessageHandler` is *only* invoked when the app is backgrounded
 * or killed; without a matching `onMessage` subscription a call push that lands
 * while the app is open is silently dropped. That is the case whenever the
 * socket is unhealthy (suspended radio, reconnect in progress) but the app is
 * on screen — the exact situation in which the callee's phone never rings.
 *
 * Dispatches on the envelope `type`, exactly like the background handler.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {Promise<object | null>}
 */
export async function handleForegroundPushMessage(remoteMessage) {
  const type = _extractPushType(remoteMessage);
  if (type === PUSH_TYPE_MESSAGE) {
    return handleForegroundMessagePush(remoteMessage);
  }
  if (type === PUSH_TYPE_CALL_CANCELLED) {
    return handleCallCancelledPush(remoteMessage);
  }
  if (type !== PUSH_TYPE_CALL) {
    logWarn('[Push] Foreground push of unknown type ignored', { type: type ?? null });
    return null;
  }

  const incoming = _extractIncomingCallFromMessage(remoteMessage);
  if (!incoming) {
    logWarn('[Push] Foreground call push missing call payload');
    return null;
  }

  logInfo('[Push] Foreground call push received', {
    callId: incoming.callId,
    callerId: incoming.callerId,
  });

  // `displayIncomingCall` deduplicates by callId, so this is a no-op when the
  // socket already surfaced the same call.
  await displayCallKeepIncomingCall({
    callId: incoming.callId,
    callerId: incoming.callerId,
  }).catch(error => {
    logWarn('[Push] CallKeep displayIncomingCall failed', { message: error?.message });
  });

  return incoming;
}

/**
 * Handle a `message.received` push that arrived while the app is on screen.
 *
 * @param {{ data?: Record<string, unknown> } | null | undefined} remoteMessage
 * @returns {Promise<object | null>}
 */
async function handleForegroundMessagePush(remoteMessage) {
  const message = _extractMessageFromMessage(remoteMessage);
  if (!message) {
    logWarn('[Push] Foreground message push missing message payload');
    return null;
  }

  logInfo('[Push] Foreground message push received', {
    messageId: message.messageId,
    conversationId: message.conversationId,
    senderId: message.senderId,
  });

  await sendPushReceipt({ remoteMessage, messageId: message.messageId, stage: 'received' });
  await displayMessagePush({ remoteMessage, message });

  return message;
}

/**
 * Subscribe to foreground push messages.
 *
 * @returns {() => void} Unsubscribe function; a no-op when messaging is absent.
 */
export function installForegroundMessageHandler() {
  const handle = loadMessaging();
  if (!handle) return () => {};

  const { instance, api } = handle;
  if (typeof api.onMessage !== 'function') return () => {};

  const unsubscribe = api.onMessage(instance, async remoteMessage => {
    try {
      await handleForegroundPushMessage(remoteMessage);
    } catch (error) {
      logError('[Push] Foreground message handler failed', error);
    }
  });

  return typeof unsubscribe === 'function' ? unsubscribe : () => {};
}
