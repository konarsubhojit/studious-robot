import RNFS from 'react-native-fs';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errors';

/**
 * Which voice notes have been listened to.
 *
 * Auto-advance needs "unplayed" to mean something across visits: a note heard
 * yesterday must not be played again when the conversation is reopened today.
 * The set is therefore held in memory (so the chaining decision is a
 * synchronous lookup) and mirrored to a small JSON document through
 * `react-native-fs`, the same medium `settingsStorage` and `chatDb` use.
 */

const PLAYED_VOICE_NOTES_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-played-voice-notes.json`;

/** Retention: ids kept, oldest dropped first, so the file cannot grow unbounded. */
export const MAX_PLAYED_VOICE_NOTES = 500;

/** Writes are coalesced over this window so a run of notes costs one write. */
const WRITE_DEBOUNCE_MS = 250;

/** Insertion-ordered, which is what makes the oldest id the one to drop. */
let played = new Set<string>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushPlayedVoiceNotes();
  }, WRITE_DEBOUNCE_MS);
}

/** Write the set to disk now. Failures are logged, never thrown. */
export async function flushPlayedVoiceNotes(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    await RNFS.writeFile(
      PLAYED_VOICE_NOTES_FILE,
      JSON.stringify({ messageIds: [...played] }),
      'utf8',
    );
  } catch (error) {
    logWarn('[PlayedVoiceNotes] failed to persist', { message: errorMessage(error) });
  }
}

/**
 * Read the persisted set into memory. Concurrent callers share one read, and
 * an unreadable (or absent) file simply starts from empty rather than
 * throwing.
 */
export function hydratePlayedVoiceNotes(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const exists = await RNFS.exists(PLAYED_VOICE_NOTES_FILE);
      if (exists) {
        const content = await RNFS.readFile(PLAYED_VOICE_NOTES_FILE, 'utf8');
        const parsed = JSON.parse(content);
        const ids = Array.isArray(parsed?.messageIds) ? parsed.messageIds : [];
        // Ids marked while the read was in flight must survive it.
        const merged = new Set<string>(ids.filter((id: unknown) => typeof id === 'string' && id));
        played.forEach(id => merged.add(id));
        played = merged;
      }
    } catch (error) {
      logWarn('[PlayedVoiceNotes] failed to load; starting empty', {
        message: errorMessage(error),
      });
    } finally {
      hydrated = true;
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}

/** Whether this voice note has already been listened to. */
export function isVoiceNotePlayed(messageId: string | null | undefined): boolean {
  return Boolean(messageId) && played.has((messageId as string));
}

/** Record that this voice note has been listened to. */
export function markVoiceNotePlayed(messageId: string | null | undefined): void {
  if (!messageId || played.has(messageId)) return;
  played.add(messageId);
  while (played.size > MAX_PLAYED_VOICE_NOTES) {
    const oldest = played.values().next().value;
    if (oldest === undefined) break;
    played.delete(oldest);
  }
  scheduleWrite();
}

/** Reset the in-memory set (tests only). */
export function _resetPlayedVoiceNotes(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  played = new Set<string>();
  hydrated = false;
  hydratePromise = null;
}
