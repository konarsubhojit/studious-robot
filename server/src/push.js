'use strict';

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
 *        APNS_BUNDLE_ID   App bundle ID (e.g. com.tcalling)
 *        APNS_PRODUCTION  Set to 'true' to use the production gateway
 *
 *  FCM   FCM_SERVICE_ACCOUNT_JSON  Firebase service-account credentials (JSON
 *                                  string, or a path to the JSON file).  Used to
 *                                  mint an OAuth2 access token for the FCM HTTP
 *                                  v1 API (`messages:send`).
 */

const fs = require('fs');
const http2 = require('http2');
const https = require('https');
const { createSign } = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const APNS_HOST_SANDBOX    = 'api.sandbox.push.apple.com';
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

// ─── APNs JWT cache ───────────────────────────────────────────────────────────

let _apnsJwt = null;
let _apnsJwtExpiresAt = 0;

/**
 * Build (or return cached) an ES256 JWT for APNs provider authentication.
 *
 * @param {{ keyId: string, teamId: string, key: string }} config
 * @returns {string}
 */
function buildApnsJwt(config) {
  const nowSecs = Math.floor(Date.now() / 1000);
  if (_apnsJwt && _apnsJwtExpiresAt > nowSecs) {
    return _apnsJwt;
  }

  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims  = Buffer.from(JSON.stringify({ iss: config.teamId, iat: nowSecs })).toString('base64url');
  const unsigned = `${header}.${claims}`;

  const signer = createSign('SHA256');
  signer.update(unsigned);
  // ieee-p1363 encoding produces the fixed-length R||S format required by JWT.
  // This option is available since Node.js 13; this project requires Node >= 22.
  const sig = signer
    .sign({ key: config.key, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  _apnsJwt = `${unsigned}.${sig}`;
  _apnsJwtExpiresAt = nowSecs + APNS_TOKEN_TTL_SECS;
  return _apnsJwt;
}

// ─── FCM OAuth2 access-token cache ─────────────────────────────────────────────

let _fcmAccessToken = null;
let _fcmAccessTokenExpiresAt = 0;
let _fcmAccessTokenEmail = null;

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
function buildFcmAssertion(config) {
  const nowSecs = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: config.clientEmail,
    scope: FCM_SEND_SCOPE,
    aud: config.tokenUri,
    iat: nowSecs,
    exp: nowSecs + 3600,
  })).toString('base64url');
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
function requestFcmAccessToken(config) {
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
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          const statusCode = res.statusCode;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = {}; }
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
      },
    );
    req.on('error', reject);
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
async function getFcmAccessToken(config) {
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
    _fcmAccessToken = result.accessToken;
    _fcmAccessTokenEmail = config.clientEmail;
    _fcmAccessTokenExpiresAt = nowSecs + FCM_TOKEN_TTL_SECS;
  }
  return result;
}

// ─── Config loaders ───────────────────────────────────────────────────────────

function loadApnsConfig() {
  const key      = process.env.APNS_KEY?.trim();
  const keyId    = process.env.APNS_KEY_ID?.trim();
  const teamId   = process.env.APNS_TEAM_ID?.trim();
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
function loadFcmConfig() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  let json = raw;
  // Allow pointing at a file on disk instead of inlining the JSON.
  if (!raw.startsWith('{')) {
    try {
      json = fs.readFileSync(raw, 'utf8');
    } catch (error) {
      console.warn(`[push] FCM service account file unreadable: ${error?.message}`);
      return null;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    console.warn(`[push] FCM service account JSON is invalid: ${error?.message}`);
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

// ─── Payload builders ─────────────────────────────────────────────────────────

function buildApnsPayload(callData) {
  return JSON.stringify({
    aps: {
      alert: {
        title: 'Incoming call',
        body: `Call from ${callData.callerId}`,
      },
      sound: 'default',
      badge: 1,
      'content-available': 1,
    },
    callId: callData.callId,
    callerId: callData.callerId,
    type: 'call.incoming',
    deepLink: `tcalling://call/${callData.callId}`,
  });
}

/**
 * Build an FCM HTTP v1 `messages:send` request body.
 *
 * v1 requires all `data` values to be strings; the notification block is sent
 * separately so the OS renders a system notification while `data` carries the
 * deep-link payload the app consumes.
 *
 * @param {string} pushToken
 * @param {{ callId: string, callerId: string }} callData
 * @returns {string}
 */
function buildFcmPayload(pushToken, callData) {
  return JSON.stringify({
    message: {
      token: pushToken,
      notification: {
        title: 'Incoming call',
        body: `Call from ${callData.callerId}`,
      },
      data: {
        callId: String(callData.callId),
        callerId: String(callData.callerId),
        type: 'call.incoming',
        deepLink: `tcalling://call/${callData.callId}`,
      },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } },
    },
  });
}

// ─── Single-attempt senders ───────────────────────────────────────────────────

/**
 * Perform one APNs HTTP/2 delivery attempt.
 *
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
function sendApnsOnce(config, pushToken, callData) {
  const host    = config.production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
  const jwt     = buildApnsJwt(config);
  const payload = buildApnsPayload(callData);
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
    let statusCode;

    req.on('response', (headers) => { statusCode = Number(headers[':status']); });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      client.close();
      if (statusCode === 200) {
        resolve({ ok: true, statusCode });
        return;
      }
      let reason = 'unknown';
      try { reason = JSON.parse(body)?.reason ?? 'unknown'; } catch { /* ignore */ }
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
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
async function sendFcmOnce(config, pushToken, callData) {
  const token = await getFcmAccessToken(config);
  if (!token.ok) {
    // Treat token-endpoint 5xx/429 (or network errors) as retryable; other
    // failures surface their status so withRetry can short-circuit.
    return { ok: false, statusCode: token.statusCode ?? null, reason: token.reason ?? 'token_error' };
  }

  const payload    = buildFcmPayload(pushToken, callData);
  const payloadLen = Buffer.byteLength(payload);
  const path       = `/v1/projects/${config.projectId}/messages:send`;

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
        res.on('data', (chunk) => { body += chunk; });
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
          } catch { /* ignore */ }
          resolve({ ok: false, statusCode, reason });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

