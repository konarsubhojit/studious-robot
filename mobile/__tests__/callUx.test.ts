import {
  clamp,
  formatCallDuration,
  formatRingCountdown,
  getConnectionQuality,
  smoothConnectionQuality,
  collectCallStats,
  summarizeCandidatePair,
} from '../src/callUx';

describe('callUx', () => {
  test('formats elapsed call duration', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(75)).toBe('01:15');
    expect(formatCallDuration(3671)).toBe('01:01:11');
  });

  test('formats the ring countdown as m:ss once past a minute', () => {
    // The ring window is two minutes, so "117s" would read as noise.
    expect(formatRingCountdown(120)).toBe('2:00');
    expect(formatRingCountdown(117)).toBe('1:57');
    expect(formatRingCountdown(60)).toBe('1:00');
    expect(formatRingCountdown(59)).toBe('59s');
    expect(formatRingCountdown(0)).toBe('0s');
    expect(formatRingCountdown(-5)).toBe('0s');
  });

  test('clamps draggable PiP coordinates to stage bounds', () => {
    expect(clamp(2, 12, 88)).toBe(12);
    expect(clamp(24, 12, 88)).toBe(24);
    expect(clamp(120, 12, 88)).toBe(88);
  });

  test('maps network metrics to signal quality bars', () => {
    expect(getConnectionQuality({})).toEqual({ bars: 0, label: 'No link' });
    expect(getConnectionQuality({ rttMs: 120, packetLossRatio: 0.01, bitrateKbps: 900 })).toEqual({
      bars: 3,
      label: 'Strong',
    });
    expect(getConnectionQuality({ rttMs: 390, packetLossRatio: 0.02, bitrateKbps: 600 })).toEqual({
      bars: 1,
      label: 'Weak',
    });
    expect(getConnectionQuality({ rttMs: 700, packetLossRatio: 0.14, bitrateKbps: 80 })).toEqual({
      bars: 0,
      label: 'Poor',
    });
  });

  describe('summarizeCandidatePair', () => {
    const lookupFrom = (entries: Record<string, any>) => (id: unknown) => entries[String(id)];
    const pair = { localCandidateId: 'lc', remoteCandidateId: 'rc' };

    test('reports a direct pair as not using TURN', () => {
      const summary = summarizeCandidatePair(
        pair,
        lookupFrom({
          lc: { candidateType: 'host', protocol: 'udp' },
          rc: { candidateType: 'srflx', protocol: 'udp' },
        }),
      );

      expect(summary).toEqual({
        local: 'host',
        remote: 'srflx',
        protocol: 'udp',
        usingTurn: false,
      });
    });

    test.each([
      ['local', 'relay', 'srflx'],
      ['remote', 'srflx', 'relay'],
      ['both', 'relay', 'relay'],
    ])('reports %s as the relaying side', (relaySide, local, remote) => {
      // Judging the pair by the local candidate alone reported a
      // srflx->relay pair as a direct call, so both sides are inspected.
      const summary = summarizeCandidatePair(
        pair,
        lookupFrom({
          lc: { candidateType: local, protocol: 'udp' },
          rc: { candidateType: remote, protocol: 'udp' },
        }),
      );

      expect(summary.usingTurn).toBe(true);
      expect(summary.relaySide).toBe(relaySide);
    });

    test('falls back through the remote candidate and the pair for the protocol', () => {
      expect(
        summarizeCandidatePair(
          { ...pair, protocol: 'tcp' },
          lookupFrom({ lc: { candidateType: 'host' }, rc: { candidateType: 'srflx' } }),
        ).protocol,
      ).toBe('tcp');

      expect(
        summarizeCandidatePair(
          pair,
          lookupFrom({ lc: { candidateType: 'host' }, rc: { candidateType: 'srflx' } }),
        ).protocol,
      ).toBe('unknown');
    });

    test('describes an unresolvable pair rather than throwing', () => {
      expect(summarizeCandidatePair(pair, () => undefined)).toEqual({
        local: 'unknown',
        remote: 'unknown',
        protocol: 'unknown',
        usingTurn: false,
      });
    });

    test('records the relay protocol only when the local candidate reports one', () => {
      const withRelay = summarizeCandidatePair(
        pair,
        lookupFrom({
          lc: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
          rc: { candidateType: 'host', protocol: 'udp' },
        }),
      );
      expect(withRelay.relayProtocol).toBe('tls');

      expect(
        summarizeCandidatePair(
          pair,
          lookupFrom({
            lc: { candidateType: 'relay', protocol: 'udp' },
            rc: { candidateType: 'host', protocol: 'udp' },
          }),
        ),
      ).not.toHaveProperty('relayProtocol');
    });
  });

  describe('collectCallStats', () => {
    const report = (stats: any[]) => ({ forEach: (fn: (stat: any) => void) => stats.forEach(fn) });

    test('sums inbound video and ignores audio and remote-side reports', () => {
      // Audio survives conditions that have already destroyed the video, so
      // folding it in would flatter a call the user can see is broken.
      const sample = collectCallStats(
        report([
          { type: 'inbound-rtp', kind: 'video', packetsLost: 5, packetsReceived: 100, bytesReceived: 900 },
          { type: 'inbound-rtp', mediaType: 'video', packetsLost: 2, packetsReceived: 50, bytesReceived: 100 },
          { type: 'inbound-rtp', kind: 'audio', packetsLost: 99, packetsReceived: 99, bytesReceived: 99 },
          { type: 'inbound-rtp', kind: 'video', isRemote: true, packetsLost: 77 },
        ]),
      );

      expect(sample).toMatchObject({
        totalPacketsLost: 7,
        totalPacketsReceived: 150,
        totalBytesReceived: 1000,
      });
    });

    test('prefers a nominated candidate pair over an earlier succeeded one', () => {
      const sample = collectCallStats(
        report([
          { type: 'candidate-pair', state: 'succeeded', id: 'first', currentRoundTripTime: 0.2 },
          { type: 'candidate-pair', state: 'succeeded', id: 'nominated', nominated: true, currentRoundTripTime: 0.05 },
        ]),
      );

      expect(sample.candidatePair.id).toBe('nominated');
      expect(sample.rttMs).toBe(50);
    });

    test('ignores candidate pairs that never succeeded', () => {
      const sample = collectCallStats(
        report([{ type: 'candidate-pair', state: 'failed', id: 'dead' }, null, 'garbage']),
      );

      expect(sample.candidatePair).toBeNull();
      expect(sample.rttMs).toBeUndefined();
    });
  });
});

