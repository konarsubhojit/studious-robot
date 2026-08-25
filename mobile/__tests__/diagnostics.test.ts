import {
  buildExportHeader,
  exportDiagnosticLogs,
  fetchServerQueryTimings,
  formatQueryTimings,
} from '../src/diagnostics';

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  DownloadDirectoryPath: '/downloads',
  ExternalDirectoryPath: '/external',
  writeFile: jest.fn(async () => undefined),
}));

jest.mock('../src/appLogger', () => ({
  getLogsForExport: jest.fn(async () => ''),
  logError: jest.fn(),
  logInfo: jest.fn(),
}));

describe('diagnostics', () => {
  test('includes the active ICE transport policy in the export header', () => {
    expect(buildExportHeader({ iceTransportPolicy: 'relay' })).toContain(
      'iceTransportPolicy: relay',
    );
    expect(buildExportHeader({})).toContain('iceTransportPolicy: all');
  });

  test('includes the last selected ICE candidate pair in the export header', () => {
    const selectedCandidatePair = {
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      relayProtocol: 'udp',
      usingTurn: true,
    };

    expect(buildExportHeader({ selectedCandidatePair })).toContain(
      `selectedCandidatePair: ${JSON.stringify(selectedCandidatePair)}`,
    );
    expect(buildExportHeader({})).toContain('selectedCandidatePair: none');
  });
});

describe('server query timings in the export', () => {
  const snapshot = {
    counters: {
      db_queries_total: 3,
      db_reads_total: 2,
      db_writes_total: 1,
      db_slow_queries_total: 1,
      db_query_errors_total: 0,
    },
    dbQueries: [
      {
        backend: 'mongo',
        operation: 'listConversations',
        kind: 'read',
        count: 2,
        errors: 0,
        slow: 1,
        totalMs: 600,
        meanMs: 300,
        maxMs: 400,
      },
      {
        backend: 'pg',
        operation: 'insert',
        kind: 'write',
        count: 1,
        errors: 0,
        slow: 0,
        totalMs: 12,
        meanMs: 12,
        maxMs: 12,
      },
    ],
  };

  afterEach(() => {
    (global as any).fetch = undefined;
    jest.clearAllMocks();
  });

  test('formats the per-operation breakdown with the costliest operation first', () => {
    const text = formatQueryTimings(snapshot);
    const rows = text.split('\n').filter(line => line.startsWith('mongo') || line.startsWith('pg'));

    expect(text).toContain('totalQueries: 3 reads: 2 writes: 1 slow: 1 errors: 0');
    expect(rows[0]).toContain('listConversations');
    expect(rows[0]).toContain('read');
    expect(rows[1]).toContain('insert');
    expect(rows[1]).toContain('write');
  });

  test('says so plainly when no query has been recorded', () => {
    expect(formatQueryTimings({ counters: {}, dbQueries: [] })).toContain(
      '(no queries recorded yet)',
    );
  });

  test('fetches the snapshot from the signaling server', async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => snapshot }));
    (global as any).fetch = fetchMock;

    const text = await fetchServerQueryTimings('https://signal.example.com/');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://signal.example.com/metrics',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(text).toContain('listConversations');
  });

  test('degrades to an explanatory line when the server is unreachable', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error('Network request failed');
    });

    await expect(fetchServerQueryTimings('https://signal.example.com')).resolves.toContain(
      'metrics unavailable: Network request failed',
    );
    await expect(fetchServerQueryTimings('')).resolves.toContain('no signaling URL configured');
  });

  test('writes the timings into the exported log file', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => snapshot }));
    const RNFS = require('react-native-fs');

    const result = await exportDiagnosticLogs({ signalingUrl: 'https://signal.example.com' });

    expect(result.ok).toBe(true);
    const written = RNFS.writeFile.mock.calls[0][1];
    expect(written).toContain('--- server query timings (slowest total first) ---');
    expect(written).toContain('listConversations');
  });
});
