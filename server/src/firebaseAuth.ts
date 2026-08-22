import fs from 'node:fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function readServiceAccount(value?: string): import('firebase-admin/app').ServiceAccount & { project_id?: string; } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const contents = raw.startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
  return JSON.parse(contents);
}

function createFirebaseTokenVerifier({ serviceAccountValue = process.env.FCM_SERVICE_ACCOUNT_JSON } = {}) {
  const serviceAccount = readServiceAccount(serviceAccountValue);
  if (!serviceAccount) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is required for authentication');
  }

  const app =
    getApps()[0] ||
    initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  const auth = getAuth(app);

  return async function verifyFirebaseToken(
    idToken: string,
  ) {
    if (typeof idToken !== 'string' || !idToken.trim()) {
      throw new Error('Firebase ID token is required');
    }
    const decoded = await auth.verifyIdToken(idToken.trim(), true);
    return {
      authUid: decoded.uid,
      email: decoded.email ?? null,
      authProvider: decoded.firebase?.sign_in_provider ?? null,
    };
  };
}

export { createFirebaseTokenVerifier, readServiceAccount };
