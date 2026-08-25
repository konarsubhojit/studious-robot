import { logInfo, logVerbose, logWarn } from './appLogger';
import { describeError } from './errors';

/**
 * Connectivity transitions, for the proactive half of mid-call recovery.
 *
 * A Wi-Fi→cellular handoff kills the old ICE path long before the peer
 * connection admits it: ICE sits in `disconnected` for seconds before reaching
 * `failed`, and that interval is the audio gap the user hears. Watching the
 * transport directly lets the call restart ICE the moment the interface
 * changes instead of waiting for the failure.
 *
 * `@react-native-community/netinfo` is loaded lazily and defensively — the same
 * optional-native-module pattern as `videoPlayback.ts` — so a build where the
 * native module is not linked simply falls back to the reactive path rather
 * than crashing the call screen.
 */

/** The part of a NetInfo state this app reacts to. */
export type NetworkSnapshot = {
  /** `wifi`, `cellular`, `none`, … — a change here is a path change. */
  type: string;
  /** Whether the transport claims to be usable. */
  isConnected: boolean;
};

/** Optional extra callbacks for {@link subscribeNetworkChanges}. */
export type NetworkChangeOptions = {
  /** Called when the transport reports it is no longer usable. */
  onConnectivityLost?: (snapshot: NetworkSnapshot) => void;
};

type NetInfoModule = {
  addEventListener: (listener: (state: unknown) => void) => (() => void) | undefined;
};

let _netInfoCache: NetInfoModule | null | undefined;

function loadNetInfo(): NetInfoModule | null {
  if (_netInfoCache !== undefined) return _netInfoCache;
  try {
    const module = require('@react-native-community/netinfo');
    const netInfo = module?.default ?? module;
    _netInfoCache = typeof netInfo?.addEventListener === 'function' ? netInfo : null;
    if (!_netInfoCache) logWarn('[Network] connectivity module exported no listener API');
  } catch (error) {
    logWarn('[Network] connectivity module is not linked; recovery stays reactive', {
      message: describeError(error),
    });
    _netInfoCache = null;
  }
  return _netInfoCache ?? null;
}

/** Reset the cached module (tests only). */
export function _resetNetworkMonitor() {
  _netInfoCache = undefined;
}

/** Whether connectivity changes can be observed on this build. */
export function isNetworkMonitorAvailable(): boolean {
  return Boolean(loadNetInfo());
}

function toSnapshot(state: unknown): NetworkSnapshot {
  const raw = (state ?? {}) as { type?: unknown; isConnected?: unknown };
  return {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    isConnected: raw.isConnected !== false,
  };
}

/**
 * Call `listener` whenever the device changes network path.
 *
 * Only *transitions* are reported: NetInfo re-emits its current state on
 * subscribe and on unrelated detail changes (signal strength, IP details),
 * none of which mean the media path moved.
 *
 * Losing connectivity is reported separately through
 * `options.onConnectivityLost`. There is still nothing to restart onto until it
 * comes back — but it is the one moment a caller's recovery budget should stop
 * running, because recovery is impossible until connectivity returns. This
 * signal used to be logged and dropped.
 *
 * @returns an unsubscribe function; safe to call when nothing was subscribed.
 */
export function subscribeNetworkChanges(
  listener: (change: { from: NetworkSnapshot | null; to: NetworkSnapshot; }) => void,
  options: NetworkChangeOptions = {}
): () => void {
  const netInfo = loadNetInfo();
  if (!netInfo) return () => {};

  let previous: NetworkSnapshot | null = null;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = netInfo.addEventListener(state => {
      const next = toSnapshot(state);
      const last = previous;
      previous = next;
      logVerbose('[Network] connectivity state', next);
      if (!last) return;
      if (last.type === next.type && last.isConnected === next.isConnected) return;
      if (!next.isConnected) {
        logInfo('[Network] connectivity lost', { from: last.type });
        try {
          options.onConnectivityLost?.(next);
        } catch (error) {
          logWarn('[Network] connectivity-lost listener threw', {
            message: describeError(error),
          });
        }
        return;
      }
      logInfo('[Network] connectivity changed', { from: last.type, to: next.type });
      try {
        listener({ from: last, to: next });
      } catch (error) {
        logWarn('[Network] connectivity listener threw', {
          message: describeError(error),
        });
      }
    });
  } catch (error) {
    logWarn('[Network] could not subscribe to connectivity changes', {
      message: describeError(error),
    });
    return () => {};
  }

  return () => {
    try {
      unsubscribe?.();
    } catch (error) {
      logWarn('[Network] connectivity unsubscribe failed', {
        message: describeError(error),
      });
    }
  };
}
