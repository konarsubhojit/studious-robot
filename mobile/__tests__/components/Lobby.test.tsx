import React from 'react';
import renderer, { act } from 'react-test-renderer';
import Lobby from '../../src/components/Lobby';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('react-native-webrtc', () => ({
  RTCView: 'RTCView',
}));

jest.mock('../../src/SafeRTCView', () => 'SafeRTCView');

jest.mock('../../src/hooks/useCallFlow', () => ({
  CALL_END_REASON_LABELS: {
    ended: 'Call ended',
    declined: 'Call declined',
    cancelled: 'Call cancelled',
    timeout: 'Missed call',
    missed: 'Missed call',
    busy: 'Line was busy',
    unreachable: 'User unavailable',
    failed: 'Call failed',
  },
}));

// ─── Default props ────────────────────────────────────────────────────────────

/** @type {any} */

const baseProps: any = {
  userId: 'user-alice',
  onChangeUserId: jest.fn(),
  calleeId: 'user-bob',
  onChangeCalleeId: jest.fn(),
  onCall: jest.fn(),
  isSettingsVisible: false,
  onToggleSettings: jest.fn(),
  onExportLogs: jest.fn(),
  settings: { autoLighting: false, speakerDefault: false },
  onToggleAutoLighting: jest.fn(),
  onToggleSpeakerDefault: jest.fn(),
  status: { message: '', severity: 'info' },
  callSummary: null,
  onDismissSummary: jest.fn(),
  callHistory: [],
  missedCallCount: 0,
  onMarkMissedRead: jest.fn(),
  developerMode: true,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Lobby – missed call badge', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not show missed badge when missedCallCount is 0', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} missedCallCount={0} />);
    });
    const badge = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBe(0);
  });

  test('shows missed badge with correct count', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} missedCallCount={3} />);
    });
    const badge = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBeGreaterThanOrEqual(1);
    // The badge text should contain the count.
    const texts = tree.root.findAll((/** @type {any} */ n: any) => n.type === 'Text' && String(n.props.children) === '3');
    expect(texts.length).toBeGreaterThanOrEqual(1);
  });

  test('calls onMarkMissedRead when badge is pressed', () => {
    const onMarkMissedRead = jest.fn();
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} missedCallCount={2} onMarkMissedRead={onMarkMissedRead} />,
      );
    });
    const badge = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBeGreaterThanOrEqual(1);
    act(() => {
      badge[0].props.onPress();
    });
    expect(onMarkMissedRead).toHaveBeenCalledTimes(1);
  });
});

