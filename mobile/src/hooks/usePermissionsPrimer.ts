import { useCallback, useEffect, useRef, useState } from 'react';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import { ensureCallPermissions, getMissingRuntimePermissions } from '../permissions';
import { shouldShowPermissionPrimer } from '../permissionsPrimer';
import { loadOnboardingState, saveOnboardingState } from '../settingsStorage';

/**
 * Decides whether the first-run permission explanation is due, and records the
 * answer so it is asked exactly once per install.
 *
 * The flag is persisted whichever way the user answers — accepting and
 * declining are both answers, and re-asking someone who said "Not now" on every
 * launch is nagging. Declining is not a dead end: every feature that needs a
 * permission still requests it at the point of use, and the startup banner
 * still reports what is missing.
 *
 * @param isRegistered Whether there is an identity to prime for; the primer
 *   must not appear over the sign-in screen.
 */
export default function usePermissionsPrimer(isRegistered: boolean) {
  // `null` means "not yet known": the flag lives on disk, and rendering the
  // primer before the read resolves would flash it at users who have already
  // answered.
  const [hasSeenPrimer, setHasSeenPrimer] = useState((null as boolean | null));
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadOnboardingState(), getMissingRuntimePermissions()])
      .then(([state, missing]) => {
        if (cancelled) return;
        if (state.permissionsPrimerSeen) {
          setHasSeenPrimer(true);
          return;
        }
        if (missing.length === 0) {
          // Nothing left to ask for — an existing install upgrading into this
          // build, or a user who granted everything already. Explaining
          // dialogs that will never appear is noise, so record it as answered.
          setHasSeenPrimer(true);
          void saveOnboardingState({ permissionsPrimerSeen: true });
          return;
        }
        setHasSeenPrimer(false);
      })
      .catch(error => {
        // Failing open (treat as unseen) shows an explanation one extra time;
        // failing closed would skip it forever.
        logWarn('[PermissionsPrimer] Could not read first-run state', {
          message: errorMessage(error),
        });
        if (!cancelled) setHasSeenPrimer(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remember = useCallback(async () => {
    // Set before the write resolves: the screen must come down on the tap, not
    // when the filesystem catches up.
    if (isMountedRef.current) setHasSeenPrimer(true);
    await saveOnboardingState({ permissionsPrimerSeen: true });
  }, []);

  const acceptPrimer = useCallback(async () => {
    await remember();
    try {
      const result = await ensureCallPermissions();
      if (result?.warningMessage) {
        logWarn('[PermissionsPrimer] Permission request', {
          message: result.warningMessage,
        });
      }
    } catch (error) {
      logWarn('[PermissionsPrimer] Permission request failed', {
        message: errorMessage(error),
      });
    }
  }, [remember]);

  const skipPrimer = useCallback(async () => {
    await remember();
  }, [remember]);

  const isPrimerVisible =
    isRegistered && hasSeenPrimer === false && shouldShowPermissionPrimer();

  return {
    isPrimerVisible,
    /** `true` once the persisted flag has been read. */
    isPrimerResolved: hasSeenPrimer !== null,
    acceptPrimer,
    skipPrimer,
  };
}
