// @ts-check
import auth from '@react-native-firebase/auth';
import { errorMessage } from './errorMessage';

const FIREBASE_APP_UNAVAILABLE_MESSAGE =
  'Firebase is not configured in this build. Add google-services.json (Android) or GoogleService-Info.plist (iOS).';
const GOOGLE_SIGN_IN_UNAVAILABLE_MESSAGE = 'Google Sign-In is not available in this build';
const MICROSOFT_SIGN_IN_UNAVAILABLE_MESSAGE = 'Microsoft Sign-In is not available in this build';

let googleConfigured = false;
/**
 * Cached `GoogleSignin` module: `undefined` before the first load attempt,
 * `null` when the optional native module is absent from this build.
 *
 * @type {any}
 */
let cachedGoogleSignin;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isFirebaseAppUnavailableError(error) {
  // Firebase failures can cross the native bridge as plain objects, so the
  // message is read through the shared helper rather than via `instanceof`.
  const message = error ? errorMessage(error) : '';
  return (
    message.includes("No Firebase App '[DEFAULT]' has been created") ||
    message.toLowerCase().includes('default app has not been created')
  );
}

/**
 * @param {unknown} error
 * @returns {unknown} A friendlier error for the missing-Firebase-config case,
 *   otherwise the original error unchanged.
 */
function toAuthError(error) {
  if (isFirebaseAppUnavailableError(error)) {
    const nextError = /** @type {Error & { code?: string }} */ (
      new Error(FIREBASE_APP_UNAVAILABLE_MESSAGE)
    );
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
    const mod = /** @type {any} */ (require('@react-native-google-signin/google-signin'));
    cachedGoogleSignin = mod?.GoogleSignin ?? mod?.default ?? mod;
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

/**
 * @param {(user: import('@react-native-firebase/auth').FirebaseAuthTypes.User | null) => void} listener
 * @returns {() => void} Unsubscribe function.
 */
export function observeAuthState(listener) {
  return getAuth().onAuthStateChanged(listener);
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function registerWithEmail(email, password) {
  return getAuth().createUserWithEmailAndPassword(email.trim(), password);
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function signInWithEmail(email, password) {
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
