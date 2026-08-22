jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  logWarn: jest.fn(),
}));

import RNFS from 'react-native-fs';
import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_FILE_PATH,
  addRecentSearch,
  clearRecentSearches,
  loadRecentSearches,
  resetRecentSearchesCache,
} from '../../src/storage/recentSearches';

describe('recentSearches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRecentSearchesCache();
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  test('returns an empty list when nothing has been persisted', async () => {
    await expect(loadRecentSearches()).resolves.toEqual([]);
  });

  test('reads the persisted terms, dropping malformed entries', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue(JSON.stringify(['bob', 42, '  ', 'carol', 'bob']));

    await expect(loadRecentSearches()).resolves.toEqual(['bob', 'carol']);
  });

  test('degrades to an empty list when the file is corrupt', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.readFile as jest.Mock).mockResolvedValue('not json');

    await expect(loadRecentSearches()).resolves.toEqual([]);
  });

  test('records the newest term first, de-duplicated', async () => {
    await addRecentSearch('bob');
    await addRecentSearch('carol');
    await expect(addRecentSearch('bob')).resolves.toEqual(['bob', 'carol']);
    expect(RNFS.writeFile).toHaveBeenLastCalledWith(
      RECENT_SEARCHES_FILE_PATH,
      JSON.stringify(['bob', 'carol']),
      'utf8',
    );
  });

  test('ignores a blank term', async () => {
    await addRecentSearch('bob');
    await expect(addRecentSearch('   ')).resolves.toEqual(['bob']);
  });

  test('caps the list', async () => {
    for (let index = 0; index <= MAX_RECENT_SEARCHES; index += 1) {
      await addRecentSearch(`term-${index}`);
    }
    const stored = await loadRecentSearches();
    expect(stored).toHaveLength(MAX_RECENT_SEARCHES);
    expect(stored[0]).toBe(`term-${MAX_RECENT_SEARCHES}`);
  });

  test('clearing removes the file and empties the list', async () => {
    await addRecentSearch('bob');
    (RNFS.exists as jest.Mock).mockResolvedValue(true);

    await clearRecentSearches();

    expect(RNFS.unlink).toHaveBeenCalledWith(RECENT_SEARCHES_FILE_PATH);
    await expect(loadRecentSearches()).resolves.toEqual([]);
  });
});
