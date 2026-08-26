import {
  categorizeStoredFile,
  clearCachedMedia,
  describeClearMediaResult,
  formatBytes,
  measureStorageUsage,
  RECENT_FILE_GRACE_MS,
} from '../src/storageUsage';

jest.mock('../src/appLogger', () => ({ logWarn: jest.fn() }));

const RNFS = require('react-native-fs');

/** Build a `readDir` entry the way `react-native-fs` reports one. */
function file(path: string, size: number, mtimeMs = 0) {
  return {
    name: path.split('/').pop(),
    path,
    size,
    mtime: new Date(mtimeMs),
    isFile: () => true,
    isDirectory: () => false,
  };
}

function dir(path: string) {
  return {
    name: path.split('/').pop(),
    path,
    size: 0,
    mtime: new Date(0),
    isFile: () => false,
    isDirectory: () => true,
  };
}

describe('categorizeStoredFile', () => {
  test('classifies the app\'s own state as data and its logs as logs', () => {
    // The three categories share a directory, so the name is the only signal.
    expect(categorizeStoredFile('wetalk-settings.json')).toBe('data');
    expect(categorizeStoredFile('wetalk-chat.db')).toBe('data');
    expect(categorizeStoredFile('wetalk-log.txt')).toBe('logs');
    expect(categorizeStoredFile('wetalk-crash.log')).toBe('logs');
  });

  test('classifies anything else as media', () => {
    expect(categorizeStoredFile('IMG_0042.jpg')).toBe('media');
    expect(categorizeStoredFile('voice-note-1.m4a')).toBe('media');
  });
});

describe('formatBytes', () => {
  test('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  test('never reports a negative or non-finite size', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('measureStorageUsage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('totals each category across the directories it walks', async () => {
    RNFS.readDir.mockImplementation(async (path: string) => {
      if (path === RNFS.DocumentDirectoryPath) {
        return [file(`${path}/wetalk-settings.json`, 100), file(`${path}/photo.jpg`, 1000)];
      }
      if (path === RNFS.CachesDirectoryPath) {
        return [file(`${path}/wetalk-log.txt`, 10), dir(`${path}/nested`)];
      }
      if (path === `${RNFS.CachesDirectoryPath}/nested`) {
        return [file(`${path}/voice.m4a`, 500)];
      }
      return [];
    });

    const usage = await measureStorageUsage();

    expect(usage.measured).toBe(true);
    expect(usage.dataBytes).toBe(100);
    expect(usage.logBytes).toBe(10);
    expect(usage.mediaBytes).toBe(1500);
    expect(usage.totalBytes).toBe(1610);
    expect(usage.mediaFileCount).toBe(2);
  });

  test('counts a file reachable from two directories only once', async () => {
    // On iOS the temporary and caches paths can resolve to the same place.
    RNFS.readDir.mockResolvedValue([file(`${RNFS.DocumentDirectoryPath}/photo.jpg`, 400)]);

    const usage = await measureStorageUsage();

    expect(usage.mediaBytes).toBe(400);
    expect(usage.mediaFileCount).toBe(1);
  });

  test('reports an unreadable device as unmeasured rather than as zero', async () => {
    RNFS.readDir.mockRejectedValue(new Error('EACCES'));

    const usage = await measureStorageUsage();

    // "0 B" would be a lie the UI has no way to distinguish from an empty app.
    expect(usage.measured).toBe(false);
    expect(usage.totalBytes).toBe(0);
  });
});

describe('clearCachedMedia', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    RNFS.unlink.mockResolvedValue(undefined);
  });

  test('removes media and leaves the app\'s own data and logs alone', async () => {
    const base = RNFS.DocumentDirectoryPath;
    RNFS.readDir.mockImplementation(async (path: string) =>
      path === base
        ? [
            file(`${base}/photo.jpg`, 400),
            file(`${base}/wetalk-settings.json`, 100),
            file(`${base}/wetalk-log.txt`, 10),
          ]
        : [],
    );

    const result = await clearCachedMedia({ now: RECENT_FILE_GRACE_MS * 10 });

    expect(result.removedFiles).toBe(1);
    expect(result.freedBytes).toBe(400);
    expect(RNFS.unlink).toHaveBeenCalledTimes(1);
    expect(RNFS.unlink).toHaveBeenCalledWith(`${base}/photo.jpg`);
  });

  test('skips a file young enough to still be in flight', async () => {
    const base = RNFS.DocumentDirectoryPath;
    const now = RECENT_FILE_GRACE_MS * 10;
    RNFS.readDir.mockImplementation(async (path: string) =>
      path === base ? [file(`${base}/recording.m4a`, 400, now - 1000)] : [],
    );

    const result = await clearCachedMedia({ now });

    // A voice note being recorded or uploaded lives in this directory; deleting
    // it out from under the upload would fail the send.
    expect(result.skippedFiles).toBe(1);
    expect(result.removedFiles).toBe(0);
    expect(RNFS.unlink).not.toHaveBeenCalled();
  });

  test('counts a failed delete instead of aborting the rest', async () => {
    const base = RNFS.DocumentDirectoryPath;
    RNFS.readDir.mockImplementation(async (path: string) =>
      path === base ? [file(`${base}/a.jpg`, 100), file(`${base}/b.jpg`, 200)] : [],
    );
    RNFS.unlink.mockRejectedValueOnce(new Error('EBUSY'));

    const result = await clearCachedMedia({ now: RECENT_FILE_GRACE_MS * 10 });

    expect(result.failedFiles).toBe(1);
    expect(result.removedFiles).toBe(1);
    expect(result.freedBytes).toBe(200);
  });
});

describe('describeClearMediaResult', () => {
  test('reports what was freed', () => {
    expect(
      describeClearMediaResult({
        removedFiles: 3,
        freedBytes: 2048,
        failedFiles: 0,
        skippedFiles: 0,
      }),
    ).toBe('Freed 2.0 KB.');
  });

  test('says so plainly when there was nothing to remove', () => {
    expect(
      describeClearMediaResult({
        removedFiles: 0,
        freedBytes: 0,
        failedFiles: 0,
        skippedFiles: 0,
      }),
    ).toBe('No cached media to clear.');
  });

  test('names a partial failure rather than claiming success', () => {
    const message = describeClearMediaResult({
      removedFiles: 1,
      freedBytes: 100,
      failedFiles: 2,
      skippedFiles: 0,
    });
    expect(message).toContain('2 files could not be removed');
  });
});
