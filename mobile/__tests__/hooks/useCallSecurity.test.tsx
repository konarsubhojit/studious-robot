import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallSecurity from '../../src/hooks/useCallSecurity';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));
jest.mock('../../src/settingsStorage', () => ({
  loadPeerVerifications: jest.fn(() => Promise.resolve({})),
  savePeerVerifications: jest.fn(() => Promise.resolve(true)),
}));

const settingsStorage = require('../../src/settingsStorage');

const LOCAL_SDP = ['v=0', 'a=fingerprint:sha-256 AA:BB:CC'].join('\r\n');
const REMOTE_SDP = ['v=0', 'a=fingerprint:sha-256 11:22:33'].join('\r\n');

function TestHook({ resultRef, params }: any) {
  resultRef.current = useCallSecurity(params);
  return null;
}

function connectedPeerConnection() {
  return {
    localDescription: { sdp: LOCAL_SDP },
    remoteDescription: { sdp: REMOTE_SDP },
  };
}

/**
 * Render the hook and let the fingerprint read — which is asynchronous even
 * when the descriptions are already there — settle.
 */
async function setup({
  isInCall = true,
  peerId = 'alice' as string | null,
  peerConnection = connectedPeerConnection() as unknown,
} = {}) {
  const resultRef: any = { current: null };
  let tree: any;
  await act(async () => {
    tree = renderer.create(
      <TestHook
        resultRef={resultRef}
        params={{ isInCall, peerId, peerConnectionRef: { current: peerConnection } }}
      />,
    );
  });
  return { resultRef, tree };
}

describe('useCallSecurity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsStorage.loadPeerVerifications.mockResolvedValue({});
    settingsStorage.savePeerVerifications.mockResolvedValue(true);
  });

  test('derives a code for a connected call', async () => {
    const { resultRef } = await setup();

    expect(resultRef.current.callSecurity.status).toBe('unverified');
    expect(resultRef.current.callSecurity.words).toHaveLength(4);
  });

  test('claims nothing when the platform will not report fingerprints', async () => {
    const { resultRef } = await setup({ peerConnection: { localDescription: null } });

    expect(resultRef.current.callSecurity).toMatchObject({ status: 'unavailable', words: null });
  });

  test('reports a previously verified peer as verified', async () => {
    settingsStorage.loadPeerVerifications.mockResolvedValue({
      alice: {
        localFingerprint: 'sha-256 AA:BB:CC',
        remoteFingerprint: 'sha-256 11:22:33',
        sas: 'alpha bravo charlie delta',
        verifiedAt: 1,
      },
    });

    const { resultRef } = await setup();

    expect(resultRef.current.callSecurity.status).toBe('verified');
  });

  test('warns when the peer key changed under a stable local key', async () => {
    settingsStorage.loadPeerVerifications.mockResolvedValue({
      alice: {
        localFingerprint: 'sha-256 AA:BB:CC',
        remoteFingerprint: 'sha-256 99:88:77',
        sas: 'alpha bravo charlie delta',
        verifiedAt: 1,
      },
    });

    const { resultRef } = await setup();

    expect(resultRef.current.callSecurity.status).toBe('changed');
  });

  test('upgrades the badge when the verification log arrives after the call', async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    settingsStorage.loadPeerVerifications.mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
    );

    const { resultRef } = await setup();
    expect(resultRef.current.callSecurity.status).toBe('unverified');

    await act(async () => {
      resolveLoad({
        alice: {
          localFingerprint: 'sha-256 AA:BB:CC',
          remoteFingerprint: 'sha-256 11:22:33',
          sas: 'alpha bravo charlie delta',
          verifiedAt: 1,
        },
      });
    });

    expect(resultRef.current.callSecurity.status).toBe('verified');
  });

  test('persists the confirmed pair and marks the peer verified', async () => {
    const { resultRef } = await setup();

    await act(async () => {
      await resultRef.current.confirmCallSecurity();
    });

    expect(settingsStorage.savePeerVerifications).toHaveBeenCalledWith({
      alice: expect.objectContaining({
        localFingerprint: 'sha-256 AA:BB:CC',
        remoteFingerprint: 'sha-256 11:22:33',
      }),
    });
    expect(resultRef.current.callSecurity.status).toBe('verified');
    expect(resultRef.current.peerVerifications.alice.sas).toBe(
      resultRef.current.callSecurity.words.join(' '),
    );
  });

  test('replaces an earlier record for the same peer rather than keeping both', async () => {
    settingsStorage.loadPeerVerifications.mockResolvedValue({
      alice: {
        localFingerprint: 'sha-256 stale',
        remoteFingerprint: 'sha-256 stale',
        sas: 'stale code words here',
        verifiedAt: 1,
      },
    });

    const { resultRef } = await setup();
    await act(async () => {
      await resultRef.current.confirmCallSecurity();
    });

    expect(resultRef.current.peerVerifications.alice.localFingerprint).toBe('sha-256 AA:BB:CC');
    expect(Object.keys(resultRef.current.peerVerifications)).toEqual(['alice']);
  });

  test('cannot confirm a call with no readable code', async () => {
    const { resultRef } = await setup({ peerConnection: {} });

    let confirmed: unknown;
    await act(async () => {
      confirmed = await resultRef.current.confirmCallSecurity();
    });

    expect(confirmed).toBe(false);
    expect(settingsStorage.savePeerVerifications).not.toHaveBeenCalled();
  });

  test('drops the code when the call ends', async () => {
    const { resultRef, tree } = await setup();

    await act(async () => {
      tree.update(
        <TestHook
          resultRef={resultRef}
          params={{
            isInCall: false,
            peerId: 'alice',
            peerConnectionRef: { current: connectedPeerConnection() },
          }}
        />,
      );
    });

    expect(resultRef.current.callSecurity.status).toBe('unavailable');
  });
});
