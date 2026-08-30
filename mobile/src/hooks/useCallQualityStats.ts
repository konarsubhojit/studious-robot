import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logInfo, logWarn } from '../appLogger';
import {
  candidatePairKey,
  collectCallStats,
  deriveBitrateKbps,
  derivePacketLossRatio,
  getConnectionQuality,
  isRelayPolicyViolated,
  shouldWarnPoorConnection,
  smoothConnectionQuality,
  summarizeCandidatePair,
} from '../callUx';
import { errorMessage } from '../errors';
import * as Telemetry from '../telemetry';
import { ICE_TRANSPORT_POLICIES } from '../webrtcConfig';
import type { IceCandidatePairSummary } from '../diagnostics';

/** How often `getStats()` is sampled while the app is in the foreground. */
const STATS_POLL_INTERVAL_MS = 7000;

type MutableRef<T> = { current: T };

/** What the indicator reports: a 0–4 bar count and the label beside it. */
export type ConnectionQuality = { bars: number; label: string };

/** The minimum of `RTCPeerConnection` this hook needs to sample. */
type StatsSource = { getStats?: () => Promise<any> } | null;

export type UseCallQualityStatsParams = {
  /** True only while a call is actually up; polling is scoped to this. */
  isInCall: boolean;
  /** Owned by `useCallFlow`; read (never written) on each poll. */
  peerConnectionRef: MutableRef<StatsSource>;
  /** Owned by `useCallFlow`; identifies the call a candidate pair belongs to. */
  activeCallIdRef: MutableRef<string | null>;
  /** Relay-only calls warn when a non-relay pair is selected. */
  activeIceTransportPolicy: string;
  /** Raises the "poor connection" banner. Must be referentially stable. */
  updateStatus: (message: string, severity?: 'error') => void;
};

export type CallQualityStats = {
  /** Current smoothed quality, for the in-call indicator. */
  connectionQuality: ConnectionQuality;
  /** The ICE pair currently carrying media, for diagnostics. */
  selectedCandidatePair: IceCandidatePairSummary | null;
  /**
   * Mirror of `connectionQuality`, so the call-end summary can read the last
   * label from a callback without taking the state as a dependency.
   */
  connectionQualityRef: MutableRef<ConnectionQuality>;
  /**
   * Clear the sampled state when the peer connection is torn down. Stable for
   * the lifetime of the hook, so callers may keep empty dependency arrays.
   */
  resetConnectionQuality: () => void;
};

/**
 * Owns the in-call connection-quality indicator: the `getStats()` poll, the
 * hysteresis smoother behind the bars, and the selected-ICE-candidate-pair
 * reporting that goes with it.
 *
 * Everything with a lifetime lives inside the single effect below — the
 * polling interval and the `AppState` subscription are both created and
 * cleared there, so neither can outlive the call or be cancelled by anything
 * else. The three refs the poll accumulates into (`qualitySmootherRef`,
 * `connectionStatsRef`, `selectedCandidatePairRef`) are declared here too, so
 * no sampling state is written from outside this module. `useCallFlow` reaches
 * in only through `resetConnectionQuality`, which is deliberately stable.
 *
 * Polling is a foreground-only concern: `getStats()` walks the whole report
 * every 7 seconds, and while the app is backgrounded there is no indicator on
 * screen to consume the result — only battery to spend on it.
 *
 * @param params
 */
