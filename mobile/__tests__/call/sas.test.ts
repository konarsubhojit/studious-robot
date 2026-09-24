/**
 * Tests for the call verification code (SAS).
 *
 * Two properties carry the whole feature: both handsets must derive the same
 * words from the same key material regardless of which end they are, and
 * nothing may be claimed about a call whose fingerprints could not be read.
 */

import {
  SAS_WORD_COUNT,
  classifyFingerprintChange,
  deriveSasWords,
  describeCallSecurity,
  describeCallSecurityBadge,
  describeCallSecurityGuidance,
  formatSasWords,
  parseSdpFingerprint,
} from '../../src/call/sas';
import { SAS_WORDS } from '../../src/call/sasWords';
import { sha256Hex } from '../../src/call/sha256';
import type { PeerVerification } from '../../src/call/sas';

const LOCAL = 'sha-256 AA:BB:CC:DD:EE:FF:00:11';
const REMOTE = 'sha-256 11:22:33:44:55:66:77:88';

function sdpWith(fingerprintLines: string[]): string {
  return ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', ...fingerprintLines, 'a=setup:actpass'].join(
    '\r\n',
  );
}

function verification(overrides: Partial<PeerVerification> = {}): PeerVerification {
  return {
    localFingerprint: LOCAL,
    remoteFingerprint: REMOTE,
    sas: 'alpha bravo charlie delta',
    verifiedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('sha256', () => {
  test('matches the published vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});

describe('SAS_WORDS', () => {
  test('is exactly 256 distinct lower-case words', () => {
    expect(SAS_WORDS).toHaveLength(256);
    expect(new Set(SAS_WORDS).size).toBe(256);
    for (const word of SAS_WORDS) expect(word).toMatch(/^[a-z]{3,9}$/);
  });
});

describe('parseSdpFingerprint', () => {
  test('normalises the fingerprint it finds', () => {
    expect(parseSdpFingerprint(sdpWith(['a=fingerprint:SHA-256 aa:bb:cc']))).toBe(
      'sha-256 AA:BB:CC',
    );
  });

  test('accepts an SDP whose m-lines repeat one fingerprint', () => {
    const sdp = sdpWith([
      'a=fingerprint:sha-256 AA:BB:CC',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=fingerprint:sha-256 aa:bb:cc',
    ]);

    expect(parseSdpFingerprint(sdp)).toBe('sha-256 AA:BB:CC');
  });

  test('refuses to summarise an SDP whose m-lines disagree', () => {
    const sdp = sdpWith([
      'a=fingerprint:sha-256 AA:BB:CC',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=fingerprint:sha-256 DD:EE:FF',
    ]);

    expect(parseSdpFingerprint(sdp)).toBeNull();
  });

  test('returns null for missing or fingerprint-free descriptions', () => {
    expect(parseSdpFingerprint(null)).toBeNull();
    expect(parseSdpFingerprint(undefined)).toBeNull();
    expect(parseSdpFingerprint('')).toBeNull();
    expect(parseSdpFingerprint(sdpWith([]))).toBeNull();
  });
});

describe('deriveSasWords', () => {
  test('derives the same words on both ends of the call', () => {
    const caller = deriveSasWords({ local: LOCAL, remote: REMOTE });
    const callee = deriveSasWords({ local: REMOTE, remote: LOCAL });

    expect(caller).toEqual(callee);
    expect(caller).toHaveLength(SAS_WORD_COUNT);
    for (const word of caller) expect(SAS_WORDS).toContain(word);
  });

  test('changes when either fingerprint changes', () => {
    const baseline = formatSasWords(deriveSasWords({ local: LOCAL, remote: REMOTE }));

    expect(formatSasWords(deriveSasWords({ local: LOCAL, remote: 'sha-256 99:88' }))).not.toBe(
      baseline,
    );
    expect(formatSasWords(deriveSasWords({ local: 'sha-256 99:88', remote: REMOTE }))).not.toBe(
      baseline,
    );
  });

  test('is stable, so a code never changes under the users', () => {
    expect(formatSasWords(deriveSasWords({ local: LOCAL, remote: REMOTE }))).toBe(
      formatSasWords(deriveSasWords({ local: LOCAL, remote: REMOTE })),
    );
  });
});

describe('classifyFingerprintChange', () => {
  test('reports first contact when nothing was ever confirmed', () => {
    expect(classifyFingerprintChange(null, { local: LOCAL, remote: REMOTE })).toBe('first-contact');
  });

  test('reports an unchanged pair', () => {
    expect(classifyFingerprintChange(verification(), { local: LOCAL, remote: REMOTE })).toBe(
      'unchanged',
    );
  });

  test('treats a changed local certificate as rotation, not as an alarm', () => {
    expect(
      classifyFingerprintChange(verification(), { local: 'sha-256 99:88', remote: 'sha-256 77:66' }),
    ).toBe('rotated');
  });

  test('flags a remote key that changed while the local one did not', () => {
    expect(
      classifyFingerprintChange(verification(), { local: LOCAL, remote: 'sha-256 77:66' }),
    ).toBe('remote-changed');
  });
});

describe('describeCallSecurity', () => {
  test('claims nothing when the fingerprints could not be read', () => {
    const state = describeCallSecurity(null, verification());

    expect(state).toEqual({ status: 'unavailable', words: null, fingerprints: null, change: null });
    expect(describeCallSecurityBadge(state.status)).toBe('Code unavailable');
    expect(describeCallSecurityGuidance(state.status)).toContain('cannot read');
  });

  test('is verified only when the whole confirmed pair matches', () => {
    const state = describeCallSecurity({ local: LOCAL, remote: REMOTE }, verification());

    expect(state.status).toBe('verified');
    expect(state.words).toHaveLength(SAS_WORD_COUNT);
    expect(describeCallSecurityBadge(state.status)).toBe('Verified');
  });

  test('does not inherit an old confirmation across a certificate rotation', () => {
    const state = describeCallSecurity(
      { local: 'sha-256 99:88', remote: 'sha-256 77:66' },
      verification(),
    );

    expect(state.status).toBe('unverified');
    expect(describeCallSecurityBadge(state.status)).toBe('Verify code');
  });

  test('warns when the peer key changed under a stable local key', () => {
    const state = describeCallSecurity({ local: LOCAL, remote: 'sha-256 77:66' }, verification());

    expect(state.status).toBe('changed');
    expect(state.change).toBe('remote-changed');
    expect(describeCallSecurityBadge(state.status)).toBe('Key changed');
    expect(describeCallSecurityGuidance(state.status)).toContain('changed');
  });

  test('asks for a comparison on a first call with a peer', () => {
    const state = describeCallSecurity({ local: LOCAL, remote: REMOTE }, null);

    expect(state.status).toBe('unverified');
    expect(state.change).toBe('first-contact');
  });
});
