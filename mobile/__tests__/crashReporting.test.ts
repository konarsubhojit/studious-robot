jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  redactSensitive: jest.fn((value: unknown) => value),
}));

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/documents',
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

/**
 * Crash reporting is an *optional* native module: `mobile-ci.yml` runs on
 * Ubuntu with no native module installed or initialised, so every path below
 * must degrade to a no-op rather than throw. This mirrors
 * `callKeep.test.ts` (package absent) and the optional-messaging tests.
 */
describe('crashReporting', () => {
  // `SENTRY_DSN` is inlined into the bundle at build time (babel.config.js), so
  // it cannot be set at runtime: tests pass the DSN explicitly instead.
  const DSN = 'https://public@example.invalid/1';

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.dontMock('@sentry/react-native');
  });

  describe('with the native module absent', () => {
    beforeEach(() => {
      jest.doMock('@sentry/react-native', () => {
        throw new Error('missing native module');
      });
    });

    test('the loader returns null and only warns once', () => {
      const { loadCrashReportingSdk } = require('../src/crashReporting');

      expect(loadCrashReportingSdk()).toBeNull();
      expect(loadCrashReportingSdk()).toBeNull();

      const { logWarn } = require('../src/appLogger');
      expect(logWarn).toHaveBeenCalledTimes(1);
    });

    test('a configured DSN reports the reporter as unavailable instead of throwing', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      const addSink = jest.fn();

      expect(initCrashReporting(addSink, DSN)).toBe('unavailable');
      expect(addSink).not.toHaveBeenCalled();
    });

    test('global crashes still save locally and chain when the SDK is absent', async () => {
      const { initCrashReporting } = require('../src/crashReporting');
      const { installCrashHandler } = require('../src/crashReporter');
      const original = jest.fn();
      let handler: any;
      const previousErrorUtils = (global as any).ErrorUtils;
      (global as any).ErrorUtils = {
        getGlobalHandler: () => original,
        setGlobalHandler: (installed: any) => { handler = installed; },
      };
      try {
        initCrashReporting(undefined, DSN);
        installCrashHandler(() => 'offline logs');
        const error = new Error('offline crash');
        expect(() => handler(error, true)).not.toThrow();
        expect(original).toHaveBeenCalledWith(error, true);
        expect(require('react-native-fs').writeFile).toHaveBeenCalledWith(
          expect.any(String), expect.stringContaining('offline logs'), 'utf8',
        );
        await Promise.resolve();
      } finally {
        (global as any).ErrorUtils = previousErrorUtils;
      }
    });
  });

  describe('with the native module present', () => {
    const sdk = {
      init: jest.fn(),
      addBreadcrumb: jest.fn(),
      captureException: jest.fn(),
      reactNativeErrorHandlersIntegration: jest.fn(),
    };

    beforeEach(() => {
      sdk.init.mockReset();
      sdk.addBreadcrumb.mockReset();
      sdk.captureException.mockReset();
      sdk.reactNativeErrorHandlersIntegration.mockReset();
      jest.doMock('@sentry/react-native', () => sdk);
    });

    test('stays off without a build-time DSN', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      const addSink = jest.fn();

      expect(initCrashReporting(addSink)).toBe('disabled');
      expect(sdk.init).not.toHaveBeenCalled();
      expect(addSink).not.toHaveBeenCalled();
      require('../src/crashReporting').captureCrash(new Error('disabled'), true, () => '');
      expect(sdk.captureException).not.toHaveBeenCalled();
    });

    test('initialises with the build-time DSN and never sends default PII', () => {
      const { initCrashReporting } = require('../src/crashReporting');

      expect(initCrashReporting(undefined, DSN)).toBe('enabled');
      expect(sdk.init).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: DSN, sendDefaultPii: false }),
      );
      const { beforeBreadcrumb } = sdk.init.mock.calls[0][0];
      expect(beforeBreadcrumb({ category: 'console', message: 'private message' })).toBeNull();
      expect(beforeBreadcrumb({ category: 'http', data: { url: '/users/alice' } })).toBeNull();
      const appBreadcrumb = { category: 'app', message: 'app.startup', data: {} };
      expect(beforeBreadcrumb(appBreadcrumb)).toBe(appBreadcrumb);
    });

    test('leaves release and dist unset for credential-free local builds', () => {
      const { initCrashReporting } = require('../src/crashReporting');

      initCrashReporting(undefined, DSN);
      expect(sdk.init).toHaveBeenCalledWith(
        expect.objectContaining({ release: undefined, dist: undefined }),
      );
    });

    test('keeps one enriched global capture while retaining native integrations', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      const { installCrashHandler } = require('../src/crashReporter');
      const original = jest.fn();
      let handler: any;
      const previousErrorUtils = (global as any).ErrorUtils;
      (global as any).ErrorUtils = {
        getGlobalHandler: () => handler ?? original,
        setGlobalHandler: (installed: any) => { handler = installed; },
      };
      const nativeIntegration = { name: 'DeviceContext', setupOnce: jest.fn() };
      const setupRejectionTracker = jest.fn();
      const jsIntegration = {
        name: 'ReactNativeErrorHandlers',
        setupOnce: jest.fn(() => {
          const previous = handler;
          handler = (error: Error, isFatal: boolean) => {
            sdk.captureException(error);
            previous(error, isFatal);
          };
        }),
      };
      sdk.init.mockImplementation(options => {
        options.integrations([jsIntegration, nativeIntegration]).forEach((integration: any) => integration.setupOnce());
      });
      sdk.reactNativeErrorHandlersIntegration.mockImplementation(options => ({
        name: 'ReactNativeErrorHandlers',
        setupOnce: () => {
          setupRejectionTracker();
          if (options.onerror) jsIntegration.setupOnce();
        },
      }));
      try {
        installCrashHandler(() => '');
        initCrashReporting(undefined, DSN);
        handler(new Error('global crash'), true);
        expect(jsIntegration.setupOnce).not.toHaveBeenCalled();
        expect(sdk.reactNativeErrorHandlersIntegration).toHaveBeenCalledWith({ onerror: false });
        expect(setupRejectionTracker).toHaveBeenCalledTimes(1);
        expect(nativeIntegration.setupOnce).toHaveBeenCalledTimes(1);
        expect(sdk.captureException).toHaveBeenCalledTimes(1);
        expect(sdk.captureException.mock.calls[0][1]).toEqual(expect.objectContaining({
          captureContext: expect.objectContaining({ level: 'fatal' }),
          mechanism: { handled: false, type: 'onerror' },
        }));
        expect(original).toHaveBeenCalledTimes(1);
      } finally {
        (global as any).ErrorUtils = previousErrorUtils;
      }
    });

    test('is idempotent, so a second call never re-initialises the SDK', () => {
      const { initCrashReporting } = require('../src/crashReporting');

      expect(initCrashReporting(undefined, DSN)).toBe('enabled');
      expect(initCrashReporting(undefined, DSN)).toBe('enabled');
      expect(sdk.init).toHaveBeenCalledTimes(1);
    });

    test('a failing initialisation degrades to unavailable', () => {
      sdk.init.mockImplementation(() => {
        throw new Error('native init failed');
      });
      const { initCrashReporting } = require('../src/crashReporting');
      const addSink = jest.fn();

      expect(initCrashReporting(addSink, DSN)).toBe('unavailable');
      expect(addSink).not.toHaveBeenCalled();
    });

    test('forwards observability events as redacted breadcrumbs', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      let registered: ((event: any) => void) | undefined;
      const addSink = jest.fn(sink => {
        registered = sink;
        return () => {};
      });

      expect(initCrashReporting(addSink, DSN)).toBe('enabled');
      registered?.({ level: 'warn', name: 'call.failed', token: 'secret-token' });

      const { redactSensitive } = require('../src/appLogger');
      expect(redactSensitive).toHaveBeenCalledWith({ token: 'secret-token' });
      expect(sdk.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warning', message: 'call.failed' }),
      );
    });

    test('a throwing reporter never breaks the emitting caller', () => {
      sdk.addBreadcrumb.mockImplementation(() => {
        throw new Error('reporter is down');
      });
      const { initCrashReporting } = require('../src/crashReporting');
      let registered: ((event: any) => void) | undefined;

      initCrashReporting((sink: any) => {
        registered = sink;
        return () => {};
      }, DSN);

      expect(() => registered?.({ level: 'info', name: 'app.startup' })).not.toThrow();
    });

    test.each([true, false])('captures exceptions with safe runtime context (fatal=%s)', isFatal => {
      const { initCrashReporting, captureCrash, registerCrashContext } = require('../src/crashReporting');
      initCrashReporting(undefined, DSN);
      const unregister = registerCrashContext(() => ({
        signalingUrl: 'https://alice@signal.example:8443/users/alice?token=private#fragment',
        callPhase: 'in_call',
        userId: 'alice',
        email: 'alice@example.com',
      }));
      const error = Object.assign(new TypeError('capture test'), { body: 'private message', attachmentKey: 'private-key' });
      captureCrash(error, isFatal, () => [
        '2026-10-03T02:40:00.000Z [INFO] [CallFlow] Phase changed {"callPhase":"in_call","userId":"alice","body":"private message","attachmentKey":"private-key"}',
        '2026-10-03T02:40:01.000Z [ERROR] alice@example.com private message',
      ].join('\n'));

      const [exception, context] = sdk.captureException.mock.calls[0];
      expect(exception.name).toBe(error.name);
      expect(exception.message).toBe(error.message);
      expect(exception.stack).toBe(error.stack);
      expect(exception.body).toBeUndefined();
      expect(exception.attachmentKey).toBeUndefined();
      expect(context).toEqual({
        captureContext: {
          level: isFatal ? 'fatal' : 'error',
          tags: { isFatal: String(isFatal), appVersion: require('../src/appInfo').APP_VERSION, signalingHost: 'signal.example:8443', callPhase: 'in_call' },
        },
        mechanism: { handled: false, type: 'onerror' },
        attachments: [expect.objectContaining({ filename: 'app-logs.jsonl', data: expect.stringContaining('"callPhase":"in_call"') })],
      });
      for (const privateText of ['alice', 'password', 'private message', 'private-key', 'token=']) {
        expect(JSON.stringify(context)).not.toContain(privateText);
      }
      unregister();
      captureCrash(error, false);
      expect(sdk.captureException.mock.calls[1][1].captureContext.tags).not.toHaveProperty('callPhase');
      expect(sdk.captureException.mock.calls[1][1].captureContext.tags).not.toHaveProperty('signalingHost');
    });

    test('omits inactive phases and invalid signaling URLs', () => {
      const { initCrashReporting, captureCrash, registerCrashContext } = require('../src/crashReporting');
      initCrashReporting(undefined, DSN);
      for (const callPhase of ['idle', 'ended', 'alice@example.com']) {
        registerCrashContext(() => ({ signalingUrl: 'not a URL alice@example.com', callPhase }));
        captureCrash(new Error('test'), false);
      }
      for (const [, context] of sdk.captureException.mock.calls) {
        expect(context.captureContext.tags).not.toHaveProperty('callPhase');
        expect(context.captureContext.tags).not.toHaveProperty('signalingHost');
      }
    });

    test('context and log callback failures do not suppress capture', () => {
      const { initCrashReporting, captureCrash, registerCrashContext } = require('../src/crashReporting');
      initCrashReporting(undefined, DSN);
      registerCrashContext(() => { throw new Error('context failure'); });
      expect(() => captureCrash(new Error('test'), true, () => { throw new Error('log failure'); })).not.toThrow();
      expect(sdk.captureException).toHaveBeenCalledTimes(1);
      expect(sdk.captureException.mock.calls[0][1].attachments).toEqual([]);
    });

    test('a partial SDK without captureException remains usable', () => {
      jest.doMock('@sentry/react-native', () => ({ init: sdk.init }));
      const { initCrashReporting, captureCrash } = require('../src/crashReporting');
      expect(initCrashReporting(undefined, DSN)).toBe('enabled');
      expect(() => captureCrash(new Error('test'), true)).not.toThrow();
    });

    test('SDK synchronous throws and rejected promises never escape', async () => {
      const { initCrashReporting, captureCrash } = require('../src/crashReporting');
      initCrashReporting(undefined, DSN);
      sdk.captureException.mockImplementationOnce(() => { throw new Error('SDK failed'); });
      expect(() => captureCrash(new Error('test'), true)).not.toThrow();
      sdk.captureException.mockRejectedValueOnce(new Error('async SDK failed'));
      expect(() => captureCrash(new Error('test'), true)).not.toThrow();
      await Promise.resolve();
    });

    test('does not send chat data in accumulated observability breadcrumbs', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      let sink: any;
      initCrashReporting((registered: any) => { sink = registered; return () => {}; }, DSN);
      sink({ level: 'info', name: 'call.phase', callPhase: 'incoming_ringing', userId: 'alice', email: 'alice@example.com', body: 'private message', attachmentKey: 'private-key', nested: { text: 'private message' } });
      expect(sdk.addBreadcrumb.mock.calls[0][0]).toEqual({
        category: 'app', level: 'info', message: 'call.phase', data: { callPhase: 'incoming_ringing' },
      });
    });

    test('redacts email and labelled content in exception details', () => {
      const { initCrashReporting, captureCrash } = require('../src/crashReporting');
      initCrashReporting(undefined, DSN);
      captureCrash(new Error('alice@example.com body: private message'), false);
      const [exception] = sdk.captureException.mock.calls[0];
      expect(exception.message).toBe('[REDACTED] body=[REDACTED]');
      expect(exception.stack).not.toContain('alice@example.com');
      expect(exception.stack).not.toContain('private message');
    });
  });
});
