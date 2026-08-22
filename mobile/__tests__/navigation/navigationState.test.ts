// @ts-check
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logWarn: jest.fn(),
}));

const STATE = { index: 0, routes: [{ name: 'chats' }] };

describe('navigationState', () => {
  /** @type {any} */
  let navigationState: any;
  /** @type {any} */
  let RNFS: any;

  beforeEach(() => {
    // The module caches the loaded state in memory; reset it (and the mocked
    // react-native-fs it closes over) per test.
    jest.resetModules();
    RNFS = require('react-native-fs');
    jest.clearAllMocks();
    navigationState = require('../../src/navigation/navigationState');
  });

  describe('isValidNavigationState', () => {
    test('accepts a well-formed state', () => {
      expect(navigationState.isValidNavigationState(STATE)).toBe(true);
    });

    test('rejects malformed state', () => {
      expect(navigationState.isValidNavigationState(null)).toBe(false);
      expect(navigationState.isValidNavigationState({ routes: [] })).toBe(false);
      expect(navigationState.isValidNavigationState({ routes: [{}] })).toBe(false);
      expect(navigationState.isValidNavigationState({ routes: [{ name: 'chats' }], index: 4 })).toBe(
        false,
      );
    });
  });

  describe('getCachedNavigationState', () => {
    test('is undefined until state has been loaded or saved', async () => {
      expect(navigationState.getCachedNavigationState()).toBeUndefined();
      RNFS.writeFile.mockResolvedValue(undefined);
      await navigationState.saveNavigationState(STATE);
      expect(navigationState.getCachedNavigationState()).toEqual(STATE);
    });
  });

  describe('loadNavigationState', () => {
    test('returns null when nothing has been persisted', async () => {
      RNFS.exists.mockResolvedValue(false);
      await expect(navigationState.loadNavigationState()).resolves.toBeNull();
    });

    test('returns the persisted state', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(JSON.stringify(STATE));
      await expect(navigationState.loadNavigationState()).resolves.toEqual(STATE);
    });

    test('returns null for corrupt state instead of throwing', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue('{not json');
      await expect(navigationState.loadNavigationState()).resolves.toBeNull();
    });

    test('returns null for a structurally invalid state', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(JSON.stringify({ routes: 'nope' }));
      await expect(navigationState.loadNavigationState()).resolves.toBeNull();
    });

    test('serves later loads from memory so a remount restores instantly', async () => {
      RNFS.exists.mockResolvedValue(true);
      RNFS.readFile.mockResolvedValue(JSON.stringify(STATE));
      await navigationState.loadNavigationState();
      await navigationState.loadNavigationState();
      expect(RNFS.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveNavigationState', () => {
    test('writes valid state and serves it back from memory', async () => {
      RNFS.writeFile.mockResolvedValue(undefined);
      await expect(navigationState.saveNavigationState(STATE)).resolves.toBe(true);
      expect(RNFS.writeFile).toHaveBeenCalledWith(
        '/docs/wetalk-navigation-state.json',
        JSON.stringify(STATE),
        'utf8',
      );
      await expect(navigationState.loadNavigationState()).resolves.toEqual(STATE);
      expect(RNFS.readFile).not.toHaveBeenCalled();
    });

    test('skips invalid state', async () => {
      await expect(navigationState.saveNavigationState(undefined)).resolves.toBe(false);
      expect(RNFS.writeFile).not.toHaveBeenCalled();
    });

    test('reports a failed write instead of throwing', async () => {
      RNFS.writeFile.mockRejectedValue(new Error('disk full'));
      await expect(navigationState.saveNavigationState(STATE)).resolves.toBe(false);
    });
  });

  describe('clearNavigationState', () => {
    test('deletes the persisted state and forgets the cached one', async () => {
      RNFS.writeFile.mockResolvedValue(undefined);
      await navigationState.saveNavigationState(STATE);

      RNFS.exists.mockResolvedValue(true);
      RNFS.unlink.mockResolvedValue(undefined);
      await navigationState.clearNavigationState();
      expect(RNFS.unlink).toHaveBeenCalledWith('/docs/wetalk-navigation-state.json');

      RNFS.exists.mockResolvedValue(false);
      await expect(navigationState.loadNavigationState()).resolves.toBeNull();
    });

    test('is a no-op when nothing is persisted', async () => {
      RNFS.exists.mockResolvedValue(false);
      await navigationState.clearNavigationState();
      expect(RNFS.unlink).not.toHaveBeenCalled();
    });
  });
});
