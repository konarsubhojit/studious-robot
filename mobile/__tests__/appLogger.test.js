// @ts-check
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  appendFile: jest.fn(),
  exists: jest.fn(),
  readFile: jest.fn(),
}));

import RNFS from 'react-native-fs';
import {
  clearLogs,
  getLogsAsText,
  getLogsForExport,
  logBackgroundInfo,
  logError,
  logInfo,
  logVerbose,
} from '../src/appLogger';

describe('appLogger', () => {
  beforeEach(() => {
    clearLogs();
    jest.clearAllMocks();
    delete process.env.VERBOSE_LOGGING;
    delete process.env.LOG_LEVEL;
  });

  test('stores timestamp, level, and message', () => {
    logInfo('logger started');

    const logs = getLogsAsText();
    expect(logs).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] logger started$/m);
  });

  test('serializes metadata safely with circular objects', () => {
    /** @type {Record<string, unknown>} */
    const metadata = { name: 'device' };
    metadata.self = metadata;

    expect(() => logInfo('circular metadata', metadata)).not.toThrow();
    expect(getLogsAsText()).toContain('"self":"[Circular]"');
  });

  test('redacts sensitive fields in metadata and errors', () => {
    const err = /** @type {Error & { context?: unknown }} */ (new Error('socket failed'));
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

  test('background logs are persisted and included in export text', async () => {
    /** @type {jest.Mock} */ (RNFS.appendFile).mockResolvedValueOnce(undefined);
    /** @type {jest.Mock} */ (RNFS.exists).mockResolvedValueOnce(true);
    /** @type {jest.Mock} */ (RNFS.readFile).mockResolvedValueOnce('persisted background line\n');

    await logBackgroundInfo('background receipt', { callId: 'call-1' });
    const exported = await getLogsForExport();

    expect(RNFS.appendFile).toHaveBeenCalledWith(
      '/docs/wetalk-background.log',
      expect.stringContaining('[INFO] background receipt'),
      'utf8',
    );
    expect(exported).toContain('background receipt');
    expect(exported).toContain('--- persisted background logs ---');
    expect(exported).toContain('persisted background line');
  });
});
