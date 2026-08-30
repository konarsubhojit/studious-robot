/**
 * Push notification delivery for incoming calls, cancellations and messages.
 *
 * This module is the package's public face; the implementation lives in
 * `push/`, one module per concern:
 *
 *  | Module                | Responsibility                                     |
 *  | --------------------- | -------------------------------------------------- |
 *  | `push/types.ts`       | Shapes shared by every module below.                |
 *  | `push/credentials.ts` | Reading provider configuration from the env.        |
 *  | `push/tokens.ts`      | Minting and caching APNs/FCM/ANH credentials.       |
 *  | `push/envelopes.ts`   | What a notification says (pure).                    |
 *  | `push/payloads.ts`    | How an envelope is rendered per wire format (pure).  |
 *  | `push/outcomes.ts`    | Retry/dead-token classification and logging (pure).  |
 *  | `push/transport.ts`   | The actual sends, and the retry loop.               |
 *  | `push/delivery.ts`    | The provider chain and the public senders.          |
 *
 * Supports APNs (Apple Push Notification service) via HTTP/2 and FCM (Firebase
 * Cloud Messaging) via the HTTP v1 API.  Both providers are env-gated and fail
 * gracefully with console diagnostics when credentials are absent.
 *
 * Configuration env vars
 * ──────────────────────
 *  APNs  APNS_KEY         PEM-encoded EC private key (.p8 file contents)
 *        APNS_KEY_ID      10-character key identifier
 *        APNS_TEAM_ID     10-character Apple team identifier
 *        APNS_BUNDLE_ID   App bundle ID (e.g. com.wetalk)
 *        APNS_PRODUCTION  Set to 'true' to use the production gateway
 *
 *  FCM   FCM_SERVICE_ACCOUNT_JSON  Firebase service-account credentials (JSON
 *                                  string, or a path to the JSON file).  Used to
 *                                  mint an OAuth2 access token for the FCM HTTP
 *                                  v1 API (`messages:send`).
 *
 *  ANH   AZURE_NOTIFICATION_HUB_CONNECTION_STRING
 *                                  DefaultFullSharedAccessSignature connection
 *                                  string of the Notification Hub namespace.
 *        AZURE_NOTIFICATION_HUB_NAME         Hub name (e.g. `storeman`).
 *        AZURE_NOTIFICATION_HUB_API_VERSION  REST api-version (default 2015-04).
 *
 * When Azure Notification Hubs is configured it is tried first for every
 * device, regardless of the underlying provider; on any failure delivery falls
 * back to the direct APNs / FCM paths so nothing breaks when ANH is misconfigured.
 */

import { buildMessageEnvelope } from './push/envelopes.ts';
import {
  buildFcmEnvelopePayload,
  buildNotificationHubAndroidEnvelopePayload,
} from './push/payloads.ts';
import type { MessagePushData, NotificationHubAndroidPayload } from './push/types.ts';

export type { PushChannel, PushDeliveryOutcome, PushEnvelope } from './push/types.ts';

export {
  pushSenders,
  sendIncomingCallPush,
  sendCallCancelledPush,
  sendMessagePush,
} from './push/delivery.ts';

export { logNotificationHubStartupStatus } from './push/credentials.ts';

// ─── Exported for unit tests ──────────────────────────────────────────────────

export {
  _resetFcmTokenCache,
  _resetNotificationHubTokenCache,
  buildNotificationHubSasToken as _buildNotificationHubSasToken,
} from './push/tokens.ts';
export {
  loadFcmConfig as _loadFcmConfig,
  loadNotificationHubConfig as _loadNotificationHubConfig,
} from './push/credentials.ts';
export {
  buildFcmPayload as _buildFcmPayload,
  buildNotificationHubAndroidPayload as _buildNotificationHubAndroidPayload,
} from './push/payloads.ts';
export {
  buildCallCancelledEnvelope as _buildCallCancelledEnvelope,
  resolveCallTtlSeconds as _resolveCallTtlSeconds,
} from './push/envelopes.ts';
export { isDeadTokenResult as _isDeadTokenResult } from './push/outcomes.ts';

/** Direct-FCM message payload, exported for the payload-contract test. */
export const _buildFcmMessagePayload = (pushToken: string, messageData: MessagePushData): string =>
  buildFcmEnvelopePayload(pushToken, buildMessageEnvelope(messageData));

/** Notification Hubs message payload, exported for the payload-contract test. */
export const _buildNotificationHubAndroidMessagePayload = (
  messageData: MessagePushData
): NotificationHubAndroidPayload =>
  buildNotificationHubAndroidEnvelopePayload(buildMessageEnvelope(messageData));