/**
 * Returns true when a failed result is likely transient and worth retrying.
 *
 * @param {{ statusCode?: number } | null | undefined} result
 */
function isRetryable(result) {
  const sc = result?.statusCode;
  // No status (network error), rate-limited, or server-side error
  return !sc || sc === 429 || sc >= 500;
}

/**
 * Call `fn` up to MAX_ATTEMPTS times, backing off exponentially on transient
 * failures.
 *
 * @param {() => Promise<{ ok: boolean, statusCode?: number, reason?: string }>} fn
 * @param {string} label - Used in log messages.
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
async function withRetry(fn, label) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fn();
      if (result.ok) return result;

      if (!isRetryable(result)) {
        console.warn(
          `[push] ${label} non-retryable failure` +
          ` status=${result.statusCode} reason=${result.reason ?? 'unknown'}`,
        );
        return result;
      }

      last = result;
      console.warn(`[push] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed status=${result.statusCode}`);
    } catch (error) {
      last = { ok: false, statusCode: null, reason: error?.message };
      console.error(`[push] ${label} attempt ${attempt}/${MAX_ATTEMPTS} threw: ${error?.message}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1))));
    }
  }
  return last ?? { ok: false };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an incoming-call push notification via APNs or FCM.
 *
 * - Skips gracefully when the provider is not configured.
 * - Retries up to MAX_ATTEMPTS times on transient network / server errors.
 * - Logs every delivery outcome (success or failure) for operational visibility.
 * - Never throws.
 *
 * @param {{ provider: 'apns'|'fcm', pushToken: string, deviceId: string }} channel
 * @param {{ callId: string, callerId: string }} callData
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string,
 *   deviceId: string,
 *   statusCode?: number,
 *   reason?: string
 * }>}
 */
async function sendIncomingCallPush(channel, callData) {
  const { provider, pushToken, deviceId } = channel;
  const label = `${provider}:${deviceId}`;

  let result;

  if (provider === 'apns') {
    const config = loadApnsConfig();
    if (!config) {
      console.warn(
        `[push] APNs not configured` +
        ` (set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID); skip ${deviceId}`,
      );
      return { ok: false, provider, deviceId, reason: 'apns_not_configured' };
    }
    result = await withRetry(() => sendApnsOnce(config, pushToken, callData), label);
  } else if (provider === 'fcm') {
    const config = loadFcmConfig();
    if (!config) {
      console.warn(`[push] FCM not configured (set FCM_SERVICE_ACCOUNT_JSON); skip ${deviceId}`);
      return { ok: false, provider, deviceId, reason: 'fcm_not_configured' };
    }
    result = await withRetry(() => sendFcmOnce(config, pushToken, callData), label);
  } else {
    console.warn(`[push] Unknown provider "${provider}" for device ${deviceId}`);
    return { ok: false, provider, deviceId, reason: 'unknown_provider' };
  }

  const outcome = { provider, deviceId, ...result };
  if (outcome.ok) {
    console.log(
      `[push] Delivered call.incoming callId=${callData.callId}` +
      ` via ${provider} to device=${deviceId}`,
    );
  } else {
    console.error(
      `[push] Failed to deliver call.incoming callId=${callData.callId}` +
      ` via ${provider} to device=${deviceId}` +
      ` status=${outcome.statusCode ?? 'N/A'} reason=${outcome.reason ?? 'unknown'}`,
    );
  }
  return outcome;
}

module.exports = {
  sendIncomingCallPush,
  // Exported for unit tests.
  _resetFcmTokenCache,
  _loadFcmConfig: loadFcmConfig,
  _buildFcmPayload: buildFcmPayload,
};
