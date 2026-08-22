export type User = { userId: string; authUid: string; email?: string | null; authProvider?: string | null; createdAt: string | null; verifiedAt: string | null; };
export type IdentityClaimGranted = { ok: true; verified: true; claimed?: true; user: User; };
export type IdentityClaimDenied = { ok: false; reason: 'account_already_bound' | 'username_required' | 'identity_claimed'; user?: User; };
export type IdentityClaim = IdentityClaimGranted | IdentityClaimDenied;

/**
 * Bind a verified external account to exactly one public username.
 *
 * @param {Map<string, User>} usersStore
 * @param {string|null} requestedUserId
 * @param {{ authUid: string, email?: string|null, authProvider?: string|null }} identity
 * @returns {IdentityClaim}
 */
function resolveIdentityClaim(usersStore: Map<string, User>, requestedUserId: string | null, identity: { authUid: string; email?: string | null; authProvider?: string | null; }): IdentityClaim {
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

export { resolveIdentityClaim };
