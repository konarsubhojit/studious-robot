import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { logError } from './appLogger';
import useHighContrast from './hooks/useHighContrast';
import { loadThemePreferences, saveThemePreferences } from './settingsStorage';
import ThemeContext, { buildTheme } from './ThemeContext';
import {
  buildPalette,
  DEFAULT_THEME_PREFERENCES,
  resolveContrast,
  resolveScheme,
  setTextScale,
} from './theme';
import type { ThemePreferences } from './theme';
import type { ReactNode } from 'react';

/**
 * Provides the active palette to the tree and keeps it in sync with both the
 * OS (`useColorScheme` and `useHighContrast` re-render on a device settings
 * change, so the app follows them without a restart) and the user's manual
 * overrides, which are persisted so they survive a relaunch.
 *
 * Kept apart from `ThemeContext` so the leaf components that only need
 * `useTheme()`/`useThemedStyles()` don't pull the persistence layer (and its
 * native `react-native-fs` dependency) into their import graph.
 *
 * **Children are not mounted until the persisted preferences have been read.**
 * The store is asynchronous, so rendering immediately meant a user who had
 * pinned the scheme opposite to the OS one saw a frame in the wrong scheme —
 * and, once accents and true black existed, a frame in the wrong colours
 * entirely. The gap is a single async tick and is filled with a plain view in
 * the OS-appropriate background colour, which is the colour the native window
 * is already painted (see the Android `styles.xml` / `values-night`), so the
 * launch reads as one continuous surface rather than a flash.
 *
 * @param props.initialMode - Seed mode before the persisted one loads.
 */
export default function ThemeProvider({
  initialMode = DEFAULT_THEME_PREFERENCES.mode,
  children,
}: {
  initialMode?: ThemePreferences['mode'];
  children: ReactNode;
}) {
  const systemScheme = useColorScheme();
  const systemHighContrast = useHighContrast();
  const [preferences, setPreferences] = useState<ThemePreferences>(() => ({
    ...DEFAULT_THEME_PREFERENCES,
    mode: initialMode,
  }));
  const [isResolved, setIsResolved] = useState(false);
  // Mirrors the state so `setPreference` can build the next value — and write
  // it — outside the state updater. React does not promise to call an updater
  // exactly once, and an updater that performs I/O would write twice under
  // StrictMode. Assigned synchronously wherever the state changes, so two
  // changes in the same tick still compose.
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    let cancelled = false;
    loadThemePreferences()
      .then(stored => {
        if (cancelled) return;
        // The text size mutates the shared typography tokens, so it has to be
        // applied before anything builds a stylesheet from them.
        setTextScale(stored.textScale);
        preferencesRef.current = stored;
        setPreferences(stored);
      })
      .catch(error => {
        logError('Failed to load the persisted theme preferences', { message: error?.message });
      })
      .finally(() => {
        // Resolved either way: a store that cannot be read must not leave the
        // app permanently blank.
        if (!cancelled) setIsResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback(
    <K extends keyof ThemePreferences>(key: K, value: ThemePreferences[K]) => {
      const previous = preferencesRef.current;
      if (previous[key] === value) return;

      const next = { ...previous, [key]: value };
      preferencesRef.current = next;
      if (key === 'textScale') setTextScale(next.textScale);
      setPreferences(next);
      void saveThemePreferences(next);
    },
    [],
  );

  const setMode = useCallback(
    (nextMode: ThemePreferences['mode']) => setPreference('mode', nextMode),
    [setPreference],
  );

  const scheme = resolveScheme(preferences.mode, systemScheme);
  const contrast = resolveContrast(preferences.contrast, systemHighContrast);

  const value = useMemo(
    () => buildTheme(preferences.mode, scheme, setMode, { preferences, contrast, setPreference }),
    [contrast, preferences, scheme, setMode, setPreference],
  );

  if (!isResolved) {
    return (
      <View
        style={[styles.gate, { backgroundColor: buildPalette({ scheme }).background }]}
        testID="theme-loading"
      />
    );
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
  },
});
