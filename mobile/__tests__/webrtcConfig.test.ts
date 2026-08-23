import {
  ICE_TRANSPORT_POLICIES,
  applyBitrateConstraints,
  deriveStunUrlsFromTurnUrl,
  getIceServers,
  getIceServersForCall,
  getTurnDiagnostics,
  normalizeIceTransportPolicy,
  resetIceServersForCallCache,
} from '../src/webrtcConfig';
import { logError, logInfo, logVerbose, logWarn } from '../src/appLogger';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

// Use indirect delete via a local reference so that
// babel-plugin-transform-inline-environment-variables (which replaces the
// literal `process.env.TURN_USERNAME` read-pattern with the compile-time
// value) does NOT compile `delete process.env.TURN_USERNAME` into
// `delete undefined`, which would silently be a no-op.
function clearTurnEnv() {
  const env = process.env;
  delete env.TURN_USERNAME;
  delete env.TURN_CREDENTIAL;
  delete env.TURN_URL;
}

describe('normalizeIceTransportPolicy', () => {
  test('accepts WebRTC-valid values and defaults unknown values to all', () => {
    expect(normalizeIceTransportPolicy(ICE_TRANSPORT_POLICIES.ALL)).toBe('all');
    expect(normalizeIceTransportPolicy(ICE_TRANSPORT_POLICIES.RELAY)).toBe('relay');
    expect(normalizeIceTransportPolicy('nostun')).toBe('all');
    expect(normalizeIceTransportPolicy(undefined)).toBe('all');
  });
});

