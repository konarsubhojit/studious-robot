// @ts-check
import { Linking } from 'react-native';
import {
  _extractIncomingCallFromMessage,
  _extractMessageFromMessage,
  _extractPushType,
  addCallLinkListener,
  addChatLinkListener,
  getInitialCallLink,
  getInitialChatLink,
  getPushToken,
  handleBackgroundPushMessage,
  handleForegroundPushMessage,
  loadMessaging,
  parseCallDeepLink,
  parseChatDeepLink,
  registerForPushNotifications,
  registerPushToken,
  sendPushReceipt,
  unregisterPushToken,
  _resetMessagingCache,
} from '../src/pushNotifications';
import {
  flushDurableLogs,
  logBackgroundInfo,
  logBackgroundWarn,
  logInfo,
  logWarn,
} from '../src/appLogger';
import * as callKeep from '../src/callKeep';
import {
  hasSeenMessage,
  markMessageSeen,
  resetMessageNotificationState,
  setActiveConversation,
  showMessageNotification,
} from '../src/messageNotification';

const globalAny = /** @type {any} */ (/** @type {unknown} */ (global));
const getInitialURLMock = /** @type {jest.Mock} */ (Linking.getInitialURL);
const addEventListenerMock = /** @type {jest.Mock} */ (Linking.addEventListener);
const showMessageNotificationMock = /** @type {jest.Mock} */ (
  /** @type {unknown} */ (showMessageNotification)
);

jest.mock('../src/messageNotification', () => {
  const actual = jest.requireActual('../src/messageNotification');
  return { ...actual, showMessageNotification: jest.fn() };
});

