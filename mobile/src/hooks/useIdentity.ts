import { useCallback, useEffect, useRef, useState } from 'react';
import { logInfo, logWarn } from '../appLogger';
import {
  isGoogleSignInConfigured,
  isMicrosoftSignInConfigured,
  observeAuthState,
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle,
  signInWithMicrosoft,
  signOut,
} from '../authService';
import { loadIdentity, saveIdentity } from '../settingsStorage';
import type { CallStatus } from '../components/StatusBanner';
import type { User } from '@react-native-firebase/auth';

/**
 * @returns the user-facing text for a failed sign-in / registration.
 */
/**
 * Error code for a username the server refused to bind.  Carried on the thrown
 * error so the single reporting path below passes the server's explanation
 * through verbatim rather than re-deriving one from a bare `Error`.
 */
const IDENTITY_UNAVAILABLE_CODE = 'identity/username-unavailable';

function getAuthenticationErrorMessage(error: any): string {
  const code = error?.code;
  if (code === IDENTITY_UNAVAILABLE_CODE) {
    return error?.message;
  }
  if (code === 'auth/email-already-in-use') {
    return 'That email is already in use. Try signing in instead.';
  }
  if (code === 'auth/weak-password') {
    return 'Password is too weak. Use at least 6 characters.';
  }
  if (code === 'auth/invalid-email') {
    return 'Enter a valid email address.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Email/password sign-in is disabled in Firebase Auth settings.';
  }
  if (code === 'auth/app-not-configured') {
    return error?.message;
  }
  return error?.message || 'Authentication failed.';
}

/**
 * Owns the authenticated account and its public username.
 *
 * Deliberately has no knowledge of sessions, sockets, or calls — those are
 * separate concerns (see `useSession`, `useCallFlow`) that merely read the
 * authenticated `userId` from this hook. Extracted out of
 * `useCallFlow` so identity persistence stays isolated from that hook's
 * call-lifecycle/session/WebRTC responsibilities.
 */
