import { clearLogs, getLogsAsText, logError, logInfo, logVerbose } from '../src/appLogger';

describe('appLogger', () => {
  beforeEach(() => {
    clearLogs();
    delete process.env.VERBOSE_LOGGING;
    delete process.env.LOG_LEVEL;
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

    logError('connect error', {
      authorization: '******',
      verificationCode: 'ABCD-EFGH',
      iceServer: { username: 'short-lived-turn-user', credential: 'short-lived-turn-secret' },
      nestedRecovery: { recovery_code: 'WXYZ-1234' },
      err,
    });
    const logs = getLogsAsText();

    expect(logs).toContain('[REDACTED]');
    expect(logs).not.toContain('demo-user');
    expect(logs).not.toContain('secret-token');
    expect(logs).not.toContain('hidden');
    expect(logs).not.toContain('******');
    expect(logs).not.toContain('ABCD-EFGH');
    expect(logs).not.toContain('WXYZ-1234');
    expect(logs).not.toContain('short-lived-turn-user');
    expect(logs).not.toContain('short-lived-turn-secret');
  });

  test('clearLogs removes all entries', () => {
    logInfo('first');
    clearLogs();
    expect(getLogsAsText()).toBe('');
  });

  test('verbose logs are opt-in and redact push tokens', () => {
    logVerbose('hidden verbose', { pushToken: 'secret-device-token' });
    expect(getLogsAsText()).toBe('');

    process.env.VERBOSE_LOGGING = 'true';
    logVerbose('visible verbose', { pushToken: 'secret-device-token' });
    const logs = getLogsAsText();

    expect(logs).toContain('[VERBOSE] visible verbose');
    expect(logs).toContain('[REDACTED]');
    expect(logs).not.toContain('secret-device-token');
  });
});