jest.mock('../src/appLogger', () => ({
  flushDurableLogs: jest.fn(() => Promise.resolve()),
  logBackgroundInfo: jest.fn(() => Promise.resolve()),
  logBackgroundWarn: jest.fn(() => Promise.resolve()),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../src/settingsStorage', () => ({
  loadDeviceId: jest.fn(() => Promise.resolve('device-test')),
  loadSettings: jest.fn(() => Promise.resolve({ signalingUrl: 'http://localhost:4173' })),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: {
    getInitialURL: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('@react-native-firebase/app', () => ({
  getApp: jest.fn(() => ({ name: '[DEFAULT]' })),
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
    expect(parseCallDeepLink(/** @type {any} */ (42))).toBeNull();
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
    getInitialURLMock.mockResolvedValue('wetalk://call/call-id-99');
    const result = await getInitialCallLink();
    expect(result).toEqual({ callId: 'call-id-99' });
  });

  test('returns null when app was launched normally', async () => {
    getInitialURLMock.mockResolvedValue(null);
    const result = await getInitialCallLink();
    expect(result).toBeNull();
  });

  test('returns null when the initial URL is unrelated', async () => {
    getInitialURLMock.mockResolvedValue('https://example.com/');
    const result = await getInitialCallLink();
    expect(result).toBeNull();
  });

  test('returns null and does not throw when getInitialURL rejects', async () => {
    getInitialURLMock.mockRejectedValue(new Error('linking unavailable'));
    await expect(getInitialCallLink()).resolves.toBeNull();
  });
});

// ─── addCallLinkListener ──────────────────────────────────────────────────────

describe('addCallLinkListener', () => {
  afterEach(() => jest.clearAllMocks());

  test('invokes callback for matching deep links', () => {
    const callback = jest.fn();
    /** @type {any} */
    let capturedListener: any;
    addEventListenerMock.mockImplementation((/** @type {string} */ event: string, /** @type {any} */ listener: any) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    addCallLinkListener(callback);

    capturedListener({ url: 'wetalk://call/my-call-id' });
    expect(callback).toHaveBeenCalledWith({ callId: 'my-call-id' });
  });

  test('does not invoke callback for non-call URLs', () => {
    const callback = jest.fn();
    /** @type {any} */
    let capturedListener: any;
    addEventListenerMock.mockImplementation((/** @type {string} */ event: string, /** @type {any} */ listener: any) => {
      capturedListener = listener;
      return { remove: jest.fn() };
    });

    addCallLinkListener(callback);

    capturedListener({ url: 'https://example.com' });
    expect(callback).not.toHaveBeenCalled();
  });

  test('returns an unsubscribe function that removes the listener', () => {
    const remove = jest.fn();
    addEventListenerMock.mockReturnValue({ remove });
    const unlisten = addCallLinkListener(jest.fn());
    unlisten();
    expect(remove).toHaveBeenCalled();
  });
});

// ─── registerPushToken ────────────────────────────────────────────────────────

describe('registerPushToken', () => {
  beforeEach(() => {
    globalAny.fetch = jest.fn();
  });

  afterEach(() => {
    delete globalAny.fetch;
    jest.clearAllMocks();
  });

  test('returns true and logs on success', async () => {
    globalAny.fetch.mockResolvedValue({
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
    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('returns false on HTTP error response', async () => {
    globalAny.fetch.mockResolvedValue({
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
    globalAny.fetch.mockRejectedValue(new Error('network error'));

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
    globalAny.fetch = jest.fn();
  });

  afterEach(() => {
    delete globalAny.fetch;
    jest.clearAllMocks();
  });

  test('returns true on success', async () => {
    globalAny.fetch.mockResolvedValue({
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
    globalAny.fetch.mockResolvedValue({
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
    await expect(registerForPushNotifications(/** @type {any} */ ({}))).resolves.toBe(false);
  });
});

describe('getPushToken (native module present)', () => {
  const AUTH = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 };

  function withMessaging(/** @type {any} */ instance: any, /** @type {any} */ run: any) {
    /** @type {any} */
    let mod: any;
    jest.isolateModules(() => {
      // Real @react-native-firebase/messaging's modular API exposes free
      // functions that take the messaging instance as their first argument
      // (`getMessaging(app)` → instance, `requestPermission(instance)`, …).
      // Mocking it this way is what makes this suite actually exercise the
      // modular call sites instead of masking them.
      const messagingApi = {
        getMessaging: jest.fn(() => instance),
        requestPermission: (/** @type {any} */ inst: any) => inst.requestPermission(),
        getToken: (/** @type {any} */ inst: any) => inst.getToken(),
        registerDeviceForRemoteMessages: (/** @type {any} */ inst: any) =>
          inst.registerDeviceForRemoteMessages?.(),
        setBackgroundMessageHandler: (/** @type {any} */ inst: any, /** @type {any} */ handler: any) =>
          inst.setBackgroundMessageHandler(handler),
        onMessage: (/** @type {any} */ inst: any, /** @type {any} */ handler: any) => inst.onMessage(handler),
        AuthorizationStatus: AUTH,
      };
      jest.doMock('@react-native-firebase/messaging', () => messagingApi, { virtual: true });
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
    await withMessaging(instance, async (/** @type {any} */ mod: any) => {
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
    await withMessaging(instance, async (/** @type {any} */ mod: any) => {
      await expect(mod.getPushToken()).resolves.toBeNull();
      expect(instance.getToken).not.toHaveBeenCalled();
    });
  });

  test('returns null when the token is empty', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
      getToken: jest.fn().mockResolvedValue(''),
    };
    await withMessaging(instance, async (/** @type {any} */ mod: any) => {
      await expect(mod.getPushToken()).resolves.toBeNull();
    });
  });

  test('registerForPushNotifications registers the acquired token', async () => {
    const instance = {
      requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
      getToken: jest.fn().mockResolvedValue('fcm-token-xyz'),
    };
    globalAny.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ deviceId: 'd-1' }),
    });
    await withMessaging(instance, async (/** @type {any} */ mod: any) => {
      await expect(
        mod.registerForPushNotifications({
          sessionId: 'sess-9',
          signalingUrl: 'http://localhost:4173',
        }),
      ).resolves.toBe(true);
      expect(globalAny.fetch).toHaveBeenCalledWith(
        'http://localhost:4173/devices/register',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    delete globalAny.fetch;
  });
});

describe('background push handler', () => {
  const AUTH = { AUTHORIZED: 1, PROVISIONAL: 2, DENIED: 0 };

  beforeEach(() => {
    _resetMessagingCache();
    globalAny.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete globalAny.fetch;
    jest.restoreAllMocks();
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

  test('rings a verbatim server call.incoming data block', async () => {
    // Exact `data` map both server transports send (server/src/push.js
    // `buildDataBlock`); FCM v1 stringifies every value. The server-side
    // counterpart of this contract lives in
    // server/test/push-payload-contract.test.js.
    const displayIncomingCall = jest
      .spyOn(callKeep, 'displayIncomingCall')
      .mockResolvedValue({ shown: true });
    const serverData = {
      callId: 'call-abc',
      callerId: 'alice',
      type: 'call.incoming',
      deepLink: 'wetalk://call/call-abc',
      title: 'Incoming call',
      body: 'Call from alice',
    };

    await expect(handleBackgroundPushMessage({ data: serverData })).resolves.toEqual({
      callId: 'call-abc',
      callerId: 'alice',
      deepLink: 'wetalk://call/call-abc',
    });
    expect(displayIncomingCall).toHaveBeenCalledWith({
      callId: 'call-abc',
      callerId: 'alice',
    });
    displayIncomingCall.mockRestore();
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
    expect(logBackgroundInfo).toHaveBeenCalledWith('[Push] Background call push received', {
      callId: 'call-3',
      callerId: 'carol',
    });
  });

  test('posts receipt stages and flushes durable logs', async () => {
    jest.spyOn(callKeep, 'displayIncomingCall').mockResolvedValueOnce({ shown: true });

    await handleBackgroundPushMessage({
      data: { callId: 'call-receipt', callerId: 'alice' },
    });

    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          deviceId: 'device-test',
          callId: 'call-receipt',
          stage: 'received',
        }),
      }),
    );
    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          deviceId: 'device-test',
          callId: 'call-receipt',
          stage: 'ui_displayed',
        }),
      }),
    );
    expect(logBackgroundInfo).toHaveBeenCalledWith('[Push] Calling CallKeep displayIncomingCall', {
      callId: 'call-receipt',
    });
    expect(logBackgroundInfo).toHaveBeenCalledWith(
      '[Push] CallKeep displayIncomingCall resolved',
      {
        callId: 'call-receipt',
        shown: true,
      },
    );
    expect(flushDurableLogs).toHaveBeenCalled();
  });

  test('sendPushReceipt can use a payload-provided session id and receipt URL', async () => {
    await expect(
      sendPushReceipt({
        remoteMessage: {
          data: {
            sessionId: 'sess-1',
            deviceId: 'device-ignored',
            receiptUrl: 'https://signal.example/',
          },
        },
        callId: 'call-1',
        stage: 'ui_failed',
      }),
    ).resolves.toBe(true);

    expect(globalAny.fetch).toHaveBeenCalledWith(
      'https://signal.example/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          sessionId: 'sess-1',
          callId: 'call-1',
          stage: 'ui_failed',
        }),
      }),
    );
  });

  /**
   * Load the push module with a virtual messaging mock installed, priming the
   * memoised native lookup while the mock is active (see the identical helper
   * in the `getPushToken` block).
   */
  function withMockedMessaging(/** @type {any} */ instance: any, /** @type {any} */ run: any) {
    /** @type {any} */
    let mod: any;
    jest.isolateModules(() => {
      const messagingApi = {
        getMessaging: jest.fn(() => instance),
        requestPermission: (/** @type {any} */ inst: any) => inst.requestPermission?.(),
        getToken: (/** @type {any} */ inst: any) => inst.getToken?.(),
        setBackgroundMessageHandler: (/** @type {any} */ inst: any, /** @type {any} */ handler: any) => inst.setBackgroundMessageHandler?.(handler),
        onMessage: (/** @type {any} */ inst: any, /** @type {any} */ handler: any) =>
          typeof inst.onMessage === 'function' ? inst.onMessage(handler) : undefined,
        AuthorizationStatus: AUTH,
      };
      jest.doMock('@react-native-firebase/messaging', () => messagingApi, { virtual: true });
      mod = require('../src/pushNotifications');
      mod._resetMessagingCache();
      mod.loadMessaging();
    });
    return run(mod);
  }

  test('installForegroundMessageHandler rings pushes that arrive while open', async () => {
    const onMessage = jest.fn().mockReturnValue(jest.fn());
    await withMockedMessaging({ onMessage }, async (/** @type {any} */ mod: any) => {
      const unsubscribe = mod.installForegroundMessageHandler();
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(typeof unsubscribe).toBe('function');

      const [handler] = onMessage.mock.calls[0];
      await handler({ data: { callId: 'call-fg', callerId: 'erin' } });
      expect(logInfo).toHaveBeenCalledWith('[Push] Foreground call push received', {
        callId: 'call-fg',
        callerId: 'erin',
      });
    });
  });

  test('installForegroundMessageHandler is a no-op when onMessage is unavailable', async () => {
    await withMockedMessaging({}, (/** @type {any} */ mod: any) => {
      expect(() => mod.installForegroundMessageHandler()()).not.toThrow();
    });
  });

  test('foreground handler ignores messages without a call payload', async () => {
    await expect(handleForegroundPushMessage({ data: {} })).resolves.toBeNull();
  });

  test('installBackgroundMessageHandler wires native background callback', async () => {
    const setBackgroundMessageHandler = jest.fn();
    /** @type {any} */
    let mod: any;
    jest.isolateModules(() => {
      const instance = {
        requestPermission: jest.fn().mockResolvedValue(AUTH.AUTHORIZED),
        getToken: jest.fn().mockResolvedValue('fcm-token'),
        setBackgroundMessageHandler,
      };
      const messagingApi = {
        getMessaging: jest.fn(() => instance),
        requestPermission: (/** @type {any} */ inst: any) => inst.requestPermission(),
        getToken: (/** @type {any} */ inst: any) => inst.getToken(),
        setBackgroundMessageHandler: (/** @type {any} */ inst: any, /** @type {any} */ handler: any) =>
          inst.setBackgroundMessageHandler(handler),
        AuthorizationStatus: AUTH,
      };
      jest.doMock('@react-native-firebase/messaging', () => messagingApi, { virtual: true });
      mod = require('../src/pushNotifications');
      mod._resetMessagingCache();
    });

    expect(mod.installBackgroundMessageHandler()).toBe(true);
    expect(setBackgroundMessageHandler).toHaveBeenCalledTimes(1);

    const [handler] = setBackgroundMessageHandler.mock.calls[0];
    await handler({ data: { callId: 'call-4', callerId: 'dave' } });
    expect(logBackgroundInfo).toHaveBeenCalledWith('[Push] Background call push received', {
      callId: 'call-4',
      callerId: 'dave',
    });
  });
});

// ─── Chat deep links ──────────────────────────────────────────────────────────

describe('parseChatDeepLink', () => {
  test('parses a valid wetalk://chat/{conversationId} URL', () => {
    expect(parseChatDeepLink('wetalk://chat/alice:bob')).toEqual({
      conversationId: 'alice:bob',
    });
  });

  test('decodes a percent-encoded conversation id', () => {
    expect(parseChatDeepLink('wetalk://chat/alice%3Abob')).toEqual({
      conversationId: 'alice:bob',
    });
  });

  test('returns null for call links, other schemes and malformed input', () => {
    expect(parseChatDeepLink('wetalk://call/call-1')).toBeNull();
    expect(parseChatDeepLink('https://example.com/chat/alice:bob')).toBeNull();
    expect(parseChatDeepLink('wetalk://chat/')).toBeNull();
    expect(parseChatDeepLink('not-a-url')).toBeNull();
    expect(parseChatDeepLink(null)).toBeNull();
  });
});

describe('getInitialChatLink / addChatLinkListener', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns the conversation the app was launched from', async () => {
    getInitialURLMock.mockResolvedValue('wetalk://chat/alice:bob');
    await expect(getInitialChatLink()).resolves.toEqual({ conversationId: 'alice:bob' });
  });

  test('returns null when the app was launched from a call link', async () => {
    getInitialURLMock.mockResolvedValue('wetalk://call/call-1');
    await expect(getInitialChatLink()).resolves.toBeNull();
  });

  test('forwards only chat links to the listener', () => {
    const remove = jest.fn();
    /** @type {any} */
    let emit: any;
    addEventListenerMock.mockImplementation((/** @type {string} */ _event: string, /** @type {any} */ handler: any) => {
      emit = handler;
      return { remove };
    });
    const callback = jest.fn();
    const unsubscribe = addChatLinkListener(callback);

    emit({ url: 'wetalk://call/call-1' });
    expect(callback).not.toHaveBeenCalled();

    emit({ url: 'wetalk://chat/alice:bob' });
    expect(callback).toHaveBeenCalledWith({ conversationId: 'alice:bob' });

    unsubscribe();
    expect(remove).toHaveBeenCalled();
  });
});

