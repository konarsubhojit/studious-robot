// @ts-check
import { useCallback, useEffect, useState } from 'react';
import { loadSettings, saveSettings } from '../settingsStorage';

export const DEFAULT_APP_SETTINGS = {
  autoCameraLightingEnabled: false,
  speakerEnabledByDefault: true,
  developerModeEnabled: false,
};

/**
 * Device-level preferences shared by every call: loaded once on mount and
 * persisted on every toggle.
 *
 * Extracted from the retired room-join hook (`useWebRTCCall`) so the settings
 * helpers outlive it and stay independently testable.
 *
 * @param {{ onStatus?: (message: string, severity?: 'info'|'success'|'error') => void }} [params]
 */
export default function useAppSettings({ onStatus } = {}) {
  const [settings, setSettings] = useState(DEFAULT_APP_SETTINGS);
  // Whether the lobby's (developer-mode) settings panel is expanded.
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSettings(DEFAULT_APP_SETTINGS).then(loaded => {
      if (cancelled) return;
      setSettings(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persistSetting = useCallback(
    (/** @type {string} */ key, /** @type {unknown} */ value, /** @type {string} */ message) => {
      setSettings(previous => {
        const next = { ...previous, [key]: value };
        void saveSettings(next);
        return next;
      });
      onStatus?.(message);
    },
    [onStatus],
  );

  const handleAutoLightingToggle = useCallback(() => {
    const nextValue = !settings.autoCameraLightingEnabled;
    persistSetting(
      'autoCameraLightingEnabled',
      nextValue,
      nextValue ? 'Auto camera lighting enabled' : 'Auto camera lighting disabled',
    );
  }, [persistSetting, settings.autoCameraLightingEnabled]);

  const handleSpeakerDefaultToggle = useCallback(() => {
    const nextValue = !settings.speakerEnabledByDefault;
    persistSetting(
      'speakerEnabledByDefault',
      nextValue,
      nextValue ? 'Speaker default enabled' : 'Speaker default disabled',
    );
  }, [persistSetting, settings.speakerEnabledByDefault]);

  const handleDeveloperModeToggle = useCallback(() => {
    const nextValue = !settings.developerModeEnabled;
    persistSetting(
      'developerModeEnabled',
      nextValue,
      nextValue ? 'Developer mode enabled' : 'Developer mode disabled',
    );
  }, [persistSetting, settings.developerModeEnabled]);

  return {
    settings,
    isSettingsVisible,
    setIsSettingsVisible,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleDeveloperModeToggle,
  };
}
