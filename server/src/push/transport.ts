/**
 * Transport: the only module in `push/` that opens a socket.
 *
 * One function per provider, each performing exactly one attempt and resolving
 * with a classified result, plus the retry wrapper that drives them.  Keeping
 * the I/O here is what lets the payload and outcome modules stay pure.
 */

import http2 from 'http2';
import https from 'https';
import { describeError } from '../lib/errors.ts';
import {
  buildApnsEnvelopePayload,
  buildFcmEnvelopePayload,
  buildNotificationHubAndroidEnvelopePayload,
} from './payloads.ts';
import { buildApnsJwt, buildNotificationHubSasToken, getFcmAccessToken } from './tokens.ts';
import { isRetryable } from './outcomes.ts';
import type {
  ApnsConfig,
  FcmConfig,
  NotificationHubAttemptResult,
  NotificationHubConfig,
  PushAttemptResult,
  PushChannel,
  PushEnvelope,
} from './types.ts';

const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const APNS_HOST_PRODUCTION = 'api.push.apple.com';

const FCM_HOST = 'fcm.googleapis.com';

/** Maximum delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Base delay for exponential back-off between retries. */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Perform one APNs HTTP/2 delivery attempt.
 *
 *   config
 */
export function sendApnsOnce(
  config: ApnsConfig,
  pushToken: string,
  envelope: PushEnvelope
): Promise<PushAttemptResult> {
  const host = config.production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
  const jwt = buildApnsJwt(config);
  const payload = buildApnsEnvelopePayload(envelope);
  const payloadLen = Buffer.byteLength(payload).toString();

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${pushToken}`,
      ':scheme': 'https',
      ':authority': host,
      authorization: `bearer ${jwt}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': payloadLen,
    });

    let body = '';
    let statusCode: number | undefined;

    req.on('response', (headers) => {
      statusCode = Number(headers[':status']);
    });
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      client.close();
      if (statusCode === 200) {
        resolve({ ok: true, statusCode });
        return;
      }
      let reason = 'unknown';
      try {
        reason = JSON.parse(body)?.reason ?? 'unknown';
      } catch {
        /* ignore */
      }
      resolve({ ok: false, statusCode, reason });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Perform one FCM HTTP v1 delivery attempt.
 *
 * Acquires (or reuses) an OAuth2 access token from the service-account
 * credentials, then POSTs the v1 message to
 * `/v1/projects/{projectId}/messages:send`.
 *
 *   config
 */
