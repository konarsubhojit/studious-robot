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

let cache: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
let hydration: Promise<NotificationPrefs> | null = null;
const listeners = new Set<(prefs: NotificationPrefs) => void>();

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
    hydration = loadNotificationPrefs().then(loaded => {
      cache = loaded;
      notify();
      return getNotificationPrefs();
    });
  }
  return hydration;
}

/** Current preferences. Defaults until `ensureNotificationPrefsLoaded` settles. */
export function getNotificationPrefs(): NotificationPrefs {
  return { ...cache, mutedPeers: [...cache.mutedPeers] };
}

/** Whether chat-message notifications are allowed at all. */
export function areMessageNotificationsEnabled(): boolean {
  return cache.messageNotificationsEnabled;
}

/** Whether this person's message notifications are silenced. */
export function isPeerMuted(peerId: string | null | undefined): boolean {
  const normalized = normalizePeerId(peerId);
  if (!normalized) return false;
  return cache.mutedPeers.some(muted => normalizePeerId(muted) === normalized);
}

async function persist(next: NotificationPrefs): Promise<boolean> {
  cache = next;
  // Anything already awaiting hydration should see the new value, not the file
  // it was reading when the user changed their mind.
  hydration = Promise.resolve(getNotificationPrefs());
  notify();
  return saveNotificationPrefs(next);
}

/** Turn chat-message notifications on or off. */
export function setMessageNotificationsEnabled(enabled: boolean): Promise<boolean> {
  return persist({ ...cache, messageNotificationsEnabled: Boolean(enabled) });
}

/**
 * Mute or unmute one person's message notifications.
 *
 * @returns whether the preference was persisted
 */
export function setPeerMuted(peerId: string, muted: boolean): Promise<boolean> {
  const normalized = normalizePeerId(peerId);
  if (!normalized) return Promise.resolve(false);
  const without = cache.mutedPeers.filter(entry => normalizePeerId(entry) !== normalized);
  return persist({
    ...cache,
    mutedPeers: muted ? [peerId.trim(), ...without] : without,
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
  cache = { ...DEFAULT_NOTIFICATION_PREFS };
  hydration = null;
  listeners.clear();
}
