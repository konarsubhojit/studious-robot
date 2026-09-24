/**
 * Tests for the DTLS fingerprint capability probe.
 *
 * `react-native-webrtc` does not expose the negotiated descriptions
 * identically on every platform and version, so the load-bearing property is
 * that every way this can fail yields `null` — never a half-read pair the call
 * chrome would then present as a code worth comparing.
 */

import { readCallFingerprints } from '../../src/call/callFingerprints';

const LOCAL_SDP = ['v=0', 'a=fingerprint:sha-256 AA:BB:CC', 'a=setup:actpass'].join('\r\n');
const REMOTE_SDP = ['v=0', 'a=fingerprint:SHA-256 11:22:33', 'a=setup:active'].join('\r\n');

describe('readCallFingerprints', () => {
  test('reads the pair off the negotiated descriptions', () => {
    expect(
      readCallFingerprints({
        localDescription: { sdp: LOCAL_SDP },
        remoteDescription: { sdp: REMOTE_SDP },
      }),
    ).toEqual({ local: 'sha-256 AA:BB:CC', remote: 'sha-256 11:22:33' });
  });

  test('reports nothing when only one side is readable', () => {
    expect(
      readCallFingerprints({ localDescription: { sdp: LOCAL_SDP }, remoteDescription: null }),
    ).toBeNull();
    expect(
      readCallFingerprints({ localDescription: { sdp: '' }, remoteDescription: { sdp: REMOTE_SDP } }),
    ).toBeNull();
  });

  test('reports nothing when both ends present the same certificate', () => {
    expect(
      readCallFingerprints({
        localDescription: { sdp: LOCAL_SDP },
        remoteDescription: { sdp: LOCAL_SDP },
      }),
    ).toBeNull();
  });

  test('reports nothing for a call that cannot be probed at all', () => {
    expect(readCallFingerprints(null)).toBeNull();
    expect(readCallFingerprints(undefined)).toBeNull();
    expect(readCallFingerprints({})).toBeNull();
    expect(readCallFingerprints('peer-connection')).toBeNull();
  });
});
