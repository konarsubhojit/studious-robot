/**
 * Push notification delivery for incoming calls.
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

import fs from 'fs';
import http2 from 'http2';
import https from 'https';
import { createSign, createHmac } from 'crypto';

/**
 * @param {unknown} error
 * @returns {string} the error message, or a stringified fallback.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const APNS_HOST_PRODUCTION = 'api.push.apple.com';

const FCM_HOST = 'fcm.googleapis.com';
/** OAuth2 scope required to send messages via the FCM HTTP v1 API. */
const FCM_SEND_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Default Google OAuth2 token endpoint (overridden by the SA `token_uri`). */
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Google access tokens last ~1 hour; refresh a little early. */
const FCM_TOKEN_TTL_SECS = 3300; // 55 minutes
/** Skew applied to the cached-token expiry check, in seconds. */
const FCM_TOKEN_SKEW_SECS = 60;

/** Maximum delivery attempts (initial + retries). */
const MAX_ATTEMPTS = 3;

/** Base delay for exponential back-off between retries. */
const RETRY_BASE_DELAY_MS = 500;

/** APNs provider tokens are valid for 1 hour; refresh after 50 minutes. */
const APNS_TOKEN_TTL_SECS = 50 * 60;

/**
 * Default Notification Hubs REST api-version.
 *
 * `2015-04` is the latest api-version documented for the data-plane
 * `/messages/?direct` (direct send) operation — later dated versions exist for
 * the management plane (hub CRUD) but do not apply here. It is required (not
 * merely sufficient) for `FcmV1`-format sends.
 */
const NOTIFICATION_HUB_DEFAULT_API_VERSION = '2015-04';
/** Lifetime of a generated Notification Hubs SAS token. */
const NOTIFICATION_HUB_TOKEN_TTL_SECS = 60 * 60;
/** Skew applied to the cached SAS-token expiry check, in seconds. */
const NOTIFICATION_HUB_TOKEN_SKEW_SECS = 60;
/**
 * Fallback lifetime of a call push when the call record carries no
 * `ringTimeoutAt`.  Matches the default server ring window
 * (`DEFAULT_RINGING_TIMEOUT_MS`) so a push can never outlive the ring — see
 * {@link resolveCallTtlSeconds}.
 */
const INCOMING_CALL_TTL_SECONDS = 120;

/**
 * Lifetime of a `call.cancelled` push.  Short: it is only useful while the
 * stale incoming-call notification is still on screen, and a device that was
 * offline for a minute never showed one.
 */
const CANCELLED_CALL_TTL_SECONDS = 60;

// ─── APNs JWT cache ───────────────────────────────────────────────────────────

/** @type {string|null} */
let _apnsJwt: string | null = null;
let _apnsJwtExpiresAt = 0;

/**
 * Build (or return cached) an ES256 JWT for APNs provider authentication.
 *
 * @param {{ keyId: string, teamId: string, key: string }} config
 * @returns {string}
 */
function buildApnsJwt(config: { keyId: string; teamId: string; key: string; }): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  if (_apnsJwt && _apnsJwtExpiresAt > nowSecs) {
    return _apnsJwt;
  }

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString(
    'base64url'
  );
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: nowSecs })).toString(
    'base64url'
  );
  const unsigned = `${header}.${claims}`;

  const signer = createSign('SHA256');
  signer.update(unsigned);
  // ieee-p1363 encoding produces the fixed-length R||S format required by JWT.
  // This option is available since Node.js 13; this project requires Node >= 22.
  const sig = signer.sign({ key: config.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

  _apnsJwt = `${unsigned}.${sig}`;
  _apnsJwtExpiresAt = nowSecs + APNS_TOKEN_TTL_SECS;
  return _apnsJwt;
}

// ─── FCM OAuth2 access-token cache ─────────────────────────────────────────────

/** @type {string|null} */
let _fcmAccessToken: string | null = null;
let _fcmAccessTokenExpiresAt = 0;
/** @type {string|null} */
let _fcmAccessTokenEmail: string | null = null;

/**
 * Reset the cached FCM access token.  Intended for tests so credential changes
 * between cases are not masked by the in-process cache.
 */
function _resetFcmTokenCache() {
  _fcmAccessToken = null;
  _fcmAccessTokenExpiresAt = 0;
  _fcmAccessTokenEmail = null;
}

/**
 * Build a signed RS256 JWT asserting the service-account identity, used to
 * exchange for an OAuth2 access token at the service account's `token_uri`.
 *
 * @param {{ clientEmail: string, privateKey: string, tokenUri: string }} config
 * @returns {string}
 */
function buildFcmAssertion(config: { clientEmail: string; privateKey: string; tokenUri: string; }): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: config.clientEmail,
      scope: FCM_SEND_SCOPE,
      aud: config.tokenUri,
      iat: nowSecs,
      exp: nowSecs + 3600,
    })
  ).toString('base64url');
  const unsigned = `${header}.${claims}`;

  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(config.privateKey).toString('base64url');
  return `${unsigned}.${sig}`;
}

