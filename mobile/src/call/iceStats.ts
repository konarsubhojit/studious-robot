/**
 * Read the candidate pair a call actually settled on, at the moment it
 * connects.
 *
 * §4 of `docs/media-connect-latency-diagnosis.md` asks whether the slow calls
 * are the ones falling back to a TURN relay while the fast ones go
 * peer-to-peer — a question the server cannot answer, because only the handset
 * can see the ICE outcome. The connection-quality poller already summarises
 * the selected pair, but it samples on a ~63s cycle, so at the instant
 * `call.connected` is emitted nothing has looked yet. This reads it once,
 * there and then.
 *
 * The reduction itself is not reimplemented here: `collectCallStats` and
 * `summarizeCandidatePair` in `../callUx` are the single definition of "which
 * pair won and what is it", and this module is only the async read around
 * them.
 */

import { collectCallStats, summarizeCandidatePair } from '../callUx';
import type { IceCandidatePairSummary } from '../diagnostics';

type StatsReport = {
  forEach: (fn: (stat: unknown) => void) => void;
  get?: (id: unknown) => unknown;
};

/** Anything that can report stats; deliberately not the full RTCPeerConnection. */
export type StatsSource = {
  getStats?: (selector?: unknown) => Promise<StatsReport | null | undefined>;
};

/** Whether `value` can be asked for stats at all. */
function hasGetStats(value: unknown): value is Required<StatsSource> {
  return Boolean(value) && typeof (value as StatsSource).getStats === 'function';
}

/**
 * Summarise the succeeded candidate pair, or `null` when there is nothing to
 * report.
 *
 * `null` is returned — never a partial summary — for a peer connection that
 * cannot report stats, a report with no succeeded pair yet, and a `getStats()`
 * that rejects. This runs purely for diagnostics, so a failure here must be
 * invisible to the call: the caller logs the absence and carries on.
 *
 * @param peerConnection - The call's peer connection, or anything falsy.
 */
export async function readSelectedCandidatePair(
  peerConnection: unknown,
): Promise<IceCandidatePairSummary | null> {
  if (!hasGetStats(peerConnection)) return null;
  let report: StatsReport | null | undefined;
  try {
    report = await peerConnection.getStats();
  } catch {
    return null;
  }
  if (!report || typeof report.forEach !== 'function') return null;
  const { candidatePair } = collectCallStats(report);
  if (!candidatePair) return null;
  const lookup =
    typeof report.get === 'function' ? (id: unknown) => report.get?.(id) : () => undefined;
  return summarizeCandidatePair(candidatePair, lookup);
}

/**
 * The candidate-pair outcome as a single token, for the receipt `reason`
 * field: `relay` when either side traverses TURN, otherwise `local→remote`
 * (e.g. `host-srflx`).
 */
export function describeCandidatePair(summary: IceCandidatePairSummary | null): string | null {
  if (!summary) return null;
  if (summary.usingTurn) return `relay:${summary.relaySide ?? 'unknown'}`;
  return `${summary.local}-${summary.remote}`;
}
