import { clearLogs, getLogsAsText, logError, logInfo } from '../src/appLogger';

describe('appLogger', () => {
  beforeEach(() => {
    clearLogs();
  });

  test('stores timestamp, level, and message', () => {
    logInfo('logger started');

    const logs = getLogsAsText();
    expect(logs).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] logger started$/m);
  });

  test('serializes metadata safely with circular objects', () => {
    const metadata = { name: 'device' };
    metadata.self = metadata;

    expect(() => logInfo('circular metadata', metadata)).not.toThrow();
    expect(getLogsAsText()).toContain('"self":"[Circular]"');
  });

  test('redacts sensitive fields in metadata and errors', () => {
    const err = new Error('socket failed');
    err.context = {
      TURN_USERNAME: 'demo-user',
      token: 'secret-token',
      nested: { password: 'hidden' },
    };

    logError('connect error', { authorization: '******', err });
    const logs = getLogsAsText();

    expect(logs).toContain('[REDACTED]');
    expect(logs).not.toContain('demo-user');
    expect(logs).not.toContain('secret-token');
    expect(logs).not.toContain('hidden');
    expect(logs).not.toContain('******');
  });

  test('clearLogs removes all entries', () => {
    logInfo('first');
    clearLogs();
    expect(getLogsAsText()).toBe('');
  });
});
