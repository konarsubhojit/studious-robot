jest.mock('react-native-fs', () => ({
  DownloadDirectoryPath: '/storage/emulated/0/Download',
  ExternalDirectoryPath: '/storage/emulated/0/Android/data/com.app/files',
  DocumentDirectoryPath: '/data/user/0/com.app/files/Documents',
  writeFile: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

jest.mock('../src/crashReporting', () => ({
  captureCrash: jest.fn(),
}));

import RNFS from 'react-native-fs';
import { installCrashHandler, saveCrashLog } from '../src/crashReporter';
import { captureCrash } from '../src/crashReporting';

const writeFileMock = (RNFS.writeFile as jest.Mock);
const globalWithErrorUtils = (global as any);

describe('saveCrashLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('writes to Downloads first on Android', async () => {
    writeFileMock.mockResolvedValueOnce(undefined);

    const error = new Error('test crash');
    const result = await saveCrashLog(error, true, () => 'app log line');

    expect(result.success).toBe(true);
    expect(result.label).toBe('Downloads');
    expect(writeFileMock).toHaveBeenCalledTimes(1);

    const [path, content] = writeFileMock.mock.calls[0];
    expect(path).toMatch(/wetalk-crash-\d{8}-\d{6}\.txt$/);
    expect(content).toContain('test crash');
    expect(content).toContain('app log line');
    expect(content).toContain('isFatal: true');
  });

  test('falls back to next storage target on write failure', async () => {
    writeFileMock
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(new Error('oops'), false, () => '');

    expect(result.success).toBe(true);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
  });

  test('returns success: false when all storage targets fail', async () => {
    writeFileMock.mockRejectedValue(new Error('disk full'));

    const result = await saveCrashLog(new Error('bad'), false, () => '');

    expect(result.success).toBe(false);
    expect(result.path).toBeUndefined();
  });

  test('handles null error without throwing', async () => {
    writeFileMock.mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(null, false, () => '');

    expect(result.success).toBe(true);
    const [, content] = writeFileMock.mock.calls[0];
    expect(content).toContain('error.name: unknown');
    expect(content).toContain('error.message: unknown');
  });

  test('handles missing log callback', async () => {
    writeFileMock.mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(new Error('x'), false, undefined);

    expect(result.success).toBe(true);
    const [, content] = writeFileMock.mock.calls[0];
    expect(content).toContain('no log callback');
  });

  test('includes the error stack in the report', async () => {
    writeFileMock.mockResolvedValueOnce(undefined);

    const error = new Error('stack test');
    await saveCrashLog(error, false, () => '');

    const [, content] = writeFileMock.mock.calls[0];
    expect(content).toContain('error.stack:');
  });
});

describe('installCrashHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (captureCrash as jest.Mock).mockReset();
    writeFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete globalWithErrorUtils.ErrorUtils;
  });

  test('replaces the global handler when ErrorUtils is available', () => {
    const original = jest.fn();
    globalWithErrorUtils.ErrorUtils = {
      getGlobalHandler: jest.fn().mockReturnValue(original),
      setGlobalHandler: jest.fn(),
    };

    installCrashHandler(() => 'logs');

    expect(globalWithErrorUtils.ErrorUtils.setGlobalHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  test('new handler calls the previous handler after saving', async () => {
    const original = jest.fn();
    let installedHandler: any;
    globalWithErrorUtils.ErrorUtils = {
      getGlobalHandler: jest.fn().mockReturnValue(original),
      setGlobalHandler: jest.fn((handler: any) => {
        installedHandler = handler;
      }),
    };
    writeFileMock.mockResolvedValueOnce(undefined);

    installCrashHandler(() => 'logs');

    const error = new Error('kaboom');
    installedHandler(error, true);

    // Allow the async saveCrashLog to settle.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(original).toHaveBeenCalledWith(error, true);
    expect(captureCrash).toHaveBeenCalledWith(error, true, expect.any(Function));
    expect(writeFileMock).toHaveBeenCalled();
    expect((captureCrash as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(original.mock.invocationCallOrder[0]);
  });

  test('a throwing remote shim cannot prevent local saving or handler chaining', async () => {
    const original = jest.fn();
    let handler: any;
    globalWithErrorUtils.ErrorUtils = {
      getGlobalHandler: () => original,
      setGlobalHandler: (installed: any) => { handler = installed; },
    };
    (captureCrash as jest.Mock).mockImplementation(() => { throw new Error('SDK failure'); });
    installCrashHandler(() => 'offline QA logs');
    const error = new Error('non-fatal');

    expect(() => handler(error, false)).not.toThrow();
    expect(original).toHaveBeenCalledWith(error, false);
    expect(writeFileMock.mock.calls[0][1]).toContain('offline QA logs');
    await Promise.resolve();
  });

  test('does nothing when ErrorUtils is not available', () => {
    delete globalWithErrorUtils.ErrorUtils;
    expect(() => installCrashHandler(() => '')).not.toThrow();
  });
});
