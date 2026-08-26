import { act, create } from 'react-test-renderer';
import React from 'react';
import useNotificationPreferences from '../../src/hooks/useNotificationPreferences';
import {
  resetNotificationPrefsForTests,
  setPeerMuted,
} from '../../src/notificationPreferences';
import { loadNotificationPrefs, saveNotificationPrefs } from '../../src/settingsStorage';

jest.mock('../../src/settingsStorage', () => ({
  DEFAULT_NOTIFICATION_PREFS: { messageNotificationsEnabled: true, mutedPeers: [] },
  loadNotificationPrefs: jest.fn(),
  saveNotificationPrefs: jest.fn(),
}));

const mockLoad = loadNotificationPrefs as jest.MockedFunction<typeof loadNotificationPrefs>;
const mockSave = saveNotificationPrefs as jest.MockedFunction<typeof saveNotificationPrefs>;

type Hook = ReturnType<typeof useNotificationPreferences>;

/** Renders the hook and exposes its latest value. */
function renderHook() {
  const result: { current: Hook } = { current: (null as unknown as Hook) };
  function Probe() {
    result.current = useNotificationPreferences();
    return null;
  }
  let tree: ReturnType<typeof create> | null = null;
  act(() => {
    tree = create(<Probe />);
  });
  return {
    result,
    unmount: () => act(() => {
      tree?.unmount();
    }),
  };
}

describe('useNotificationPreferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNotificationPrefsForTests();
    mockLoad.mockResolvedValue({ messageNotificationsEnabled: true, mutedPeers: [] });
    mockSave.mockResolvedValue(true);
  });

  test('hydrates from the stored preferences', async () => {
    mockLoad.mockResolvedValue({
      messageNotificationsEnabled: false,
      mutedPeers: ['user-bob'],
    });

    const { result } = renderHook();
    await act(async () => {});

    expect(result.current.messageNotificationsEnabled).toBe(false);
    expect(result.current.mutedPeers).toEqual(['user-bob']);
    expect(result.current.isPeerMuted('user-bob')).toBe(true);
  });

  test('matches a muted peer however the caller cased it', async () => {
    mockLoad.mockResolvedValue({
      messageNotificationsEnabled: true,
      mutedPeers: ['User-Bob'],
    });

    const { result } = renderHook();
    await act(async () => {});

    expect(result.current.isPeerMuted('  user-bob ')).toBe(true);
    expect(result.current.isPeerMuted('user-carol')).toBe(false);
    expect(result.current.isPeerMuted('')).toBe(false);
  });

  test('re-renders when the shared cache changes, whoever changed it', async () => {
    const { result } = renderHook();
    await act(async () => {});
    expect(result.current.isPeerMuted('user-bob')).toBe(false);

    // The push path and the person hub share one cache; a change made anywhere
    // has to reach the UI without a prop being threaded through.
    await act(async () => {
      await setPeerMuted('user-bob', true);
    });

    expect(result.current.isPeerMuted('user-bob')).toBe(true);
  });

  test('setters persist through the shared cache', async () => {
    const { result } = renderHook();
    await act(async () => {});

    await act(async () => {
      result.current.setPeerMuted('user-bob', true);
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ mutedPeers: ['user-bob'] }),
    );

    await act(async () => {
      result.current.setMessageNotificationsEnabled(false);
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ messageNotificationsEnabled: false }),
    );
    expect(result.current.messageNotificationsEnabled).toBe(false);
  });

  test('stops listening once unmounted', async () => {
    const { result, unmount } = renderHook();
    await act(async () => {});
    const before = result.current;

    unmount();
    await act(async () => {
      await setPeerMuted('user-bob', true);
    });

    // An update after unmount would warn and, worse, leak the subscription.
    expect(result.current).toBe(before);
  });
});
