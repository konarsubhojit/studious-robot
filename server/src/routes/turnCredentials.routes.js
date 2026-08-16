'use strict';

const express = require('express');
const { getSessionFromRequest } = require('../lib/auth');

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TURN_URLS = [
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp',
];

function withStunServer(iceServers) {
  const hasStun = iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === 'string' && url.startsWith('stun:'));
  });
  return hasStun ? iceServers : [{ urls: ['stun:stun.l.google.com:19302'] }, ...iceServers];
}

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

function getTtlSeconds(value) {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
}

function createTurnCredentialsRouter({ state, fetchImpl = fetch, env = process.env }) {
  const router = express.Router();
  let cache = null;

  router.get('/turn-credentials', async (req, res) => {
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
        if (!response.ok) {
          throw new Error(`Cloudflare TURN API returned ${response.status}`);
        }
        const payload = await response.json();
        const iceServers = Array.isArray(payload) ? payload : payload.iceServers;
        if (!Array.isArray(iceServers) || iceServers.length === 0) {
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
        console.warn(`[turn] credential minting failed: ${error?.message || 'unknown error'}`);
      }
    }

    res.json(getStaticIceServers(env));
  });

  return router;
}

module.exports = { createTurnCredentialsRouter };
