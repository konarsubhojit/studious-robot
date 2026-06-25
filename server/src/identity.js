'use strict';

/**
 * Identity verification for `userId` ownership.
 *
 * `POST /session` historically accepted any `userId` with no proof of
 * ownership, which made impersonation trivial.  This module adds a minimal,
 * opt-in verification step: a `userId` becomes **claimed** the first time a
 * session request supplies a `verificationCode` for it.  The code is stored only
 * as a salted scrypt hash — never in plaintext — keyed by `userId` (whose
 * uniqueness is enforced by the `users` store / table primary key).
 *
 * Once an identity is claimed, any later session request for the same `userId`
 * must present the matching code; otherwise it is rejected (HTTP 409).  Requests
 * for `userId`s that have never been claimed are still accepted without a code,
 * keeping the change backwards-compatible for existing/anonymous clients.
 */

const { randomBytes, scryptSync, timingSafeEqual } = require('crypto');

/** Bytes of random salt generated per claimed identity. */
const SALT_BYTES = 16;

/** Derived key length (bytes) for the scrypt hash. */
const KEY_LENGTH = 32;

/**
 * Normalise a caller-supplied verification code to a non-empty string or null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normaliseVerificationCode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Hash a verification code with scrypt.  A fresh random salt is generated unless
 * one is supplied (used to re-derive the hash when verifying).
 *
 * @param {string} code
 * @param {string} [salt]  Hex-encoded salt; omit to generate a new one.
 * @returns {{ salt: string, hash: string }}
 */
function hashVerificationCode(code, salt = randomBytes(SALT_BYTES).toString('hex')) {
  const hash = scryptSync(String(code), salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

/**
 * Constant-time check that `code` matches a claimed identity's stored hash.
 *
 * @param {string} code
 * @param {{ verificationHash?: string, verificationSalt?: string }} record
 * @returns {boolean}
 */
function verifyVerificationCode(code, record) {
  if (!record || !record.verificationHash || !record.verificationSalt) {
    return false;
  }
  const { hash } = hashVerificationCode(code, record.verificationSalt);
  const provided = Buffer.from(hash, 'hex');
  const expected = Buffer.from(record.verificationHash, 'hex');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

/**
 * @typedef {object} IdentityClaimResult
 * @property {boolean} ok        Whether the session request may proceed.
 * @property {boolean} [verified] True when the identity was verified via code.
 * @property {boolean} [claimed]  True when this request claimed the identity.
 * @property {string}  [reason]   Denial reason when `ok` is false.
 * @property {object}  [user]     The stored/created user record (when present).
 */

/**
 * Resolve whether a session may be created for `userId`, claiming the identity
 * when a verification code is supplied for a not-yet-claimed `userId`.
 *
 * Semantics:
 *   - Claimed identity + matching code → allowed (verified).
 *   - Claimed identity + missing/wrong code → denied (409, `identity_claimed`).
 *   - Unclaimed identity + code → claimed now (verified).
 *   - Unclaimed identity + no code → allowed (unverified, backwards-compatible).
 *
 * @param {Map<string, object>} usersStore
 * @param {string} userId
 * @param {unknown} verificationCode
 * @returns {IdentityClaimResult}
 */
function resolveIdentityClaim(usersStore, userId, verificationCode) {
  const code = normaliseVerificationCode(verificationCode);
  const existing = usersStore.get(userId) || null;
  const isClaimed = Boolean(existing && existing.verificationHash);

  if (isClaimed) {
    if (!code || !verifyVerificationCode(code, existing)) {
      return { ok: false, reason: 'identity_claimed', user: existing };
    }
    return { ok: true, verified: true, user: existing };
  }

  if (code) {
    const { salt, hash } = hashVerificationCode(code);
    const now = new Date().toISOString();
    const user = {
      userId,
      verificationHash: hash,
      verificationSalt: salt,
      createdAt: existing?.createdAt ?? now,
      verifiedAt: now,
    };
    usersStore.set(userId, user);
    return { ok: true, verified: true, claimed: true, user };
  }

  return { ok: true, verified: false, user: existing };
}

module.exports = {
  normaliseVerificationCode,
  hashVerificationCode,
  verifyVerificationCode,
  resolveIdentityClaim,
};
