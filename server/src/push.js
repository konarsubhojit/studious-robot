'use strict';

/**
 * Push notification delivery for incoming calls.
 *
 * Supports APNs (Apple Push Notification service) via HTTP/2 and FCM (Firebase
 * Cloud Messaging) via the Legacy HTTP API.  Both providers are env-gated and
 * fail gracefully with console diagnostics when credentials are absent.
 *
 * Configuration env vars
 * ──────────────────────
 *  APNs  APNS_KEY         PEM-encoded EC private key (.p8 file contents)
 *        APNS_KEY_ID      10-character key identifier
 *        APNS_TEAM_ID     10-character Apple team identifier
 *        APNS_BUNDLE_ID   App bundle ID (e.g. com.tcalling)
 *        APNS_PRODUCTION  Set to 'true' to use the production gateway
 *
 *  FCM   FCM_SERVER_KEY   Legacy server key from the Firebase console
 */

const http2 = require('http2');
const https = require('https');
const { createSign } = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const APNS_HOST_SANDBOX    = 'api.sandbox.push.apple.com';
const APNS_HOST_PRODUCTION = 'api.push.apple.com';

const FCM_HOST = 'fcm.googleapis.com';
const FCM_PATH = '/fcm/send';

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

  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId  })).toString('base64url');
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

function loadFcmConfig() {
  const serverKey = process.env.FCM_SERVER_KEY?.trim();
  return serverKey ? { serverKey } : null;
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

function buildFcmPayload(pushToken, callData) {
  return JSON.stringify({
    to: pushToken,
    priority: 'high',
    notification: {
      title: 'Incoming call',
      body: `Call from ${callData.callerId}`,
    },
    data: {
      callId: callData.callId,
      callerId: callData.callerId,
      type: 'call.incoming',
      deepLink: `tcalling://call/${callData.callId}`,
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
 * Perform one FCM Legacy HTTP delivery attempt.
 *
 * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string }>}
 */
function sendFcmOnce(config, pushToken, callData) {
  const payload    = buildFcmPayload(pushToken, callData);
  const payloadLen = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: FCM_HOST,
        path: FCM_PATH,
        method: 'POST',
        headers: {
          Authorization: `key=${config.serverKey}`,
          'Content-Type': 'application/json',
          'Content-Length': payloadLen,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const statusCode = res.statusCode;
          if (statusCode !== 200) {
            resolve({ ok: false, statusCode });
            return;
          }
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = {}; }
          const reason = parsed.results?.[0]?.error;
          resolve(reason ? { ok: false, statusCode, reason } : { ok: true, statusCode });
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
      console.warn(`[push] FCM not configured (set FCM_SERVER_KEY); skip ${deviceId}`);
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

module.exports = { sendIncomingCallPush };
