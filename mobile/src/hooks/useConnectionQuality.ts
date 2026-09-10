import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
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
import type { ConnectionQuality } from '../callUx';
import type { IceCandidatePairSummary } from '../diagnostics';
import { errorMessage } from '../errors';
import * as Telemetry from '../telemetry';
import { ICE_TRANSPORT_POLICIES } from '../webrtcConfig';

const STATS_POLL_INTERVAL_MS = 7000;
const CANDIDATE_PAIR_POLL_INTERVAL_MS = STATS_POLL_INTERVAL_MS * 9;
const NO_LINK_CONNECTION_QUALITY: ConnectionQuality = { bars: 0, label: 'No link' };

type StatsReport = {
  forEach: (fn: (stat: any) => void) => void;
  get?: (id: unknown) => any;
};

type PeerConnectionLike = {
  getStats?: (selector?: any) => Promise<StatsReport | null | undefined>;
};

type RemoteStreamLike = {
  getVideoTracks?: () => unknown[];
};

type UseConnectionQualityParams = {
  activeCallIdRef: RefObject<string | null>;
  activeIceTransportPolicy: string;
  isInCall: boolean;
  peerConnectionRef: RefObject<PeerConnectionLike | null>;
  remoteStreamRef: RefObject<RemoteStreamLike | null>;
  updateStatus: (message: string, severity?: 'info' | 'success' | 'warning' | 'error') => void;
};

function areConnectionQualitiesEqual(left: ConnectionQuality, right: ConnectionQuality): boolean {
  return left.bars === right.bars && left.label === right.label;
}

async function getConnectionQualityReports(
  peerConnection: PeerConnectionLike,
  remoteVideoTrack: unknown,
  shouldPollCandidatePair: boolean,
) {
  if (!peerConnection.getStats) return { candidatePairReport: null, report: null };
  const candidatePairReport = shouldPollCandidatePair ? await peerConnection.getStats() : null;
  const report = remoteVideoTrack
    ? await peerConnection.getStats(remoteVideoTrack)
    : candidatePairReport;
  return { candidatePairReport, report };
}

function selectedCandidatePairFromReports(
  report: StatsReport,
  candidatePairReport: StatsReport | null | undefined,
  callStats: { candidatePair: any },
) {
  if (!candidatePairReport) return null;
  if (candidatePairReport === report) return callStats.candidatePair;
  return collectCallStats(candidatePairReport).candidatePair;
}

export default function useConnectionQuality({
  activeCallIdRef,
  activeIceTransportPolicy,
  isInCall,
  peerConnectionRef,
  remoteStreamRef,
  updateStatus,
}: UseConnectionQualityParams) {
  const [connectionQuality, setConnectionQuality] = useState(NO_LINK_CONNECTION_QUALITY);
  const [selectedCandidatePair, setSelectedCandidatePair] = useState(
    null as IceCandidatePairSummary | null,
  );
  const qualitySmootherRef = useRef(
    null as { reported: ConnectionQuality; pendingWorse: number } | null,
  );
  const connectionStatsRef = useRef({
    timestampMs: null,
    totalBytesReceived: 0,
  } as { timestampMs: number | null; totalBytesReceived: number });
  const selectedCandidatePairRef = useRef(null as string | null);

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
      setConnectionQuality(current =>
        areConnectionQualitiesEqual(current, NO_LINK_CONNECTION_QUALITY)
          ? current
          : NO_LINK_CONNECTION_QUALITY,
      );
      qualitySmootherRef.current = null;
      connectionStatsRef.current = { timestampMs: null, totalBytesReceived: 0 };
      selectedCandidatePairRef.current = null;
      setSelectedCandidatePair(null);
      return undefined;
    }

    let cancelled = false;
    let pollsSinceCandidatePair = 0;
    const pollStats = async () => {
      const pc = peerConnectionRef.current;
      if (!pc || typeof pc.getStats !== 'function') return;

      try {
        const remoteVideoTrack = remoteStreamRef.current?.getVideoTracks?.()[0];
        const shouldPollCandidatePair =
          !remoteVideoTrack ||
          pollsSinceCandidatePair >=
            CANDIDATE_PAIR_POLL_INTERVAL_MS / STATS_POLL_INTERVAL_MS - 1;
        if (remoteVideoTrack) {
          pollsSinceCandidatePair = shouldPollCandidatePair ? 0 : pollsSinceCandidatePair + 1;
        }
        const { candidatePairReport, report } = await getConnectionQualityReports(
          pc,
          remoteVideoTrack,
          shouldPollCandidatePair,
        );
        if (cancelled) return;
        if (!report || typeof report.forEach !== 'function') return;

        const callStats = collectCallStats(report);
        const {
          rttMs,
          totalPacketsLost,
          totalPacketsReceived,
          totalBytesReceived,
        } = callStats;
        const succeededCandidatePair = selectedCandidatePairFromReports(
          report,
          candidatePairReport,
          callStats,
        );

        if (succeededCandidatePair) {
          const getReportStat =
            typeof report.get === 'function' ? (id: unknown) => report.get?.(id) : () => undefined;
          noteSelectedCandidatePair(
            summarizeCandidatePair(succeededCandidatePair, getReportStat),
            succeededCandidatePair,
          );
        }

        const sampleTimestampMs = Date.now();
        const bitrateKbps = deriveBitrateKbps(connectionStatsRef.current, {
          timestampMs: sampleTimestampMs,
          totalBytesReceived,
        });
        connectionStatsRef.current = { timestampMs: sampleTimestampMs, totalBytesReceived };

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
        setConnectionQuality(current =>
          areConnectionQualitiesEqual(current, nextQuality) ? current : nextQuality,
        );

        if (shouldWarnPoorConnection({ bars: nextQuality.bars, packetLossRatio })) {
          updateStatus('Poor connection — high packet loss detected', 'error');
        }
      } catch (error) {
        logWarn('[CallFlow] Failed to read connection stats', {
          message: errorMessage(error),
        });
      }
    };

    let intervalId = null as ReturnType<typeof setInterval> | null;
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
  }, [isInCall, noteSelectedCandidatePair, peerConnectionRef, remoteStreamRef, updateStatus]);

  return {
    connectionQuality,
    selectedCandidatePair,
  };
}
