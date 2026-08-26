import { useCallback, useEffect, useState } from 'react';
import { loadSettings, saveSettings } from '../settingsStorage';
import {
  ICE_TRANSPORT_POLICIES,
  normalizeIceTransportPolicy,
  resetIceServersForCallCache,
} from '../webrtcConfig';
import type { IceTransportPolicy } from '../webrtcConfig';

export type AppSettingsValues = {
  autoCameraLightingEnabled: boolean;
  speakerEnabledByDefault: boolean;
  developerModeEnabled: boolean;
  iceTransportPolicy: IceTransportPolicy;
};

export const DEFAULT_APP_SETTINGS: AppSettingsValues = {
  autoCameraLightingEnabled: false,
  speakerEnabledByDefault: true,
  developerModeEnabled: false,
  iceTransportPolicy: ICE_TRANSPORT_POLICIES.ALL,
};

/**
 * Device-level preferences shared by every call: loaded once on mount and
 * persisted on every toggle.
 *
 * Extracted from the retired room-join hook (`useWebRTCCall`) so the settings
 * helpers outlive it and stay independently testable.
 */
export default function useAppSettings({ onStatus }: { onStatus?: (message: string, severity?: 'info' | 'success' | 'error') => void; } = {}) {
  const [settings, setSettings] = useState(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    loadSettings(DEFAULT_APP_SETTINGS).then(loaded => {
      if (cancelled) return;
      setSettings({
        ...loaded,
        iceTransportPolicy: normalizeIceTransportPolicy(loaded.iceTransportPolicy),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persistSetting = useCallback(
    (key: string, value: unknown, message: string) => {
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

  const handleIceTransportPolicyChange = useCallback(
    (policy: string) => {
      const nextPolicy = normalizeIceTransportPolicy(policy);
      if (nextPolicy === settings.iceTransportPolicy) return;
      resetIceServersForCallCache();
      persistSetting(
        'iceTransportPolicy',
        nextPolicy,
        nextPolicy === ICE_TRANSPORT_POLICIES.RELAY
          ? 'TURN relay forced for new calls'
          : 'ICE transport policy reset to default',
      );
    },
    [persistSetting, settings.iceTransportPolicy],
  );

  return {
    settings,
    handleAutoLightingToggle,
    handleSpeakerDefaultToggle,
    handleDeveloperModeToggle,
    handleIceTransportPolicyChange,
  };
}
