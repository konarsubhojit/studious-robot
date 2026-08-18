describe('index startup registration diagnostics', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('logs and records degraded state when native registration fails', () => {
    const logError = jest.fn();
    const recordStartupIssue = jest.fn();
    jest.doMock('react-native-gesture-handler', () => ({}), { virtual: true });
    jest.doMock('@react-native-firebase/app', () => ({}));
    jest.doMock('react-native', () => ({
      AppRegistry: { registerComponent: jest.fn() },
    }));
    jest.doMock('../App', () => () => null);
    jest.doMock('../src/appLogger', () => ({
      getLogsAsText: jest.fn(() => ''),
      logError,
    }));
    jest.doMock('../src/ErrorBoundary', () => ({ children }) => children);
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
    }));

    require('../index');

    expect(logError).toHaveBeenCalledWith('[Startup] Background push handler registration failed');
    expect(logError).toHaveBeenCalledWith('[Startup] CallKeep action listener registration failed');
    expect(logError).toHaveBeenCalledWith(
      '[Startup] CallKeep showIncomingCallUi listener registration failed',
    );
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
  });
});
