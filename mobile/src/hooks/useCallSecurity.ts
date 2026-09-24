import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { logInfo, logWarn } from '../appLogger';
import { readCallFingerprints } from '../call/callFingerprints';
import { deriveSasWords, describeCallSecurity, formatSasWords } from '../call/sas';
import type { CallFingerprints, CallSecurityState } from '../call/sas';
import { errorMessage } from '../errors';
import { loadPeerVerifications, savePeerVerifications } from '../settingsStorage';
import type { PeerVerificationMap } from '../settingsStorage';

/**
 * How often the fingerprints are looked for once a call is up, and for how
 * long. Both descriptions are in place at most a beat after `call.connected`,
 * but on the answering side the last one can land a moment later, so a single
 * read on connect would report "unavailable" for a call that has a perfectly
 * good code.
 */
const FINGERPRINT_POLL_INTERVAL_MS = 700;
const FINGERPRINT_POLL_ATTEMPTS = 10;

type FingerprintSourceRef = RefObject<unknown>;

type UseCallSecurityParams = {
  /** Whether a call is up; the fingerprints only exist while one is. */
  isInCall: boolean;
  /** The remote party of the live call, or `null` outside one. */
  peerId: string | null;
  peerConnectionRef: FingerprintSourceRef;
};

/**
 * The short authentication string for the live call, and the record of which
 * peers the user has confirmed one with.
 *
 * Reading the fingerprints is a capability probe (`readCallFingerprints`), so
 * every failure mode — a platform that will not report them, a call that never
 * finished negotiating, a `getStats()` that rejects — ends in the same
 * `unavailable` state, and the chrome says so instead of implying safety.
 *
 * @param params
 */
export default function useCallSecurity({
  isInCall,
  peerId,
  peerConnectionRef,
}: UseCallSecurityParams) {
  const [fingerprints, setFingerprints] = useState((null as CallFingerprints | null));
  const [peerVerifications, setPeerVerifications] = useState(({} as PeerVerificationMap));
  const peerVerificationsRef = useRef(({} as PeerVerificationMap));
  const fingerprintsRef = useRef((null as CallFingerprints | null));
  const peerIdRef = useRef((null as string | null));

  useEffect(() => {
    peerIdRef.current = peerId;
  }, [peerId]);

  useEffect(() => {
    fingerprintsRef.current = fingerprints;
  }, [fingerprints]);

  useEffect(() => {
    let cancelled = false;
    loadPeerVerifications()
      .then(loaded => {
        if (cancelled) return;
        peerVerificationsRef.current = loaded;
        setPeerVerifications(loaded);
      })
      .catch(error => {
        logWarn('[CallSecurity] Failed to load verified peers', {
          message: errorMessage(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isInCall) {
      setFingerprints(null);
      return undefined;
    }

    let cancelled = false;
    let attemptsLeft = FINGERPRINT_POLL_ATTEMPTS;
    let timer = (null as ReturnType<typeof setTimeout> | null);

    const readOnce = () => {
      const read = readCallFingerprints(peerConnectionRef.current);
      if (cancelled) return;
      if (!read) {
        attemptsLeft -= 1;
        if (attemptsLeft <= 0) {
          logInfo('[CallSecurity] DTLS fingerprints unavailable for this call');
          return;
        }
        timer = setTimeout(readOnce, FINGERPRINT_POLL_INTERVAL_MS);
        return;
      }
      setFingerprints(read);
    };

    readOnce();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isInCall, peerConnectionRef]);

  // Derived rather than stored, so a verification that lands later — the
  // confirmation the user just tapped, or the log arriving from disk after the
  // call connected — is reflected immediately instead of leaving the badge
  // making yesterday's claim.
  const callSecurity = useMemo(
    () => describeCallSecurity(fingerprints, peerId ? peerVerifications[peerId] : null),
    [fingerprints, peerId, peerVerifications],
  );

  useEffect(() => {
    if (callSecurity.status !== 'changed') return;
    logWarn('[CallSecurity] Peer DTLS key changed since it was verified', { peerId });
  }, [callSecurity.status, peerId]);

  /**
   * Record that the user compared the code aloud and it matched.
   *
   * Only ever called from the confirmation the user taps: nothing marks a call
   * verified on its own, and a call with no readable code cannot be confirmed
   * at all.
   */
  const confirmCallSecurity = useCallback(async () => {
    const current = fingerprintsRef.current;
    const confirmedPeerId = peerIdRef.current;
    if (!confirmedPeerId || !current) return false;
    // The freshly confirmed peer is written first — and any older record for
    // it dropped — so the entry cap trims the stalest peer rather than the one
    // just confirmed.
    const others = Object.fromEntries(
      Object.entries(peerVerificationsRef.current).filter(([id]) => id !== confirmedPeerId),
    );
    const next: PeerVerificationMap = {
      [confirmedPeerId]: {
        localFingerprint: current.local,
        remoteFingerprint: current.remote,
        sas: formatSasWords(deriveSasWords(current)),
        verifiedAt: Date.now(),
      },
      ...others,
    };
    peerVerificationsRef.current = next;
    setPeerVerifications(next);
    logInfo('[CallSecurity] Call verified by code comparison', { peerId: confirmedPeerId });
    return savePeerVerifications(next);
  }, []);

  return { callSecurity, peerVerifications, confirmCallSecurity };
}

export type { CallSecurityState };
