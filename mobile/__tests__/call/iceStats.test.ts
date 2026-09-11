/**
 * Direct tests for the connect-time candidate-pair read.
 *
 * This runs after `call.connected` has already been emitted, purely to answer
 * "did this call go peer-to-peer or over a relay". So the load-bearing
 * property is that every way it can fail yields `null` rather than throwing
 * into a call that has, by then, already connected.
 */

import { describeCandidatePair, readSelectedCandidatePair } from '../../src/call/iceStats';

/** A stats report shaped like the `RTCStatsReport` Map the platform returns. */
function statsReport(entries: Record<string, Record<string, unknown>>) {
  const map = new Map(Object.entries(entries));
  return {
    forEach: (fn: (stat: unknown) => void) => map.forEach(value => fn(value)),
    get: (id: unknown) => map.get(id as string),
  };
}

const relayPair = statsReport({
  pair: {
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    localCandidateId: 'local',
    remoteCandidateId: 'remote',
  },
  local: { type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' },
  remote: { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
});

const directPair = statsReport({
  pair: {
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    localCandidateId: 'local',
    remoteCandidateId: 'remote',
  },
  local: { type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
  remote: { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
});

describe('readSelectedCandidatePair', () => {
  it('summarises the pair the call settled on', async () => {
    const summary = await readSelectedCandidatePair({ getStats: async () => relayPair });

    expect(summary).toMatchObject({
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      usingTurn: true,
      relaySide: 'local',
    });
  });

  it('reports a direct call as not using TURN', async () => {
    const summary = await readSelectedCandidatePair({ getStats: async () => directPair });

    expect(summary).toMatchObject({ local: 'host', remote: 'srflx', usingTurn: false });
    expect(summary?.relaySide).toBeUndefined();
  });

  it('returns null when the peer connection cannot report stats', async () => {
    expect(await readSelectedCandidatePair(null)).toBeNull();
    expect(await readSelectedCandidatePair({})).toBeNull();
    expect(await readSelectedCandidatePair({ getStats: 'nope' })).toBeNull();
  });

  it('returns null rather than throwing when getStats rejects', async () => {
    const peerConnection = {
      getStats: async () => {
        throw new Error('stats unavailable');
      },
    };

    await expect(readSelectedCandidatePair(peerConnection)).resolves.toBeNull();
  });

  it('returns null when no pair has succeeded yet', async () => {
    const pending = statsReport({
      pair: { type: 'candidate-pair', state: 'in-progress', localCandidateId: 'local' },
    });

    expect(await readSelectedCandidatePair({ getStats: async () => pending })).toBeNull();
    expect(await readSelectedCandidatePair({ getStats: async () => null })).toBeNull();
  });

  it('still summarises a report that cannot be indexed by id', async () => {
    const unindexable = {
      forEach: (fn: (stat: unknown) => void) => {
        fn({ type: 'candidate-pair', state: 'succeeded', nominated: true });
      },
    };

    // Unknown, rather than absent: the pair won, we just cannot name its ends.
    expect(await readSelectedCandidatePair({ getStats: async () => unindexable })).toMatchObject({
      local: 'unknown',
      remote: 'unknown',
      usingTurn: false,
    });
  });
});

describe('describeCandidatePair', () => {
  it('names the relaying side when the call traverses TURN', () => {
    expect(
      describeCandidatePair({ local: 'relay', remote: 'srflx', protocol: 'udp', usingTurn: true, relaySide: 'local' }),
    ).toBe('relay:local');
  });

  it('names both candidate types for a direct call', () => {
    expect(
      describeCandidatePair({ local: 'host', remote: 'srflx', protocol: 'udp', usingTurn: false }),
    ).toBe('host-srflx');
  });

  it('returns null for an absent summary, so it is never mistaken for a direct call', () => {
    expect(describeCandidatePair(null)).toBeNull();
  });
});
