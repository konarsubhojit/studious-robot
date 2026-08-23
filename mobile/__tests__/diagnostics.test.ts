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
});
