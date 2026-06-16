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
  // HMAC-SHA1 is mandated by coturn's `use-auth-secret` / TURN REST API scheme
  // (draft-uberti-behave-turn-rest-00); it is the only algorithm coturn accepts
  // for this credential format. This is a keyed MAC, not a bare SHA-1 hash, so
  // SHA-1's collision weaknesses do not apply, and the shared secret never
  // leaves the server. Switching algorithms here would break interop with every
  // standard TURN server. (CodeQL js/weak-cryptographic-algorithm: accepted.)
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