describe('getIceServers', () => {
  beforeEach(() => {
    clearTurnEnv();
    resetIceServersForCallCache();
  });
  afterEach(() => {
    clearTurnEnv();
    resetIceServersForCallCache();
  });

  test('includes Google STUN server by default', () => {
    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toContain('stun:stun.l.google.com:19302');
  });

  test('derives one self-hosted STUN URL from duplicate TURN transports', () => {
    expect(
      deriveStunUrlsFromTurnUrl(
        'turn:relay.example.com:3478,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349?transport=tcp',
      ),
    ).toEqual(['stun:relay.example.com:3478']);
    expect(deriveStunUrlsFromTurnUrl(undefined)).toEqual([]);
  });

  describe('getIceServersForCall', () => {
    beforeEach(() => {
      clearTurnEnv();
      resetIceServersForCallCache();
    });
    afterEach(() => {
      clearTurnEnv();
      resetIceServersForCallCache();
    });

    function response(iceServers: any, expiresAt: any) {
      return {
        ok: true,
        json: async () => iceServers,
        headers: { get: () => expiresAt },
      };
    }

    test('fetches server credentials and reuses them while fresh', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        response([{ urls: ['turn:cf.example'], username: 'short', credential: 'lived' }],
          new Date(Date.now() + 5 * 60 * 1000).toISOString()),
      );

      const first = await getIceServersForCall({
        signalingUrl: 'https://signal.example/',
        sessionId: 'session-id',
        fetchImpl,
      });
      const second = await getIceServersForCall({
        signalingUrl: 'https://signal.example/',
        sessionId: 'session-id',
        fetchImpl,
      });

      expect(first).toEqual(second);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith('https://signal.example/turn-credentials', {
        headers: { Authorization: 'Bearer ' + 'session-id' },
      });
    });

    test('refreshes credentials near expiry', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(response([{ urls: ['turn:first'] }], new Date(Date.now() + 30_000).toISOString()))
        .mockResolvedValueOnce(response([{ urls: ['turn:second'] }], new Date(Date.now() + 5 * 60 * 1000).toISOString()));

      await expect(
        getIceServersForCall({ signalingUrl: 'https://signal.example', sessionId: 'session-id', fetchImpl }),
      ).resolves.toEqual([{ urls: ['turn:first'] }]);
      await expect(
        getIceServersForCall({ signalingUrl: 'https://signal.example', sessionId: 'session-id', fetchImpl }),
      ).resolves.toEqual([{ urls: ['turn:second'] }]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('falls back from a failed refresh to cache, static credentials, then STUN', async () => {
      const cachedFetch = jest
        .fn()
        .mockResolvedValueOnce(response([{ urls: ['turn:cached'] }], new Date(Date.now() + 30_000).toISOString()))
        .mockRejectedValueOnce(new Error('offline'));
      await getIceServersForCall({
        signalingUrl: 'https://signal.example',
        sessionId: 'session-id',
        fetchImpl: cachedFetch,
      });
      await expect(
        getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: cachedFetch,
        }),
      ).resolves.toEqual([{ urls: ['turn:cached'] }]);

      resetIceServersForCallCache();
      process.env.TURN_USERNAME = 'static-user';
      process.env.TURN_CREDENTIAL = 'static-password';
      await expect(
        getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
        }),
      ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ username: 'static-user' })]));

      clearTurnEnv();
      await expect(
        getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
        }),
      ).resolves.toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    });

    describe('degradation logging', () => {
      const turnServers = [
        { urls: ['turn:relay.example.com:3478'], username: 'minted', credential: 'secret' },
      ];

      beforeEach(() => {
        (logError as jest.Mock).mockClear();
        (logInfo as jest.Mock).mockClear();
        (logVerbose as jest.Mock).mockClear();
        (logWarn as jest.Mock).mockClear();
      });

      /** The metadata of the single warn emitted by a degraded call. */
      function warnMetadata() {
        expect(logWarn).toHaveBeenCalledTimes(1);
        return (logWarn as jest.Mock).mock.calls[0][1];
      }

      test('a successful fetch logs neither a warning nor an error', async () => {
        const fetchImpl = jest
          .fn()
          .mockResolvedValue(response(turnServers, new Date(Date.now() + 5 * 60 * 1000).toISOString()));

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });

        expect(logWarn).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
        expect(logInfo).toHaveBeenCalledWith(
          '[WebRTC] ICE servers fetched',
          expect.objectContaining({ tier: 'fetched', turnServers: ['turn:relay.example.com'] }),
        );
      });

      test('never logs the credentials it fetched', async () => {
        const fetchImpl = jest
          .fn()
          .mockResolvedValue(response(turnServers, new Date(Date.now() + 5 * 60 * 1000).toISOString()));

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });

        const logged = JSON.stringify([
          (logInfo as jest.Mock).mock.calls,
          (logVerbose as jest.Mock).mock.calls,
        ]);
        expect(logged).not.toContain('minted');
        expect(logged).not.toContain('secret');
        expect(logged).not.toContain('session-id');
      });

      test('warns with the missing-session-id reason when no fetch is attempted', async () => {
        const fetchImpl = jest.fn();

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: null,
          fetchImpl,
        });

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(warnMetadata()).toMatchObject({
          tier: 'build-time-config',
          reason: 'missing-session-id',
          host: 'https://signal.example',
        });
      });

      test('warns with the missing-signaling-url reason', async () => {
        await getIceServersForCall({ sessionId: 'session-id', fetchImpl: jest.fn() });

        expect(warnMetadata()).toMatchObject({
          tier: 'build-time-config',
          reason: 'missing-signaling-url',
          host: 'unset',
        });
      });

      test('warns with the HTTP status when the credential request is rejected', async () => {
        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 401 }),
        });

        expect(warnMetadata()).toMatchObject({
          tier: 'build-time-config',
          reason: 'http-error',
          status: 401,
        });
      });

      test('warns with the transport error instead of discarding it', async () => {
        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: jest.fn().mockRejectedValue(new Error('Network request failed')),
        });

        expect(warnMetadata()).toMatchObject({
          tier: 'build-time-config',
          reason: 'transport-error',
          message: expect.stringContaining('Network request failed'),
        });
      });

      test('warns with the malformed-response reason for a non-array body', async () => {
        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl: jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ iceServers: [] }),
            headers: { get: () => null },
          }),
        });

        expect(warnMetadata()).toMatchObject({
          tier: 'build-time-config',
          reason: 'malformed-response',
        });
      });

      test('warns that it served a stale cache, and does not repeat the error', async () => {
        const fetchImpl = jest
          .fn()
          .mockResolvedValueOnce(response(turnServers, new Date(Date.now() + 30_000).toISOString()))
          .mockRejectedValueOnce(new Error('offline'));

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });
        (logWarn as jest.Mock).mockClear();
        (logError as jest.Mock).mockClear();

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });

        expect(warnMetadata()).toMatchObject({
          tier: 'stale-cache',
          reason: 'transport-error',
          turnServers: ['turn:relay.example.com'],
        });
        // A stale relay is still a relay, so this is not the TURN-less error.
        expect(logError).not.toHaveBeenCalled();
      });

      test('logs an error when the final list has no TURN server at all', async () => {
        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: null,
          fetchImpl: jest.fn(),
        });

        expect(logError).toHaveBeenCalledWith(
          '[WebRTC] ICE server list contains no TURN server',
          expect.objectContaining({ tier: 'build-time-config', reason: 'missing-session-id' }),
        );
      });

      test('serves a fresh cache as verbose detail rather than news', async () => {
        const fetchImpl = jest
          .fn()
          .mockResolvedValue(response(turnServers, new Date(Date.now() + 5 * 60 * 1000).toISOString()));

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });
        (logInfo as jest.Mock).mockClear();

        await getIceServersForCall({
          signalingUrl: 'https://signal.example',
          sessionId: 'session-id',
          fetchImpl,
        });

        expect(logVerbose).toHaveBeenCalledWith(
          '[WebRTC] ICE servers served from cache',
          expect.objectContaining({ tier: 'cache' }),
        );
        expect(logWarn).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
      });
    });
  });

  test('adds Metered TURN server when credentials are provided', () => {
    process.env.TURN_USERNAME = 'demo-user';
    process.env.TURN_CREDENTIAL = 'demo-pass';

    const servers = getIceServers();
    expect(servers).toHaveLength(2);
    expect(servers[0].urls).toEqual(['stun:stun.l.google.com:19302']);
    expect(servers[1].urls).toContain('turn:global.relay.metered.ca:80');
    expect(servers[1].username).toBe('demo-user');
    expect(servers[1].credential).toBe('demo-pass');
  });

  test('uses TURN_URL for self-hosted TURN when provided', () => {
    process.env.TURN_USERNAME = 'u';
    process.env.TURN_CREDENTIAL = 'p';
    process.env.TURN_URL = 'turn:relay.example.com:3478,turns:relay.example.com:5349';

    const servers = getIceServers();
    expect(servers).toHaveLength(2);
    expect(servers[0].urls).toEqual([
      'stun:relay.example.com:3478',
      'stun:stun.l.google.com:19302',
    ]);
    expect(servers[1].urls).toEqual([
      'turn:relay.example.com:3478',
      'turns:relay.example.com:5349',
    ]);
    expect(servers[1].username).toBe('u');
    expect(servers[1].credential).toBe('p');
    // Must NOT include metered.ca when TURN_URL is set
    expect(JSON.stringify(servers)).not.toContain('metered.ca');
  });

  test('TURN_URL without credentials still advertises self-hosted STUN', () => {
    process.env.TURN_URL = 'turn:relay.example.com:3478';

    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toEqual([
      'stun:relay.example.com:3478',
      'stun:stun.l.google.com:19302',
    ]);
  });
});

