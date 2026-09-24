/**
 * Read the DTLS fingerprints a live call negotiated, from the peer
 * connection's own descriptions.
 *
 * This is a capability probe, not an accessor: `react-native-webrtc` exposes
 * `localDescription` / `remoteDescription` on both platforms today, but what
 * they carry has changed across versions and a call can be asked before
 * negotiation has finished. Every one of those cases yields `null`, and the
 * caller reports the code as unavailable rather than inventing one — the same
 * honesty rule the screen share applies with its `unverified` delivery state.
 *
 * The parsing and the code derivation itself live in `./sas`; this module is
 * only the probe around them.
 */

import { parseSdpFingerprint } from './sas';
import type { CallFingerprints } from './sas';

type Description = { sdp?: string | null } | null | undefined;

/** Anything a call's fingerprints might be read from; not the full RTCPeerConnection. */
export type FingerprintSource = {
  localDescription?: Description;
  remoteDescription?: Description;
};

/**
 * The call's fingerprint pair, or `null` when this call will not report one.
 *
 * Identical fingerprints are refused too: that is a single certificate serving
 * both ends, which this code cannot tell apart from a loopback, and neither is
 * something to verify.
 *
 * @param peerConnection - The call's peer connection, or anything falsy.
 */
export function readCallFingerprints(peerConnection: unknown): CallFingerprints | null {
  if (!peerConnection || typeof peerConnection !== 'object') return null;
  const source = peerConnection as FingerprintSource;
  const local = parseSdpFingerprint(source.localDescription?.sdp);
  const remote = parseSdpFingerprint(source.remoteDescription?.sdp);
  if (!local || !remote || local === remote) return null;
  return { local, remote };
}
