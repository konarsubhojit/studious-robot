import { useCallback, useEffect, useState } from 'react';
import {
  ensureNotificationPrefsLoaded,
  getNotificationPrefs,
  setNotificationPreviewMode as persistNotificationPreviewMode,
  setMessageNotificationsEnabled as persistMessageNotificationsEnabled,
  setPeerMuted as persistPeerMuted,
  setQuietHours as persistQuietHours,
  subscribeToNotificationPrefs,
} from '../notificationPreferences';
import type { NotificationPrefs } from '../settingsStorage';

/**
 * React's view of the notification preferences.
 *
 * The preferences themselves live in `notificationPreferences.ts`, not in this
 * hook: the push handler runs headless in the background, long before React
 * exists, so it cannot read hook state. This hook therefore *subscribes* to
 * that cache rather than owning it, which also means a mute applied from the
 * person hub is visible to the push path immediately, not after a re-render.
 */
export default function useNotificationPreferences() {
  const [prefs, setPrefs] = useState(getNotificationPrefs);

  useEffect(() => {
    // Subscribe before hydrating: a load that settles between the two would
    // otherwise be missed, leaving the UI on the defaults for the session.
    const unsubscribe = subscribeToNotificationPrefs(setPrefs);
    let cancelled = false;
    ensureNotificationPrefsLoaded()
      .then(loaded => {
        if (!cancelled) setPrefs(loaded);
      })
      .catch(() => {
        // `loadNotificationPrefs` already falls back to the defaults and logs;
        // there is nothing further to recover here.
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const isPeerMuted = useCallback(
    (peerId: string | null | undefined) => {
      const normalized = (peerId ?? '').trim().toLowerCase();
      if (!normalized) return false;
      if (!prefs.mutedPeers.some(muted => muted.trim().toLowerCase() === normalized)) return false;
      const expiresAt = prefs.mutedPeerExpirations[normalized];
      return typeof expiresAt !== 'number' || expiresAt > Date.now();
    },
    [prefs.mutedPeerExpirations, prefs.mutedPeers],
  );

  const setPeerMuted = useCallback((peerId: string, muted: boolean) => {
    void persistPeerMuted(peerId, muted);
  }, []);

  const setMessageNotificationsEnabled = useCallback((enabled: boolean) => {
    void persistMessageNotificationsEnabled(enabled);
  }, []);

  const setNotificationPreviewMode = useCallback((previewMode: NotificationPrefs['previewMode']) => {
    void persistNotificationPreviewMode(previewMode);
  }, []);

  const setQuietHours = useCallback((quietHours: NotificationPrefs['quietHours']) => {
    void persistQuietHours(quietHours);
  }, []);

  return {
    mutedPeers: prefs.mutedPeers,
    isPeerMuted,
    setPeerMuted,
    messageNotificationsEnabled: prefs.messageNotificationsEnabled,
    setMessageNotificationsEnabled,
    mutedPeerExpirations: prefs.mutedPeerExpirations,
    quietHours: prefs.quietHours,
    setQuietHours,
    previewMode: prefs.previewMode,
    setNotificationPreviewMode,
  };
}
