import { useCallback, useEffect, useRef, useState } from 'react';
import { logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import {
  clearCachedMedia,
  describeClearMediaResult,
  EMPTY_STORAGE_USAGE,
  measureStorageUsage,
} from '../storageUsage';
import type { StorageUsage } from '../storageUsage';

/**
 * Owns the "Storage & data" numbers Settings shows, and the one action that
 * changes them.
 *
 * Measurement is deliberately *not* run on mount: walking the app's
 * directories costs a filesystem crawl that nothing outside Settings needs, so
 * the screen asks for it when it appears (`onRefreshStorage`) and again after
 * a clear. A stale number on a screen nobody is looking at is worse than no
 * number at all.
 *
 * @param onStatus Reports the outcome of a clear through the app's usual
 *   status line, so this hook never has to render anything itself.
 */
export default function useStorageUsage({
  onStatus,
}: { onStatus?: (message: string, severity?: 'info' | 'success' | 'error') => void } = {}) {
  const [storageUsage, setStorageUsage] = useState((EMPTY_STORAGE_USAGE as StorageUsage));
  const [isMeasuringStorage, setIsMeasuringStorage] = useState(false);
  const [isClearingMedia, setIsClearingMedia] = useState(false);

  // A measurement can outlive the screen that asked for it (leave Settings
  // while the crawl is in flight), and resolving into an unmounted tree is a
  // React warning plus a pointless render.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshStorageUsage = useCallback(async () => {
    setIsMeasuringStorage(true);
    try {
      const usage = await measureStorageUsage();
      if (isMountedRef.current) setStorageUsage(usage);
    } catch (error) {
      // A failed measurement is not worth a status line of its own: the row
      // keeps saying "unavailable", which is the truth.
      logWarn('[StorageUsage] Measurement failed', { message: errorMessage(error) });
    } finally {
      if (isMountedRef.current) setIsMeasuringStorage(false);
    }
  }, []);

  const clearMedia = useCallback(async () => {
    setIsClearingMedia(true);
    try {
      const result = await clearCachedMedia();
      onStatus?.(
        describeClearMediaResult(result),
        result.failedFiles > 0 ? 'error' : 'success',
      );
    } catch (error) {
      logWarn('[StorageUsage] Clear failed', { message: errorMessage(error) });
      onStatus?.('Cached media could not be removed.', 'error');
    } finally {
      if (isMountedRef.current) setIsClearingMedia(false);
      await refreshStorageUsage();
    }
  }, [onStatus, refreshStorageUsage]);

  return {
    storageUsage,
    isMeasuringStorage,
    isClearingMedia,
    refreshStorageUsage,
    clearCachedMedia: clearMedia,
  };
}
