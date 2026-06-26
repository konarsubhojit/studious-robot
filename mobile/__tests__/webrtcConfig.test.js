import { applyBitrateConstraints, getIceServers, getTurnDiagnostics } from '../src/webrtcConfig';

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

describe('getIceServers', () => {
  beforeEach(clearTurnEnv);
  afterEach(clearTurnEnv);

  test('includes Google STUN server by default', () => {
    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toContain('stun:stun.l.google.com:19302');
  });

  test('adds Metered TURN server when credentials are provided', () => {
    process.env.TURN_USERNAME = 'demo-user';
    process.env.TURN_CREDENTIAL = 'demo-pass';

    const servers = getIceServers();
    expect(servers).toHaveLength(2);
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
    expect(servers[1].urls).toEqual([
      'turn:relay.example.com:3478',
      'turns:relay.example.com:5349',
    ]);
    expect(servers[1].username).toBe('u');
    expect(servers[1].credential).toBe('p');
    // Must NOT include metered.ca when TURN_URL is set
    expect(JSON.stringify(servers)).not.toContain('metered.ca');
  });

  test('TURN_URL without credentials is ignored', () => {
    process.env.TURN_URL = 'turn:relay.example.com:3478';

    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toContain('stun:stun.l.google.com:19302');
  });
});

describe('getTurnDiagnostics', () => {
  let consoleWarnSpy;
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

    await applyBitrateConstraints(pc);

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

    await applyBitrateConstraints(pc, { videoMaxBps: 500_000 });

    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxBitrate: 500_000 })],
      }),
    );
  });

  test('silently skips senders without getParameters', async () => {
    const sender = { track: { kind: 'video' }, setParameters: jest.fn() };
    const pc = { getSenders: () => [sender] };
    await expect(applyBitrateConstraints(pc)).resolves.toBeUndefined();
    expect(sender.setParameters).not.toHaveBeenCalled();
  });

  test('silently skips setParameters errors', async () => {
    const sender = {
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: jest.fn().mockRejectedValue(new Error('not supported')),
    };
    const pc = { getSenders: () => [sender] };
    await expect(applyBitrateConstraints(pc)).resolves.toBeUndefined();
  });
});