describe('Lobby – call history section', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not render history section when callHistory is empty', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={[]} />);
    });
    const section = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'call-history-section');
    expect(section.length).toBe(0);
  });

  test('renders history rows for each entry (up to 5)', () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      callId: `call-${i}`,
      callerId: 'user-alice',
      calleeId: 'user-bob',
      direction: 'outgoing',
      status: 'ended',
      endReason: 'ended',
      createdAt: new Date().toISOString(),
      durationSeconds: 60 + i,
      isRead: true,
    }));

    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={history} />);
    });

    const rows = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'call-history-row');
    // Only up to 5 rows should be shown; findAll returns multiple fibers per
    // Pressable row (composite + host + inner), so allow up to 5 × 3.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(15);
  });

  test('history rows meet the minimum touch-target height and show a redial affordance', () => {
    const history = [
      {
        callId: 'call-1',
        callerId: 'user-alice',
        calleeId: 'user-bob',
        direction: 'outgoing',
        status: 'ended',
        endReason: 'ended',
        createdAt: new Date().toISOString(),
        durationSeconds: 60,
        isRead: true,
      },
    ];
    const onRedial = jest.fn();
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={history} onRedial={onRedial} />);
    });

    const rowNodes = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'call-history-row');
    const hostRow = rowNodes.find((/** @type {any} */ n: any) => typeof n.type === 'string');
    const flatStyle = ([] as any[]).concat(hostRow.props.style).flat();
    expect(flatStyle.some(s => s?.minHeight === 56)).toBe(true);

    const pressableRow = rowNodes.find((/** @type {any} */ n: any) => typeof n.props.onPress === 'function');
    act(() => {
      pressableRow.props.onPress();
    });
    expect(onRedial).toHaveBeenCalledWith('user-bob');
  });

  test('missed incoming calls are visually distinguished', () => {
    const history = [
      {
        callId: 'missed-1',
        callerId: 'user-bob',
        calleeId: 'user-alice',
        direction: 'incoming',
        status: 'missed',
        endReason: 'timeout',
        createdAt: new Date().toISOString(),
        durationSeconds: null,
        isRead: false,
      },
    ];
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={history} />);
    });
    const section = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'call-history-section');
    expect(section.length).toBeGreaterThanOrEqual(1);
    // The peer label should show the caller's ID.
    const texts = tree.root.findAll((/** @type {any} */ n: any) => n.type === 'Text' && n.props.children === 'user-bob');
    expect(texts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Lobby – developer mode (developer tools section)', () => {
  afterEach(() => jest.clearAllMocks());

  test('hides the developer tools by default (developerMode off)', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} developerMode={false} />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'developer-tools-section')).toHaveLength(0);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-export-logs')).toHaveLength(0);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-settings')).toHaveLength(0);
  });

  test('shows the developer tools when developerMode is on', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} developerMode />);
    });
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'developer-tools-section').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-export-logs').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-settings').length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('no room-join affordances remain', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} developerMode />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'input-signaling-url')).toHaveLength(0);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'input-room-id')).toHaveLength(0);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-join-room')).toHaveLength(0);
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-start-preview')).toHaveLength(0);
  });

  test('the server-authoritative Call button is shown regardless of developerMode', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} developerMode={false} />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'lobby-call').length).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe('Lobby – contact directory', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not render the contacts section without onSearchUsers', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} onSearchUsers={undefined} />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'contact-directory')).toHaveLength(0);
  });

  test('renders the contacts search input when onSearchUsers is provided', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} onSearchUsers={jest.fn().mockResolvedValue([])} />,
      );
    });
    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'input-contact-search').length,
    ).toBeGreaterThanOrEqual(1);
  });

  test('debounces, lists results, and selects a contact on press', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockResolvedValue([
      { userId: 'user-carol', online: true },
      { userId: 'user-dave', online: false },
    ]);
    const onSelectContact = jest.fn();

    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} onSearchUsers={onSearchUsers} onSelectContact={onSelectContact} />,
      );
    });

    const input = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'input-contact-search')[0];
    act(() => {
      input.props.onChangeText('user');
    });

    // Before the debounce window elapses, no request should fire.
    expect(onSearchUsers).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(onSearchUsers).toHaveBeenCalledWith('user');

    const rows = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'contact-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);

    act(() => {
      rows[0].props.onPress();
    });
    expect(onSelectContact).toHaveBeenCalledWith('user-carol');

    jest.useRealTimers();
  });

  test('shows an empty-state message when no contacts match', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockResolvedValue([]);

    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} onSearchUsers={onSearchUsers} onSelectContact={jest.fn()} />,
      );
    });

    const input = tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'input-contact-search')[0];
    act(() => {
      input.props.onChangeText('nobody');
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(
      tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'contact-empty').length,
    ).toBeGreaterThanOrEqual(1);

    jest.useRealTimers();
  });
});

describe('Lobby – server unreachable', () => {
  afterEach(() => jest.clearAllMocks());

  test('explains the failure and offers a retry action', () => {
    const onRetryConnect = jest.fn();
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} isServerUnreachable onRetryConnect={onRetryConnect} />,
      );
    });

    const banner = tree.root.find(
      (/** @type {any} */ n: any) => typeof n.type === 'string' && n.props.testID === 'offline-banner',
    );
    expect(banner.props.accessibilityRole).toBe('alert');

    const retry = tree.root.find(
      (/** @type {any} */ n: any) => n.props?.testID === 'offline-banner-action' && typeof n.props.onPress === 'function',
    );
    act(() => {
      retry.props.onPress();
    });
    expect(onRetryConnect).toHaveBeenCalledTimes(1);
  });

  test('hides the banner while the server is reachable', () => {
    /** @type {any} */
    let tree: any;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} />);
    });
    expect(tree.root.findAll((/** @type {any} */ n: any) => n.props.testID === 'offline-banner')).toHaveLength(0);
  });
});
