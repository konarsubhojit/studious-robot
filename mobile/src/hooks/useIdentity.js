import { useCallback, useEffect, useRef, useState } from 'react';
import { logInfo } from '../appLogger';
import {
  observeAuthState,
  registerWithEmail,
  signInWithEmail,
  signInWithGoogle,
  signInWithMicrosoft,
  signOut,
} from '../authService';
import { loadIdentity, saveIdentity } from '../settingsStorage';

/**
 * Owns the authenticated account and its public username.
 *
 * Deliberately has no knowledge of sessions, sockets, or calls — those are
 * separate concerns (see `useSession`, `useCallFlow`) that merely read the
 * authenticated `userId` from this hook. Extracted out of
 * `useCallFlow` so identity persistence stays isolated from that hook's
 * call-lifecycle/session/WebRTC responsibilities.
 *
 * @param {(message: string, severity?: string) => void} updateStatus
 */
export default function useIdentity(updateStatus) {
  const [userId, setUserId] = useState('');
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authUser, setAuthUser] = useState(null);

  const committedIdentityRef = useRef({ userId: '' });

  const isRegistered = userId.trim().length > 0 && Boolean(authUser);

  const commitIdentity = useCallback(async nextUserId => {
    const identity = { userId: (nextUserId ?? '').trim() };
    committedIdentityRef.current = identity;
    setUserId(identity.userId);
    await saveIdentity(identity);
    return identity;
  }, []);

  const editUserId = useCallback(nextUserId => {
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
   * @param {{ userId: string, method: string, email?: string, password?: string }} registration
   */
  const registerUser = useCallback(
    async registration => {
      const trimmed = (registration?.userId ?? '').trim();
      if (!trimmed) return;
      setIsAuthenticating(true);
      try {
        if (registration.method === 'email-register') {
          await registerWithEmail(registration.email, registration.password);
        } else if (registration.method === 'email-sign-in') {
          await signInWithEmail(registration.email, registration.password);
        } else if (registration.method === 'google') {
          await signInWithGoogle();
        } else if (registration.method === 'microsoft') {
          await signInWithMicrosoft();
        } else {
          throw new Error('Unsupported sign-in method');
        }
        const identity = await commitIdentity(trimmed);
        updateStatus('Account authenticated.', 'success');
        logInfo('[Identity] User registered', {
          userId: identity.userId,
        });
      } catch (error) {
        updateStatus(error?.message || 'Authentication failed.', 'error');
        throw error;
      } finally {
        setIsAuthenticating(false);
      }
    },
    [commitIdentity, updateStatus],
  );

  /**
   * Update the active userId and persist the new value.
   * Use this when the user edits their username in the Lobby so the new
   * identity survives app restarts.
   *
   * @param {string} newUserId
   */
  const updateUserId = useCallback(
    async newUserId => {
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
    committedIdentityRef,
    editUserId,
    registerUser,
    updateUserId,
    unregisterUser,
  };
}
