/**
 * Wire-format payloads: how an envelope is rendered for each transport.
 *
 * Three formats, one envelope: APNs' `aps` body, the FCM HTTP v1
 * `messages:send` body, and the Android (`FcmV1`) body Notification Hubs
 * forwards to FCM.  All three are pure string/object construction, which is
 * what makes `push-payload-contract.test.ts` able to pin the client-facing
 * contract without touching a provider.
 */

import { buildCallEnvelope } from './envelopes.ts';
import type { CallPushData, NotificationHubAndroidPayload, PushEnvelope } from './types.ts';

/**
 * FCM HTTP v1 `AndroidConfig.priority` enum value for time-critical messages.
 *
 * The v1 API defines the field as the proto enum `AndroidMessagePriority`
 * (`NORMAL` | `HIGH`), so the canonical spelling is upper-case; the lower-case
 * spelling is a legacy-HTTP artefact and is not part of the v1 contract. Shared
 * by the direct-FCM and Notification Hubs (`FcmV1`) bodies so the two cannot
 * drift apart.
 */
const FCM_PRIORITY_HIGH = 'HIGH';

/**
 * Build an APNs payload body for a push envelope.
 */
export function buildApnsEnvelopePayload(envelope: PushEnvelope): string {
  return JSON.stringify({
    aps: {
      alert: {
        title: envelope.title,
        body: envelope.body,
      },
      sound: 'default',
      badge: 1,
      'content-available': 1,
    },
    ...envelope.data,
    type: envelope.type,
    deepLink: envelope.deepLink,
  });
}

/**
 * Flatten an envelope into the string-valued `data` map shared by the direct
 * FCM v1 and Notification Hubs (`FcmV1`) wire formats.
 */
export function buildDataBlock(envelope: PushEnvelope): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(envelope.data)) {
    data[key] = String(value);
  }
  data.type = envelope.type;
  data.deepLink = envelope.deepLink;
  data.title = envelope.title;
  data.body = envelope.body;
  return data;
}

/**
 * Whether a TTL is a usable, positive number of seconds.
 */
function hasTtl(ttlSeconds: number | null | undefined): ttlSeconds is number {
  return Boolean(ttlSeconds) && Number.isFinite(ttlSeconds) && (ttlSeconds as number) > 0;
}

/**
 * Build an FCM HTTP v1 `messages:send` request body from a push envelope.
 *
 * This is a *data-only* message (no `notification` block).  A `notification`
 * payload would make Android deliver the message straight to the system tray
 * and skip the app's `setBackgroundMessageHandler` whenever the app is
 * backgrounded or killed — so the CallKeep full-screen incoming-call UI would
 * never show and the phone would not ring.  Sending data-only with
 * `android.priority: 'HIGH'` wakes the background handler, which then rings the
 * call via CallKeep.  The human-readable title/body are carried inside `data`
 * (v1 requires all `data` values to be strings) so the client can still render
 * a heads-up notification if it chooses.
 */
export function buildFcmEnvelopePayload(
  pushToken: string,
  envelope: PushEnvelope,
  { ttlSeconds = null }: { ttlSeconds?: number | null; } = {}
): string {
  const apnsHeaders: Record<string, string> = { 'apns-priority': '10' };
  if (hasTtl(ttlSeconds)) {
    apnsHeaders['apns-expiration'] = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  }
  return JSON.stringify({
    message: {
      token: pushToken,
      data: buildDataBlock(envelope),
      android: {
        priority: FCM_PRIORITY_HIGH,
        ...(hasTtl(ttlSeconds) ? { ttl: `${ttlSeconds}s` } : {}),
      },
      apns: { headers: apnsHeaders },
    },
  });
}

/**
 * Build the FCM HTTP v1 payload for an incoming call.
 */
export function buildFcmPayload(pushToken: string, callData: CallPushData): string {
  const envelope = buildCallEnvelope(callData);
  return buildFcmEnvelopePayload(pushToken, envelope, { ttlSeconds: envelope.ttlSeconds });
}

/**
 * Build the Android (`FcmV1` format) body Notification Hubs forwards to FCM.
 *
 * Google retired the FCM *legacy* HTTP protocol (the `gcm` Notification Hubs
 * format) in June 2024; hubs configured with a Google (FCM v1) service-account
 * credential only accept the native FCM v1 `message` envelope — a legacy-shape
 * body matches no target application and the hub answers "no target
 * applications ... format is gcm" with a 400. As with
 * {@link buildFcmEnvelopePayload} this is deliberately **data-only**: adding a
 * `notification` block would bypass the app's `setBackgroundMessageHandler`
 * and break the CallKeep full-screen incoming-call UI. The
 * `token`/`topic`/`condition` target field required by a standalone FCM v1
 * call is omitted — Notification Hubs routes the message using the
 * `ServiceBusNotification-DeviceHandle` header instead.
 */
export function buildNotificationHubAndroidEnvelopePayload(
  envelope: PushEnvelope,
  { ttlSeconds = null }: { ttlSeconds?: number | null; } = {}
): NotificationHubAndroidPayload {
  return {
    message: {
      android: {
        data: buildDataBlock(envelope),
        priority: FCM_PRIORITY_HIGH,
        ...(hasTtl(ttlSeconds) ? { ttl: `${ttlSeconds}s` } : {}),
      },
    },
  };
}

/**
 * Build the Notification Hubs Android body for an incoming call.
 */
export function buildNotificationHubAndroidPayload(
  callData: CallPushData
): NotificationHubAndroidPayload {
  const envelope = buildCallEnvelope(callData);
  return buildNotificationHubAndroidEnvelopePayload(envelope, {
    ttlSeconds: envelope.ttlSeconds,
  });
}
