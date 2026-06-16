'use strict';

const crypto = require('crypto');

/**
 * Mint short-lived TURN credentials using coturn's `use-auth-secret` (TURN REST
 * API) scheme.
 *
 * coturn, when started with `use-auth-secret` and a `static-auth-secret`,
 * accepts any credential whose username is `<expiry-unix-timestamp>[:<name>]`
 * and whose password is `base64(HMAC-SHA1(secret, username))`. This lets the
 * signaling server hand out time-limited credentials without provisioning a
 * per-user account on the TURN server, and without ever shipping the long-lived
 * shared secret to clients.
 *
 * @param {object} turn - The resolved `config.turn` object.
 * @param {boolean} turn.enabled
 * @param {string|null} turn.secret
 * @param {string[]} turn.urls
 * @param {number} turn.ttlSeconds
 * @param {object} [options]
 * @param {string} [options.name] - Optional label embedded in the username.
 * @param {number} [options.nowMs=Date.now()] - Injectable clock for testing.
 * @returns {{ username: string, credential: string, ttl: number, urls: string[], iceServers: Array<{urls: string[], username: string, credential: string}> }}
 */
function createTurnCredentials(turn, { name = '', nowMs = Date.now() } = {}) {
  if (!turn || !turn.enabled || !turn.secret || turn.urls.length === 0) {
    throw new Error('TURN credential provisioning is not configured');
  }

  const ttl = turn.ttlSeconds;
  const expiry = Math.floor(nowMs / 1000) + ttl;
  const username = name ? `${expiry}:${name}` : `${expiry}`;
  const credential = crypto
    .createHmac('sha1', turn.secret)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    ttl,
    urls: turn.urls,
    iceServers: [{ urls: turn.urls, username, credential }],
  };
}

module.exports = { createTurnCredentials };
