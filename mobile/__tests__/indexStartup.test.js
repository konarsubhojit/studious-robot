describe('index startup registration diagnostics', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('logs and records degraded state when native registration fails', () => {
    const logError = jest.fn();
    const recordStartupIssue = jest.fn();
    jest.doMock('react-native-fs', () => ({ DocumentDirectoryPath: '/docs' }));
    jest.doMock('../src/appLogger', () => ({
      getLogsAsText: jest.fn(() => ''),
      logDebug: jest.fn(),
      logInfo: jest.fn(),
      logWarn: jest.fn(),
      logError,
      persistLogLine: jest.fn(),
    }));
    jest.doMock('../src/crashReporter', () => ({
      installCrashHandler: jest.fn(),
    }));
    jest.doMock('../src/pushNotifications', () => ({
      installBackgroundMessageHandler: jest.fn(() => false),
    }));
    jest.doMock('../src/callKeep', () => ({
      registerCallActionListeners: jest.fn(() => Object.assign(() => {}, { registered: false })),
      registerShowIncomingCallUiListener: jest.fn(() =>
        Object.assign(() => {}, { registered: false }),
      ),
    }));
    jest.doMock('../src/startupHealth', () => ({
      recordStartupIssue,
      getStartupIssues: jest.fn(() => []),
    }));

    const { initObservability } = require('../src/observability');
    const result = initObservability();

    expect(result).toMatchObject({
      backgroundPushRegistered: false,
      callActionsRegistered: false,
      incomingCallUiRegistered: false,
    });
    expect(recordStartupIssue).toHaveBeenCalledWith(
      'backgroundPush',
      'Background push handler unavailable',
    );
    expect(recordStartupIssue).toHaveBeenCalledWith(
      'callKeepActions',
      'CallKeep action listeners unavailable',
    );
    expect(recordStartupIssue).toHaveBeenCalledWith(
      'callKeepIncomingUi',
      'CallKeep incoming-call UI listener unavailable',
    );
    expect(logError).toHaveBeenCalledWith(
      '[startup.degraded]',
      expect.objectContaining({ source: 'backgroundPush' }),
    );
  });

  test('initialises observability once from the app entry point', () => {
    const initObservability = jest.fn();
    const registerComponent = jest.fn();
    jest.doMock('react-native-gesture-handler', () => ({}), { virtual: true });
    jest.doMock('@react-native-firebase/app', () => ({}));
    jest.doMock('react-native', () => ({
      AppRegistry: { registerComponent },
    }));
    jest.doMock('../App', () => () => null);
    jest.doMock('../src/ErrorBoundary', () => ({ children }) => children);
    jest.doMock('../src/observability', () => ({ initObservability }));

    require('../index');

    expect(initObservability).toHaveBeenCalledTimes(1);
    expect(registerComponent).toHaveBeenCalledTimes(1);
  });
});
