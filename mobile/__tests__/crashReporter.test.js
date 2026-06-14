jest.mock('react-native-fs', () => ({
  DownloadDirectoryPath: '/storage/emulated/0/Download',
  ExternalDirectoryPath: '/storage/emulated/0/Android/data/com.app/files',
  DocumentDirectoryPath: '/data/user/0/com.app/files/Documents',
  writeFile: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

// eslint-disable-next-line import/first
import RNFS from 'react-native-fs';
// eslint-disable-next-line import/first
import { installCrashHandler, saveCrashLog } from '../src/crashReporter';

describe('saveCrashLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('writes to Downloads first on Android', async () => {
    RNFS.writeFile.mockResolvedValueOnce(undefined);

    const error = new Error('test crash');
    const result = await saveCrashLog(error, true, () => 'app log line');

    expect(result.success).toBe(true);
    expect(result.label).toBe('Downloads');
    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);

    const [path, content] = RNFS.writeFile.mock.calls[0];
    expect(path).toMatch(/studious-robot-crash-\d{8}-\d{6}\.txt$/);
    expect(content).toContain('test crash');
    expect(content).toContain('app log line');
    expect(content).toContain('isFatal: true');
  });

  test('falls back to next storage target on write failure', async () => {
    RNFS.writeFile
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(new Error('oops'), false, () => '');

    expect(result.success).toBe(true);
    expect(RNFS.writeFile).toHaveBeenCalledTimes(2);
  });

  test('returns success: false when all storage targets fail', async () => {
    RNFS.writeFile.mockRejectedValue(new Error('disk full'));

    const result = await saveCrashLog(new Error('bad'), false, () => '');

    expect(result.success).toBe(false);
    expect(result.path).toBeUndefined();
  });

  test('handles null error without throwing', async () => {
    RNFS.writeFile.mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(null, false, () => '');

    expect(result.success).toBe(true);
    const [, content] = RNFS.writeFile.mock.calls[0];
    expect(content).toContain('error.name: unknown');
    expect(content).toContain('error.message: unknown');
  });

  test('handles missing log callback', async () => {
    RNFS.writeFile.mockResolvedValueOnce(undefined);

    const result = await saveCrashLog(new Error('x'), false, undefined);

    expect(result.success).toBe(true);
    const [, content] = RNFS.writeFile.mock.calls[0];
    expect(content).toContain('no log callback');
  });

  test('includes the error stack in the report', async () => {
    RNFS.writeFile.mockResolvedValueOnce(undefined);

    const error = new Error('stack test');
    await saveCrashLog(error, false, () => '');

    const [, content] = RNFS.writeFile.mock.calls[0];
    expect(content).toContain('error.stack:');
  });
});

describe('installCrashHandler', () => {
  afterEach(() => {
    delete global.ErrorUtils;
  });

  test('replaces the global handler when ErrorUtils is available', () => {
    const original = jest.fn();
    global.ErrorUtils = {
      getGlobalHandler: jest.fn().mockReturnValue(original),
      setGlobalHandler: jest.fn(),
    };

    installCrashHandler(() => 'logs');

    expect(ErrorUtils.setGlobalHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  test('new handler calls the previous handler after saving', async () => {
    const original = jest.fn();
    let installedHandler;
    global.ErrorUtils = {
      getGlobalHandler: jest.fn().mockReturnValue(original),
      setGlobalHandler: jest.fn((handler) => {
        installedHandler = handler;
      }),
    };
    RNFS.writeFile.mockResolvedValueOnce(undefined);

    installCrashHandler(() => 'logs');

    const error = new Error('kaboom');
    installedHandler(error, true);

    // Allow the async saveCrashLog to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(original).toHaveBeenCalledWith(error, true);
  });

  test('does nothing when ErrorUtils is not available', () => {
    delete global.ErrorUtils;
    expect(() => installCrashHandler(() => '')).not.toThrow();
  });
});
