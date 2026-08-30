/**
 * Vocabulary shared by every push module.
 *
 * These shapes used to be repeated inline on each function signature, which is
 * why the same "channel" object was described four slightly different ways.
 * Naming them once makes a mismatch a compile error rather than a review catch.
 */

/** One deliverable device: which provider owns it and how to address it. */
export type PushChannel = {
  provider: string;
  pushToken: string;
  deviceId: string;
};

/** Transport-neutral description of a push notification. */
export type PushEnvelope = {
  type: string;
  title: string;
  body: string;
  deepLink: string;
  data: Record<string, string>;
  ttlSeconds?: number;
};

/** Result of a single delivery attempt against one transport. */
export type PushAttemptResult = {
  ok: boolean;
  statusCode?: number;
  reason?: string;
};

/** Notification Hubs adds correlation headers to the generic attempt result. */
export type NotificationHubAttemptResult = PushAttemptResult & {
  headers?: Record<string, string>;
  trackingId?: string | null;
};

/** The outcome of the whole provider chain for one device. */
export type PushDeliveryOutcome = {
  ok: boolean;
  provider: string;
  deviceId: string;
  transport: 'notification_hub' | 'direct';
  statusCode?: number;
  reason?: string;
  trackingId?: string | null;
  deadToken: boolean;
};

/** Incoming-call push input. */
export type CallPushData = {
  callId: string;
  callerId: string;
  ringTimeoutAt?: string | null;
};

/** Call-cancelled push input. */
export type CallCancelledPushData = {
  callId: string;
  reason?: string | null;
};

/** Message push input. */
export type MessagePushData = {
  messageId: string;
  conversationId: string;
  senderId: string;
  preview?: string | null;
};

/** APNs provider credentials, as loaded from the environment. */
export type ApnsConfig = {
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  production: boolean;
};

/** FCM service-account credentials, as loaded from the environment. */
export type FcmConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

/** The subset of an FCM service account needed to mint an access token. */
export type FcmTokenCredentials = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

/** Azure Notification Hubs credentials, as loaded from the environment. */
export type NotificationHubConfig = {
  endpoint: string;
  keyName: string;
  key: string;
  hubName: string;
  apiVersion: string;
};

/** The `Endpoint`/`SharedAccessKeyName`/`SharedAccessKey` triple of a hub. */
export type NotificationHubCredentials = {
  endpoint: string;
  keyName: string;
  key: string;
};

/** An OAuth2 access-token acquisition result. */
export type AccessTokenResult = {
  ok: boolean;
  accessToken?: string;
  statusCode?: number;
  reason?: string;
};

/** The Android (`FcmV1`) body Notification Hubs forwards to FCM. */
export type NotificationHubAndroidPayload = {
  message: {
    android: {
      data: Record<string, string>;
      priority: string;
      ttl?: string;
    };
  };
};