describe('getTurnDiagnostics', () => {
  let consoleWarnSpy: jest.SpyInstance;
  beforeEach(() => {
    clearTurnEnv();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
    clearTurnEnv();
  });

  test('returns not-configured and warns when no credentials', () => {
    const result = getTurnDiagnostics();
    expect(result.configured).toBe(false);
    expect(result.provider).toBe('none');
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('No TURN credentials'));
  });

  test('returns metered provider when credentials are set without TURN_URL', () => {
    process.env.TURN_USERNAME = 'u';
    process.env.TURN_CREDENTIAL = 'p';
    const result = getTurnDiagnostics();
    expect(result.configured).toBe(true);
    expect(result.provider).toBe('metered');
  });

  test('returns custom provider when TURN_URL is set', () => {
    process.env.TURN_USERNAME = 'u';
    process.env.TURN_CREDENTIAL = 'p';
    process.env.TURN_URL = 'turn:relay.example.com:3478';
    const result = getTurnDiagnostics();
    expect(result.configured).toBe(true);
    expect(result.provider).toBe('custom');
    expect(result.description).toContain('relay.example.com');
  });
});

describe('applyBitrateConstraints', () => {
  test('calls setParameters on video and audio senders', async () => {
    const makeVideoSender = () => ({
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [{ active: true }] }),
      setParameters: jest.fn().mockResolvedValue(undefined),
    });
    const makeAudioSender = () => ({
      track: { kind: 'audio' },
      getParameters: () => ({ encodings: [{ active: true }] }),
      setParameters: jest.fn().mockResolvedValue(undefined),
    });
    const videoSender = makeVideoSender();
    const audioSender = makeAudioSender();
    const pc = { getSenders: () => [videoSender, audioSender] };

    await applyBitrateConstraints((pc as any));

    expect(videoSender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxBitrate: 1_500_000 })],
      }),
    );
    expect(audioSender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxBitrate: 64_000 })],
      }),
    );
  });

  test('respects custom bitrate options', async () => {
    const sender = {
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [] }),
      setParameters: jest.fn().mockResolvedValue(undefined),
    };
    const pc = { getSenders: () => [sender] };

    await applyBitrateConstraints((pc as any), { videoMaxBps: 500_000 });

    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxBitrate: 500_000 })],
      }),
    );
  });

  test('silently skips senders without getParameters', async () => {
    const sender = { track: { kind: 'video' }, setParameters: jest.fn() };
    const pc = { getSenders: () => [sender] };
    await expect(applyBitrateConstraints((pc as any))).resolves.toBeUndefined();
    expect(sender.setParameters).not.toHaveBeenCalled();
  });

  test('silently skips setParameters errors', async () => {
    const sender = {
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: jest.fn().mockRejectedValue(new Error('not supported')),
    };
    const pc = { getSenders: () => [sender] };
    await expect(applyBitrateConstraints((pc as any))).resolves.toBeUndefined();
  });
});
