jest.mock('../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  redactSensitive: jest.fn((value: unknown) => value),
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
  });

  describe('with the native module present', () => {
    const sdk = {
      init: jest.fn(),
      addBreadcrumb: jest.fn(),
    };

    beforeEach(() => {
      sdk.init.mockReset();
      sdk.addBreadcrumb.mockReset();
      jest.doMock('@sentry/react-native', () => sdk);
    });

    test('stays off without a build-time DSN', () => {
      const { initCrashReporting } = require('../src/crashReporting');
      const addSink = jest.fn();

      expect(initCrashReporting(addSink)).toBe('disabled');
      expect(sdk.init).not.toHaveBeenCalled();
      expect(addSink).not.toHaveBeenCalled();
    });

    test('initialises with the build-time DSN and never sends default PII', () => {
      const { initCrashReporting } = require('../src/crashReporting');

      expect(initCrashReporting(undefined, DSN)).toBe('enabled');
      expect(sdk.init).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: DSN, sendDefaultPii: false }),
      );
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
  });
});
