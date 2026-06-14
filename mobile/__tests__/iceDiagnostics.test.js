import {
  classifyMediaError,
  summarizeIceServers,
  summarizeSelectedCandidatePair,
} from '../src/iceDiagnostics';

describe('classifyMediaError', () => {
  test('classifies permission denial', () => {
    expect(classifyMediaError({ name: 'NotAllowedError', message: 'Permission denied' })).toBe(
      'permission-denied',
    );
    expect(classifyMediaError({ name: 'SecurityError' })).toBe('permission-denied');
  });

  test('classifies camera-in-use', () => {
    expect(classifyMediaError({ name: 'NotReadableError', message: 'Could not start video source' })).toBe(
      'camera-in-use',
    );
    expect(classifyMediaError({ message: 'Camera is in use' })).toBe('camera-in-use');
  });

  test('classifies overconstrained', () => {
    expect(classifyMediaError({ name: 'OverconstrainedError' })).toBe('overconstrained');
  });

  test('classifies device-not-found', () => {
    expect(classifyMediaError({ name: 'NotFoundError', message: 'device not found' })).toBe(
      'device-not-found',
    );
  });

  test('falls back to generic', () => {
    expect(classifyMediaError({ name: 'TypeError', message: 'boom' })).toBe('generic');
    expect(classifyMediaError(undefined)).toBe('generic');
  });
});

describe('summarizeIceServers', () => {
  test('reports STUN-only configuration without TURN', () => {
    const summary = summarizeIceServers([{ urls: ['stun:stun.l.google.com:19302'] }]);
    expect(summary).toEqual({ iceServerCount: 1, turnConfigured: false, turnSchemes: [] });
  });

  test('summarizes TURN schemes without exposing credentials', () => {
    const summary = summarizeIceServers([
      { urls: ['stun:stun.l.google.com:19302'] },
      {
        urls: [
          'turn:global.relay.metered.ca:3478',
          'turns:global.relay.metered.ca:443?transport=tcp',
        ],
        username: 'demo-user',
        credential: 'demo-pass',
      },
    ]);

    expect(summary.iceServerCount).toBe(2);
    expect(summary.turnConfigured).toBe(true);
    expect(summary.turnSchemes).toEqual(['turn:3478', 'turns:443?tcp']);
    expect(JSON.stringify(summary)).not.toContain('demo-user');
    expect(JSON.stringify(summary)).not.toContain('demo-pass');
  });

  test('handles missing/invalid input', () => {
    expect(summarizeIceServers(undefined)).toEqual({
      iceServerCount: 0,
      turnConfigured: false,
      turnSchemes: [],
    });
  });
});

describe('summarizeSelectedCandidatePair', () => {
  function makeReport(stats) {
    return {
      forEach: (callback) => stats.forEach(callback),
    };
  }

  test('returns null when no report is given', () => {
    expect(summarizeSelectedCandidatePair(null)).toBeNull();
    expect(summarizeSelectedCandidatePair({})).toBeNull();
  });

  test('returns null when there is no selected pair', () => {
    const report = makeReport([{ id: 'cp1', type: 'candidate-pair', state: 'failed' }]);
    expect(summarizeSelectedCandidatePair(report)).toBeNull();
  });

  test('summarizes a relay/srflx selected pair', () => {
    const report = makeReport([
      { id: 'local1', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
      { id: 'remote1', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
      {
        id: 'cp1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local1',
        remoteCandidateId: 'remote1',
      },
    ]);

    expect(summarizeSelectedCandidatePair(report)).toEqual({
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      usesRelay: true,
    });
  });

  test('marks direct host pairs as not using relay', () => {
    const report = makeReport([
      { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
      { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
      {
        id: 'cp',
        type: 'candidate-pair',
        state: 'succeeded',
        selected: true,
        localCandidateId: 'l',
        remoteCandidateId: 'r',
      },
    ]);

    const summary = summarizeSelectedCandidatePair(report);
    expect(summary.usesRelay).toBe(false);
    expect(summary.local).toBe('host');
  });
});
