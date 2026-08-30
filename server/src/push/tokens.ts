/**
 * Provider authentication: the three credentials a push send needs, and the
 * caches that stop every send from re-minting them.
 *
 *  - APNs           — an ES256 provider JWT, valid an hour.
 *  - FCM HTTP v1    — an OAuth2 access token, exchanged for a signed RS256
 *                     service-account assertion.
 *  - Notification   — a Service Bus SAS token scoped to the hub resource.
 *    Hubs
 *
 * The caches are module-level singletons, exactly as they were when this lived
 * in `push.ts`; the `_reset*` helpers exist so a test changing credentials is
 * not silently served the previous tenant's token.
 */

import https from 'https';
import { createSign, createHmac } from 'crypto';
import { resetNotificationHubUnconfiguredLog } from './credentials.ts';
import type {
  AccessTokenResult,
  ApnsConfig,
  FcmTokenCredentials,
  NotificationHubCredentials,
} from './types.ts';

/** OAuth2 scope required to send messages via the FCM HTTP v1 API. */
const FCM_SEND_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Google access tokens last ~1 hour; refresh a little early. */
const FCM_TOKEN_TTL_SECS = 3300; // 55 minutes
/** Skew applied to the cached-token expiry check, in seconds. */
const FCM_TOKEN_SKEW_SECS = 60;

/** APNs provider tokens are valid for 1 hour; refresh after 50 minutes. */
const APNS_TOKEN_TTL_SECS = 50 * 60;

/** Lifetime of a generated Notification Hubs SAS token. */
const NOTIFICATION_HUB_TOKEN_TTL_SECS = 60 * 60;
/** Skew applied to the cached SAS-token expiry check, in seconds. */
const NOTIFICATION_HUB_TOKEN_SKEW_SECS = 60;

// ─── APNs JWT cache ───────────────────────────────────────────────────────────

let _apnsJwt: string | null = null;
let _apnsJwtExpiresAt = 0;

/**
 * Build (or return cached) an ES256 JWT for APNs provider authentication.
 */
export function buildApnsJwt(config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'key'>): string {
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

let _fcmAccessToken: string | null = null;
let _fcmAccessTokenExpiresAt = 0;
let _fcmAccessTokenEmail: string | null = null;

/**
 * Reset the cached FCM access token.  Intended for tests so credential changes
 * between cases are not masked by the in-process cache.
 */
export function _resetFcmTokenCache(): void {
  _fcmAccessToken = null;
  _fcmAccessTokenExpiresAt = 0;
  _fcmAccessTokenEmail = null;
}

/**
 * Build a signed RS256 JWT asserting the service-account identity, used to
 * exchange for an OAuth2 access token at the service account's `token_uri`.
 */
function buildFcmAssertion(config: FcmTokenCredentials): string {
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
 */
function requestFcmAccessToken(config: FcmTokenCredentials): Promise<AccessTokenResult> {
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
 */
export async function getFcmAccessToken(config: FcmTokenCredentials): Promise<AccessTokenResult> {
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

// ─── Notification Hubs SAS-token cache ────────────────────────────────────────

let _notificationHubToken: string | null = null;
let _notificationHubTokenExpiresAt = 0;
let _notificationHubTokenUri: string | null = null;

/**
 * Reset the cached Notification Hubs SAS token.  Intended for tests so
 * credential changes between cases are not masked by the in-process cache.
 */
export function _resetNotificationHubTokenCache(): void {
  _notificationHubToken = null;
  _notificationHubTokenExpiresAt = 0;
  _notificationHubTokenUri = null;
  resetNotificationHubUnconfiguredLog();
}

/**
 * Build (or return cached) a Service Bus SAS token for the given resource URI.
 *
 * Format: `SharedAccessSignature sr={uri}&sig={sig}&se={expiry}&skn={keyName}`
 *
 * @param uri - Resource URI the token grants access to.
 */
export function buildNotificationHubSasToken(
  config: Pick<NotificationHubCredentials, 'keyName' | 'key'>,
  uri: string
): string {
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
