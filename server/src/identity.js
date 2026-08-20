// @ts-check
'use strict';

/**
 * @typedef {{
 *   userId: string,
 *   authUid: string,
 *   email?: string|null,
 *   authProvider?: string|null,
 *   createdAt: string,
 *   verifiedAt: string,
 * }} User
 */

/**
 * The outcome of {@link resolveIdentityClaim}: a discriminated union, so a
 * caller that has checked `ok` knows whether `user` is guaranteed present.
 *
 * @typedef {{ ok: true, verified: boolean, claimed?: boolean, user: User }
 *   | { ok: false, reason: string, user?: User }} IdentityClaim
 */

/**
 * Bind a verified external account to exactly one public username.
 *
 * @param {Map<string, User>} usersStore
 * @param {string|null} requestedUserId
 * @param {{ authUid: string, email?: string|null, authProvider?: string|null }} identity
 * @returns {IdentityClaim}
 */
function resolveIdentityClaim(usersStore, requestedUserId, identity) {
  const accountUser = Array.from(usersStore.values()).find(
    (candidate) => candidate.authUid === identity.authUid,
  );
  if (accountUser) {
    if (requestedUserId && requestedUserId !== accountUser.userId) {
      return { ok: false, reason: 'account_already_bound', user: accountUser };
    }
    return { ok: true, verified: true, user: accountUser };
  }

  if (!requestedUserId) {
    return { ok: false, reason: 'username_required' };
  }

  const existing = usersStore.get(requestedUserId) || null;
  if (existing) {
    return { ok: false, reason: 'identity_claimed', user: existing };
  }

  const now = new Date().toISOString();
  const user = {
    userId: requestedUserId,
    authUid: identity.authUid,
    email: identity.email ?? null,
    authProvider: identity.authProvider ?? null,
    createdAt: now,
    verifiedAt: now,
  };
  usersStore.set(requestedUserId, user);
  return { ok: true, verified: true, claimed: true, user };
}

module.exports = { resolveIdentityClaim };
