import { getIceServers } from '../src/webrtcConfig';

describe('getIceServers', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_TURN_USERNAME;
    delete process.env.EXPO_PUBLIC_TURN_CREDENTIAL;
  });

  test('includes Google STUN server by default', () => {
    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toContain('stun:stun.l.google.com:19302');
  });

  test('adds Metered TURN server when credentials are provided', () => {
    process.env.EXPO_PUBLIC_TURN_USERNAME = 'demo-user';
    process.env.EXPO_PUBLIC_TURN_CREDENTIAL = 'demo-pass';

    const servers = getIceServers();
    expect(servers).toHaveLength(2);
    expect(servers[1].urls).toContain('turn:global.relay.metered.ca:80');
    expect(servers[1].username).toBe('demo-user');
    expect(servers[1].credential).toBe('demo-pass');
  });
});
