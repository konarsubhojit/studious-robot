import { Linking } from 'react-native';
import {
  _extractIncomingCallFromMessage,
  addCallLinkListener,
  getInitialCallLink,
  getPushToken,
  handleBackgroundPushMessage,
  installBackgroundMessageHandler,
  loadMessaging,
  parseCallDeepLink,
  registerForPushNotifications,
  registerPushToken,
  unregisterPushToken,
  _resetMessagingCache,
} from '../src/pushNotifications';
import { logInfo, logWarn } from '../src/appLogger';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: {
    getInitialURL: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('@react-native-firebase/messaging', () => {
  throw new Error('missing native module');
});

// ─── parseCallDeepLink ────────────────────────────────────────────────────────

describe('parseCallDeepLink', () => {
  test('parses valid wetalk://call/{callId} URL', () => {
    expect(parseCallDeepLink('wetalk://call/abc-123')).toEqual({ callId: 'abc-123' });
  });

  test('parses URL with UUID callId', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseCallDeepLink(`wetalk://call/${id}`)).toEqual({ callId: id });
  });

  test('returns null for wrong scheme', () => {
    expect(parseCallDeepLink('https://example.com/call/abc')).toBeNull();
  });

  test('returns null for wrong host', () => {
    expect(parseCallDeepLink('wetalk://join/abc-123')).toBeNull();
  });

  test('returns null for missing callId', () => {
    expect(parseCallDeepLink('wetalk://call/')).toBeNull();
    expect(parseCallDeepLink('wetalk://call')).toBeNull();
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
    Linking.getInitialURL.mockResolvedValue('wetalk://call/call-id-99');
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

    capturedListener({ url: 'wetalk://call/my-call-id' });
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

// ─── getPushToken / registerForPushNotifications ──────────────────────────────

describe('getPushToken / registerForPushNotifications (native module absent)', () => {
  beforeEach(() => {
    _resetMessagingCache();
    jest.clearAllMocks();
  });
  afterEach(() => _resetMessagingCache());

  test('loadMessaging returns null when the package is not installed', () => {
    expect(loadMessaging()).toBeNull();
  });

  test('getPushToken resolves null when the native module is missing', async () => {
    await expect(getPushToken()).resolves.toBeNull();
  });

  test('logs the missing native-module warning only once', async () => {
    expect(loadMessaging()).toBeNull();
    await expect(getPushToken()).resolves.toBeNull();
    expect(loadMessaging()).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  test('reset hook clears the missing-module warning state', () => {
    expect(loadMessaging()).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
    _resetMessagingCache();
    expect(loadMessaging()).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  test('registerForPushNotifications resolves false when no token is available', async () => {
    await expect(
      registerForPushNotifications({
        sessionId: 'sess-1',
        signalingUrl: 'http://localhost:4173',
      }),
    ).resolves.toBe(false);
  });

  test('registerForPushNotifications resolves false for missing args', async () => {
    await expect(registerForPushNotifications({})).resolves.toBe(false);
  });
});

describe('getPushToken (native module present)', () => {
  const AUTH = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 };

  function withMessaging(instance, run) {
    let mod;
    jest.isolateModules(() => {
      const messagingFn = jest.fn(() => instance);
      messagingFn.AuthorizationStatus = AUTH;
      jest.doMock(
        '@react-native-firebase/messaging',
        () => ({ __esModule: true, default: messagingFn }),
        { virtual: true },
      );
      mod = require('../src/pushNotifications');
      // Prime the memoised native-module lookup while the virtual mock is
      // active; the lazy require would otherwise resolve after isolateModules
      // exits and pick up a stale mock from a previous test.
      mod._resetMessagingCache();
      mod.loadMessaging();
    });
    return run(mod);
  }

  test('returns an fcm token when permission is granted', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
      getToken: jest.fn().mockResolvedValue('fcm-token-123'),
    };
    await withMessaging(instance, async (mod) => {
      await expect(mod.getPushToken()).resolves.toEqual({
        provider: 'fcm',
        pushToken: 'fcm-token-123',
      });
    });
  });

  test('returns null when permission is denied', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.DENIED),
      getToken: jest.fn(),
    };
    await withMessaging(instance, async (mod) => {
      await expect(mod.getPushToken()).resolves.toBeNull();
      expect(instance.getToken).not.toHaveBeenCalled();
    });
  });

  test('returns null when the token is empty', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
      getToken: jest.fn().mockResolvedValue(''),
    };
    await withMessaging(instance, async (mod) => {
      await expect(mod.getPushToken()).resolves.toBeNull();
    });
  });

  test('registerForPushNotifications registers the acquired token', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
      getToken: jest.fn().mockResolvedValue('fcm-token-xyz'),
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ deviceId: 'd-1' }),
    });
    await withMessaging(instance, async (mod) => {
      await expect(
        mod.registerForPushNotifications({
          sessionId: 'sess-9',
          signalingUrl: 'http://localhost:4173',
        }),
      ).resolves.toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4173/devices/register',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    delete global.fetch;
  });
});

describe('background push handler', () => {
  const AUTH = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 };

  beforeEach(() => {
    _resetMessagingCache();
    jest.clearAllMocks();
  });

  test('extracts incoming call payload from data messages', () => {
    expect(
      _extractIncomingCallFromMessage({
        data: { callId: 'call-1', callerId: 'alice', deepLink: 'wetalk://call/call-1' },
      }),
    ).toEqual({
      callId: 'call-1',
      callerId: 'alice',
      deepLink: 'wetalk://call/call-1',
    });
  });

  test('builds a fallback deep link when deepLink is absent', () => {
    expect(
      _extractIncomingCallFromMessage({
        data: { callId: 'call-2', callerId: 'bob' },
      }),
    ).toEqual({
      callId: 'call-2',
      callerId: 'bob',
      deepLink: 'wetalk://call/call-2',
    });
  });

  test('returns null when callId is missing', () => {
    expect(_extractIncomingCallFromMessage({ data: { callerId: 'alice' } })).toBeNull();
  });

  test('background callback logs and returns parsed call payload', async () => {
    await expect(
      handleBackgroundPushMessage({
        data: { callId: 'call-3', callerId: 'carol' },
      }),
    ).resolves.toEqual({
      callId: 'call-3',
      callerId: 'carol',
      deepLink: 'wetalk://call/call-3',
    });
    expect(logInfo).toHaveBeenCalledWith('[Push] Background call push received', {
      callId: 'call-3',
      callerId: 'carol',
    });
  });

  test('installBackgroundMessageHandler wires native background callback', async () => {
    const setBackgroundMessageHandler = jest.fn();
    let mod;
    jest.isolateModules(() => {
      const messagingFn = jest.fn(() => ({
        requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
        getToken: jest.fn().mockResolvedValue('fcm-token'),
        setBackgroundMessageHandler,
      }));
      messagingFn.AuthorizationStatus = AUTH;
      jest.doMock(
        '@react-native-firebase/messaging',
        () => ({ __esModule: true, default: messagingFn }),
        { virtual: true },
      );
      mod = require('../src/pushNotifications');
      mod._resetMessagingCache();
    });

    expect(mod.installBackgroundMessageHandler()).toBe(true);
    expect(setBackgroundMessageHandler).toHaveBeenCalledTimes(1);

    const [handler] = setBackgroundMessageHandler.mock.calls[0];
    await handler({ data: { callId: 'call-4', callerId: 'dave' } });
    expect(logInfo).toHaveBeenCalledWith('[Push] Background call push received', {
      callId: 'call-4',
      callerId: 'dave',
    });
  });
});