export default function useCallQualityStats({
  isInCall,
  peerConnectionRef,
  activeCallIdRef,
  activeIceTransportPolicy,
  updateStatus,
}: UseCallQualityStatsParams): CallQualityStats {
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>({
    bars: 0,
    label: 'No link',
  });
  const [selectedCandidatePair, setSelectedCandidatePair] = useState(
    (null as IceCandidatePairSummary | null),
  );
  const connectionQualityRef = useRef<ConnectionQuality>({ bars: 0, label: 'No link' });
  // Hysteresis state for the quality indicator: a single bad sample must not
  // be allowed to flip the bars, so the smoother remembers how many
  // consecutive worse samples have been seen. Reset whenever a call ends.
  const qualitySmootherRef = useRef(
    (null as { reported: ConnectionQuality; pendingWorse: number; } | null),
  );
  const connectionStatsRef = useRef(
    ({
      timestampMs: null,
      totalBytesReceived: 0,
    } as { timestampMs: number | null, totalBytesReceived: number }),
  );
  const selectedCandidatePairRef = useRef((null as string | null));

  useEffect(() => {
    connectionQualityRef.current = connectionQuality;
  }, [connectionQuality]);

  const resetConnectionQuality = useCallback(() => {
    setConnectionQuality({ bars: 0, label: 'No link' });
    connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
  }, []);

  /**
   * Record a newly selected ICE candidate pair, once per selection.
   *
   * `getStats` reports the same pair on every poll, so this is keyed on the
   * pair's identity: telemetry, the log line and the relay-policy warning fire
   * when the route changes, not seven seconds apart forever.
   */
  const noteSelectedCandidatePair = useCallback(
    (
      summary: IceCandidatePairSummary,
      candidatePair: {
        id?: unknown;
        localCandidateId?: unknown;
        remoteCandidateId?: unknown;
      },
    ) => {
      const key = candidatePairKey(candidatePair, summary);
      if (key === selectedCandidatePairRef.current) return;
      selectedCandidatePairRef.current = key;
      setSelectedCandidatePair(summary);
      logInfo('[CallFlow] ICE candidate pair selected', summary);
      if (activeCallIdRef.current) {
        Telemetry.trackSelectedCandidatePair(activeCallIdRef.current, summary.local);
      }
      if (
        isRelayPolicyViolated({
          isRelayOnly: activeIceTransportPolicy === ICE_TRANSPORT_POLICIES.RELAY,
          summary,
        })
      ) {
        logWarn('[CallFlow] Relay ICE policy selected a non-relay candidate pair', summary);
      }
    },
    [activeCallIdRef, activeIceTransportPolicy],
  );

  useEffect(() => {
    if (!isInCall) {
      setConnectionQuality({ bars: 0, label: 'No link' });
      qualitySmootherRef.current = null;
      connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
      selectedCandidatePairRef.current = null;
      setSelectedCandidatePair(null);
      return undefined;
    }

    let cancelled = false;
    const pollStats = async () => {
      const pc = peerConnectionRef.current;
      if (!pc || typeof pc.getStats !== 'function') return;

      try {
        const report = await pc.getStats();
        if (cancelled) return;
        if (!report || typeof report.forEach !== 'function') return;

        const {
          rttMs,
          totalPacketsLost,
          totalPacketsReceived,
          totalBytesReceived,
          candidatePair: succeededCandidatePair,
        } = collectCallStats(report);

        if (succeededCandidatePair) {
          const getReportStat =
            typeof report.get === 'function' ? (id: unknown) => report.get(id) : () => undefined;
          noteSelectedCandidatePair(
            summarizeCandidatePair(succeededCandidatePair, getReportStat),
            succeededCandidatePair,
          );
        }

        const now = Date.now();
        const bitrateKbps = deriveBitrateKbps(connectionStatsRef.current, {
          timestampMs: now,
          totalBytesReceived,
        });
        connectionStatsRef.current = { timestampMs: now, totalBytesReceived };

        const packetLossRatio = derivePacketLossRatio({
          totalPacketsLost,
          totalPacketsReceived,
        });
        const sampledQuality = getConnectionQuality({
          rttMs,
          packetLossRatio,
          bitrateKbps,
        });
        qualitySmootherRef.current = smoothConnectionQuality(
          qualitySmootherRef.current,
          sampledQuality,
        );
        const nextQuality = qualitySmootherRef.current.reported;
        setConnectionQuality(nextQuality);

        // Surface a status warning when packet loss is severe enough to impair
        // the call.  Only update status on the downgrade crossing so the message
        // doesn't flicker; recovery is silent (the bars update speaks for itself).
        if (shouldWarnPoorConnection({ bars: nextQuality.bars, packetLossRatio })) {
          updateStatus('Poor connection — high packet loss detected', 'error');
        }
      } catch (error) {
        logWarn('[CallFlow] Failed to read connection stats', {
          message: errorMessage(error),
        });
      }
    };

    // A foreground transition takes a sample straight away so the bars are
    // current by the time the user can see them.
    let intervalId = (null as ReturnType<typeof setInterval> | null);
    const startPolling = () => {
      if (intervalId) return;
      pollStats();
      intervalId = setInterval(pollStats, STATS_POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    if (AppState.currentState !== 'background') startPolling();
    const subscription = AppState.addEventListener?.('change', nextState => {
      if (nextState === 'background') stopPolling();
      else startPolling();
    });

    return () => {
      cancelled = true;
      stopPolling();
      subscription?.remove?.();
    };
  }, [isInCall, noteSelectedCandidatePair, peerConnectionRef, updateStatus]);

  return {
    connectionQuality,
    selectedCandidatePair,
    connectionQualityRef,
    resetConnectionQuality,
  };
}