export default function useIdentity(updateStatus: (message: string, severity?: CallStatus['severity']) => void) {
  const [userId, setUserId] = useState('');
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authUser, setAuthUser] = useState(
    (null as User | null),
  );

  const committedIdentityRef = useRef({ userId: '' });
  // Confirms a username with the server before it is committed. Supplied by
  // whoever composes this hook with `useSession` (see `useCallFlow`), so
  // identity still knows nothing about sessions — only that something can
  // answer "may this account have this name?". Absent, registration proceeds
  // unverified, which is what the tests that exercise identity alone rely on.
  const verifyIdentityRef = useRef(
    (null as ((userId: string) => Promise<{ ok: boolean; message?: string; }>) | null),
  );

  const isRegistered = userId.trim().length > 0 && Boolean(authUser);
  const canUseGoogleSignIn = isGoogleSignInConfigured();
  const canUseMicrosoftSignIn = isMicrosoftSignInConfigured();

  const commitIdentity = useCallback(async (nextUserId: string) => {
    const identity = { userId: (nextUserId ?? '').trim() };
    committedIdentityRef.current = identity;
    setUserId(identity.userId);
    await saveIdentity(identity);
    return identity;
  }, []);

  const editUserId = useCallback((nextUserId: string) => {
    const rawUserId = typeof nextUserId === 'string' ? nextUserId : '';
    const trimmedUserId = rawUserId.trim();
    const committedIdentity = committedIdentityRef.current;
    const isCommittedIdentity = trimmedUserId === committedIdentity.userId;

    setUserId(rawUserId);
    if (isCommittedIdentity) setUserId(committedIdentity.userId);
  }, []);

  // ─── Load persisted identity on mount ────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    let identityLoaded = false;
    let authLoaded = false;

    const finishLoading = () => {
      if (!cancelled && identityLoaded && authLoaded) setIsLoadingIdentity(false);
    };

    const initialiseIdentity = async () => {
      try {
        const storedIdentity = await loadIdentity();
        if (cancelled) return;

        const savedId = (storedIdentity?.userId ?? '').trim();
        if (savedId) {
          committedIdentityRef.current = { userId: savedId };
          setUserId(savedId);
        }
      } finally {
        identityLoaded = true;
        finishLoading();
      }
    };

    const unsubscribe = observeAuthState(user => {
      if (cancelled) return;
      setAuthUser(user);
      authLoaded = true;
      finishLoading();
    });
    initialiseIdentity().catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updateStatus]);

  /**
   * Register the local user with the given userId.  Persists the identity to
   * disk and updates the in-memory state so the presence socket connects.
   *
   * Authenticating is only half of registering: the username is bound by the
   * server, not by the account, so it is verified *before* it is committed.
   * Committing first admitted a user whose chosen name was already taken into
   * an app that could not create a session — no chats, no calls — with the
   * refusal reported only as a status message on another screen.  Now the
   * rejection throws, `isRegistered` stays false, and the registration screen
   * they are still on shows why.
   */
  const registerUser = useCallback(
    async (registration: { userId: string; method: string; email?: string; password?: string; }) => {
      const trimmed = (registration?.userId ?? '').trim();
      if (!trimmed) return;
      setIsAuthenticating(true);
      try {
        if (registration.method === 'email-register') {
          await registerWithEmail(
            (registration.email as string),
            (registration.password as string),
          );
        } else if (registration.method === 'email-sign-in') {
          await signInWithEmail(
            (registration.email as string),
            (registration.password as string),
          );
        } else if (registration.method === 'google') {
          await signInWithGoogle();
        } else if (registration.method === 'microsoft') {
          await signInWithMicrosoft();
        } else {
          throw new Error('Unsupported sign-in method');
        }
        const verification = await verifyIdentityRef.current?.(trimmed);
        if (verification && !verification.ok) {
          const message = verification.message ?? 'That username is unavailable.';
          logWarn('[Identity] Username rejected by the server', { message });
          throw Object.assign(new Error(message), { code: IDENTITY_UNAVAILABLE_CODE });
        }

        const identity = await commitIdentity(trimmed);
        updateStatus('Account authenticated.', 'success');
        logInfo('[Identity] User registered', {
          userId: identity.userId,
        });
      } catch (error) {
        updateStatus(getAuthenticationErrorMessage(error), 'error');
        throw error;
      } finally {
        setIsAuthenticating(false);
      }
    },
    [commitIdentity, updateStatus],
  );

  /**
   * Update the active userId and persist the new value.
   * Use this when the user edits their username in Settings so the new
   * identity survives app restarts.
   */
  const updateUserId = useCallback(
    async (newUserId: string) => {
      const trimmed = (newUserId ?? '').trim();
      if (!trimmed || trimmed === committedIdentityRef.current.userId) return;

      setUserId(committedIdentityRef.current.userId);
      updateStatus('Usernames are bound to your account and cannot be changed here.', 'error');
    },
    [updateStatus],
  );

  /**
   * Clear the persisted identity so the app returns to the RegistrationScreen
   * on next launch.  Callers that also hold a live session (e.g. `useCallFlow`)
   * are responsible for dropping the device's push registration *before*
   * calling this, since the session lives outside this hook.
   */
  const unregisterUser = useCallback(async () => {
    committedIdentityRef.current = { userId: '' };
    setUserId('');
    await signOut();
    await saveIdentity({ userId: '' });
    logInfo('[Identity] User unregistered');
  }, []);

  return {
    userId,
    setUserId,
    authUser,
    isLoadingIdentity,
    isAuthenticating,
    isRegistered,
    verifyIdentityRef,
    canUseGoogleSignIn,
    canUseMicrosoftSignIn,
    committedIdentityRef,
    editUserId,
    registerUser,
    updateUserId,
    unregisterUser,
  };
}
