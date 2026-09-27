import fs from 'node:fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function readServiceAccount(value?: string): import('firebase-admin/app').ServiceAccount & { project_id?: string; } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const contents = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  return JSON.parse(contents);
}

/**
 * Default prefix a bypassed token's `userId` must carry when
 * `TEST_AUTH_BYPASS_ENABLED` is set. Matches the load-test rig's generated
 * user ids (`lt-${index}`, see `tools/loadrig/rig.mjs`), so the bypass can
 * never be triggered by a real Firebase ID token, which is never this short
 * or this shaped. Override with `TEST_AUTH_USER_PREFIX` if the rig's user id
 * scheme changes.
 */
const DEFAULT_TEST_AUTH_USER_PREFIX = 'lt-';

/**
 * Builds the `verifyIdToken` used by `POST /session`.
 *
 * By default every token is verified against Firebase, and `FCM_SERVICE_ACCOUNT_JSON`
 * (the same service-account credential used for push) is required.
 *
 * Setting `TEST_AUTH_BYPASS_ENABLED=true` additionally lets tokens whose value
 * starts with `TEST_AUTH_USER_PREFIX` (default `lt-`) skip Firebase
 * verification entirely, so load-test traffic (`tools/loadrig/rig.mjs`, which
 * authenticates with `idToken: userId` for its synthetic `lt-*` users) can run
 * against a real deployment without provisioning per-user Firebase ID tokens.
 * Any token that does not match the prefix is still verified normally, so
 * real users are unaffected even when the switch is left enabled. This is an
 * explicit opt-in: leave it unset outside of load-testing.
 */
function createFirebaseTokenVerifier({
  serviceAccountValue = process.env.FCM_SERVICE_ACCOUNT_JSON,
  testAuthBypassEnabled = process.env.TEST_AUTH_BYPASS_ENABLED === 'true',
  testAuthUserPrefix = process.env.TEST_AUTH_USER_PREFIX || DEFAULT_TEST_AUTH_USER_PREFIX,
} = {}) {
  const serviceAccount = readServiceAccount(serviceAccountValue);
  if (!serviceAccount && !testAuthBypassEnabled) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is required for authentication');
  }
  if (testAuthBypassEnabled) {
    console.warn(
      `[auth] TEST_AUTH_BYPASS_ENABLED is set; tokens prefixed "${testAuthUserPrefix}" skip Firebase verification. Do not leave this enabled outside of load testing.`,
    );
  }

  const auth = serviceAccount
    ? getAuth(
        getApps()[0] ||
          initializeApp({
            credential: cert(serviceAccount),
            projectId: serviceAccount.project_id,
          }),
      )
    : null;

  return async function verifyFirebaseToken(
    idToken: string,
  ) {
    if (typeof idToken !== 'string' || !idToken.trim()) {
      throw new Error('Firebase ID token is required');
    }
    const trimmed = idToken.trim();
    if (testAuthBypassEnabled && trimmed.startsWith(testAuthUserPrefix)) {
      return {
        authUid: trimmed,
        email: null,
        authProvider: 'test',
        authTime: new Date().toISOString(),
      };
    }
    if (!auth) {
      throw new Error('Firebase ID token verification is not configured');
    }
    const decoded = await auth.verifyIdToken(trimmed, true);
    return {
      authUid: decoded.uid,
      email: decoded.email ?? null,
      authProvider: decoded.firebase?.sign_in_provider ?? null,
      authTime: typeof decoded.auth_time === 'number'
        ? new Date(decoded.auth_time * 1000).toISOString()
        : null,
    };
  };
}

export { createFirebaseTokenVerifier, readServiceAccount };