/**
 * Exchange a signed assertion for an OAuth2 access token via the token endpoint.
 *
 * @param {{ clientEmail: string, privateKey: string, tokenUri: string }} config
 * @returns {Promise<{ ok: boolean, accessToken?: string, statusCode?: number, reason?: string }>}
 */
function requestFcmAccessToken(config: { clientEmail: string; privateKey: string; tokenUri: string; }): Promise<{ ok: boolean; accessToken?: string; statusCode?: number; reason?: string; }> {
  const assertion = buildFcmAssertion(config);
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();

  const url = new URL(config.tokenUri);
  const body = Buffer.from(form);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = {};
          }
          if (statusCode === 200 && parsed.access_token) {
            resolve({ ok: true, accessToken: parsed.access_token });
            return;
          }
          resolve({
            ok: false,
            statusCode,
            reason: parsed.error || parsed.error_description || 'token_request_failed',
          });
        });
      }
    );
    req.on('error', () => {
      resolve({ ok: false, reason: 'token_request_failed' });
    });
    req.end(body);
  });
}

/**
 * Return a cached OAuth2 access token, refreshing it when expired or when the
 * service-account identity changes.
 *
 * @param {{ clientEmail: string, privateKey: string, tokenUri: string }} config
 * @returns {Promise<{ ok: boolean, accessToken?: string, statusCode?: number, reason?: string }>}
 */
async function getFcmAccessToken(config: { clientEmail: string; privateKey: string; tokenUri: string; }): Promise<{ ok: boolean; accessToken?: string; statusCode?: number; reason?: string; }> {
  const nowSecs = Math.floor(Date.now() / 1000);
  if (
    _fcmAccessToken &&
    _fcmAccessTokenEmail === config.clientEmail &&
    _fcmAccessTokenExpiresAt - FCM_TOKEN_SKEW_SECS > nowSecs
  ) {
    return { ok: true, accessToken: _fcmAccessToken };
  }

  const result = await requestFcmAccessToken(config);
  if (result.ok) {
    _fcmAccessToken = result.accessToken ?? null;
    _fcmAccessTokenEmail = config.clientEmail;
    _fcmAccessTokenExpiresAt = nowSecs + FCM_TOKEN_TTL_SECS;
  }
  return result;
}

// ─── Config loaders ───────────────────────────────────────────────────────────

function loadApnsConfig() {
  const key = process.env.APNS_KEY?.trim();
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const bundleId = process.env.APNS_BUNDLE_ID?.trim();

  if (!key || !keyId || !teamId || !bundleId) return null;

  return {
    key,
    keyId,
    teamId,
    bundleId,
    production: process.env.APNS_PRODUCTION === 'true',
  };
}

/**
 * Load and validate the FCM service-account credentials used for HTTP v1.
 *
 * `FCM_SERVICE_ACCOUNT_JSON` may contain either the raw JSON of the service
 * account key, or a filesystem path to that JSON file.  Returns `null` (so the
 * caller can skip gracefully) when the variable is absent or cannot be parsed
 * into a usable credential.
 *
 * @returns {{ projectId: string, clientEmail: string, privateKey: string, tokenUri: string } | null}
 */
function loadFcmConfig(): { projectId: string; clientEmail: string; privateKey: string; tokenUri: string; } | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  let json = raw;
  // Allow pointing at a file on disk instead of inlining the JSON.
  if (!raw.startsWith('{')) {
    try {
      json = fs.readFileSync(raw, 'utf8');
    } catch (error) {
      console.warn(`[push] FCM service account file unreadable: ${errorMessage(error)}`);
      return null;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    console.warn(`[push] FCM service account JSON is invalid: ${errorMessage(error)}`);
    return null;
  }

  const projectId = parsed.project_id;
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[push] FCM service account JSON missing project_id/client_email/private_key');
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: parsed.token_uri || GOOGLE_TOKEN_URI,
  };
}

