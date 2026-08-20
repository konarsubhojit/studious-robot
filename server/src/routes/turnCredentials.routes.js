// @ts-check
'use strict';

const express = require('express');
const { API_ROUTES } = require('../../../shared');
const { getSessionFromRequest } = require('../lib/auth');

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TURN_URLS = [
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp',
];

/**
 * An ICE server entry as returned to clients.
 *
 * @typedef {{ urls: string|string[], username?: string, credential?: string }} IceServer
 */

/**
 * Cached Cloudflare-minted credentials, refreshed shortly before they expire.
 *
 * @typedef {{ iceServers: IceServer[], expiresAt: Date, refreshAt: number }} TurnCache
 */

/**
 * Ensure a public STUN server is present alongside the TURN relays.
 *
 * @param {IceServer[]} iceServers
 * @returns {IceServer[]}
 */
function withStunServer(iceServers) {
  const hasStun = iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === 'string' && url.startsWith('stun:'));
  });
  return hasStun ? iceServers : [{ urls: ['stun:stun.l.google.com:19302'] }, ...iceServers];
}

/**
 * Build the fallback ICE server list from static env configuration.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {IceServer[]}
 */
function getStaticIceServers(env) {
  if (!env.TURN_USERNAME || !env.TURN_CREDENTIAL) {
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  const urls = env.TURN_URL
    ? env.TURN_URL.split(',').map((url) => url.trim()).filter(Boolean)
    : DEFAULT_TURN_URLS;
  return [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
  ];
}

/**
 * Coerce a configured credential TTL, falling back to the default.
 *
 * @param {unknown} value
 * @returns {number} TTL in seconds.
 */
function getTtlSeconds(value) {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
}

/**
 * Accept the several shapes the Cloudflare API may return and normalise them
 * to a flat ICE server list.
 *
 * @param {unknown} payload
 * @returns {IceServer[]}
 */
function normalizeIceServers(payload) {
  if (Array.isArray(payload)) return payload;
  const iceServers = /** @type {{ iceServers?: unknown }} */ (payload ?? {}).iceServers;
  if (Array.isArray(iceServers)) return iceServers;
  if (iceServers && typeof iceServers === 'object') {
    return [/** @type {IceServer} */ (iceServers)];
  }
  return [];
}

/**
 * `GET /turn-credentials` – mint short-lived TURN credentials (Cloudflare when
 * configured), falling back to static TURN/STUN configuration.
 *
 * @param {{
 *   state: import('../stores/contracts').ServerState,
 *   fetchImpl?: typeof fetch,
 *   env?: Record<string, string|undefined>,
 * }} ctx
 * @returns {import('express').Router}
 */
function createTurnCredentialsRouter({ state, fetchImpl = fetch, env = process.env }) {
  const router = express.Router();
  /** @type {TurnCache|null} */
  let cache = null;

  router.get(API_ROUTES.TURN_CREDENTIALS, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const session = getSessionFromRequest(req, state.sessions);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }

    const rateCheck = state.turnCredentialsRateLimiter.check(session.userId);
    if (!rateCheck.allowed) {
      state.auditLog.record({
        event: 'turn_credentials.rate_limited',
        actor: session.userId,
        outcome: 'rejected',
      });
      res.status(429).json({
        error: 'too many requests',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
      });
      return;
    }

    const keyId = env.CLOUDFLARE_TURN_KEY_ID;
    const apiToken = env.CLOUDFLARE_TURN_API_TOKEN;
    const now = Date.now();
    if (keyId && apiToken) {
      if (cache && cache.refreshAt > now) {
        res.set('X-Turn-Credential-Expires-At', cache.expiresAt.toISOString());
        res.json(cache.iceServers);
        return;
      }

      try {
        const ttl = getTtlSeconds(env.CLOUDFLARE_TURN_TTL_SECONDS);
        const response = await fetchImpl(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + apiToken,
              'Content-Type': 'application/json',
            },
              body: JSON.stringify({ ttl }),
          }
        );
        const responseBody = await response.text().catch(() => '');
        const payload = responseBody ? JSON.parse(responseBody) : null;
        if (!response.ok) {
          throw new Error(
              `Cloudflare TURN API returned ${response.status}` +
              (responseBody ? ` body=${responseBody}` : '')
          );
        }
        const iceServers = normalizeIceServers(payload);
        if (iceServers.length === 0) {
          throw new Error('Cloudflare TURN API returned no ICE servers');
        }

        const expiresAt = new Date(now + ttl * 1000);
        cache = {
          iceServers: withStunServer(iceServers),
          expiresAt,
          refreshAt: now + Math.floor(ttl * 0.9) * 1000,
        };
        res.set('X-Turn-Credential-Expires-At', expiresAt.toISOString());
        res.json(cache.iceServers);
        return;
      } catch (error) {
        const logger = env.TURN_USERNAME && env.TURN_CREDENTIAL ? console.warn : console.error;
        logger(
          `[turn] credential minting failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    res.json(getStaticIceServers(env));
  });

  return router;
}

module.exports = { createTurnCredentialsRouter };
