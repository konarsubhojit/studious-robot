/**
 * Short Authentication String (SAS) for a call: a four-word code derived from
 * the two DTLS fingerprints, for the two people on the call to read to each
 * other.
 *
 * WebRTC already encrypts media with DTLS-SRTP, so nobody between the handsets
 * can listen in — but the fingerprints that bind those keys travel through our
 * own signalling server inside the SDP. A compromised or malicious server can
 * therefore substitute both fingerprints, terminate two legitimate DTLS
 * sessions, and relay the decrypted media. That is the one gap the transport
 * cannot close by itself, and the only thing that closes it is the two humans
 * confirming out of band — over the very call — that both ends see the same
 * key material.
 *
 * The code is derived from *both* fingerprints in a canonical, order-
 * independent way, so the two handsets compute the same four words without
 * agreeing on who is the caller. A man in the middle holds two different key
 * pairs and cannot make both sides' codes agree.
 *
 * Everything here is pure: reading the fingerprints off a peer connection and
 * remembering what the user confirmed live in `../hooks/useCallSecurity`.
 */

import { SAS_WORDS } from './sasWords';
import { sha256Bytes } from './sha256';

/** Words in a code. Four words over 256 words each is 32 bits of comparison. */
export const SAS_WORD_COUNT = 4;

/**
 * Domain separator mixed into the digest, so a code can never collide with a
 * hash computed for another purpose, and so a future code format can be
 * introduced without silently matching this one.
 */
const SAS_DOMAIN = 'wetalk-sas-v1';

/** The two ends' DTLS fingerprints, normalised by `parseSdpFingerprint`. */
export type CallFingerprints = {
  local: string;
  remote: string;
};

/**
 * What a call's key material looks like compared with what the user last
 * confirmed for this peer.
 *
 * - `first-contact` — nothing was ever confirmed for this peer.
 * - `unchanged` — both fingerprints match the confirmed pair.
 * - `rotated` — the *local* fingerprint changed too, so this platform mints a
 *   fresh DTLS certificate per call and a changed remote fingerprint carries
 *   no information. The code must be compared again; it is not an alarm.
 * - `remote-changed` — the local fingerprint is stable across calls, and the
 *   remote one changed anyway. That is the signal worth shouting about.
 */
export type FingerprintChange = 'first-contact' | 'unchanged' | 'rotated' | 'remote-changed';

/**
 * How much the UI may honestly say about this call.
 *
 * `unavailable` exists because `react-native-webrtc` does not expose the
 * negotiated SDP identically on every platform and build. When the
 * fingerprints cannot be read there is no code, and the UI says exactly that
 * rather than implying a verified call — the same honesty rule the screen
 * share applies with its `unverified` delivery state.
 */
export type CallSecurityStatus = 'unavailable' | 'unverified' | 'verified' | 'changed';

/** The verification state of the live call, as shown in the call chrome. */
export type CallSecurityState = {
  status: CallSecurityStatus;
  /** The code words, or `null` when the fingerprints could not be read. */
  words: readonly string[] | null;
  /** The fingerprints the code was derived from, for persistence. */
  fingerprints: CallFingerprints | null;
  /** How this call's key material compares with the confirmed pair. */
  change: FingerprintChange | null;
};

/** Nothing readable: no code, and no claim of any kind. */
export const UNAVAILABLE_CALL_SECURITY: CallSecurityState = {
  status: 'unavailable',
  words: null,
  fingerprints: null,
  change: null,
};

/** A pair of fingerprints the user confirmed matched, and when. */
export type PeerVerification = {
  localFingerprint: string;
  remoteFingerprint: string;
  /** The code that was read aloud, kept for the profile screen. */
  sas: string;
  verifiedAt: number;
};

const FINGERPRINT_LINE = /^a=fingerprint:(\S+)\s+([0-9a-fA-F:]+)\s*$/;

/** `sha-256 AA:BB:…`, upper-case hex, so two spellings of one key compare equal. */
function normalizeFingerprint(algorithm: string, value: string): string {
  return `${algorithm.toLowerCase()} ${value.toUpperCase()}`;
}

