import { useCallback, useEffect, useRef, useState } from 'react';
import { logInfo } from '../appLogger';
import { generateVerificationCode, normalizeVerificationCode } from '../identityVerification';
import { loadIdentity, saveIdentity } from '../settingsStorage';

/**
 * Owns the local user's identity: `userId` / `verificationCode`, persistence
 * to disk, and the registration / rename / sign-out lifecycle.
 *
 * Deliberately has no knowledge of sessions, sockets, or calls — those are
 * separate concerns (see `useSession`, `useCallFlow`) that merely *read*
 * `userId` / `verificationCodeRef` from this hook. Extracted out of
 * `useCallFlow` so identity persistence stays isolated from that hook's
 * call-lifecycle/session/WebRTC responsibilities.
 *
 * @param {(message: string, severity?: string) => void} updateStatus
 */
export default function useIdentity(updateStatus) {
  const [userId, setUserId] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingVerificationCode, setPendingVerificationCode] = useState('');

  // true while the identity is being loaded from persistent storage on mount.
  const [isLoadingIdentity, setIsLoadingIdentity] = useState(true);

  const verificationCodeRef = useRef('');
  const committedIdentityRef = useRef({ userId: '', verificationCode: '' });

  /** True once a userId has been persisted (i.e. the user has registered). */
  const isRegistered = userId.trim().length > 0;

  const dismissVerificationCodeNotice = useCallback(() => {
    setPendingVerificationCode('');
  }, []);

  const commitIdentity = useCallback(
    async (nextUserId, nextVerificationCode, { announceVerificationCode = false } = {}) => {
      const identity = {
        userId: (nextUserId ?? '').trim(),
        verificationCode: normalizeVerificationCode(nextVerificationCode),
      };

      committedIdentityRef.current = identity;
      verificationCodeRef.current = identity.verificationCode;
      setUserId(identity.userId);
      setVerificationCode(identity.verificationCode);
      setPendingVerificationCode(announceVerificationCode ? identity.verificationCode : '');
      await saveIdentity(identity);
      return identity;
    },
    [],
  );

  const editUserId = useCallback(nextUserId => {
    const rawUserId = typeof nextUserId === 'string' ? nextUserId : '';
    const trimmedUserId = rawUserId.trim();
    const committedIdentity = committedIdentityRef.current;
    const isCommittedIdentity = trimmedUserId === committedIdentity.userId;

    setUserId(rawUserId);
    if (isCommittedIdentity) {
      verificationCodeRef.current = committedIdentity.verificationCode;
      setVerificationCode(committedIdentity.verificationCode);
    } else {
      verificationCodeRef.current = '';
      setVerificationCode('');
    }
    setPendingVerificationCode('');
  }, []);

  // ─── Load persisted identity on mount ────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const initialiseIdentity = async () => {
      try {
        const storedIdentity = await loadIdentity();
        if (cancelled) return;

        const savedId = (storedIdentity?.userId ?? '').trim();
        let savedVerificationCode = normalizeVerificationCode(storedIdentity?.verificationCode);

        if (savedId) {
          const shouldGenerateVerificationCode = !savedVerificationCode;
          if (shouldGenerateVerificationCode) {
            savedVerificationCode = generateVerificationCode();
          }

          committedIdentityRef.current = {
            userId: savedId,
            verificationCode: savedVerificationCode,
          };
          verificationCodeRef.current = savedVerificationCode;
          setUserId(savedId);
          setVerificationCode(savedVerificationCode);

          if (shouldGenerateVerificationCode) {
            setPendingVerificationCode(savedVerificationCode);
            updateStatus(
              'Save your recovery code. You’ll need it to use this username on another device.',
              'info',
            );
            void saveIdentity({
              userId: savedId,
              verificationCode: savedVerificationCode,
            });
            logInfo('[Identity] Recovery code generated for stored identity', {
              userId: savedId,
              hasVerificationCode: true,
            });
          }
        }
      } finally {
        if (!cancelled) setIsLoadingIdentity(false);
      }
    };

    initialiseIdentity().catch(() => {
      if (!cancelled) setIsLoadingIdentity(false);
    });
    return () => {
      cancelled = true;
    };
  }, [updateStatus]);

  /**
   * Register the local user with the given userId.  Persists the identity to
   * disk and updates the in-memory state so the presence socket connects.
   *
   * @param {string} newUserId
   * @param {string} [existingVerificationCode]
   */
  const registerUser = useCallback(
    async (newUserId, existingVerificationCode = '') => {
      const trimmed = (newUserId ?? '').trim();
      if (!trimmed) return;
      const nextVerificationCode =
        normalizeVerificationCode(existingVerificationCode) || generateVerificationCode();
      const identity = await commitIdentity(trimmed, nextVerificationCode, {
        announceVerificationCode: true,
      });
      updateStatus(
        'Save your recovery code. You’ll need it to use this username on another device.',
        'success',
      );
      logInfo('[Identity] User registered', {
        userId: identity.userId,
        hasVerificationCode: true,
      });
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

      const identity = await commitIdentity(trimmed, generateVerificationCode(), {
        announceVerificationCode: true,
      });
      updateStatus('Username updated. Save your new recovery code.', 'success');
      logInfo('[Identity] Username updated', {
        userId: identity.userId,
        hasVerificationCode: true,
      });
    },
    [commitIdentity, updateStatus],
  );

  /**
   * Clear the persisted identity so the app returns to the RegistrationScreen
   * on next launch.  Callers that also hold a live session (e.g. `useCallFlow`)
   * are responsible for dropping the device's push registration *before*
   * calling this, since the session lives outside this hook.
   */
  const unregisterUser = useCallback(async () => {
    committedIdentityRef.current = { userId: '', verificationCode: '' };
    verificationCodeRef.current = '';
    setUserId('');
    setVerificationCode('');
    setPendingVerificationCode('');
    await saveIdentity({ userId: '', verificationCode: '' });
    logInfo('[Identity] User unregistered');
  }, []);

  return {
    userId,
    setUserId,
    verificationCode,
    verificationCodeRef,
    pendingVerificationCode,
    isLoadingIdentity,
    isRegistered,
    committedIdentityRef,
    dismissVerificationCodeNotice,
    editUserId,
    registerUser,
    updateUserId,
    unregisterUser,
  };
}
