/**
 * Delivery orchestration: the provider chain, and the three public senders.
 *
 * Chain order is Azure Notification Hubs (when configured) → the provider's own
 * API → skip.  Nothing here throws: an unconfigured provider resolves with a
 * `*_not_configured` reason so a missing credential can never fail a call or a
 * message send.
 */

import {
  loadApnsConfig,
  loadFcmConfig,
  loadNotificationHubConfig,
  logNotificationHubNotConfigured,
} from './credentials.ts';
import {
  buildCallCancelledEnvelope,
  buildCallEnvelope,
  buildMessageEnvelope,
} from './envelopes.ts';
import { isDeadTokenResult, logDeliveryOutcome } from './outcomes.ts';
import { sendApnsOnce, sendFcmOnce, sendNotificationHubOnce, withRetry } from './transport.ts';
import type {
  CallCancelledPushData,
  CallPushData,
  MessagePushData,
  PushAttemptResult,
  PushChannel,
  PushDeliveryOutcome,
  PushEnvelope,
} from './types.ts';

/**
 * Attempt delivery through Azure Notification Hubs.
 *
 * Returns `{ ok: false, reason: 'notification_hub_not_configured' }` without any
 * network traffic (and without log spam) when ANH is not configured, so callers
 * can fall straight through to the direct provider path.
 */
async function tryNotificationHub(
  channel: PushChannel,
  envelope: PushEnvelope,
  label: string
): Promise<PushAttemptResult> {
  const config = loadNotificationHubConfig();
  if (!config) {
    logNotificationHubNotConfigured();
    console.log(
      `[push] Skipped Notification Hub for device=${channel.deviceId}` +
        ` reason=notification_hub_not_configured; using direct ${channel.provider}`
    );
    return { ok: false, reason: 'notification_hub_not_configured' };
  }

  return withRetry(() => sendNotificationHubOnce(config, channel, envelope), `hub:${label}`);
}

/**
 * Deliver through the provider's own API, after the hub declined or is absent.
 *
 * `hubResult` is threaded through so a dead-token verdict the hub already
 * reached is not lost when the direct path is skipped for want of credentials.
 */
async function deliverDirect(
  channel: PushChannel,
  envelope: PushEnvelope,
  hubResult: PushAttemptResult,
  label: string
): Promise<PushDeliveryOutcome> {
  const { provider, pushToken, deviceId } = channel;

  let result;
  if (provider === 'apns') {
    const config = loadApnsConfig();
    if (!config) {
      console.warn(
        `[push] APNs not configured` +
          ` (set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID); skip ${deviceId}`
      );
      return {
        ok: false,
        provider,
        deviceId,
        transport: 'direct',
        reason: 'apns_not_configured',
        deadToken: isDeadTokenResult(hubResult),
      };
    }
    result = await withRetry(() => sendApnsOnce(config, pushToken, envelope), label);
  } else if (provider === 'fcm') {
    const config = loadFcmConfig();
    if (!config) {
      console.warn(`[push] FCM not configured (set FCM_SERVICE_ACCOUNT_JSON); skip ${deviceId}`);
      return {
        ok: false,
        provider,
        deviceId,
        transport: 'direct',
        reason: 'fcm_not_configured',
        deadToken: isDeadTokenResult(hubResult),
      };
    }
    result = await withRetry(() => sendFcmOnce(config, pushToken, envelope), label);
  } else {
    console.warn(`[push] Unknown provider "${provider}" for device ${deviceId}`);
    return {
      ok: false,
      provider,
      deviceId,
      transport: 'direct',
      reason: 'unknown_provider',
      deadToken: false,
    };
  }

  return {
    provider,
    deviceId,
    transport: 'direct',
    ...result,
    deadToken: !result.ok && (isDeadTokenResult(result) || isDeadTokenResult(hubResult)),
  };
}

/**
 * Deliver a push envelope to one device.
 *
 * Provider chain: Azure Notification Hubs (when configured) → direct APNs / FCM
 * → skip.  Never throws; unconfigured providers resolve with a
 * `*_not_configured` reason.
 */
export async function deliverPush(
  channel: PushChannel,
  envelope: PushEnvelope
): Promise<PushDeliveryOutcome> {
  const { provider, deviceId } = channel;
  const label = `${provider}:${deviceId}`;

  // 1. Preferred transport: Azure Notification Hubs (direct send).
  const hubResult = await tryNotificationHub(channel, envelope, label);
  if (hubResult.ok) {
    return { provider, deviceId, transport: 'notification_hub', deadToken: false, ...hubResult };
  }
  if (hubResult.reason !== 'notification_hub_not_configured') {
    console.warn(
      `[push] Notification Hub delivery failed (reason=${hubResult.reason ?? 'unknown'});` +
        ` falling back to direct ${provider}`
    );
  }

  // 2. Fallback transport: the provider's own API.
  return deliverDirect(channel, envelope, hubResult, label);
}

/**
 * Send an incoming-call push notification.
 *
 * - Tries Azure Notification Hubs first when configured, falling back to the
 *   direct APNs / FCM path on any failure.
 * - Skips gracefully when no provider is configured.
 * - Retries up to MAX_ATTEMPTS times on transient network / server errors.
 * - Logs every delivery outcome (success or failure).
 * - Never throws.
 */
export async function sendIncomingCallPush(
  channel: PushChannel,
  callData: CallPushData
): Promise<PushDeliveryOutcome> {
  const outcome = await deliverPush(channel, buildCallEnvelope(callData));
  logDeliveryOutcome(outcome, `call.incoming callId=${callData.callId}`);
  return outcome;
}

/**
 * Tell a device that a call stopped ringing so it can dismiss the stale
 * incoming-call notification even with no socket connected.  Never throws.
 *
 * @returns delivery outcome, see {@link sendIncomingCallPush}
 */
export async function sendCallCancelledPush(
  channel: PushChannel,
  callData: CallCancelledPushData
): Promise<PushDeliveryOutcome> {
  const outcome = await deliverPush(channel, buildCallCancelledEnvelope(callData));
  logDeliveryOutcome(
    outcome,
    `call.cancelled callId=${callData.callId} reason=${callData.reason ?? 'ended'}`
  );
  return outcome;
}

/**
 * Send a text-message push notification to an offline recipient.
 *
 * Uses the same Notification-Hubs-first chain and data-only payload shape as
 * {@link sendIncomingCallPush}.  Never throws.
 *
 * Acceptance by the provider says nothing about whether the handset displayed
 * anything — the client reports that separately through
 * `POST /devices/push-receipt` keyed by `messageId`.
 *
 * @param messageData
 */
export async function sendMessagePush(
  channel: PushChannel,
  messageData: MessagePushData
): Promise<PushDeliveryOutcome> {
  const outcome = await deliverPush(channel, buildMessageEnvelope(messageData));
  logDeliveryOutcome(outcome, `message.received messageId=${messageData.messageId}`);
  return outcome;
}

/**
 * Mutable indirection for the three senders. Callers go through this object so
 * tests can swap an individual sender at runtime: ES module namespaces are
 * read-only, so the object property is what keeps the seam patchable.
 */
export const pushSenders: {
  sendIncomingCallPush: (channel: any, callData: any) => Promise<any>;
  sendCallCancelledPush: (channel: any, callData: any) => Promise<any>;
  sendMessagePush: (channel: any, messageData: any) => Promise<any>;
} = {
  sendIncomingCallPush,
  sendCallCancelledPush,
  sendMessagePush,
};