/**
 * The single DTLS fingerprint an SDP offer or answer commits to, or `null`.
 *
 * `null` — never a guess — for an SDP with no fingerprint at all, and for one
 * whose m-lines disagree: a session that is not pinned to one certificate
 * cannot be summarised by one code, and claiming otherwise would verify a key
 * that only some of the media uses.
 *
 * @param sdp - The negotiated local or remote description.
 */
export function parseSdpFingerprint(sdp: string | null | undefined): string | null {
  if (typeof sdp !== 'string' || !sdp) return null;
  let found: string | null = null;
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    const match = FINGERPRINT_LINE.exec(line.trim());
    if (!match) continue;
    const fingerprint = normalizeFingerprint(match[1], match[2]);
    if (found && found !== fingerprint) return null;
    found = fingerprint;
  }
  return found;
}

/**
 * The four-word code for a pair of fingerprints.
 *
 * The two are sorted before hashing, so both handsets — which disagree about
 * which one is "local" — derive the same words.
 *
 * @param fingerprints - Normalised local and remote fingerprints.
 */
export function deriveSasWords(fingerprints: CallFingerprints): readonly string[] {
  const canonical = [fingerprints.local, fingerprints.remote].sort().join('|');
  const digest = sha256Bytes(`${SAS_DOMAIN}|${canonical}`);
  return digest.slice(0, SAS_WORD_COUNT).map(byte => SAS_WORDS[byte]);
}

/** The code as one readable string, for logs and the profile screen. */
export function formatSasWords(words: readonly string[] | null | undefined): string {
  return words?.length ? words.join(' ') : '';
}

/**
 * Short label for the in-call badge.
 *
 * Note what `unavailable` says and does not say: the fingerprints were not
 * readable, so there is no claim at all — the badge never reads "verified"
 * for a call whose keys this device could not see.
 */
export function describeCallSecurityBadge(status: CallSecurityStatus): string {
  if (status === 'verified') return 'Verified';
  if (status === 'changed') return 'Key changed';
  if (status === 'unverified') return 'Verify code';
  return 'Code unavailable';
}

/** The sentence shown in the panel the badge opens. */
export function describeCallSecurityGuidance(status: CallSecurityStatus): string {
  if (status === 'verified') {
    return 'You confirmed this code with this person, and this call uses the same keys.';
  }
  if (status === 'changed') {
    return "This person's encryption key changed since you verified them, while this device's key did not. Compare the words again before discussing anything sensitive.";
  }
  if (status === 'unverified') {
    return 'Read these words aloud. If you both see the same four words, nobody has substituted the call\u2019s encryption keys.';
  }
  return 'This device cannot read the call\u2019s encryption fingerprints, so there is no code to compare. The call is still encrypted; it is simply unverified.';
}

/**
 * Compare this call's fingerprints with the pair the user confirmed earlier.
 *
 * @param previous - The confirmed pair, or `null` if this peer was never verified.
 * @param current - This call's fingerprints.
 */
export function classifyFingerprintChange(
  previous: PeerVerification | null | undefined,
  current: CallFingerprints,
): FingerprintChange {
  if (!previous) return 'first-contact';
  const localMatches = previous.localFingerprint === current.local;
  const remoteMatches = previous.remoteFingerprint === current.remote;
  if (localMatches && remoteMatches) return 'unchanged';
  if (!localMatches) return 'rotated';
  return 'remote-changed';
}

/**
 * The call's verification state: what the code is, and what may be claimed
 * about it.
 *
 * `verified` is reserved for a call whose *whole* key pair matches what the
 * user confirmed. A rotated certificate is honestly reported as unverified
 * rather than quietly inheriting the old confirmation, because the previous
 * comparison said nothing about this call's keys.
 *
 * @param fingerprints - This call's fingerprints, or `null` when unreadable.
 * @param previous - The confirmed pair for this peer, if any.
 */
export function describeCallSecurity(
  fingerprints: CallFingerprints | null,
  previous: PeerVerification | null | undefined,
): CallSecurityState {
  if (!fingerprints) return UNAVAILABLE_CALL_SECURITY;
  const change = classifyFingerprintChange(previous, fingerprints);
  const status: CallSecurityStatus =
    change === 'unchanged' ? 'verified' : change === 'remote-changed' ? 'changed' : 'unverified';
  return {
    status,
    words: deriveSasWords(fingerprints),
    fingerprints,
    change,
  };
}
