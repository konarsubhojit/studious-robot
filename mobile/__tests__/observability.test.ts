// @ts-check
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  appendFile: jest.fn(),
  exists: jest.fn(),
  readFile: jest.fn(),
}));

jest.mock('../src/crashReporter', () => ({ installCrashHandler: jest.fn() }));
jest.mock('../src/pushNotifications', () => ({
  installBackgroundMessageHandler: jest.fn(() => true),
}));
jest.mock('../src/callKeep', () => ({
  registerCallActionListeners: jest.fn(() => () => {}),
  registerShowIncomingCallUiListener: jest.fn(() => () => {}),
}));

import { clearLogs, getLogsAsText } from '../src/appLogger';
import { clearStartupIssues } from '../src/startupHealth';
import {
  addSink,
  emitEvent,
  emitMetric,
  getCorrelationId,
  getDegradations,
  recordDegradation,
  resetCorrelationId,
  resetObservabilityForTests,
} from '../src/observability';

describe('observability', () => {
  beforeEach(() => {
    clearLogs();
    clearStartupIssues();
    resetObservabilityForTests();
    resetCorrelationId();
  });

  test('reuses a stable per-session correlation id', () => {
    const id = getCorrelationId();

    expect(id).toMatch(/^wt-[a-z0-9]+$/);
    expect(getCorrelationId()).toBe(id);
    expect(resetCorrelationId()).not.toBe(id);
  });

  test('stamps every event with level, name, and correlation id', () => {
    const event = emitEvent('warn', 'call.failed', { callId: 'call-1' });

    expect(event).toMatchObject({
      level: 'warn',
      name: 'call.failed',
      callId: 'call-1',
      correlationId: getCorrelationId(),
    });
    expect(getLogsAsText()).toContain('[WARN] [call.failed]');
    expect(getLogsAsText()).toContain(getCorrelationId());
  });

  test('falls back to info for unknown levels', () => {
    const event = (emitEvent('trace' as any, 'call.noisy') as any);
    expect(event.level).toBe('info');
  });

  test('fans events out to pluggable sinks and can unsubscribe', () => {
    const sink = jest.fn();
    const unsubscribe = addSink(sink);

    emitMetric('call.ice_failed', 1, { callId: 'call-2' });

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'metric.call.ice_failed',
        metric: 'call.ice_failed',
        value: 1,
        callId: 'call-2',
      }),
    );

    unsubscribe();
    emitMetric('call.reconnect');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  test('a failing sink never breaks the caller or other sinks', () => {
    const healthy = jest.fn();
    addSink(() => {
      throw new Error('sink is down');
    });
    addSink(healthy);

    expect(() => emitEvent('info', 'call.started')).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });

  test('degradations are recorded for the banner and emitted as events', () => {
    const sink = jest.fn();
    addSink(sink);

    recordDegradation('backgroundPush', 'Background push handler unavailable');

    expect(getDegradations()).toEqual([
      { source: 'backgroundPush', message: 'Background push handler unavailable' },
    ]);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        name: 'startup.degraded',
        source: 'backgroundPush',
      }),
    );
  });
});
