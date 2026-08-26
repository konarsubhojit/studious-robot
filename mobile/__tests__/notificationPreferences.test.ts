import {
  areMessageNotificationsEnabled,
  ensureNotificationPrefsLoaded,
  getNotificationPrefs,
  isPeerMuted,
  resetNotificationPrefsForTests,
  setMessageNotificationsEnabled,
  setPeerMuted,
  subscribeToNotificationPrefs,
} from '../src/notificationPreferences';
import { loadNotificationPrefs, saveNotificationPrefs } from '../src/settingsStorage';

jest.mock('../src/settingsStorage', () => ({
  DEFAULT_NOTIFICATION_PREFS: { messageNotificationsEnabled: true, mutedPeers: [] },
  loadNotificationPrefs: jest.fn(),
  saveNotificationPrefs: jest.fn(),
}));

const mockLoad = loadNotificationPrefs as jest.MockedFunction<typeof loadNotificationPrefs>;
const mockSave = saveNotificationPrefs as jest.MockedFunction<typeof saveNotificationPrefs>;

describe('notificationPreferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNotificationPrefsForTests();
    mockLoad.mockResolvedValue({ messageNotificationsEnabled: true, mutedPeers: [] });
    mockSave.mockResolvedValue(true);
  });

  test('reads the file at most once however many callers ask', async () => {
    const [first, second] = await Promise.all([
      ensureNotificationPrefsLoaded(),
      ensureNotificationPrefsLoaded(),
    ]);
    await ensureNotificationPrefsLoaded();

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  test('defaults to notifying until the file has been read', () => {
    expect(areMessageNotificationsEnabled()).toBe(true);
    expect(isPeerMuted('user-bob')).toBe(false);
  });

  test('a load failure fails open rather than silencing every message', async () => {
    // `loadNotificationPrefs` already swallows its own errors, but a rejection
    // here would leave the cache permanently unresolved.
    mockLoad.mockResolvedValue({ messageNotificationsEnabled: true, mutedPeers: [] });
    await ensureNotificationPrefsLoaded();

    expect(areMessageNotificationsEnabled()).toBe(true);
  });

  test('hydration publishes the stored preferences', async () => {
    mockLoad.mockResolvedValue({
      messageNotificationsEnabled: false,
      mutedPeers: ['user-bob'],
    });

    await ensureNotificationPrefsLoaded();

    expect(areMessageNotificationsEnabled()).toBe(false);
    expect(isPeerMuted('user-bob')).toBe(true);
  });

  test('mute is case- and whitespace-insensitive, and never matches an empty id', async () => {
    await setPeerMuted('  User-Bob  ', true);

    expect(isPeerMuted('user-bob')).toBe(true);
    expect(isPeerMuted('USER-BOB')).toBe(true);
    expect(isPeerMuted('user-carol')).toBe(false);
    expect(isPeerMuted('')).toBe(false);
    expect(isPeerMuted(null)).toBe(false);
    // The trimmed id is what gets stored, so the list stays readable.
    expect(getNotificationPrefs().mutedPeers).toEqual(['User-Bob']);
  });

  test('muting the same person twice does not duplicate the entry', async () => {
    await setPeerMuted('user-bob', true);
    await setPeerMuted('USER-BOB', true);

    expect(getNotificationPrefs().mutedPeers).toHaveLength(1);
  });

  test('unmuting removes the person however they were cased', async () => {
    await setPeerMuted('User-Bob', true);
    await setPeerMuted('user-bob', false);

    expect(isPeerMuted('user-bob')).toBe(false);
    expect(getNotificationPrefs().mutedPeers).toEqual([]);
  });

  test('an empty peer id is not persisted', async () => {
    await expect(setPeerMuted('   ', true)).resolves.toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('every change is persisted and fanned out to subscribers', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToNotificationPrefs(listener);

    await setMessageNotificationsEnabled(false);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ messageNotificationsEnabled: false }),
    );
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ messageNotificationsEnabled: false }),
    );

    unsubscribe();
    await setMessageNotificationsEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a change made during an in-flight load wins over the file', async () => {
    let resolveLoad: (prefs: { messageNotificationsEnabled: boolean; mutedPeers: string[] }) => void = () => {};
    mockLoad.mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
    );

    const hydration = ensureNotificationPrefsLoaded();
    // The user muted someone before the file came back; the stale file must not
    // undo it.
    await setPeerMuted('user-bob', true);
    resolveLoad({ messageNotificationsEnabled: true, mutedPeers: [] });
    await hydration;

    expect(isPeerMuted('user-bob')).toBe(true);
    await expect(ensureNotificationPrefsLoaded()).resolves.toEqual(
      expect.objectContaining({ mutedPeers: ['user-bob'] }),
    );
  });

  test('the published snapshot cannot be mutated by its reader', async () => {
    await setPeerMuted('user-bob', true);

    const snapshot = getNotificationPrefs();
    snapshot.mutedPeers.push('user-carol');

    expect(isPeerMuted('user-carol')).toBe(false);
  });
});
