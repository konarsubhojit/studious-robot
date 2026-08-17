import auth from '@react-native-firebase/auth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

let googleConfigured = false;

function configureGoogle() {
  if (googleConfigured) return;
  if (!process.env.GOOGLE_WEB_CLIENT_ID) {
    throw new Error('GOOGLE_WEB_CLIENT_ID is not configured');
  }
  GoogleSignin.configure({
    webClientId: process.env.GOOGLE_WEB_CLIENT_ID,
  });
  googleConfigured = true;
}

export function observeAuthState(listener) {
  return auth().onAuthStateChanged(listener);
}

export async function registerWithEmail(email, password) {
  return auth().createUserWithEmailAndPassword(email.trim(), password);
}

export async function signInWithEmail(email, password) {
  return auth().signInWithEmailAndPassword(email.trim(), password);
}

export async function signInWithGoogle() {
  configureGoogle();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  const idToken = result.data?.idToken ?? result.idToken;
  if (!idToken) throw new Error('Google did not return an ID token');
  const credential = auth.GoogleAuthProvider.credential(idToken);
  return auth().signInWithCredential(credential);
}

export async function signInWithMicrosoft() {
  const provider = new auth.OAuthProvider('microsoft.com');
  provider.addScope('email');
  return auth().signInWithProvider(provider);
}

export async function getIdToken(forceRefresh = false) {
  const user = auth().currentUser;
  if (!user) throw new Error('Sign in is required');
  return user.getIdToken(forceRefresh);
}

export async function signOut() {
  await auth().signOut();
}
