import { Linking } from 'react-native';
import {
  addCallLinkListener,
  getInitialCallLink,
  parseCallDeepLink,
  registerPushToken,
  unregisterPushToken,
} from '../src/pushNotifications';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  Linking: {
    getInitialURL: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// ─── parseCallDeepLink ────────────────────────────────────────────────────────

describe('parseCallDeepLink', () => {
  test('parses valid tcalling://call/{callId} URL', () => {
    expect(parseCallDeepLink('tcalling://call/abc-123')).toEqual({ callId: 'abc-123' });
  });

  test('parses URL with UUID callId', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseCallDeepLink(`tcalling://call/${id}`)).toEqual({ callId: id });
  });

  test('returns null for wrong scheme', () => {
    expect(parseCallDeepLink('https://example.com/call/abc')).toBeNull();
  });

  test('returns null for wrong host', () => {
    expect(parseCallDeepLink('tcalling://join/abc-123')).toBeNull();
  });

  test('returns null for missing callId', () => {
    expect(parseCallDeepLink('tcalling://call/')).toBeNull();
    expect(parseCallDeepLink('tcalling://call')).toBeNull();
  });

  test('returns null for null input', () => {
    expect(parseCallDeepLink(null)).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(parseCallDeepLink(42)).toBeNull();
    expect(parseCallDeepLink(undefined)).toBeNull();
  });

  test('returns null for malformed URL', () => {
    expect(parseCallDeepLink('not-a-url')).toBeNull();
  });
});

// ─── getInitialCallLink ───────────────────────────────────────────────────────

describe('getInitialCallLink', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns descriptor when app launched from call deep link', async () => {
    Linking.getInitialURL.mockResolvedValue('tcalling://call/call-id-99');
    const result = await getInitialCallLink();
    expect(result).toEqual({ callId: 'call-id-99' });
  });

  test('returns null when app was launched normally', async () => {
    Linking.getInitialURL.mockResolvedValue(null);
    const result = await getInitialCallLink();
    expect(result).toBeNull();
  });

  test('returns null when the initial URL is unrelated', async () => {
    Linking.getInitialURL.mockResolvedValue('https://example.com/');
    const result = await getInitialCallLink();
    expect(result).toBeNull();
  });

  test('returns null and does not throw when getInitialURL rejects', async () => {
    Linking.getInitialURL.mockRejectedValue(new Error('linking unavailable'));
    await expect(getInitialCallLink()).resolves.toBeNull();
  });
});

// ─── addCallLinkListener ──────────────────────────────────────────────────────

describe('addCallLinkListener', () => {
  afterEach(() => jest.clearAllMocks());

  test('invokes callback for matching deep links', () => {
    const callback = jest.fn();
    let capturedListener;
    Linking.addEventListener.mockImplementation((event, listener) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    addCallLinkListener(callback);

    capturedListener({ url: 'tcalling://call/my-call-id' });
    expect(callback).toHaveBeenCalledWith({ callId: 'my-call-id' });
  });

  test('does not invoke callback for non-call URLs', () => {
    const callback = jest.fn();
    let capturedListener;
    Linking.addEventListener.mockImplementation((event, listener) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    addCallLinkListener(callback);

    capturedListener({ url: 'https://example.com' });
    expect(callback).not.toHaveBeenCalled();
  });

  test('returns an unsubscribe function that removes the listener', () => {
    const remove = jest.fn();
    Linking.addEventListener.mockReturnValue({ remove });
    const unlisten = addCallLinkListener(jest.fn());
    unlisten();
    expect(remove).toHaveBeenCalled();
  });
});

// ─── registerPushToken ────────────────────────────────────────────────────────

describe('registerPushToken', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  test('returns true and logs on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ deviceId: 'device-1', provider: 'fcm' }),
    });

    const result = await registerPushToken({
      sessionId: 'sess-1',
      signalingUrl: 'http://localhost:4173',
      provider: 'fcm',
      pushToken: 'tok-abc',
    });

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns false on HTTP error response', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid session' }),
    });

    const result = await registerPushToken({
      sessionId: 'bad-sess',
      signalingUrl: 'http://localhost:4173',
      provider: 'apns',
      pushToken: 'tok-xyz',
    });

    expect(result).toBe(false);
  });

  test('returns false when fetch throws (network error)', async () => {
    global.fetch.mockRejectedValue(new Error('network error'));

    const result = await registerPushToken({
      sessionId: 'sess-2',
      signalingUrl: 'http://localhost:4173',
      provider: 'fcm',
      pushToken: 'tok-def',
    });

    expect(result).toBe(false);
  });
});

// ─── unregisterPushToken ──────────────────────────────────────────────────────

describe('unregisterPushToken', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  test('returns true on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'unregistered' }),
    });

    const result = await unregisterPushToken({
      sessionId: 'sess-3',
      signalingUrl: 'http://localhost:4173',
    });

    expect(result).toBe(true);
  });

  test('returns false on HTTP error', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad request' }),
    });

    const result = await unregisterPushToken({
      sessionId: 'sess-4',
      signalingUrl: 'http://localhost:4173',
    });

    expect(result).toBe(false);
  });
});