// ─── Message pushes ───────────────────────────────────────────────────────────

describe('message push handling', () => {
  // The exact `data` map both server transports send for a message
  // (`buildMessageEnvelope` + `buildDataBlock` in server/src/push.js); FCM v1
  // stringifies every value.
  const SERVER_MESSAGE_DATA = {
    messageId: 'message-1',
    conversationId: 'alice:bob',
    senderId: 'alice',
    type: 'message.received',
    deepLink: 'wetalk://chat/alice:bob',
    title: 'alice',
    body: 'hey there',
  };

  beforeEach(() => {
    _resetMessagingCache();
    resetMessageNotificationState();
    globalAny.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    jest.clearAllMocks();
    showMessageNotificationMock.mockImplementation(async () => ({ shown: true }));
  });

  afterEach(() => {
    delete globalAny.fetch;
    jest.restoreAllMocks();
  });

  test('classifies pushes by the envelope type', () => {
    expect(_extractPushType({ data: SERVER_MESSAGE_DATA })).toBe('message.received');
    expect(_extractPushType({ data: { type: 'call.incoming', callId: 'call-1' } })).toBe(
      'call.incoming',
    );
    // Payload-shape fallback for servers predating the `type` field.
    expect(_extractPushType({ data: { callId: 'call-1' } })).toBe('call.incoming');
    expect(_extractPushType({ data: { messageId: 'message-1' } })).toBe('message.received');
    expect(_extractPushType({ data: {} })).toBeNull();
  });

  test('extracts the message payload a data-only push carries', () => {
    expect(_extractMessageFromMessage({ data: SERVER_MESSAGE_DATA })).toEqual({
      messageId: 'message-1',
      conversationId: 'alice:bob',
      senderId: 'alice',
      title: 'alice',
      body: 'hey there',
      deepLink: 'wetalk://chat/alice:bob',
    });
  });

  test('falls back to a default title, body and deep link', () => {
    expect(
      _extractMessageFromMessage({
        data: { messageId: 'message-2', conversationId: 'alice:bob' },
      }),
    ).toEqual({
      messageId: 'message-2',
      conversationId: 'alice:bob',
      senderId: null,
      title: 'New message',
      body: 'Sent you a message',
      deepLink: 'wetalk://chat/alice:bob',
    });
  });

  test('returns null without a messageId or conversationId', () => {
    expect(_extractMessageFromMessage({ data: { conversationId: 'alice:bob' } })).toBeNull();
    expect(_extractMessageFromMessage({ data: { messageId: 'message-1' } })).toBeNull();
  });

  test('background handler renders the notification instead of dropping the push', async () => {
    await expect(handleBackgroundPushMessage({ data: SERVER_MESSAGE_DATA })).resolves.toEqual({
      messageId: 'message-1',
      conversationId: 'alice:bob',
      senderId: 'alice',
      title: 'alice',
      body: 'hey there',
      deepLink: 'wetalk://chat/alice:bob',
    });
    expect(showMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1', conversationId: 'alice:bob' }),
    );
    expect(logBackgroundInfo).toHaveBeenCalledWith('[Push] Background message push received', {
      messageId: 'message-1',
      conversationId: 'alice:bob',
      senderId: 'alice',
    });
    expect(flushDurableLogs).toHaveBeenCalled();
  });

  test('reports message receipt stages keyed by messageId', async () => {
    await handleBackgroundPushMessage({ data: SERVER_MESSAGE_DATA });

    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: 'device-test',
          messageId: 'message-1',
          stage: 'received',
        }),
      }),
    );
    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: 'device-test',
          messageId: 'message-1',
          stage: 'notification_shown',
        }),
      }),
    );
  });

  test('reports notification_failed when nothing could be displayed', async () => {
    showMessageNotificationMock.mockResolvedValue({ shown: false, reason: 'module_unavailable' });

    await handleBackgroundPushMessage({ data: SERVER_MESSAGE_DATA });

    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: 'device-test',
          messageId: 'message-1',
          stage: 'notification_failed',
          reason: 'module_unavailable',
        }),
      }),
    );
  });

  test('does not notify twice for a message the socket already delivered', async () => {
    markMessageSeen('message-1');

    await handleBackgroundPushMessage({ data: SERVER_MESSAGE_DATA });

    expect(showMessageNotification).not.toHaveBeenCalled();
    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: 'device-test',
          messageId: 'message-1',
          stage: 'notification_suppressed',
          reason: 'already_delivered',
        }),
      }),
    );
  });

  test('suppresses the notification while that conversation is on screen', async () => {
    setActiveConversation({ peerId: 'alice', conversationId: 'alice:bob' });

    await handleForegroundPushMessage({ data: SERVER_MESSAGE_DATA });

    expect(showMessageNotification).not.toHaveBeenCalled();
    expect(hasSeenMessage('message-1')).toBe(true);
    expect(globalAny.fetch).toHaveBeenCalledWith(
      'http://localhost:4173/devices/push-receipt',
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: 'device-test',
          messageId: 'message-1',
          stage: 'notification_suppressed',
          reason: 'conversation_on_screen',
        }),
      }),
    );
  });

  test('still notifies in the foreground for another conversation', async () => {
    setActiveConversation({ peerId: 'carol', conversationId: 'bob:carol' });

    await handleForegroundPushMessage({ data: SERVER_MESSAGE_DATA });

    expect(showMessageNotification).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith('[Push] Foreground message push received', {
      messageId: 'message-1',
      conversationId: 'alice:bob',
      senderId: 'alice',
    });
  });

  test('logs unknown push types instead of silently dropping them', async () => {
    await expect(
      handleBackgroundPushMessage({ data: { type: 'presence.changed' } }),
    ).resolves.toBeNull();
    expect(logBackgroundWarn).toHaveBeenCalledWith('[Push] Background push of unknown type ignored', {
      type: 'presence.changed',
    });

    await expect(
      handleForegroundPushMessage({ data: { type: 'presence.changed' } }),
    ).resolves.toBeNull();
    expect(logWarn).toHaveBeenCalledWith('[Push] Foreground push of unknown type ignored', {
      type: 'presence.changed',
    });
  });
});

