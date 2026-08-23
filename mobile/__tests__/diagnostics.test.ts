import { buildExportHeader } from '../src/diagnostics';

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  DownloadDirectoryPath: '/downloads',
  ExternalDirectoryPath: '/external',
  writeFile: jest.fn(),
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
