import RNFS from 'react-native-fs';
import { logError, logWarn } from '../appLogger';
import type { InitialState } from '@react-navigation/native';

/**
 * Persisted React Navigation state, in the partial shape the container accepts
 * as `initialState`.
 */
export type PersistedNavigationState = InitialState;

const NAVIGATION_STATE_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-navigation-state.json`;

/**
 * @returns the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Last known navigation state, kept in memory so remounting the navigator —
 * which happens whenever a full-screen call takes over the shell and then ends
 * — restores the screen the user was on without waiting for a disk read.
 *
 * `undefined` means "not loaded yet"; `null` means "nothing persisted".
 */
let cachedState: PersistedNavigationState | null | undefined;

/**
 * Minimal structural check on a persisted navigation state: React Navigation
 * throws on a malformed `initialState`, so a truncated or out-of-date file must
 * be treated as "no saved state" rather than crashing the app on launch.
 */
export function isValidNavigationState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const { routes, index } = (state as { routes?: unknown, index?: unknown });
  if (!Array.isArray(routes) || routes.length === 0) return false;
  if (index !== undefined && (typeof index !== 'number' || index < 0 || index >= routes.length)) {
    return false;
  }
  return routes.every(route => Boolean(route) && typeof route.name === 'string');
}

/**
 * Synchronously read the in-memory navigation state, so a remount (e.g. a
 * full-screen call ending) can restore without a blank frame.
 *
 * @returns `undefined` when nothing has been
 *   loaded or saved yet in this process.
 */
export function getCachedNavigationState(): PersistedNavigationState | null | undefined {
  return cachedState;
}

/**
 * Load the persisted navigation state so the app can restore the last screen
 * after a cold start. Missing/corrupt state resolves to `null` (start fresh)
 * rather than throwing.
 */
export async function loadNavigationState(): Promise<PersistedNavigationState | null> {
  if (cachedState !== undefined) return cachedState;
  try {
    const exists = await RNFS.exists(NAVIGATION_STATE_FILE);
    if (!exists) {
      cachedState = null;
      return null;
    }
    const content = await RNFS.readFile(NAVIGATION_STATE_FILE, 'utf8');
    const parsed = JSON.parse(content);
    const loaded: PersistedNavigationState | null = isValidNavigationState(parsed) ? parsed : null;
    cachedState = loaded;
    return loaded;
  } catch (error) {
    logWarn('Failed to load navigation state; starting at the default screen', {
      message: errorMessage(error),
    });
    cachedState = null;
    return null;
  }
}

/**
 * Persist the current navigation state. Write failures are logged but never
 * thrown: losing state restoration must not break navigation itself.
 *
 * @returns whether the write succeeded
 */
export async function saveNavigationState(state: PersistedNavigationState | undefined): Promise<boolean> {
  if (!isValidNavigationState(state)) return false;
  cachedState = state;
  try {
    await RNFS.writeFile(NAVIGATION_STATE_FILE, JSON.stringify(state), 'utf8');
    return true;
  } catch (error) {
    logError('Failed to persist navigation state', { message: errorMessage(error) });
    return false;
  }
}

/**
 * Forget the persisted navigation state, e.g. on sign-out so the next user
 * does not land inside the previous one's conversation.
 */
export async function clearNavigationState(): Promise<void> {
  cachedState = null;
  try {
    const exists = await RNFS.exists(NAVIGATION_STATE_FILE);
    if (exists) await RNFS.unlink(NAVIGATION_STATE_FILE);
  } catch (error) {
    logWarn('Failed to clear navigation state', { message: errorMessage(error) });
  }
}
