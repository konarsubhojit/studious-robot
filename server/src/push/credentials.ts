/**
 * Push provider configuration: reading credentials out of the environment and
 * reporting, once, when a provider is not configured.
 *
 * Nothing here performs I/O beyond reading `process.env` (and, for FCM, the
 * service-account file the variable may point at), so every loader is
 * exercisable from a test by setting variables.
 */

import fs from 'fs';
import { describeError } from '../lib/errors.ts';
import type {
  ApnsConfig,
  FcmConfig,
  NotificationHubConfig,
  NotificationHubCredentials,
} from './types.ts';

/** Default Google OAuth2 token endpoint (overridden by the SA `token_uri`). */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Default Notification Hubs REST api-version.
 *
 * `2015-04` is the latest api-version documented for the data-plane
 * `/messages/?direct` (direct send) operation — later dated versions exist for
 * the management plane (hub CRUD) but do not apply here. It is required (not
 * merely sufficient) for `FcmV1`-format sends.
 */
const NOTIFICATION_HUB_DEFAULT_API_VERSION = '2015-04';

export function loadApnsConfig(): ApnsConfig | null {
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
 */
export function loadFcmConfig(): FcmConfig | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  let json = raw;
  // Allow pointing at a file on disk instead of inlining the JSON.
  if (!raw.startsWith('{')) {
    try {
      json = fs.readFileSync(raw, 'utf8');
    } catch (error) {
      console.warn(`[push] FCM service account file unreadable: ${describeError(error)}`);
      return null;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    console.warn(`[push] FCM service account JSON is invalid: ${describeError(error)}`);
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

/**
 * Parse an Azure Service Bus / Notification Hubs connection string.
 *
 * Expected shape:
 *   `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=…;SharedAccessKey=…`
 */
export function parseNotificationHubConnectionString(
  connectionString: string
): NotificationHubCredentials | null {
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
 */
export function loadNotificationHubConfig(): NotificationHubConfig | null {
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

/** Tracks whether the "Notification Hub not configured" note was already logged. */
let _notificationHubUnconfiguredLogged = false;

export function logNotificationHubNotConfigured(): void {
  if (_notificationHubUnconfiguredLogged) return;
  _notificationHubUnconfiguredLogged = true;
  console.log(
    '[push] Notification Hub not configured' +
      ' (set AZURE_NOTIFICATION_HUB_CONNECTION_STRING and AZURE_NOTIFICATION_HUB_NAME);' +
      ' using direct APNs/FCM delivery'
  );
}

/** Re-arm the once-only "not configured" note.  Intended for tests. */
export function resetNotificationHubUnconfiguredLog(): void {
  _notificationHubUnconfiguredLogged = false;
}

export function logNotificationHubStartupStatus(): void {
  if (!loadNotificationHubConfig()) {
    logNotificationHubNotConfigured();
  }
}
