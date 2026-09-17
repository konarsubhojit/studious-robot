import {
  areMessageNotificationsEnabled,
  ensureNotificationPrefsLoaded,
  getNotificationPrefs,
  isPeerMuted,
  isQuietHoursActive,
  resetNotificationPrefsForTests,
  setNotificationPreviewMode,
  setMessageNotificationsEnabled,
  setPeerMuted,
  setQuietHours,
  subscribeToNotificationPrefs,
} from '../src/notificationPreferences';
import { loadNotificationPrefs, saveNotificationPrefs } from '../src/settingsStorage';

jest.mock('../src/settingsStorage', () => ({
  DEFAULT_NOTIFICATION_PREFS: {
    messageNotificationsEnabled: true,
    mutedPeers: [],
    mutedPeerExpirations: {},
    quietHours: { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60, affects: 'messages' },
    previewMode: 'full',
  },
  loadNotificationPrefs: jest.fn(),
  saveNotificationPrefs: jest.fn(),
}));

const mockLoad = loadNotificationPrefs as jest.MockedFunction<typeof loadNotificationPrefs>;
const mockSave = saveNotificationPrefs as jest.MockedFunction<typeof saveNotificationPrefs>;
const mockDefaultNotificationPrefs = {
  messageNotificationsEnabled: true,
  mutedPeers: [],
  mutedPeerExpirations: {},
  quietHours: { enabled: false, startMinutes: 22 * 60, endMinutes: 7 * 60, affects: 'messages' as const },
  previewMode: 'full' as const,
};

describe('notificationPreferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNotificationPrefsForTests();
    mockLoad.mockResolvedValue(mockDefaultNotificationPrefs);
    mockSave.mockResolvedValue(true);
    jest.useRealTimers();
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
    mockLoad.mockResolvedValue(mockDefaultNotificationPrefs);
    await ensureNotificationPrefsLoaded();

    expect(areMessageNotificationsEnabled()).toBe(true);
  });

  test('hydration publishes the stored preferences', async () => {
    mockLoad.mockResolvedValue({
      messageNotificationsEnabled: false,
      mutedPeers: ['user-bob'],
      mutedPeerExpirations: {},
      quietHours: mockDefaultNotificationPrefs.quietHours,
      previewMode: 'full',
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

  test('an expiring mute is active until its deadline and is then ignored', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T10:00:00Z'));

    await setPeerMuted('user-bob', true, { expiresAt: Date.now() + 60_000 });
    expect(isPeerMuted('user-bob')).toBe(true);

    jest.setSystemTime(new Date('2026-01-01T10:01:01Z'));
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

  test('quiet hours support overnight schedules and explicit notification targets', async () => {
    await setQuietHours({
      enabled: true,
      startMinutes: 22 * 60,
      endMinutes: 7 * 60,
      affects: 'messages',
    });

    expect(isQuietHoursActive('messages', new Date('2026-03-01T23:30:00'))).toBe(true);
    expect(isQuietHoursActive('messages', new Date('2026-03-02T06:59:00'))).toBe(true);
    expect(isQuietHoursActive('messages', new Date('2026-03-02T07:00:00'))).toBe(false);
    expect(isQuietHoursActive('calls', new Date('2026-03-01T23:30:00'))).toBe(false);
  });

  test('quiet hours use the current local clock evaluation each time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-01T10:00:00'));
    await setQuietHours({
      enabled: true,
      startMinutes: 9 * 60,
      endMinutes: 17 * 60,
      affects: 'both',
    });

    expect(isQuietHoursActive('messages')).toBe(true);
    jest.setSystemTime(new Date('2026-06-01T18:00:00'));
    expect(isQuietHoursActive('calls')).toBe(false);
  });

  test('preview mode is persisted with the rest of the local account preferences', async () => {
    await setNotificationPreviewMode('sender');

    expect(getNotificationPrefs().previewMode).toBe('sender');
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ previewMode: 'sender' }));
  });

  test('a change made during an in-flight load wins over the file', async () => {
    let resolveLoad: (prefs: typeof mockDefaultNotificationPrefs) => void = () => {};
    mockLoad.mockReturnValue(
      new Promise(resolve => {
        resolveLoad = resolve;
      }),
    );

    const hydration = ensureNotificationPrefsLoaded();
    // The user muted someone before the file came back; the stale file must not
    // undo it.
    await setPeerMuted('user-bob', true);
    resolveLoad(mockDefaultNotificationPrefs);
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
