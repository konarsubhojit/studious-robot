import { getAppConfig, isValidSignalingUrl, isLoopbackUrl, APP_CONFIG_DEFAULTS } from '../src/appConfig';

describe('appConfig', () => {
  afterEach(() => {
    delete process.env.SIGNALING_URL;
    delete process.env.ROOM_ID;
  });

  test('isValidSignalingUrl accepts http(s)/ws(s) URLs', () => {
    expect(isValidSignalingUrl('https://example.com')).toBe(true);
    expect(isValidSignalingUrl('http://localhost:4173')).toBe(true);
    expect(isValidSignalingUrl('wss://relay.example.com')).toBe(true);
    expect(isValidSignalingUrl('ftp://example.com')).toBe(false);
    expect(isValidSignalingUrl('not a url')).toBe(false);
    expect(isValidSignalingUrl('')).toBe(false);
  });

  test('isLoopbackUrl detects local hosts', () => {
    expect(isLoopbackUrl('http://localhost:4173')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1')).toBe(true);
    expect(isLoopbackUrl('https://signal.example.com')).toBe(false);
  });

  test('falls back to defaults when env is unset', () => {
    const config = getAppConfig();
    expect(config.signalingUrl).toBe(APP_CONFIG_DEFAULTS.signalingUrl);
    expect(config.roomId).toBe(APP_CONFIG_DEFAULTS.roomId);
  });

  test('reads valid env overrides', () => {
    process.env.SIGNALING_URL = 'https://signal.example.com';
    process.env.ROOM_ID = 'team-standup';
    const config = getAppConfig();
    expect(config.signalingUrl).toBe('https://signal.example.com');
    expect(config.roomId).toBe('team-standup');
    expect(config.warnings).toHaveLength(0);
  });

  test('warns and falls back on an invalid signaling URL', () => {
    process.env.SIGNALING_URL = 'not-a-valid-url';
    const config = getAppConfig();
    expect(config.signalingUrl).toBe(APP_CONFIG_DEFAULTS.signalingUrl);
    expect(config.warnings.length).toBeGreaterThan(0);
  });

  test('warns when pointing at a loopback host', () => {
    process.env.SIGNALING_URL = 'http://127.0.0.1:4173';
    const config = getAppConfig();
    expect(config.warnings.some((w) => w.includes('loopback'))).toBe(true);
  });
});
