import { useCallback, useState } from 'react';
import { API_ROUTES } from '../../../shared';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import type { CallStatus } from '../components/StatusBanner';

export type ActiveDevice = {
  deviceId: string;
  platform: string | null;
  current: boolean;
  connected: boolean;
  activeSession: boolean;
  pushRegistered: boolean;
  lastRegisteredAt: string | null;
  lastUnregisteredAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
};

type AuthedFetch = (
  buildRequest: (sessionId: string) => { url: string; options?: object }
) => Promise<Response | null>;

export default function useDevices({
  signalingUrl,
  authedFetch,
  updateStatus,
}: {
  signalingUrl: string;
  authedFetch: AuthedFetch;
  updateStatus: (message: string, severity?: CallStatus['severity']) => void;
}) {
  const [devices, setDevices] = useState<ActiveDevice[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const trimmedUrl = signalingUrl.trim();

  const refreshDevices = useCallback(async () => {
    if (!trimmedUrl) return;
    setIsLoadingDevices(true);
    try {
      const response = await authedFetch(sessionId => ({
        url: `${trimmedUrl}${API_ROUTES.DEVICES}`,
        options: { headers: { authorization: 'Bearer ' + sessionId } },
      }));
      if (!response?.ok) {
        updateStatus('Could not load active devices.', 'warning');
        return;
      }
      const body = await response.json();
      setDevices(Array.isArray(body?.devices) ? body.devices : []);
    } catch (error) {
      logWarn('[Devices] refresh failed', { message: errorMessage(error) });
      updateStatus('Could not load active devices.', 'warning');
    } finally {
      setIsLoadingDevices(false);
    }
  }, [authedFetch, trimmedUrl, updateStatus]);

  const revokeDevice = useCallback(async (deviceId: string) => {
    const response = await authedFetch(sessionId => ({
      url: `${trimmedUrl}${API_ROUTES.DEVICES_REVOKE}`,
      options: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionId },
        body: JSON.stringify({ deviceId }),
      },
    }));
    if (!response?.ok) {
      updateStatus('Could not sign out that device.', 'error');
      return false;
    }
    await refreshDevices();
    updateStatus('Device signed out.', 'success');
    return true;
  }, [authedFetch, refreshDevices, trimmedUrl, updateStatus]);

  const revokeAllDevices = useCallback(async () => {
    const response = await authedFetch(sessionId => ({
      url: `${trimmedUrl}${API_ROUTES.DEVICES_REVOKE_ALL}`,
      options: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionId },
        body: JSON.stringify({}),
      },
    }));
    if (!response?.ok) {
      updateStatus('Could not sign out all devices.', 'error');
      return false;
    }
    setDevices([]);
    updateStatus('All devices signed out. Sign in again to continue.', 'success');
    return true;
  }, [authedFetch, trimmedUrl, updateStatus]);

  return {
    devices,
    isLoadingDevices,
    refreshDevices,
    revokeDevice,
    revokeAllDevices,
  };
}