export async function sendFcmOnce(
  config: FcmConfig,
  pushToken: string,
  envelope: PushEnvelope
): Promise<PushAttemptResult> {
  const token = await getFcmAccessToken(config);
  if (!token.ok) {
    // Treat token-endpoint 5xx/429 (or network errors) as retryable; other
    // failures surface their status so withRetry can short-circuit.
    return {
      ok: false,
      statusCode: token.statusCode,
      reason: token.reason ?? 'token_error',
    };
  }

  const payload = buildFcmEnvelopePayload(pushToken, envelope, {
    ttlSeconds: envelope.ttlSeconds ?? null,
  });
  const payloadLen = Buffer.byteLength(payload);
  const path = `/v1/projects/${config.projectId}/messages:send`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: FCM_HOST,
        path,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token.accessToken,
          'Content-Type': 'application/json',
          'Content-Length': payloadLen,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode;
          if (statusCode === 200) {
            resolve({ ok: true, statusCode });
            return;
          }
          let reason = 'unknown';
          try {
            const parsed = JSON.parse(body);
            reason = parsed?.error?.status || parsed?.error?.message || 'unknown';
          } catch {
            /* ignore */
          }
          resolve({ ok: false, statusCode, reason });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Perform one Azure Notification Hubs **direct send** attempt.
 *
 * Direct send targets a single device handle (the token we already store on the
 * device record) instead of an ANH registration/tag, so no registration
 * migration is required.  The hub translates the body into a native APNs or
 * FCM v1 payload according to the `ServiceBusNotification-Format` header
 * (`apple` or `FcmV1` — the legacy `gcm` format targets FCM credentials Google
 * retired in June 2024 and is no longer accepted).
 */
export function sendNotificationHubOnce(
  config: NotificationHubConfig,
  channel: PushChannel,
  envelope: PushEnvelope
): Promise<NotificationHubAttemptResult> {
  const isApple = channel.provider === 'apns';
  const format = isApple ? 'apple' : 'FcmV1';
  const payload = isApple
    ? buildApnsEnvelopePayload(envelope)
    : JSON.stringify(
        buildNotificationHubAndroidEnvelopePayload(envelope, {
          ttlSeconds: envelope.ttlSeconds ?? null,
        }),
      );

  const url = new URL(
    `${config.hubName}/messages/?direct&api-version=${encodeURIComponent(config.apiVersion)}`,
    config.endpoint
  );
  // The SAS token is scoped to the hub resource, not the per-send query string.
  const sasToken = buildNotificationHubSasToken(
    config,
    new URL(config.hubName, config.endpoint).toString()
  );
  const payloadLen = Buffer.byteLength(payload);
  const headers: Record<string, string | number> = {
    Authorization: sasToken,
    'Content-Type': 'application/json;charset=utf-8',
    'Content-Length': payloadLen,
    'ServiceBusNotification-Format': format,
    'ServiceBusNotification-DeviceHandle': channel.pushToken,
  };
  if (Number.isFinite(envelope.ttlSeconds) && (envelope.ttlSeconds ?? 0) > 0) {
    headers['ServiceBusNotification-TTL'] = String(envelope.ttlSeconds);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode;
          const responseHeaders = extractNotificationHubCorrelationHeaders(res.headers);
          const trackingId =
            responseHeaders['x-ms-request-id'] ||
            responseHeaders['x-ms-tracking-id'] ||
            responseHeaders['x-ms-correlation-request-id'] ||
            null;
          console.debug(
            `[push] Notification Hub response status=${statusCode ?? 'N/A'}` +
              ` device=${channel.deviceId} headers=${JSON.stringify(responseHeaders)}`
          );
          if (statusCode === 200 || statusCode === 201) {
            resolve({ ok: true, statusCode, headers: responseHeaders, trackingId });
            return;
          }
          let reason = 'unknown';
          if (body) {
            try {
              const parsed = JSON.parse(body);
              reason =
                parsed?.error?.message || parsed?.Message || parsed?.message || body.slice(0, 200);
            } catch {
              reason = body.slice(0, 200);
            }
          }
          resolve({ ok: false, statusCode, reason, headers: responseHeaders, trackingId });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * @returns the `x-ms-*` headers, lower-cased.
 */
export function extractNotificationHubCorrelationHeaders(
  headers: Record<string, string | string[] | undefined> = {}
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith('x-ms-')) continue;
    output[lower] = Array.isArray(value) ? value.join(',') : String(value ?? '');
  }
  return output;
}

/**
 * Call `fn` up to MAX_ATTEMPTS times, backing off exponentially on transient
 * failures.
 *
 * @param label - Used in log messages.
 */
export async function withRetry(
  fn: () => Promise<PushAttemptResult>,
  label: string
): Promise<PushAttemptResult> {
  let last: PushAttemptResult | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      if (result.ok) return result;

      if (!isRetryable(result)) {
        console.warn(
          `[push] ${label} non-retryable failure` +
            ` status=${result.statusCode} reason=${result.reason ?? 'unknown'}`
        );
        return result;
      }

      last = result;
      console.warn(
        `[push] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed status=${result.statusCode}`
      );
    } catch (error) {
      last = { ok: false, reason: describeError(error) };
      console.error(
        `[push] ${label} attempt ${attempt}/${MAX_ATTEMPTS} threw: ${describeError(error)}`
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  return last ?? { ok: false };
}
