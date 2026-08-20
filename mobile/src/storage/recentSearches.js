// @ts-check
import RNFS from 'react-native-fs';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errorMessage';

/**
 * Locally persisted recent search terms, so re-opening search offers what the
 * user looked for last time instead of a blank slate.
 *
 * Persisted as a small JSON document through `react-native-fs`, the same
 * medium `settingsStorage` and `chatDb` already use, so no native dependency
 * is taken on for it.
 */

const RECENT_SEARCHES_FILE = `${RNFS.DocumentDirectoryPath}/wetalk-recent-searches.json`;

/** How many terms are kept; older ones fall off the end. */
export const MAX_RECENT_SEARCHES = 8;

/** @type {string[] | null} */
let cache = null;

/**
 * Coerce a parsed file into a list of usable terms, dropping anything
 * malformed so a corrupt file degrades to "no recent searches".
 *
 * @param {unknown} parsed
 * @returns {string[]}
 */
function sanitize(parsed) {
  if (!Array.isArray(parsed)) return [];
  /** @type {string[]} */
  const terms = [];
  parsed.forEach(entry => {
    const term = typeof entry === 'string' ? entry.trim() : '';
    if (term && !terms.includes(term)) terms.push(term);
  });
  return terms.slice(0, MAX_RECENT_SEARCHES);
}

/**
 * Read the persisted recent searches, newest first.  Never rejects: an
 * unreadable file yields an empty list.
 *
 * @returns {Promise<string[]>}
 */
export async function loadRecentSearches() {
  if (cache) return [...cache];
  try {
    const exists = await RNFS.exists(RECENT_SEARCHES_FILE);
    cache = exists ? sanitize(JSON.parse(await RNFS.readFile(RECENT_SEARCHES_FILE, 'utf8'))) : [];
  } catch (error) {
    logWarn('[RecentSearches] Failed to load recent searches', { message: errorMessage(error) });
    cache = [];
  }
  return [...cache];
}

/**
 * Record `term` as the newest recent search (de-duplicated, capped) and
 * persist the list.  Failures are logged, never thrown.
 *
 * @param {string} term
 * @returns {Promise<string[]>} the updated list, newest first.
 */
export async function addRecentSearch(term) {
  const trimmed = (term ?? '').trim();
  const existing = await loadRecentSearches();
  if (!trimmed) return existing;

  const next = [trimmed, ...existing.filter(entry => entry !== trimmed)].slice(
    0,
    MAX_RECENT_SEARCHES,
  );
  cache = next;
  try {
    await RNFS.writeFile(RECENT_SEARCHES_FILE, JSON.stringify(next), 'utf8');
  } catch (error) {
    logWarn('[RecentSearches] Failed to persist recent searches', { message: errorMessage(error) });
  }
  return [...next];
}

/**
 * Forget every recent search (the "Clear" affordance, and sign-out).
 *
 * @returns {Promise<void>}
 */
export async function clearRecentSearches() {
  cache = [];
  try {
    const exists = await RNFS.exists(RECENT_SEARCHES_FILE);
    if (exists) await RNFS.unlink(RECENT_SEARCHES_FILE);
  } catch (error) {
    logWarn('[RecentSearches] Failed to clear recent searches', { message: errorMessage(error) });
  }
}

/** Test seam: forget the in-memory cache so the next load re-reads the file. */
export function resetRecentSearchesCache() {
  cache = null;
}

export const RECENT_SEARCHES_FILE_PATH = RECENT_SEARCHES_FILE;
