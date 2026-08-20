// @ts-check
import { useEffect, useRef } from 'react';
import { logWarn } from '../appLogger';
import { ensureCallPermissions } from '../permissions';

/**
 * Requests every runtime permission the app can use (camera, microphone,
 * Bluetooth audio routing, notifications) exactly once per established
 * identity, right after `userId` is set — instead of only prompting the
 * first time each feature is used.
 *
 * A first-time user sees one consolidated system permission flow up front;
 * a user who declines something here still gets the narrower,
 * feature-specific prompt/message later (see `ensureCallPermissions` call
 * sites in `useCallFlow`).
 *
 * Extracted out of `useCallFlow` so this one-time startup concern stays
 * isolated from that hook's call-lifecycle/session/WebRTC responsibilities.
 *
 * @param {string} userId
 */
export default function useStartupPermissions(userId) {
  // Guards the one-time upfront permission request, so a fresh identity
  // reconnecting (e.g. after a network blip) doesn't re-prompt every time.
  const hasRequestedRef = useRef(false);

  useEffect(() => {
    if (!userId.trim() || hasRequestedRef.current) return;
    hasRequestedRef.current = true;
    ensureCallPermissions()
      .then(result => {
        if (result?.warningMessage) {
          logWarn('[StartupPermissions] Startup permission request', {
            message: result.warningMessage,
          });
        }
      })
      .catch(error => {
        logWarn('[StartupPermissions] Startup permission request failed', {
          message: error?.message,
        });
      });
  }, [userId]);
}