describe('smoothConnectionQuality', () => {
  const strong = { bars: 3, label: 'Strong' };
  const fair = { bars: 2, label: 'Fair' };
  const poor = { bars: 0, label: 'Poor' };

  test('publishes the first sample as-is', () => {
    expect(smoothConnectionQuality(null, strong)).toEqual({
      reported: strong,
      pendingWorse: 0,
    });
  });

  test('holds the previous grade through a single worse sample', () => {
    const first = smoothConnectionQuality(null, strong);
    const second = smoothConnectionQuality(first, poor);
    expect(second.reported).toEqual(strong);
    expect(second.pendingWorse).toBe(1);
  });

  test('drops only once consecutive samples agree the link got worse', () => {
    let state = smoothConnectionQuality(null, strong);
    state = smoothConnectionQuality(state, poor);
    state = smoothConnectionQuality(state, poor);
    expect(state.reported).toEqual(poor);
    expect(state.pendingWorse).toBe(0);
  });

  test('a recovery between two bad samples cancels the pending downgrade', () => {
    let state = smoothConnectionQuality(null, strong);
    state = smoothConnectionQuality(state, poor);
    state = smoothConnectionQuality(state, strong);
    state = smoothConnectionQuality(state, poor);
    expect(state.reported).toEqual(strong);
    expect(state.pendingWorse).toBe(1);
  });

  test('an improvement is published immediately', () => {
    let state = smoothConnectionQuality(null, poor);
    state = smoothConnectionQuality(state, fair);
    expect(state.reported).toEqual(fair);
  });
});
