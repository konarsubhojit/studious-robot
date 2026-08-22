// @ts-check
import { useCallback, useEffect, useState } from 'react';
import {
  addRecentSearch,
  clearRecentSearches,
  loadRecentSearches,
} from '../storage/recentSearches';

/**
 * Recent search terms, loaded from local storage on mount and kept in sync
 * with it as the user searches.
 *
 * Lives outside `SearchScreen` so that screen stays presentational (and its
 * tests stay free of the filesystem), matching how the other screens receive
 * their data as props.
 *
 * @returns {{ recentSearches: string[], recordSearch: (term: string) => void,
 *   clearSearches: () => void }}
 */
export default function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState(/** @type {string[]} */ ([]));

  useEffect(() => {
    let cancelled = false;
    loadRecentSearches().then(terms => {
      if (!cancelled) setRecentSearches(terms);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const recordSearch = useCallback((/** @type {string} */ term) => {
    addRecentSearch(term).then(setRecentSearches);
  }, []);

  const clearSearches = useCallback(() => {
    setRecentSearches([]);
    clearRecentSearches();
  }, []);

  return { recentSearches, recordSearch, clearSearches };
}
