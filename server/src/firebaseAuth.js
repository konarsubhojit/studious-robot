'use strict';

const fs = require('node:fs');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

function readServiceAccount(value) {
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

  return async function verifyFirebaseToken(idToken) {
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

module.exports = { createFirebaseTokenVerifier, readServiceAccount };
