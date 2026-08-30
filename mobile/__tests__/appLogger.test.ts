jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  appendFile: jest.fn(),
  exists: jest.fn(),
  readFile: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
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
  MAX_DURABLE_LOG_BYTES,
  MAX_IN_MEMORY_LOG_ENTRIES,
  persistLogLine,
} from '../src/appLogger';

describe('appLogger', () => {
  beforeEach(() => {
    clearLogs();
    jest.clearAllMocks();
    (RNFS.appendFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.stat as jest.Mock).mockResolvedValue({ size: 0 });
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    delete process.env.VERBOSE_LOGGING;
    delete process.env.LOG_LEVEL;
  });

  test('stores timestamp, level, and message', () => {
    logInfo('logger started');

    const logs = getLogsAsText();
    expect(logs).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] logger started$/m);
  });

  test('serializes metadata safely with circular objects', () => {
    const metadata: Record<string, unknown> = { name: 'device' };
    metadata.self = metadata;

    expect(() => logInfo('circular metadata', metadata)).not.toThrow();
    expect(getLogsAsText()).toContain('"self":"[Circular]"');
  });

  test('redacts sensitive fields in metadata and errors', () => {
    const err = (new Error('socket failed') as Error & { context?: unknown });
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

  test('redacts call ids from buffered metadata', () => {
    logInfo('call status', { callId: 'call-secret', call_id: 'call-secret-2' });

    const logs = getLogsAsText();
    expect(logs).toContain('[REDACTED]');
    expect(logs).not.toContain('call-secret');
    expect(logs).not.toContain('call-secret-2');
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

  test('keeps only the newest in-memory entries', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < MAX_IN_MEMORY_LOG_ENTRIES + 5; i += 1) {
        logInfo(`entry-${i}`);
      }
    } finally {
      logSpy.mockRestore();
    }

    const logs = getLogsAsText();
    const lines = logs.split('\n');
    expect(lines).toHaveLength(MAX_IN_MEMORY_LOG_ENTRIES);
    expect(lines[0]).toContain('entry-5');
    expect(lines[lines.length - 1]).toContain(`entry-${MAX_IN_MEMORY_LOG_ENTRIES + 4}`);
  });

  test('background logs are persisted and included in export text', async () => {
    (RNFS.appendFile as jest.Mock).mockResolvedValueOnce(undefined);
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true);
    (RNFS.readFile as jest.Mock).mockResolvedValueOnce('persisted background line\n');

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

  test('truncates the durable log before an append would exceed the size cap', async () => {
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({ size: MAX_DURABLE_LOG_BYTES - 4 });

    await persistLogLine('line that would overflow');

    expect(RNFS.writeFile).toHaveBeenCalledWith('/docs/wetalk-background.log', '', 'utf8');
    expect(RNFS.appendFile).toHaveBeenCalledWith(
      '/docs/wetalk-background.log',
      'line that would overflow\n',
      'utf8',
    );
    expect(RNFS.readFile).not.toHaveBeenCalled();
  });

  test('falls back without read-modify-write when appendFile is unavailable', async () => {
    const appendFile = RNFS.appendFile as jest.Mock;
    (RNFS as any).appendFile = undefined;

    try {
      await persistLogLine('latest durable line');

      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-background.log',
        'latest durable line\n',
        'utf8',
      );
      expect(RNFS.readFile).not.toHaveBeenCalled();
    } finally {
      (RNFS as any).appendFile = appendFile;
    }
  });
});
