import auth from '@react-native-firebase/auth';
import type { FirebaseAuthTypes } from '@react-native-firebase/auth';

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
  const message = error instanceof Error ? error.message : '';
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

function getAuth() {
  try {
    return auth();
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

export function observeAuthState(listener: (user: FirebaseAuthTypes.User | null) => void): () => void {
  return getAuth().onAuthStateChanged(listener);
}

export async function registerWithEmail(email: string, password: string) {
  return getAuth().createUserWithEmailAndPassword(email.trim(), password);
}

export async function signInWithEmail(email: string, password: string) {
  return getAuth().signInWithEmailAndPassword(email.trim(), password);
}

export async function signInWithGoogle() {
  configureGoogle();
  const GoogleSignin = loadGoogleSignin();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  const idToken = result.data?.idToken ?? result.idToken;
  if (!idToken) throw new Error('Google did not return an ID token');
  const credential = auth.GoogleAuthProvider.credential(idToken);
  return getAuth().signInWithCredential(credential);
}

export async function signInWithMicrosoft() {
  if (!isMicrosoftSignInConfigured()) {
    throw new Error(MICROSOFT_SIGN_IN_UNAVAILABLE_MESSAGE);
  }
  const provider = new auth.OAuthProvider('microsoft.com');
  provider.addScope('email');
  return getAuth().signInWithProvider(provider);
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
  await getAuth().signOut();
}

export function _resetGoogleSigninCache() {
  cachedGoogleSignin = undefined;
  googleConfigured = false;
}
