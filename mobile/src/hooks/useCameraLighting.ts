import { useCallback, useEffect, useRef } from 'react';
import { logError, logInfo } from '../appLogger';
import { applyLightingAdjustment } from '../cameraLighting';

// How often to re-evaluate ambient lighting and auto-adjust the camera. Chosen
// to stay responsive to lighting changes while avoiding frequent
// applyConstraints calls that would add unnecessary CPU/battery overhead.
const LIGHTING_ADJUST_INTERVAL_MS = 8000;

/**
 * Periodically auto-adjusts the local camera for ambient lighting while the
 * "Auto camera lighting" preference is on and a local stream exists.
 *
 * Extracted from the retired room-join hook (`useWebRTCCall`) so the shared
 * media helper survives it as an isolated, testable concern.
 *
 * @param {{ localStream?: any, enabled?: boolean }} params `localStream` is a
 *   `MediaStream`, or anything falsy.
 */
export default function useCameraLighting({ localStream = null, enabled = false }: { localStream?: any; enabled?: boolean; }) {
  const localStreamRef = useRef(localStream);
  localStreamRef.current = localStream;

  const adjustCameraLighting = useCallback(async () => {
    try {
      const stream = localStreamRef.current;
      if (!stream?.getVideoTracks) return;
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) return;
      await applyLightingAdjustment(videoTrack);
    } catch (error) {
      logError('Camera lighting auto-adjust failed', error);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !localStream) return undefined;
    logInfo('Starting camera lighting auto-adjust monitor');
    void adjustCameraLighting();
    const intervalId = setInterval(() => {
      void adjustCameraLighting();
    }, LIGHTING_ADJUST_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [adjustCameraLighting, enabled, localStream]);
}
