import { useCallback, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { logError } from './appLogger';
import { loadThemeMode, saveThemeMode } from './settingsStorage';
import ThemeContext, { buildTheme } from './ThemeContext';
import { resolveScheme, THEME_MODES } from './theme';

/**
 * Provides the active palette to the tree and keeps it in sync with both the
 * OS colour scheme (`useColorScheme` re-renders on a device theme change, so
 * the app follows it without a restart) and the user's manual override, which
 * is persisted so it survives a relaunch.
 *
 * Kept apart from `ThemeContext` so the leaf components that only need
 * `useTheme()`/`useThemedStyles()` don't pull the persistence layer (and its
 * native `react-native-fs` dependency) into their import graph.
 *
 * @param {object} props
 * @param {string} [props.initialMode] - Seed mode before the persisted one loads.
 * @param {import('react').ReactNode} props.children
 */
export default function ThemeProvider({ initialMode = THEME_MODES.SYSTEM, children }: { initialMode?: string; children: import('react').ReactNode; }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState(initialMode);

  // The stored preference is read asynchronously (there is no synchronous
  // store on the device), so a user who pinned a scheme opposite to the OS one
  // sees a single frame in the OS scheme before it applies.
  useEffect(() => {
    let cancelled = false;
    loadThemeMode()
      .then(stored => {
        if (!cancelled) setModeState(stored);
      })
      .catch(error => {
        logError('Failed to load the persisted theme mode', { message: error?.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(
      (nextMode: string) => {
      setModeState(nextMode);
      void saveThemeMode(nextMode);
    },
    [],
  );

  const value = useMemo(
    () => buildTheme(mode, resolveScheme(mode, systemScheme), setMode),
    [mode, systemScheme, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
