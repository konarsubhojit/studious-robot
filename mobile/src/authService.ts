import {
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  getAuth as getFirebaseAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
} from '@react-native-firebase/auth';
import type { Auth, AuthProvider, User } from '@react-native-firebase/auth';
import { errorMessage } from './errors';

const FIREBASE_APP_UNAVAILABLE_MESSAGE =
  'Firebase is not configured in this build. Add google-services.json (Android) or GoogleService-Info.plist (iOS).';
const GOOGLE_SIGN_IN_UNAVAILABLE_MESSAGE = 'Google Sign-In is not available in this build';
const MICROSOFT_SIGN_IN_UNAVAILABLE_MESSAGE = 'Microsoft Sign-In is not available in this build';

let googleConfigured = false;
/**
 * The lazily `require`d Google Sign-In module: `undefined` before the first
 * load attempt, `null` when the native module is absent from this build.
 */
let cachedGoogleSignin: any;

function isFirebaseAppUnavailableError(error: unknown): boolean {
  const message = errorMessage(error) ?? '';
  return (
    message.includes("No Firebase App '[DEFAULT]' has been created") ||
    message.toLowerCase().includes('default app has not been created')
  );
}

/**
 * Translate a missing-Firebase-app failure into an actionable error.
 *
 * @returns the original error, or a coded replacement.
 */
function toAuthError(error: unknown): unknown {
  if (isFirebaseAppUnavailableError(error)) {
    const nextError = (new Error(FIREBASE_APP_UNAVAILABLE_MESSAGE) as Error & { code?: string });
    nextError.code = 'auth/app-not-configured';
    return nextError;
  }
  return error;
}

function getAuth(): Auth {
  try {
    return getFirebaseAuth();
  } catch (error) {
    throw toAuthError(error);
  }
}

function loadGoogleSignin() {
  if (cachedGoogleSignin !== undefined) return cachedGoogleSignin;
  try {
    const mod = require('@react-native-google-signin/google-signin');
    const anyMod = (mod as any);
    cachedGoogleSignin = anyMod?.GoogleSignin ?? anyMod?.default ?? anyMod;
  } catch {
    cachedGoogleSignin = null;
  }
  return cachedGoogleSignin;
}

export function isFirebaseConfigured() {
  try {
    getAuth();
    return true;
  } catch {
    return false;
  }
}

export function isGoogleSignInConfigured() {
  return Boolean(process.env.GOOGLE_WEB_CLIENT_ID && loadGoogleSignin() && isFirebaseConfigured());
}

export function isMicrosoftSignInConfigured() {
  return isFirebaseConfigured();
}

function configureGoogle() {
  if (googleConfigured) return;
  if (!isGoogleSignInConfigured()) {
    throw new Error(GOOGLE_SIGN_IN_UNAVAILABLE_MESSAGE);
  }
  const googleSignin = loadGoogleSignin();
  googleSignin.configure({
    webClientId: process.env.GOOGLE_WEB_CLIENT_ID,
  });
  googleConfigured = true;
}

export function observeAuthState(listener: (user: User | null) => void): () => void {
  return onAuthStateChanged(getAuth(), listener);
}

export async function registerWithEmail(email: string, password: string) {
  return createUserWithEmailAndPassword(getAuth(), email.trim(), password);
}

export async function signInWithEmail(email: string, password: string) {
  return signInWithEmailAndPassword(getAuth(), email.trim(), password);
}

export async function signInWithGoogle() {
  configureGoogle();
  const GoogleSignin = loadGoogleSignin();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  const idToken = result.data?.idToken ?? result.idToken;
  if (!idToken) throw new Error('Google did not return an ID token');
  const credential = GoogleAuthProvider.credential(idToken);
  return signInWithCredential(getAuth(), credential);
}

export async function signInWithMicrosoft() {
  if (!isMicrosoftSignInConfigured()) {
    throw new Error(MICROSOFT_SIGN_IN_UNAVAILABLE_MESSAGE);
  }
  const provider = new OAuthProvider('microsoft.com');
  provider.addScope('email');
  // `OAuthProvider` declares `providerId` as private, so it does not structurally
  // satisfy the exported `AuthProvider` interface even though it is the value the
  // modular API expects here (an upstream typing quirk in @react-native-firebase).
  return signInWithPopup(getAuth(), provider as unknown as AuthProvider);
}

export async function getIdToken(forceRefresh = false) {
  const user = getAuth().currentUser;
  if (!user) throw new Error('Sign in is required');
  try {
    return await user.getIdToken(forceRefresh);
  } catch (error) {
    throw toAuthError(error);
  }
}

export async function signOut() {
  await firebaseSignOut(getAuth());
}

export function _resetGoogleSigninCache() {
  cachedGoogleSignin = undefined;
  googleConfigured = false;
}
