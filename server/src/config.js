'use strict';

/**
 * Centralised, validated runtime configuration for the signaling server.
 *
 * Reading environment variables in one place (with sane defaults and fail-fast
 * validation) keeps the rest of the codebase free of `process.env` lookups and
 * makes the operational surface easy to document and test.
 */

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_MAX_ROOM_SIZE = 2;
const DEFAULT_TURN_TTL_SECONDS = 86400;

/**
 * Parse a positive integer from an environment value, falling back to a default.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, received "${raw}"`);
  }
  return value;
}

/**
 * Resolve the CORS origin policy.
 *
 * - `*` (or unset in non-production) → allow any origin.
 * - A comma-separated list → that explicit allow-list.
 * - Unset in production → empty allow-list (reject browser origins) plus a warning.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {(msg: string) => void} warn
 * @returns {string | string[]}
 */
function resolveCorsOrigin(env, warn) {
  const raw = env.CORS_ORIGIN?.trim();
  if (raw) {
    return raw === '*' ? raw : raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.NODE_ENV === 'production') {
    warn('[signaling] CORS_ORIGIN is not set; rejecting browser origins in production.');
    return [];
  }
  return '*';
}

/**
 * Resolve the TURN credential-provisioning policy.
 *
 * When `TURN_SECRET` and `TURN_URLS` are both set the server can mint
 * short-lived TURN credentials using coturn's `use-auth-secret` (REST API)
 * scheme. When either is missing the `/turn-credentials` endpoint is disabled.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ enabled: boolean, secret: string|null, urls: string[], ttlSeconds: number }}
 */
function resolveTurn(env) {
  const secret = env.TURN_SECRET?.trim() || null;
  const urls = (env.TURN_URLS?.trim() || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ttlSeconds = parsePositiveInt(env.TURN_TTL_SECONDS, DEFAULT_TURN_TTL_SECONDS, 'TURN_TTL_SECONDS');
  return {
    enabled: Boolean(secret && urls.length > 0),
    secret,
    urls,
    ttlSeconds,
  };
}

/**
 * Build the validated configuration object.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {(msg: string) => void} [warn=console.warn]
 * @returns {{ port: number, host: string, maxRoomSize: number, corsOrigin: string|string[], redisUrl: string|null, sentryDsn: string|null, environment: string, instanceId: string, turn: object }}
 */
function loadConfig(env = process.env, warn = console.warn) {
  return {
    port: parsePositiveInt(env.PORT, DEFAULT_PORT, 'PORT'),
    host: env.HOST?.trim() || DEFAULT_HOST,
    maxRoomSize: parsePositiveInt(env.MAX_ROOM_SIZE, DEFAULT_MAX_ROOM_SIZE, 'MAX_ROOM_SIZE'),
    corsOrigin: resolveCorsOrigin(env, warn),
    // Horizontal scaling: when set, Socket.IO fans events out across instances
    // via the Redis adapter so multiple replicas can serve the same rooms.
    redisUrl: env.REDIS_URL?.trim() || null,
    // Telemetry: when set, errors are reported to Sentry.
    sentryDsn: env.SENTRY_DSN?.trim() || null,
    environment: env.NODE_ENV?.trim() || 'development',
    instanceId: env.INSTANCE_ID?.trim() || env.RENDER_INSTANCE_ID?.trim() || `local-${process.pid}`,
    turn: resolveTurn(env),
  };
}

module.exports = {
  loadConfig,
  parsePositiveInt,
  resolveCorsOrigin,
  resolveTurn,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_MAX_ROOM_SIZE,
  DEFAULT_TURN_TTL_SECONDS,
};