// ─── Notification Hubs config + SAS token ─────────────────────────────────────

/**
 * Parse an Azure Service Bus / Notification Hubs connection string.
 *
 * Expected shape:
 *   `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=…;SharedAccessKey=…`
 *
 * @param {string} connectionString
 * @returns {{ endpoint: string, keyName: string, key: string } | null}
 */
function parseNotificationHubConnectionString(connectionString: string): { endpoint: string; keyName: string; key: string; } | null {
  if (typeof connectionString !== 'string' || connectionString.trim().length === 0) {
    return null;
  }

  let endpoint = null;
  let keyName = null;
  let key = null;

  for (const part of connectionString.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    if (name === 'endpoint') endpoint = value;
    else if (name === 'sharedaccesskeyname') keyName = value;
    else if (name === 'sharedaccesskey') key = value;
  }

  if (!endpoint || !keyName || !key) return null;

  // The REST API is addressed over HTTPS; the connection string advertises the
  // AMQP (`sb://`) endpoint.
  const httpsEndpoint = endpoint.replace(/^sb:\/\//i, 'https://');
  if (!/^https:\/\//i.test(httpsEndpoint)) return null;

  return {
    endpoint: httpsEndpoint.endsWith('/') ? httpsEndpoint : `${httpsEndpoint}/`,
    keyName,
    key,
  };
}

/**
 * Load the Azure Notification Hubs configuration from the environment.
 *
 * Returns `null` (so callers can fall back to the direct providers) when the
 * connection string / hub name are absent or unparseable.
 *
 * @returns {{ endpoint: string, keyName: string, key: string, hubName: string, apiVersion: string } | null}
 */
function loadNotificationHubConfig(): { endpoint: string; keyName: string; key: string; hubName: string; apiVersion: string; } | null {
  const connectionString = process.env.AZURE_NOTIFICATION_HUB_CONNECTION_STRING?.trim();
  const hubName = process.env.AZURE_NOTIFICATION_HUB_NAME?.trim();
  if (!connectionString || !hubName) return null;

  const parsed = parseNotificationHubConnectionString(connectionString);
  if (!parsed) {
    console.warn(
      '[push] AZURE_NOTIFICATION_HUB_CONNECTION_STRING could not be parsed' +
        ' (expected Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…)'
    );
    return null;
  }

  return {
    ...parsed,
    hubName,
    apiVersion:
      process.env.AZURE_NOTIFICATION_HUB_API_VERSION?.trim() ||
      NOTIFICATION_HUB_DEFAULT_API_VERSION,
  };
}

/** @type {string|null} */
let _notificationHubToken: string | null = null;
let _notificationHubTokenExpiresAt = 0;
/** @type {string|null} */
let _notificationHubTokenUri: string | null = null;

/**
 * Reset the cached Notification Hubs SAS token.  Intended for tests so
 * credential changes between cases are not masked by the in-process cache.
 */
function _resetNotificationHubTokenCache() {
  _notificationHubToken = null;
  _notificationHubTokenExpiresAt = 0;
  _notificationHubTokenUri = null;
  _notificationHubUnconfiguredLogged = false;
}

/**
 * Build (or return cached) a Service Bus SAS token for the given resource URI.
 *
 * Format: `SharedAccessSignature sr={uri}&sig={sig}&se={expiry}&skn={keyName}`
 *
 * @param {{ keyName: string, key: string }} config
 * @param {string} uri - Resource URI the token grants access to.
 * @returns {string}
 */
function buildNotificationHubSasToken(config: { keyName: string; key: string; }, uri: string): string {
  const nowSecs = Math.floor(Date.now() / 1000);
  if (
    _notificationHubToken &&
    _notificationHubTokenUri === uri &&
    _notificationHubTokenExpiresAt - NOTIFICATION_HUB_TOKEN_SKEW_SECS > nowSecs
  ) {
    return _notificationHubToken;
  }

  const expiry = nowSecs + NOTIFICATION_HUB_TOKEN_TTL_SECS;
  const encodedUri = encodeURIComponent(uri);
  const signature = createHmac('sha256', config.key)
    .update(`${encodedUri}\n${expiry}`)
    .digest('base64');

  _notificationHubToken =
    `SharedAccessSignature sr=${encodedUri}` +
    `&sig=${encodeURIComponent(signature)}` +
    `&se=${expiry}` +
    `&skn=${encodeURIComponent(config.keyName)}`;
  _notificationHubTokenExpiresAt = expiry;
  _notificationHubTokenUri = uri;
  return _notificationHubToken;
}

// ─── Payload builders ─────────────────────────────────────────────────────────

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
 * Transport-neutral description of a push notification.
 */
export type PushEnvelope = { type: string; title: string; body: string; deepLink: string; data: Record<string, string>; ttlSeconds?: number; };

/**
 * Derive the push time-to-live from the time left in the ring window.
 *
 * A late-delivered call push must never ring a call that has already timed
 * out, so the TTL tracks the *remaining* ring time rather than a fixed value:
 * a push handed to the provider 100s into a 120s ring window expires in 20s,
 * exactly when the call does.  Falls back to
 * {@link INCOMING_CALL_TTL_SECONDS} when the caller supplied no timeout.
 *
 * @param {string|null|undefined} ringTimeoutAt - ISO 8601 ring deadline.
 * @returns {number} TTL in seconds (at least 1).
 */
function resolveCallTtlSeconds(ringTimeoutAt: string | null | undefined): number {
  if (!ringTimeoutAt) return INCOMING_CALL_TTL_SECONDS;
  const deadlineMs = new Date(ringTimeoutAt).getTime();
  if (!Number.isFinite(deadlineMs)) return INCOMING_CALL_TTL_SECONDS;
  return Math.max(1, Math.ceil((deadlineMs - Date.now()) / 1000));
}

/**
 * Describe an incoming call as a transport-neutral push envelope.
 *
 * @param {{ callId: string, callerId: string, ringTimeoutAt?: string|null }} callData
 * @returns {PushEnvelope}
 */
function buildCallEnvelope(callData: { callId: string; callerId: string; ringTimeoutAt?: string | null; }): PushEnvelope {
  return {
    type: 'call.incoming',
    ttlSeconds: resolveCallTtlSeconds(callData.ringTimeoutAt),
    title: 'Incoming call',
    body: `Call from ${callData.callerId}`,
    deepLink: `wetalk://call/${callData.callId}`,
    data: {
      callId: callData.callId,
      callerId: callData.callerId,
    },
  };
}

/**
 * Maximum number of characters of a message body carried in a push payload.
 * Long messages are truncated so the notification stays a preview and the
 * payload stays well inside the provider size limits.
 */
const MESSAGE_PREVIEW_MAX_LENGTH = 120;

/**
 * Describe a received text message as a transport-neutral push envelope.
 *
 * The title is the sender and the body a preview of what they wrote, because
 * the client renders this notification itself: message pushes are data-only
 * (see {@link buildDataBlock}), so whatever is not in `data` cannot be shown.
 *
 * @param {{
 *   messageId: string,
 *   conversationId: string,
 *   senderId: string,
 *   preview?: string | null,
 * }} messageData
 * @returns {PushEnvelope}
 */
function buildMessageEnvelope(messageData: {
        messageId: string;
        conversationId: string;
        senderId: string;
        preview?: string | null;
    }): PushEnvelope {
  const preview =
    typeof messageData.preview === 'string' ? messageData.preview.trim().replace(/\s+/g, ' ') : '';
  const truncated =
    preview.length > MESSAGE_PREVIEW_MAX_LENGTH
      ? `${preview.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1)}…`
      : preview;
  return {
    type: 'message.received',
    title: messageData.senderId,
    body: truncated || 'Sent you a message',
    deepLink: `wetalk://chat/${messageData.conversationId}`,
    data: {
      messageId: messageData.messageId,
      conversationId: messageData.conversationId,
      senderId: messageData.senderId,
    },
  };
}

/**
 * Describe a call that stopped ringing as a transport-neutral push envelope.
 *
 * Sent so a killed app — which has no socket and therefore never sees
 * `call.state_changed` — can dismiss the incoming-call notification it is
 * still showing for a call nobody can answer any more.
 *
 * @param {{ callId: string, reason?: string|null }} callData
 * @returns {PushEnvelope}
 */
function buildCallCancelledEnvelope(callData: { callId: string; reason?: string | null; }): PushEnvelope {
  return {
    type: 'call.cancelled',
    ttlSeconds: CANCELLED_CALL_TTL_SECONDS,
    title: 'Call ended',
    body: 'The call is no longer ringing',
    deepLink: `wetalk://call/${callData.callId}`,
    data: {
      callId: callData.callId,
      reason: callData.reason || 'ended',
    },
  };
}

/**
 * Build an APNs payload body for a push envelope.
 *
 * @param {PushEnvelope} envelope
 * @returns {string}
 */
function buildApnsEnvelopePayload(envelope: PushEnvelope): string {
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
 * Build the APNs payload for an incoming call.
 *
 * @param {{ callId: string, callerId: string, ringTimeoutAt?: string|null }} callData
 * @returns {string}
 */
function buildApnsPayload(callData: { callId: string; callerId: string; ringTimeoutAt?: string | null; }): string {
  return buildApnsEnvelopePayload(buildCallEnvelope(callData));
}

/**
 * Flatten an envelope into the string-valued `data` map shared by the direct
 * FCM v1 and Notification Hubs (`FcmV1`) wire formats.
 *
 * @param {PushEnvelope} envelope
 * @returns {Record<string, string>}
 */
function buildDataBlock(envelope: PushEnvelope): Record<string, string> {
  /** @type {Record<string, string>} */
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
 * Build an FCM HTTP v1 `messages:send` request body.
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
 *
 * @param {string} pushToken
 * @param {{ callId: string, callerId: string, ringTimeoutAt?: string|null }} callData
 * @returns {string}
 */
function buildFcmPayload(pushToken: string, callData: { callId: string; callerId: string; ringTimeoutAt?: string | null; }): string {
  const envelope = buildCallEnvelope(callData);
  return buildFcmEnvelopePayload(pushToken, envelope, { ttlSeconds: envelope.ttlSeconds });
}

/**
 * Build an FCM HTTP v1 `messages:send` request body from a push envelope.
 *
 * @param {string} pushToken
 * @param {PushEnvelope} envelope
 * @returns {string}
 */
function buildFcmEnvelopePayload(
  pushToken: string,
  envelope: PushEnvelope,
  /** @type {{ ttlSeconds?: number|null }} */ { ttlSeconds = null }: { ttlSeconds?: number | null; } = {}
): string {
  /** @type {Record<string, string>} */
  const apnsHeaders: Record<string, string> = { 'apns-priority': '10' };
  if (ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    apnsHeaders['apns-expiration'] = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  }
  return JSON.stringify({
    message: {
      token: pushToken,
      data: buildDataBlock(envelope),
      android: {
        priority: FCM_PRIORITY_HIGH,
        ...(ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0
          ? { ttl: `${ttlSeconds}s` }
          : {}),
      },
      apns: { headers: apnsHeaders },
    },
  });
}

/**
 * Build the Android (`FcmV1` format) body Notification Hubs forwards to FCM.
 *
 * Google retired the FCM *legacy* HTTP protocol (the `gcm` Notification Hubs
 * format) in June 2024; hubs configured with a Google (FCM v1) service-account
 * credential only accept the native FCM v1 `message` envelope — a legacy-shape
 * body matches no target application and the hub answers "no target
 * applications ... format is gcm" with a 400. As with {@link buildFcmPayload}
 * this is deliberately **data-only**: adding a `notification` block would
 * bypass the app's `setBackgroundMessageHandler` and break the CallKeep
 * full-screen incoming-call UI. The `token`/`topic`/`condition` target field
 * required by a standalone FCM v1 call is omitted — Notification Hubs routes
 * the message using the `ServiceBusNotification-DeviceHandle` header instead.
 *
 * @param {{ callId: string, callerId: string, ringTimeoutAt?: string|null }} callData
 * @returns {{ message: { android: { data: Record<string, string>, priority: string, ttl?: string } } }}
 */
function buildNotificationHubAndroidPayload(callData: { callId: string; callerId: string; ringTimeoutAt?: string | null; }): { message: { android: { data: Record<string, string>; priority: string; ttl?: string; }; }; } {
  const envelope = buildCallEnvelope(callData);
  return buildNotificationHubAndroidEnvelopePayload(envelope, {
    ttlSeconds: envelope.ttlSeconds,
  });
}

/**
 * @param {PushEnvelope} envelope
 * @returns {{ message: { android: { data: Record<string, string>, priority: string, ttl?: string } } }}
 */
function buildNotificationHubAndroidEnvelopePayload(
  envelope: PushEnvelope,
  /** @type {{ ttlSeconds?: number|null }} */ { ttlSeconds = null }: { ttlSeconds?: number | null; } = {}
): { message: { android: { data: Record<string, string>; priority: string; ttl?: string; }; }; } {
  return {
    message: {
      android: {
        data: buildDataBlock(envelope),
        priority: FCM_PRIORITY_HIGH,
        ...(ttlSeconds && Number.isFinite(ttlSeconds) && ttlSeconds > 0
          ? { ttl: `${ttlSeconds}s` }
          : {}),
      },
    },
  };
}

// ─── Single-attempt senders ───────────────────────────────────────────────────

/**
 * Perform one APNs HTTP/2 delivery attempt.
 *
 * @param {{ production?: boolean, bundleId: string, keyId: string, teamId: string, key: string }}
 *   config
 * @param {string} pushToken
 * @param {PushEnvelope} envelope
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
function sendApnsOnce(config: { production?: boolean; bundleId: string; keyId: string; teamId: string; key: string; }, pushToken: string, envelope: PushEnvelope): Promise<{ ok: boolean; statusCode?: number; reason?: string; }> {
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
    /** @type {number|undefined} */
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
 * @param {{ projectId: string, clientEmail: string, privateKey: string, tokenUri: string }}
 *   config
 * @param {string} pushToken
 * @param {PushEnvelope} envelope
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
async function sendFcmOnce(config: { projectId: string; clientEmail: string; privateKey: string; tokenUri: string; }, pushToken: string, envelope: PushEnvelope): Promise<{ ok: boolean; statusCode?: number; reason?: string; }> {
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
 *
 * @param {{ endpoint: string, keyName: string, key: string, hubName: string, apiVersion: string }} config
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {PushEnvelope} envelope
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string, headers?: Record<string, string>, trackingId?: string|null }>}
 */
function sendNotificationHubOnce(config: { endpoint: string; keyName: string; key: string; hubName: string; apiVersion: string; }, channel: { provider: string; pushToken: string; deviceId: string; }, envelope: PushEnvelope): Promise<{ ok: boolean; statusCode?: number; reason?: string; headers?: Record<string, string>; trackingId?: string | null; }> {
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
  /** @type {Record<string, string|number>} */
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
 * @param {Record<string, string|string[]|undefined>} [headers]
 * @returns {Record<string, string>} the `x-ms-*` headers, lower-cased.
 */
function extractNotificationHubCorrelationHeaders(headers: Record<string, string | string[] | undefined> = {}): Record<string, string> {
  /** @type {Record<string, string>} */
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith('x-ms-')) continue;
    output[lower] = Array.isArray(value) ? value.join(',') : String(value ?? '');
  }
  return output;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/**
 * Returns true when a failed result is likely transient and worth retrying.
 *
 * @param {{ statusCode?: number } | null | undefined} result
 */
function isRetryable(result: { statusCode?: number; } | null | undefined) {
  const sc = result?.statusCode;
  // No status (network error), rate-limited, or server-side error
  return !sc || sc === 429 || sc >= 500;
}

/**
 * Status codes that can carry a dead-token (unregistered / malformed) reason.
 * Both FCM's direct HTTP v1 path and Azure Notification Hubs' `FcmV1` direct
 * send relay these same underlying codes/reasons, so the same check applies
 * to either transport.
 */
const DEAD_TOKEN_STATUS_CODES = new Set([404, 400]);
/**
 * Matches FCM HTTP v1's canonical error-status enum values for a dead token
 * (`UNREGISTERED` for a 404, `INVALID_ARGUMENT` for a malformed token on a
 * 400) — see https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode
 * — plus common human-readable variants Notification Hubs or APNs may wrap
 * the same underlying failure in.
 */
const DEAD_TOKEN_REASON_PATTERN =
  /unregistered|invalid_argument|invalid.*registration.*token|baddevicetoken/i;

/**
 * Determine whether a failed delivery result indicates the push token itself
 * is dead (the app was uninstalled / the token was rotated away) rather than
 * a transient failure. Dead-token results must never be retried and must
 * cause the offending device row to be pruned so it stops silently
 * swallowing future pushes.
 *
 * @param {{ ok: boolean, statusCode?: number, reason?: string } | null | undefined} result
 * @returns {boolean}
 */
function isDeadTokenResult(result: { ok: boolean; statusCode?: number; reason?: string; } | null | undefined): boolean {
  if (!result || result.ok) return false;
  if (result.statusCode === undefined) return false;
  if (!DEAD_TOKEN_STATUS_CODES.has(result.statusCode)) return false;
  return typeof result.reason === 'string' && DEAD_TOKEN_REASON_PATTERN.test(result.reason);
}

/**
 * Call `fn` up to MAX_ATTEMPTS times, backing off exponentially on transient
 * failures.
 *
 * @param {() => Promise<{ ok: boolean, statusCode?: number, reason?: string }>} fn
 * @param {string} label - Used in log messages.
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
async function withRetry(fn: () => Promise<{ ok: boolean; statusCode?: number; reason?: string; }>, label: string): Promise<{ ok: boolean; statusCode?: number; reason?: string; }> {
  /** @type {{ ok: boolean, statusCode?: number, reason?: string }|undefined} */
  let last: { ok: boolean; statusCode?: number; reason?: string; } | undefined;
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
      last = { ok: false, reason: errorMessage(error) };
      console.error(
        `[push] ${label} attempt ${attempt}/${MAX_ATTEMPTS} threw: ${errorMessage(error)}`
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  return last ?? { ok: false };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Tracks whether the "Notification Hub not configured" note was already logged. */
let _notificationHubUnconfiguredLogged = false;

function logNotificationHubNotConfigured() {
  if (_notificationHubUnconfiguredLogged) return;
  _notificationHubUnconfiguredLogged = true;
  console.log(
    '[push] Notification Hub not configured' +
      ' (set AZURE_NOTIFICATION_HUB_CONNECTION_STRING and AZURE_NOTIFICATION_HUB_NAME);' +
      ' using direct APNs/FCM delivery'
  );
}

function logNotificationHubStartupStatus() {
  if (!loadNotificationHubConfig()) {
    logNotificationHubNotConfigured();
  }
}

/**
 * Attempt delivery through Azure Notification Hubs.
 *
 * Returns `{ ok: false, reason: 'notification_hub_not_configured' }` without any
 * network traffic (and without log spam) when ANH is not configured, so callers
 * can fall straight through to the direct provider path.
 *
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {PushEnvelope} envelope
 * @param {string} label
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
async function tryNotificationHub(channel: { provider: string; pushToken: string; deviceId: string; }, envelope: PushEnvelope, label: string): Promise<{ ok: boolean; statusCode?: number; reason?: string; }> {
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
 * Deliver a push envelope to one device.
 *
 * Provider chain: Azure Notification Hubs (when configured) → direct APNs / FCM
 * → skip.  Never throws; unconfigured providers resolve with a
 * `*_not_configured` reason.
 *
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {PushEnvelope} envelope
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: 'notification_hub'|'direct',
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken: boolean
 * }>}
 */
async function deliverPush(channel: { provider: string; pushToken: string; deviceId: string; }, envelope: PushEnvelope): Promise<{
    ok: boolean;
    provider: string;
    deviceId: string;
    transport: 'notification_hub' | 'direct';
    statusCode?: number;
    reason?: string;
    trackingId?: string | null;
    deadToken: boolean;
}> {
  const { provider, pushToken, deviceId } = channel;
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
 * Log the outcome of a delivery attempt for operational visibility.
 *
 * @param {{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: string,
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken?: boolean,
 * }} outcome
 * @param {string} description - Event description, e.g. `call.incoming callId=…`.
 */
function logDeliveryOutcome(outcome: {
        ok: boolean;
        provider: string;
        deviceId: string;
        transport: string;
        statusCode?: number;
        reason?: string;
        trackingId?: string | null;
        deadToken?: boolean;
    }, description: string) {
  if (outcome.ok) {
    if (outcome.transport === 'notification_hub') {
      console.log(
        `[push] Accepted by hub ${description}` +
          ` via ${outcome.provider} to device=${outcome.deviceId}` +
          ` status=${outcome.statusCode ?? 'N/A'}` +
          ` trackingId=${outcome.trackingId ?? 'N/A'}`
      );
    } else {
      console.log(
        `[push] Accepted by provider ${description}` +
          ` via ${outcome.provider} to device=${outcome.deviceId}` +
          ` status=${outcome.statusCode ?? 'N/A'}`
      );
    }
    return;
  }
  console.error(
    `[push] Failed to deliver ${description}` +
      ` via ${outcome.provider} to device=${outcome.deviceId}` +
      ` status=${outcome.statusCode ?? 'N/A'} reason=${outcome.reason ?? 'unknown'}` +
      (outcome.deadToken ? ' deadToken=true' : '')
  );
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
 *
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {{ callId: string, callerId: string, ringTimeoutAt?: string|null }} callData
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: 'notification_hub'|'direct',
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken: boolean
 * }>}
 */
async function sendIncomingCallPush(channel: { provider: string; pushToken: string; deviceId: string; }, callData: { callId: string; callerId: string; ringTimeoutAt?: string | null; }): Promise<{
    ok: boolean;
    provider: string;
    deviceId: string;
    transport: 'notification_hub' | 'direct';
    statusCode?: number;
    reason?: string;
    trackingId?: string | null;
    deadToken: boolean;
}> {
  const outcome = await deliverPush(channel, buildCallEnvelope(callData));
  logDeliveryOutcome(outcome, `call.incoming callId=${callData.callId}`);
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
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {{
 *   messageId: string,
 *   conversationId: string,
 *   senderId: string,
 *   preview?: string | null,
 * }} messageData
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: 'notification_hub'|'direct',
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken: boolean
 * }>}
 */
/**
 * Tell a device that a call stopped ringing so it can dismiss the stale
 * incoming-call notification even with no socket connected.  Never throws.
 *
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {{ callId: string, reason?: string|null }} callData
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: 'notification_hub'|'direct',
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken: boolean
 * }>} delivery outcome, see {@link sendIncomingCallPush}
 */
async function sendCallCancelledPush(channel: { provider: string; pushToken: string; deviceId: string; }, callData: { callId: string; reason?: string | null; }): Promise<{
    ok: boolean;
    provider: string;
    deviceId: string;
    transport: 'notification_hub' | 'direct';
    statusCode?: number;
    reason?: string;
    trackingId?: string | null;
    deadToken: boolean;
}> {
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
 * @param {{ provider: string, pushToken: string, deviceId: string }} channel
 * @param {{
 *   messageId: string,
 *   conversationId: string,
 *   senderId: string,
 *   preview?: string | null,
 * }} messageData
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   transport: 'notification_hub'|'direct',
 *   statusCode?: number,
 *   reason?: string,
 *   trackingId?: string|null,
 *   deadToken: boolean
 * }>}
 */
async function sendMessagePush(channel: { provider: string; pushToken: string; deviceId: string; }, messageData: {
        messageId: string;
        conversationId: string;
        senderId: string;
        preview?: string | null;
    }): Promise<{
    ok: boolean;
    provider: string;
    deviceId: string;
    transport: 'notification_hub' | 'direct';
    statusCode?: number;
    reason?: string;
    trackingId?: string | null;
    deadToken: boolean;
}> {
  const outcome = await deliverPush(channel, buildMessageEnvelope(messageData));
  logDeliveryOutcome(outcome, `message.received messageId=${messageData.messageId}`);
  return outcome;
}

const _buildFcmMessagePayload = (pushToken: string, messageData: any) =>
  buildFcmEnvelopePayload(pushToken, buildMessageEnvelope(messageData));

const _buildNotificationHubAndroidMessagePayload = (messageData: any) =>
  buildNotificationHubAndroidEnvelopePayload(buildMessageEnvelope(messageData));

/**
 * Mutable indirection for the three senders. Callers go through this object so
 * tests can swap an individual sender at runtime: ES module namespaces are
 * read-only, so the object property is what keeps the seam patchable.
 */
const pushSenders: {
  sendIncomingCallPush: (channel: any, callData: any) => Promise<any>;
  sendCallCancelledPush: (channel: any, callData: any) => Promise<any>;
  sendMessagePush: (channel: any, messageData: any) => Promise<any>;
} = {
  sendIncomingCallPush,
  sendCallCancelledPush,
  sendMessagePush,
};

export {
  pushSenders,
  sendIncomingCallPush,
  sendCallCancelledPush,
  sendMessagePush,
  logNotificationHubStartupStatus,
  // Exported for unit tests.
  _resetFcmTokenCache,
  loadFcmConfig as _loadFcmConfig,
  buildFcmPayload as _buildFcmPayload,
  _buildFcmMessagePayload,
  _resetNotificationHubTokenCache,
  loadNotificationHubConfig as _loadNotificationHubConfig,
  buildNotificationHubSasToken as _buildNotificationHubSasToken,
  buildNotificationHubAndroidPayload as _buildNotificationHubAndroidPayload,
  buildCallCancelledEnvelope as _buildCallCancelledEnvelope,
  resolveCallTtlSeconds as _resolveCallTtlSeconds,
  _buildNotificationHubAndroidMessagePayload,
  isDeadTokenResult as _isDeadTokenResult,
};
