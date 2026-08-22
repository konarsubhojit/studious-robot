import crypto from 'node:crypto';
import express from 'express';
import { API_ROUTES } from '../../../shared/index.ts';
import { getSessionFromRequest } from '../lib/auth.ts';

export type IceServer = { urls: string | string[]; username?: string; credential?: string; };

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TURN_URLS = [
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp',
];

function withStunServer(iceServers: IceServer[]): IceServer[] {
  const hasStun = iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => typeof url === 'string' && url.startsWith('stun:'));
  });
  return hasStun ? iceServers : [{ urls: ['stun:stun.l.google.com:19302'] }, ...iceServers];
}

/**
 * @param value comma-separated TURN URLs, if configured.
 */
function parseTurnUrls(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split(',').map((url) => url.trim()).filter(Boolean)
    : [];
}

function getStaticIceServers(env: NodeJS.ProcessEnv): IceServer[] {
  if (!env.TURN_USERNAME || !env.TURN_CREDENTIAL) {
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  const urls = env.TURN_URL ? parseTurnUrls(env.TURN_URL) : DEFAULT_TURN_URLS;
  return [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
  ];
}

function getTtlSeconds(value: unknown): number {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
}

/**
 * Mint time-limited coturn `use-auth-secret` (HMAC) credentials for a user.
 *
 * coturn validates `username` as `<unix-expiry>:<anything>` and `credential`
 * as base64(HMAC-SHA1(static-auth-secret, username)).
 */
function createHmacIceServers({ secret, urls, userId, ttlSeconds, now }: { secret: string; urls: string[]; userId: string; ttlSeconds: number; now: number; }): { iceServers: IceServer[]; expiresAt: Date; } {
  const expiresAt = new Date(now + ttlSeconds * 1000);
  const username = `${Math.floor(expiresAt.getTime() / 1000)}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { iceServers: withStunServer([{ urls, username, credential }]), expiresAt };
}

/**
 * @param payload Cloudflare TURN API response body.
 */
function normalizeIceServers(payload: any): IceServer[] {
  if (Array.isArray(payload)) return payload;
  const iceServers = payload?.iceServers;
  if (Array.isArray(iceServers)) return iceServers;
  if (iceServers && typeof iceServers === 'object') return [iceServers];
  return [];
}

/**
 * Issue ICE server credentials (Cloudflare TURN, coturn HMAC, or static).
 *
 * @param ctx
 */
function createTurnCredentialsRouter({ state, fetchImpl = fetch, env = process.env }: {
        state: import('../stores/contracts.ts').ServerState;
        fetchImpl?: typeof fetch;
        env?: NodeJS.ProcessEnv;
    }): import('express').Router {
  const router = express.Router();
  let cache: { iceServers: IceServer[]; expiresAt: Date; refreshAt: number; } | null = null;
  let warnedMissingTurnUrl = false;

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
        const message = error instanceof Error ? error.message : '';
        logger(`[turn] credential minting failed: ${message || 'unknown error'}`);
      }
    }

    // HMAC (coturn `use-auth-secret`) tier: per-user, time-limited credentials.
    // Never cached — every request mints a fresh credential for its own user.
    const staticAuthSecret = env.TURN_STATIC_AUTH_SECRET;
    if (staticAuthSecret) {
      const urls = parseTurnUrls(env.TURN_URL);
      if (urls.length === 0) {
        if (!warnedMissingTurnUrl) {
          warnedMissingTurnUrl = true;
          console.warn(
            '[turn] TURN_STATIC_AUTH_SECRET is set but TURN_URL is missing; falling back to static credentials'
          );
        }
      } else {
        const { iceServers, expiresAt } = createHmacIceServers({
          secret: staticAuthSecret,
          urls,
          userId: session.userId,
          ttlSeconds: getTtlSeconds(env.TURN_TTL_SECONDS),
          now,
        });
        res.set('X-Turn-Credential-Expires-At', expiresAt.toISOString());
        res.json(iceServers);
        return;
      }
    }

    res.json(getStaticIceServers(env));
  });

  return router;
}

export { createTurnCredentialsRouter };
