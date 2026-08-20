// @ts-check
import RNFS from 'react-native-fs';
import { logError, logWarn } from '../appLogger';
import { errorMessage } from '../errorMessage';

const NAVIGATION_STATE_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-navigation-state.json`;

/**
 * Last known navigation state, kept in memory so remounting the navigator —
 * which happens whenever a full-screen call takes over the shell and then ends
 * — restores the screen the user was on without waiting for a disk read.
 *
 * `undefined` means "not loaded yet"; `null` means "nothing persisted".
 */
/** @type {object|null|undefined} */
let cachedState;

/**
 * Minimal structural check on a persisted navigation state: React Navigation
 * throws on a malformed `initialState`, so a truncated or out-of-date file must
 * be treated as "no saved state" rather than crashing the app on launch.
 *
 * @param {unknown} state
 * @returns {boolean}
 */
export function isValidNavigationState(state) {
  if (!state || typeof state !== 'object') return false;
  const { routes, index } = /** @type {{ routes?: unknown, index?: unknown }} */ (state);
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
 * @returns {object | null | undefined} `undefined` when nothing has been
 *   loaded or saved yet in this process.
 */
export function getCachedNavigationState() {
  return cachedState;
}

/**
 * Load the persisted navigation state so the app can restore the last screen
 * after a cold start. Missing/corrupt state resolves to `null` (start fresh)
 * rather than throwing.
 *
 * @returns {Promise<object | null>}
 */
export async function loadNavigationState() {
  if (cachedState !== undefined) return cachedState;
  try {
    const exists = await RNFS.exists(NAVIGATION_STATE_FILE);
    if (!exists) {
      cachedState = null;
      return null;
    }
    const content = await RNFS.readFile(NAVIGATION_STATE_FILE, 'utf8');
    const parsed = JSON.parse(content);
    /** @type {object|null} */
    const restored = isValidNavigationState(parsed) ? parsed : null;
    cachedState = restored;
    return restored;
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
 * @param {object | undefined} state
 * @returns {Promise<boolean>} whether the write succeeded
 */
export async function saveNavigationState(state) {
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
 *
 * @returns {Promise<void>}
 */
export async function clearNavigationState() {
  cachedState = null;
  try {
    const exists = await RNFS.exists(NAVIGATION_STATE_FILE);
    if (exists) await RNFS.unlink(NAVIGATION_STATE_FILE);
  } catch (error) {
    logWarn('Failed to clear navigation state', { message: errorMessage(error) });
  }
}