// ─── call.cancelled pushes ────────────────────────────────────────────────────

describe('call-cancelled push handling', () => {
  beforeEach(() => {
    globalAny.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete globalAny.fetch;
    jest.restoreAllMocks();
  });

  test('a background call.cancelled push dismisses the stale call UI', async () => {
    const endCall = jest.spyOn(callKeep, 'endCall').mockReturnValue(true);
    const clearPendingAnswer = jest.spyOn(callKeep, 'clearPendingAnswer').mockReturnValue(true);
    const displayIncomingCall = jest
      .spyOn(callKeep, 'displayIncomingCall')
      .mockResolvedValue({ shown: true });

    const result = await handleBackgroundPushMessage({
      data: {
        type: 'call.cancelled',
        callId: 'call-cancelled-1',
        reason: 'cancelled',
        title: 'Call ended',
        body: 'The call is no longer ringing',
        deepLink: 'wetalk://call/call-cancelled-1',
      },
    });

    expect(result).toEqual({ callId: 'call-cancelled-1', reason: 'cancelled' });
    expect(endCall).toHaveBeenCalledWith('call-cancelled-1');
    expect(clearPendingAnswer).toHaveBeenCalledWith('call-cancelled-1', 'cancelled');
    // A cancelled call must never ring.
    expect(displayIncomingCall).not.toHaveBeenCalled();
  });

  test('a foreground call.cancelled push dismisses the stale call UI', async () => {
    const endCall = jest.spyOn(callKeep, 'endCall').mockReturnValue(true);

    const result = await handleForegroundPushMessage({
      data: { type: 'call.cancelled', callId: 'call-cancelled-2', reason: 'timeout' },
    });

    expect(result).toEqual({ callId: 'call-cancelled-2', reason: 'timeout' });
    expect(endCall).toHaveBeenCalledWith('call-cancelled-2');
  });

  test('a call.cancelled push without a callId is ignored', async () => {
    const endCall = jest.spyOn(callKeep, 'endCall').mockReturnValue(true);

    expect(await handleForegroundPushMessage({ data: { type: 'call.cancelled' } })).toBeNull();
    expect(endCall).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith('[Push] Call-cancelled push missing callId');
  });
});
