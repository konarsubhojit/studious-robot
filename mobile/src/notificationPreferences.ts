import {
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  saveNotificationPrefs,
} from './settingsStorage';
import type { NotificationPrefs } from './settingsStorage';

/**
 * Notification preferences, cached in memory so the push path can consult them
 * synchronously.
 *
 * The person hub has offered a "Mute notifications" row for a while, but it was
 * only rendered when an `onToggleMute` prop was supplied and nothing ever
 * supplied one — a control that existed in the code and never in the app. This
 * module is what makes it real: the *decision* has to be readable by
 * `pushNotifications`, which runs headless in the background handler, long
 * before React (and therefore any hook state) exists. So the source of truth is
 * a small file, read once into this cache, and React subscribes to the cache
 * rather than owning it.
 */

let cache: NotificationPrefs = clonePrefs(DEFAULT_NOTIFICATION_PREFS);
let hydration: Promise<NotificationPrefs> | null = null;
// Bumped by every write and by the test reset, so a read that is still in
// flight can tell that its result is already stale.
let epoch = 0;
const listeners = new Set<(prefs: NotificationPrefs) => void>();

type PeerMuteOptions = {
  expiresAt?: number | Date | null;
};

function clonePrefs(prefs: NotificationPrefs): NotificationPrefs {
  return {
    ...prefs,
    mutedPeers: [...prefs.mutedPeers],
    mutedPeerExpirations: { ...prefs.mutedPeerExpirations },
    quietHours: { ...prefs.quietHours },
  };
}

function notify() {
  const snapshot = getNotificationPrefs();
  listeners.forEach(listener => listener(snapshot));
}

/** Normalised peer id; mute must not depend on how the caller cased it. */
function normalizePeerId(peerId: string | null | undefined): string {
  return (peerId ?? '').trim().toLowerCase();
}

/**
 * Read the preferences from disk into the cache, at most once per process.
 *
 * Idempotent and safe to call from several places (app start, the headless push
 * handler): concurrent callers share the same in-flight promise.
 */
export function ensureNotificationPrefsLoaded(): Promise<NotificationPrefs> {
  if (!hydration) {
    const startedAt = ++epoch;
    hydration = loadNotificationPrefs().then(loaded => {
      // Only adopt the file if nothing was changed while it was being read: a
      // mute applied in the meantime is newer than the file it was reading, and
      // overwriting it here would silently un-mute the person.
      if (startedAt === epoch) {
        cache = clonePrefs(loaded);
        notify();
      }
      return getNotificationPrefs();
    });
  }
  return hydration;
}

/** Current preferences. Defaults until `ensureNotificationPrefsLoaded` settles. */
export function getNotificationPrefs(): NotificationPrefs {
  return clonePrefs({
    ...cache,
    mutedPeers: cache.mutedPeers.filter(peerId => isPeerMuted(peerId)),
  });
}

/** Whether chat-message notifications are allowed at all. */
export function areMessageNotificationsEnabled(): boolean {
  return cache.messageNotificationsEnabled;
}

export function getNotificationPreviewMode(): NotificationPrefs['previewMode'] {
  return cache.previewMode;
}

function expiryToTimestamp(expiresAt: PeerMuteOptions['expiresAt']): number | null {
  if (expiresAt instanceof Date) return expiresAt.getTime();
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null;
}

/** Whether this person's message notifications are silenced. */
export function isPeerMuted(peerId: string | null | undefined): boolean {
  const normalized = normalizePeerId(peerId);
  if (!normalized) return false;
  if (!cache.mutedPeers.some(muted => normalizePeerId(muted) === normalized)) return false;
  const expiresAt = cache.mutedPeerExpirations?.[normalized];
  return typeof expiresAt !== 'number' || expiresAt > Date.now();
}

export function isQuietHoursActive(
  target: NotificationPrefs['quietHours']['affects'],
  at: Date = new Date(),
): boolean {
  const { quietHours } = cache;
  if (!quietHours.enabled) return false;
  if (quietHours.affects !== 'both' && quietHours.affects !== target) return false;
  const start = quietHours.startMinutes;
  const end = quietHours.endMinutes;
  if (start === end) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

async function persist(next: NotificationPrefs): Promise<boolean> {
  cache = clonePrefs(next);
  // Anything already awaiting hydration should see the new value, not the file
  // it was reading when the user changed their mind.
  epoch += 1;
  hydration = Promise.resolve(getNotificationPrefs());
  notify();
  return saveNotificationPrefs(next);
}

/** Turn chat-message notifications on or off. */
export function setMessageNotificationsEnabled(enabled: boolean): Promise<boolean> {
  return persist({ ...cache, messageNotificationsEnabled: Boolean(enabled) });
}

export function setNotificationPreviewMode(
  previewMode: NotificationPrefs['previewMode'],
): Promise<boolean> {
  if (!['full', 'sender', 'generic'].includes(previewMode)) return Promise.resolve(false);
  return persist({ ...cache, previewMode });
}

export function setQuietHours(quietHours: NotificationPrefs['quietHours']): Promise<boolean> {
  const startMinutes = Number.isInteger(quietHours.startMinutes)
    ? Math.max(0, Math.min(1439, quietHours.startMinutes))
    : cache.quietHours.startMinutes;
  const endMinutes = Number.isInteger(quietHours.endMinutes)
    ? Math.max(0, Math.min(1439, quietHours.endMinutes))
    : cache.quietHours.endMinutes;
  const affects =
    quietHours.affects === 'calls' || quietHours.affects === 'both' || quietHours.affects === 'messages'
      ? quietHours.affects
      : cache.quietHours.affects;
  return persist({
    ...cache,
    quietHours: {
      enabled: Boolean(quietHours.enabled),
      startMinutes,
      endMinutes,
      affects,
    },
  });
}

/**
 * Mute or unmute one person's message notifications.
 *
 * @returns whether the preference was persisted
 */
export function setPeerMuted(
  peerId: string,
  muted: boolean,
  options: PeerMuteOptions = {},
): Promise<boolean> {
  const normalized = normalizePeerId(peerId);
  if (!normalized) return Promise.resolve(false);
  const without = cache.mutedPeers.filter(entry => normalizePeerId(entry) !== normalized);
  const mutedPeerExpirations = { ...cache.mutedPeerExpirations };
  delete mutedPeerExpirations[normalized];
  const expiresAt = muted ? expiryToTimestamp(options.expiresAt) : null;
  if (expiresAt !== null) mutedPeerExpirations[normalized] = expiresAt;
  return persist({
    ...cache,
    mutedPeers: muted ? [peerId.trim(), ...without] : without,
    mutedPeerExpirations,
  });
}

/**
 * Observe preference changes.
 *
 * @returns an unsubscribe function
 */
export function subscribeToNotificationPrefs(
  listener: (prefs: NotificationPrefs) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the cache and any hydration in flight. */
export function resetNotificationPrefsForTests() {
  cache = clonePrefs(DEFAULT_NOTIFICATION_PREFS);
  hydration = null;
  // A read left in flight by the previous test must not land in this one.
  epoch += 1;
  listeners.clear();
}
